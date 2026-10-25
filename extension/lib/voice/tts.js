import {
  CARTESIA_VERSION, TTS_URL, TTS_MODEL, TTS_OUTPUT_FORMAT, TTS_SAMPLE_RATE, SONIC_MAX_SPEED,
} from './config.js';
import { WordClock } from './karaoke.js';

// Speaks text with Sonic over one shared TTS websocket. Each utterance is its own context;
// requests go out immediately, audio plays strictly in order, and stop() cuts everything (barge-in).
// duck() fades our speech to near silence while the talk key is touched; unduck() brings it back.
//
// Captions follow the audio, not the text: onCaption gets
//   { kind: "line", utteranceId, text, karaoke }   when a line starts to be heard
//   { kind: "word", utteranceId, index, ms, elapsed } each time the heard word changes:
//                                                    the word lasts ms, elapsed of it already heard
//   { kind: "word", utteranceId, index, done }      the whole line has been heard
//   { kind: "word", utteranceId, index, ms, elapsed, frozen }  stop() cut it off there
//   { kind: "word", utteranceId, fallback }         Sonic sent no timestamps: show it plainly
// using the word timestamps Sonic sends (add_timestamps) mapped onto the
// AudioContext clock (karaoke.js). A line that produced no audio is still
// shown, plainly, once the lines before it have been heard.
export const DUCK_LEVEL = 0.03;
export const DUCK_SECONDS = 0.08;
export const CAPTION_TICK_MS = 40;
// A line playing this long without any timestamps is shown plainly.
export const NO_TIMESTAMPS_AFTER_S = 1;

export class Speaker {
  constructor({
    ctx, getToken, getSpeed, voiceId, log, onSpeakingChange, onCaption,
    setInterval: every = (fn, ms) => setInterval(fn, ms), clearInterval: unevery = (t) => clearInterval(t),
  }) {
    this.ctx = ctx;
    this.getToken = getToken;
    this.getSpeed = getSpeed;
    this.voiceId = voiceId;
    this.log = log;
    this.onSpeakingChange = onSpeakingChange || (() => {});
    this.onCaption = onCaption || (() => {});
    this.captions = true; // the controller leaves agent captions to us
    this.every = every;
    this.unevery = unevery;
    this.ticker = null;
    this.lines = []; // utterances in play order whose caption is still to show or advance
    this.out = this.#newOut();
    this.ws = null;
    this.connecting = null;
    this.queue = []; // utterances in play order
    this.byId = new Map();
    this.sources = new Set();
    this.playHead = 0;
    this.speaking = false;
    this.seq = 0;
  }

  async speak(text) {
    if (!text || !text.trim()) return;
    const speed = this.getSpeed();
    const utt = {
      id: `cc-${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
      pending: [], rem: null, done: false,
      rate: speed > SONIC_MAX_SPEED ? speed / SONIC_MAX_SPEED : 1,
      text, clock: new WordClock({ text, sampleRate: TTS_SAMPLE_RATE }),
      shown: false, index: -1, plain: false,
    };
    this.queue.push(utt);
    this.byId.set(utt.id, utt);
    this.lines.push(utt);
    this.#startTicker();
    this.#setSpeaking(true);
    try {
      const ws = await this.#socket();
      if (!this.byId.has(utt.id)) return; // stopped while connecting
      ws.send(JSON.stringify({
        model_id: TTS_MODEL,
        transcript: text,
        voice: this.voiceId,
        language: 'en',
        context_id: utt.id,
        output_format: TTS_OUTPUT_FORMAT,
        generation_config: { speed: Math.min(speed, SONIC_MAX_SPEED) },
        add_timestamps: true,
        use_normalized_timestamps: false, // the words as written, to match the caption
        continue: false,
      }));
    } catch (err) {
      this.log(`TTS failed: ${err.message}`);
      utt.done = true;
      this.#pump();
    }
  }

  #newOut() {
    const out = this.ctx.createGain();
    out.connect(this.ctx.destination);
    return out;
  }

  #rampTo(level) {
    const g = this.out.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(level, now + DUCK_SECONDS);
  }

  duck() { this.#rampTo(DUCK_LEVEL); }

  unduck() { this.#rampTo(1); }

  // Barge-in: silence now, cancel anything still generating.
  stop() {
    this.#freezeCaption();
    const ws = this.ws;
    for (const utt of this.queue) {
      if (!utt.done && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ context_id: utt.id, cancel: true }));
      }
      this.byId.delete(utt.id);
    }
    this.queue = [];
    for (const s of this.sources) {
      s.onended = null;
      try { s.stop(); } catch {}
    }
    this.sources.clear();
    // Mute and drop the output node too, so nothing already scheduled on the
    // AudioContext can still be heard; later speech gets a fresh one at full level.
    const old = this.out;
    try { old.gain.cancelScheduledValues(0); old.gain.value = 0; old.disconnect(); } catch {}
    this.out = this.#newOut();
    this.playHead = 0;
    this.#setSpeaking(false);
  }

  #socket() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const token = await this.getToken();
      const url = new URL(TTS_URL);
      url.searchParams.set('cartesia_version', CARTESIA_VERSION);
      url.searchParams.set('access_token', token);
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('could not connect to Cartesia TTS'));
      });
      ws.onerror = () => this.log('TTS socket error');
      ws.onmessage = (e) => this.#onMessage(e.data);
      ws.onclose = (e) => {
        if (this.ws === ws) this.ws = null;
        if (e.code !== 1000) this.log(`TTS socket closed (${e.code}${e.reason ? ` ${e.reason}` : ''})`);
        // Anything still generating on this socket is lost; let the queue move on.
        for (const utt of this.queue) utt.done = true;
        this.#pump();
      };
      this.ws = ws;
      return ws;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  #onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const utt = this.byId.get(m.context_id);
    if (!utt) return; // cancelled or unknown
    if (m.type === 'chunk' && m.data) {
      const samples = this.#decode(utt, m.data);
      if (samples) utt.pending.push(samples);
    } else if (m.type === 'timestamps') {
      utt.clock.addTimestamps(m.word_timestamps);
    } else if (m.type === 'error') {
      this.log(`TTS error: ${m.title || ''} ${m.message || m.error || ''}`.trim());
      utt.done = true;
    }
    if (m.done || m.type === 'done') utt.done = true;
    this.#pump();
  }

  // base64 -> Float32 samples, carrying over bytes that split a sample across chunks.
  #decode(utt, b64) {
    const bin = atob(b64);
    const prev = utt.rem ? utt.rem.length : 0;
    const bytes = new Uint8Array(prev + bin.length);
    if (prev) bytes.set(utt.rem, 0);
    for (let i = 0; i < bin.length; i++) bytes[prev + i] = bin.charCodeAt(i);
    const usable = bytes.length - (bytes.length % 4);
    utt.rem = usable < bytes.length ? bytes.slice(usable) : null;
    if (!usable) return null;
    return new Float32Array(bytes.buffer, 0, usable / 4);
  }

  #pump() {
    while (this.queue.length) {
      const head = this.queue[0];
      for (const samples of head.pending) this.#schedule(samples, head);
      head.pending = [];
      if (!head.done) break;
      this.queue.shift();
      this.byId.delete(head.id);
    }
    this.#checkIdle();
  }

  #schedule(samples, utt) {
    const rate = utt.rate;
    const buf = this.ctx.createBuffer(1, samples.length, TTS_SAMPLE_RATE);
    buf.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(this.out);
    const start = Math.max(this.playHead, this.ctx.currentTime + 0.05);
    src.start(start);
    utt.clock.addChunk(samples.length, start, rate);
    this.playHead = start + buf.duration / rate;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      this.#checkIdle();
    };
  }

  // Advances the caption to what is being heard. Lines go strictly in order:
  // the next one shows only after the one before has been heard to the end.
  tick() {
    const now = this.#heardTime();
    while (this.lines.length) {
      const utt = this.lines[0];
      const c = utt.clock;
      if (!c.chunks.length) {
        if (!utt.done) break; // still generating
        // No audio at all (TTS failed): show the words anyway.
        this.#line(utt, false);
        this.lines.shift();
        continue;
      }
      if (now < c.firstAt) break;
      if (!utt.shown) this.#line(utt, true);
      const heardAll = utt.done && !utt.pending.length && !this.byId.has(utt.id) && now >= c.endAt;
      if (!utt.plain) {
        if (!c.timed && (heardAll || utt.done || now - c.firstAt >= NO_TIMESTAMPS_AFTER_S)) {
          utt.plain = true;
          this.onCaption({ kind: 'word', utteranceId: utt.id, fallback: true });
        } else if (c.timed) {
          const i = c.indexAt(now);
          if (i > utt.index) {
            utt.index = i;
            this.onCaption({ kind: 'word', utteranceId: utt.id, index: i, ...this.#timing(utt, now) });
          }
        }
      }
      if (!heardAll) break;
      if (!utt.plain) this.onCaption({ kind: 'word', utteranceId: utt.id, index: c.words.length, done: true });
      this.lines.shift();
    }
    if (!this.lines.length) this.#stopTicker();
  }

  // How long the word being heard lasts and how much of it has been heard,
  // in ms of playback (so the caption's sweep across it keeps pace).
  #timing(utt, now) {
    const span = utt.index >= 0 ? utt.clock.spanOf(utt.index) : null;
    if (!span || !Number.isFinite(span.end)) return {};
    const ms = Math.round((span.end - span.start) * 1000);
    return { ms, elapsed: Math.max(0, Math.min(ms, Math.round((now - span.start) * 1000))) };
  }

  #line(utt, karaoke) {
    utt.shown = true;
    if (!karaoke) utt.plain = true;
    this.onCaption({ kind: 'line', utteranceId: utt.id, text: utt.text, karaoke });
  }

  // AudioContext time of what is reaching the ears now: currentTime is when
  // audio leaves the graph, and the device (Bluetooth most of all) adds more.
  #heardTime() {
    const lag = (Number(this.ctx.baseLatency) || 0) + (Number(this.ctx.outputLatency) || 0);
    return this.ctx.currentTime - lag;
  }

  // stop() mid-line: the highlight stays on the word that was being heard.
  #freezeCaption() {
    if (this.lines.length) this.tick(); // catch up first: a line heard to its end is done, not frozen
    const utt = this.lines[0];
    if (utt && utt.shown && !utt.plain) {
      this.onCaption({ kind: 'word', utteranceId: utt.id, index: utt.index, ...this.#timing(utt, this.#heardTime()), frozen: true });
    }
    this.lines = [];
    this.#stopTicker();
  }

  #startTicker() {
    if (this.ticker == null) this.ticker = this.every(() => this.tick(), CAPTION_TICK_MS);
  }

  #stopTicker() {
    if (this.ticker != null) this.unevery(this.ticker);
    this.ticker = null;
  }

  #checkIdle() {
    if (!this.queue.length && !this.sources.size) this.#setSpeaking(false);
  }

  #setSpeaking(on) {
    if (on === this.speaking) return;
    this.speaking = on;
    this.onSpeakingChange(on);
  }
}
