// Voice for Orbi Desktop: the helper's push-to-talk and speaker as one more
// Orbi window.
//
// The extension does its voice in the browser: Ink 2 hears the mic and the
// words go to /session as user_text; agent_text comes back and Sonic speaks
// it. The helper has no browser, so this does those two ends here and
// joins the same SessionHub (hub.ts) as a peer, exactly like a /session
// socket. The agent, its turns, barge-in and the one-window-owns-it rules
// are the hub's and the session's, unchanged:
//   - ptt_down claims the session ({type:"interrupt"} from a window): if
//     Orbi was speaking, audio_stop goes to the helper and Sonic is
//     cancelled, and the rest of that turn is not spoken.
//   - The mic audio (PCM s16le 16 kHz) goes to Ink 2 through the
//     extension's own SttSession (extension/lib/voice/stt.js), as float32.
//   - ptt_up finishes the transcript and sends it as user_text.
//   - latch_toggle: hands free, the first toggle starts listening like
//     ptt_down and the next ends it like ptt_up.
//   - agent_text is spoken with Sonic (PCM s16le 24 kHz to the helper),
//     and its subtitle and state go to the helper's overlay. A helper with
//     the "overlay2" feature gets the line as overlay {speech} instead, with
//     Sonic's word and phoneme timestamps as they arrive, so it shows the
//     karaoke words and moves the orb's lips in step with the audio, as
//     lib/voice/tts.js does in the extension.
// CLEARCART_VOICE=false: nothing reaches Cartesia; replies show as
// subtitles only, and push-to-talk says voice is off.

import type { HubMessage, HubPeer } from "../hub.ts";
// @ts-ignore: plain JS module from the extension
import { SttSession } from "../../extension/lib/voice/stt.js";
// @ts-ignore: plain JS module from the extension
import { CARTESIA_VERSION, DEFAULT_VOICE_ID, TTS_MODEL, TTS_URL } from "../../extension/lib/voice/config.js";
import type { DesktopBridge } from "./bridge.ts";

export const MIC_RATE = 16_000;
export const TTS_RATE = 24_000;
const TOKEN_TTL_S = 300;
export const VOICE_OFF_TEXT = "Orbi can't hear you here: voice is off on the Orbi server, or it has no Cartesia key.";

// A Cartesia access token for STT and TTS. The API key stays on the server;
// only the short-lived token goes into the socket URL, as in the extension.
export async function mintCartesiaToken(key: string, version = process.env.CARTESIA_VERSION || CARTESIA_VERSION): Promise<{ token: string; expires_in: number }> {
  const r = await fetch("https://api.cartesia.ai/access-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Cartesia-Version": version, "Content-Type": "application/json" },
    body: JSON.stringify({ grants: { tts: true, stt: true }, expires_in: TOKEN_TTL_S }),
  });
  const body = (await r.json().catch(() => ({}))) as { token?: string };
  if (!r.ok || !body.token) throw Object.assign(new Error(`Cartesia token request failed (${r.status})`), { status: r.status });
  return { token: body.token, expires_in: TOKEN_TTL_S };
}

// Cached until 15 s before it expires (extension/lib/voice/token.js).
export function serverTokenSource(now = () => Date.now()): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  let inflight: Promise<string> | null = null;
  return async () => {
    if (cached && cached.until - now() > 15_000) return cached.token;
    const key = process.env.CARTESIA_API_KEY?.trim();
    if (!key) throw new Error("no Cartesia key is set");
    inflight ??= mintCartesiaToken(key)
      .then((t) => {
        cached = { token: t.token, until: now() + t.expires_in * 1000 };
        return t.token;
      })
      .finally(() => (inflight = null));
    return inflight;
  };
}

// PCM s16le to float32 little endian, what SttSession's Ink 2 URL asks for.
export function s16ToF32(pcm: Buffer): ArrayBuffer {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out.buffer;
}

type WsLike = { readyState: number; send(d: string): void; close(): void; onopen: any; onmessage: any; onclose: any; onerror: any };
type WsCtor = new (url: string) => WsLike;

// One overlay {speech} update (docs/desktop-protocol.md): text when a line
// is queued, Sonic's timestamps as they come (seconds of the line's audio),
// done once all its audio has been sent.
export type SpeechUpdate = {
  id: string;
  text?: string;
  timestamps?: { words: string[]; start: number[]; end: number[] };
  phonemes?: { phonemes: string[]; start: number[]; end: number[] };
  done?: true;
};

// Sonic over one TTS socket. Utterances play strictly in order; stop()
// cancels everything still generating (barge-in).
export class SonicSpeaker {
  private ws: WsLike | null = null;
  private opening: Promise<WsLike> | null = null;
  private queue: Array<{ id: string; chunks: Buffer[]; done: boolean }> = [];
  private seq = 0;
  // Audio goes out faster than it plays: when what was sent ends playing.
  private playUntil = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private o: {
      getToken: () => Promise<string>;
      onAudio: (pcm: Buffer) => void;
      onIdle: () => void;
      onSpeech?: (s: SpeechUpdate) => void;
      log: (l: string) => void;
      WebSocketImpl?: WsCtor;
    }
  ) {}

  speaking(): boolean {
    return this.queue.length > 0 || Date.now() < this.playUntil;
  }

  async speak(text: string) {
    if (!text.trim()) return;
    const utt = { id: `od-${Date.now().toString(36)}-${(this.seq++).toString(36)}`, chunks: [] as Buffer[], done: false };
    this.queue.push(utt);
    this.o.onSpeech?.({ id: utt.id, text });
    try {
      const ws = await this.socket();
      if (!this.queue.includes(utt)) return; // stopped while connecting
      ws.send(
        JSON.stringify({
          model_id: TTS_MODEL,
          transcript: text,
          voice: DEFAULT_VOICE_ID,
          language: "en",
          context_id: utt.id,
          output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: TTS_RATE },
          add_timestamps: true,
          use_normalized_timestamps: false, // the words as written, to match the caption
          add_phoneme_timestamps: true, // the orb's lip-sync
          continue: false,
        })
      );
    } catch (e) {
      this.o.log(`desktop: TTS failed (${(e as Error).message})`);
      utt.done = true;
      this.pump();
    }
  }

  stop() {
    this.playUntil = 0;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const ws = this.ws;
    for (const u of this.queue) if (!u.done && ws && ws.readyState === 1) ws.send(JSON.stringify({ context_id: u.id, cancel: true }));
    this.queue = [];
  }

  close() {
    this.stop();
    this.ws?.close();
    this.ws = null;
  }

  private socket(): Promise<WsLike> {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve(this.ws);
    this.opening ??= (async () => {
      const token = await this.o.getToken();
      const url = new URL(TTS_URL);
      url.searchParams.set("cartesia_version", CARTESIA_VERSION);
      url.searchParams.set("access_token", token);
      const Ctor = this.o.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsCtor);
      const ws = new Ctor(url.toString());
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("TTS socket error"));
      });
      ws.onerror = () => this.o.log("desktop: TTS socket error");
      ws.onmessage = (e: { data: unknown }) => this.onMessage(e.data);
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        for (const u of this.queue) u.done = true;
        this.pump();
      };
      this.ws = ws;
      return ws;
    })().finally(() => (this.opening = null));
    return this.opening;
  }

  private onMessage(data: unknown) {
    if (typeof data !== "string") return;
    let m: any;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const utt = this.queue.find((u) => u.id === m.context_id);
    if (!utt) return;
    if (m.type === "chunk" && typeof m.data === "string") utt.chunks.push(Buffer.from(m.data, "base64"));
    else if (m.type === "timestamps" && m.word_timestamps) this.o.onSpeech?.({ id: utt.id, timestamps: stamps(m.word_timestamps, "words") });
    else if (m.type === "phoneme_timestamps" && m.phoneme_timestamps) this.o.onSpeech?.({ id: utt.id, phonemes: stamps(m.phoneme_timestamps, "phonemes") });
    else if (m.type === "error") this.o.log("desktop: TTS error");
    if (m.done || m.type === "done" || m.type === "error") utt.done = true;
    this.pump();
  }

  private pump() {
    while (this.queue.length) {
      const u = this.queue[0];
      for (const c of u.chunks) {
        this.playUntil = Math.max(Date.now(), this.playUntil) + (c.length / 2 / TTS_RATE) * 1000;
        this.o.onAudio(c);
      }
      u.chunks = [];
      if (!u.done) return;
      this.queue.shift();
      // After the line's last audio, so the helper knows the audio that
      // follows is the next line's.
      this.o.onSpeech?.({ id: u.id, done: true });
      if (!this.queue.length) {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (!this.queue.length) this.o.onIdle();
        }, Math.max(0, this.playUntil - Date.now()));
        this.idleTimer.unref?.();
      }
    }
  }
}

// Sonic's {words|phonemes, start, end}, only those fields, as plain lists.
function stamps<K extends "words" | "phonemes">(ts: any, key: K) {
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return { [key]: list(ts[key]).map(String), start: list(ts.start).map(Number), end: list(ts.end).map(Number) } as Record<K, string[]> & { start: number[]; end: number[] };
}

type Stt = { open(): void; sendAudio(b: ArrayBuffer): void; finish(): void; abort(): void };
type SttCtor = new (o: { getToken: () => Promise<string>; sampleRate: number; handlers: Record<string, (...a: any[]) => void>; log: (l: string) => void }) => Stt;

export type DesktopVoiceOptions = {
  voice: boolean;
  getToken?: () => Promise<string>;
  log?: (line: string) => void;
  Stt?: SttCtor;
  speaker?: (o: ConstructorParameters<typeof SonicSpeaker>[0]) => Pick<SonicSpeaker, "speak" | "stop" | "close" | "speaking">;
};

type Bridge = Pick<DesktopBridge, "on" | "overlay" | "sendAudio" | "audioStop" | "connected"> & Partial<Pick<DesktopBridge, "helperInfo">>;

export class DesktopVoice {
  private peer: HubPeer | null = null;
  private stt: Stt | null = null;
  private listening = false;
  private latched = false;
  // After a barge-in: replies from the interrupted turn are not spoken.
  private muted = false;
  private speaker: Pick<SonicSpeaker, "speak" | "stop" | "close" | "speaking"> | null = null;
  private log: (l: string) => void;
  private getToken: () => Promise<string>;

  constructor(private bridge: Bridge, private hub: { join(send: (m: HubMessage) => void): HubPeer }, private o: DesktopVoiceOptions) {
    this.log = o.log ?? ((l) => console.log(l));
    this.getToken = o.getToken ?? serverTokenSource();
    if (o.voice) {
      const make = o.speaker ?? ((so) => new SonicSpeaker(so));
      this.speaker = make({
        getToken: this.getToken,
        onAudio: (pcm) => this.bridge.sendAudio(pcm),
        onIdle: () => this.bridge.overlay({ state: "idle" }),
        onSpeech: (s) => {
          if (this.karaoke()) this.bridge.overlay({ speech: s });
        },
        log: this.log,
      });
    }
  }

  // The helper shows Sonic's lines word by word (hello feature overlay2).
  private karaoke(): boolean {
    return this.bridge.helperInfo?.()?.features.includes("overlay2") ?? false;
  }

  start() {
    this.bridge.on("disconnect", () => {
      this.stt?.abort();
      this.stt = null;
      this.listening = this.latched = false;
      this.speaker?.stop();
      const p = this.peer;
      this.peer = null;
      p?.leave();
    });
    this.bridge.on("ptt_down", () => this.down());
    this.bridge.on("ptt_up", () => this.up());
    this.bridge.on("latch_toggle", () => {
      if (this.latched) {
        this.latched = false;
        this.up();
      } else {
        this.down();
        this.latched = this.listening;
      }
    });
    this.bridge.on("audio", (pcm) => {
      if (this.listening && this.stt) this.stt.sendAudio(s16ToF32(pcm));
    });
    return this;
  }

  private down() {
    if (!this.bridge.connected()) return;
    // Joined on the first press, not at helper launch, so an idle helper
    // never keeps a session running.
    this.peer ??= this.hub.join((m) => this.onHub(m));
    // Voice off: nothing to hear or cut, so the session stays where it is.
    if (!this.o.voice) {
      this.bridge.overlay({ state: "idle", subtitle: VOICE_OFF_TEXT });
      return;
    }
    // Barge-in: silence now (the helper may still be playing what was
    // sent), and the agent drops the rest of its turn.
    this.speaker?.stop();
    this.bridge.audioStop();
    this.muted = true;
    this.peer.interrupt();
    if (this.listening) return;
    this.listening = true;
    const heard: string[] = [];
    const Ctor = this.o.Stt ?? (SttSession as SttCtor);
    const s: Stt = new Ctor({
      getToken: this.getToken,
      sampleRate: MIC_RATE,
      log: this.log,
      handlers: {
        onTurnStart: () => {},
        onPartial: (t: string) => this.bridge.overlay({ state: "listening", subtitle: [...heard, t].join(" ") }),
        onFinal: (t: string) => heard.push(t),
        onError: () => this.log("desktop: speech recognition error"),
        onClosed: () => {
          if (this.stt === s) {
            this.stt = null;
            this.listening = this.latched = false;
          }
          this.send(heard.join(" ").trim());
        },
      },
    });
    this.stt = s;
    this.bridge.overlay({ state: "listening" });
    s.open();
  }

  private up() {
    if (!this.listening || !this.stt) return;
    this.listening = false;
    this.bridge.overlay({ state: "thinking" });
    this.stt.finish();
  }

  private send(text: string) {
    // The press is over: later lines are this turn's or new, so heard again.
    this.muted = false;
    if (!text || !this.peer) {
      if (!this.listening) this.bridge.overlay({ state: "idle" });
      return;
    }
    this.bridge.overlay({ state: "thinking", subtitle: text });
    this.peer.userText(text);
  }

  // What the session sends this window (it owns the session).
  private onHub(m: HubMessage) {
    if (m.type === "agent_text") {
      if (this.muted || !m.text) return;
      if (this.speaker) {
        // overlay2: the caption comes with the audio, from onSpeech.
        this.bridge.overlay(this.karaoke() ? { state: "speaking" } : { state: "speaking", subtitle: m.text });
        void this.speaker.speak(m.text);
      } else this.bridge.overlay({ state: "idle", subtitle: m.text });
    } else if (m.type === "standby") {
      // Another Orbi window took the conversation.
      this.speaker?.stop();
      this.bridge.audioStop();
      this.bridge.overlay({ state: "idle", subtitle: m.text });
    }
  }

  close() {
    this.stt?.abort();
    this.speaker?.close();
  }
}
