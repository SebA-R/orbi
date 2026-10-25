import {
  CARTESIA_VERSION, TTS_URL, TTS_MODEL, TTS_OUTPUT_FORMAT, TTS_SAMPLE_RATE, SONIC_MAX_SPEED,
} from './config.js';

// Speaks text with Sonic over one shared TTS websocket. Each utterance is its own context;
// requests go out immediately, audio plays strictly in order, and stop() cuts everything (barge-in).
// duck() fades our speech to near silence while the talk key is touched (20 ms: fast
// enough to be gone at once, slow enough not to click); unduck() brings it back over 80 ms.
export const DUCK_LEVEL = 0.03;
export const DUCK_SECONDS = 0.02;
export const UNDUCK_SECONDS = 0.08;

export class Speaker {
  constructor({ ctx, getToken, getSpeed, voiceId, log, onSpeakingChange }) {
    this.ctx = ctx;
    this.getToken = getToken;
    this.getSpeed = getSpeed;
    this.voiceId = voiceId;
    this.log = log;
    this.onSpeakingChange = onSpeakingChange || (() => {});
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
    };
    this.queue.push(utt);
    this.byId.set(utt.id, utt);
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

  #rampTo(level, seconds) {
    const g = this.out.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(level, now + seconds);
  }

  duck() { this.#rampTo(DUCK_LEVEL, DUCK_SECONDS); }

  unduck() { this.#rampTo(1, UNDUCK_SECONDS); }

  // Barge-in: silence now, cancel anything still generating.
  stop() {
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
      for (const samples of head.pending) this.#schedule(samples, head.rate);
      head.pending = [];
      if (!head.done) break;
      this.queue.shift();
      this.byId.delete(head.id);
    }
    this.#checkIdle();
  }

  #schedule(samples, rate) {
    const buf = this.ctx.createBuffer(1, samples.length, TTS_SAMPLE_RATE);
    buf.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(this.out);
    const start = Math.max(this.playHead, this.ctx.currentTime + 0.05);
    src.start(start);
    this.playHead = start + buf.duration / rate;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      this.#checkIdle();
    };
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
