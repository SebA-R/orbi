// Microphone capture, ported from voice/public/js/mic.js. Once started it keeps
// running; audio goes to whatever `sink` is set, as 100 ms ArrayBuffers of
// pcm_f32le at ctx.sampleRate (Cartesia asks for ~100 ms chunks).
const WORKLET_URL = new URL("./pcm-capture-worklet.js", import.meta.url).href;

export class Mic {
  constructor(ctx, { getUserMedia } = {}) {
    this.ctx = ctx;
    this.getUserMedia = getUserMedia || ((c) => navigator.mediaDevices.getUserMedia(c));
    this.sink = null;
    this.starting = null;
    this.stream = null;
  }

  start() {
    if (!this.starting) this.starting = this.#start().catch((err) => { this.starting = null; throw err; });
    return this.starting;
  }

  // Release the device so Chrome's "using your microphone" indicator goes away.
  release() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.node) try { this.node.disconnect(); } catch {}
    this.stream = null;
    this.node = null;
    this.starting = null;
  }

  async #start() {
    await this.ctx.audioWorklet.addModule(WORKLET_URL);
    const stream = await this.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const source = this.ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(this.ctx, "pcm-capture");
    const chunkLen = Math.round(this.ctx.sampleRate / 10);
    let buf = new Float32Array(chunkLen);
    let fill = 0;
    node.port.onmessage = (e) => {
      const frame = e.data;
      let i = 0;
      while (i < frame.length) {
        const n = Math.min(chunkLen - fill, frame.length - i);
        buf.set(frame.subarray(i, i + n), fill);
        fill += n;
        i += n;
        if (fill === chunkLen) {
          if (this.sink) this.sink(buf.buffer);
          buf = new Float32Array(chunkLen);
          fill = 0;
        }
      }
    };
    // Keep the worklet pulled by the graph without making any sound.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute).connect(this.ctx.destination);
    this.stream = stream;
    this.node = node;
  }
}
