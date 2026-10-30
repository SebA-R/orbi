// Collects mono Float32 mic frames (128 samples each) into 100 ms chunks and
// hands each full chunk to the main thread, transferred rather than copied.
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkLen = Math.round(sampleRate / 10);
    this.buf = new Float32Array(this.chunkLen);
    this.fill = 0;
  }

  process(inputs) {
    const frame = inputs[0] && inputs[0][0];
    if (!frame) return true;
    let i = 0;
    while (i < frame.length) {
      const n = Math.min(this.chunkLen - this.fill, frame.length - i);
      this.buf.set(frame.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.chunkLen) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Float32Array(this.chunkLen);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);
