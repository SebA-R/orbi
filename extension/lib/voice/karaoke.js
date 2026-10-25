// Karaoke captions: which word of an agent line is being heard right now.
//
// Sonic sends word timestamps ({ words, start, end } in seconds of generated
// audio, from the start of the context) alongside the audio chunks. Each
// chunk is played from its own AudioContext time and, above SONIC_MAX_SPEED,
// at a playback rate above 1, so audio second `a` is heard at
//   chunk.at + (a * SR - chunk.offset) / SR / rate
// and the reverse is how indexAt() turns the AudioContext clock into a word.
// Chunks may be scheduled with gaps (a slow network), so the mapping is per
// chunk, never one start time for the whole line.
//
// Word indexes always count the display words: the whitespace-separated
// words of the exact text sent to TTS (captionWords), which is what the
// caption card draws. Sonic's own word list is aligned onto them, so a
// number or a punctuation mark it splits differently can't shift the line.

export function captionWords(text) {
  return String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}

const norm = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");

// For each timestamp word, the index of the display word it falls in.
// Monotonic: matched left to right in the letters and digits of the line; a
// word that isn't found stays on the next display word not yet passed.
export function alignWords(display, spoken) {
  let stream = "";
  const owner = [];
  display.forEach((w, i) => {
    const n = norm(w);
    stream += n;
    for (let k = 0; k < n.length; k++) owner.push(i);
  });
  const map = [];
  let cursor = 0;
  let prev = 0;
  for (const w of spoken) {
    const n = norm(w);
    if (!n) { // punctuation on its own: stays on the word before it
      map.push(Math.min(prev, Math.max(0, display.length - 1)));
      continue;
    }
    const pos = stream.indexOf(n, cursor);
    if (pos >= 0 && pos - cursor <= 48) {
      prev = owner[pos];
      cursor = pos + n.length;
    } else if (owner.length) {
      prev = Math.max(prev, owner[Math.min(cursor, owner.length - 1)]);
    }
    map.push(Math.min(prev, Math.max(0, display.length - 1)));
  }
  return map;
}

export class WordClock {
  constructor({ text, sampleRate }) {
    this.words = captionWords(text);
    this.sampleRate = sampleRate;
    this.chunks = []; // { offset (samples into the line), length, at (ctx time), rate }
    this.samples = 0;
    this.starts = []; // audio seconds when each timestamp word starts
    this.ends = []; // and ends
    this.targets = []; // display index for each timestamp word
    this.spoken = [];
  }

  get timed() { return this.starts.length > 0; }

  addChunk(length, at, rate) {
    this.chunks.push({ offset: this.samples, length, at, rate });
    this.samples += length;
  }

  // Sonic may send several timestamp messages per line, each with the next words.
  addTimestamps(ts) {
    if (!ts || !Array.isArray(ts.words) || !Array.isArray(ts.start)) return;
    const n = Math.min(ts.words.length, ts.start.length);
    for (let i = 0; i < n; i++) {
      const s = Number(ts.start[i]);
      if (!Number.isFinite(s)) continue;
      const e = Number(ts.end && ts.end[i]);
      this.spoken.push(String(ts.words[i]));
      this.starts.push(s);
      this.ends.push(Number.isFinite(e) && e > s ? e : s);
    }
    this.targets = alignWords(this.words, this.spoken);
  }

  get firstAt() { return this.chunks.length ? this.chunks[0].at : Infinity; }

  get endAt() {
    const c = this.chunks.at(-1);
    return c ? c.at + c.length / this.sampleRate / c.rate : Infinity;
  }

  // Seconds of generated audio heard by AudioContext time t (-1 before it starts).
  audioTimeAt(t) {
    let heard = -1;
    for (const c of this.chunks) {
      if (t < c.at) break;
      const played = Math.min(c.length, (t - c.at) * this.sampleRate * c.rate);
      heard = (c.offset + played) / this.sampleRate;
    }
    return heard;
  }

  // AudioContext time when audio second `a` is heard (Infinity if not scheduled yet).
  ctxTimeOf(a) {
    const s = a * this.sampleRate;
    for (let k = this.chunks.length - 1; k >= 0; k--) {
      const c = this.chunks[k];
      if (s >= c.offset) return c.at + Math.min(s - c.offset, c.length) / this.sampleRate / c.rate;
    }
    return Infinity;
  }

  // When display word d is heard, in AudioContext time: from the start of its
  // first timestamp word to the end of its last one (Sonic may split it).
  spanOf(d) {
    let a = Infinity;
    let b = -Infinity;
    this.targets.forEach((t, i) => {
      if (t !== d) return;
      a = Math.min(a, this.starts[i]);
      b = Math.max(b, this.ends[i]);
    });
    if (a === Infinity) return null;
    const start = this.ctxTimeOf(a);
    return { start, end: Math.max(start, this.ctxTimeOf(b)) };
  }

  // The display word being heard at AudioContext time t: -1 before the first
  // word starts; the last word to start holds through any pause after it.
  indexAt(t) {
    const a = this.audioTimeAt(t);
    if (a < 0) return -1;
    let i = -1;
    while (i + 1 < this.starts.length && this.starts[i + 1] <= a + 1e-6) i++;
    return i < 0 ? -1 : this.targets[i];
  }
}
