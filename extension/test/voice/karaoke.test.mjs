// Karaoke captions: the Speaker maps Sonic's word timestamps onto the
// AudioContext clock. A fake AudioContext clock, a fake Sonic socket and a
// fake timestamp stream; no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { RT } from "../../lib/protocol.js";
import { Speaker, NO_TIMESTAMPS_AFTER_S } from "../../lib/voice/tts.js";
import { alignWords, captionWords, WordClock } from "../../lib/voice/karaoke.js";
import { VoiceController } from "../../lib/voice/controller.js";
import { TTS_SAMPLE_RATE, SONIC_MAX_SPEED } from "../../lib/voice/config.js";

const SR = TTS_SAMPLE_RATE;

class FakeSocket {
  static OPEN = 1;
  static last = null;
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.sent = [];
    FakeSocket.last = this;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {}
  // Sonic sends this to us.
  push(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
globalThis.WebSocket = FakeSocket;

function fakeCtx(start = 10) {
  const ctx = {
    currentTime: start,
    destination: {},
    createGain: () => ({ gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }),
    createBuffer: (_ch, length, rate) => ({ length, duration: length / rate, copyToChannel() {} }),
    createBufferSource: () => ({ playbackRate: { value: 1 }, connect() {}, start(t) { this.at = t; }, stop() {} }),
  };
  return ctx;
}

// `seconds` of silent pcm_f32le as Sonic's base64 chunk.
const chunk = (seconds) => Buffer.alloc(Math.round(seconds * SR) * 4).toString("base64");

function rig({ speed = 1 } = {}) {
  const ctx = fakeCtx();
  const captions = [];
  let ticker = null;
  const sp = new Speaker({
    ctx, getToken: async () => "t", getSpeed: () => speed, voiceId: "v", log: () => {},
    onCaption: (c) => captions.push(c),
    setInterval: (fn) => { ticker = fn; return 1; },
    clearInterval: () => { ticker = null; },
  });
  const at = (t) => { ctx.currentTime = t; sp.tick(); };
  const words = () => captions.filter((c) => c.kind === "word");
  return { ctx, sp, captions, at, words, get ticking() { return ticker != null; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function speakLine(r, text) {
  await r.sp.speak(text);
  await flush();
  const ws = FakeSocket.last;
  return { ws, id: ws.sent.at(-1).context_id };
}

const TEXT = "Found it, nine dollars.";
const TS = { words: ["Found", "it,", "nine", "dollars."], start: [0, 0.3, 0.5, 0.8], end: [0.25, 0.45, 0.75, 1.0] };

test("captionWords and alignWords map Sonic's words onto the caption's words", () => {
  assert.deepEqual(captionWords("  Found  it,\nnine "), ["Found", "it,", "nine"]);
  const display = captionWords("It's $4.99 for 30 count, okay?");
  // Sonic may split or drop punctuation differently; indexes stay on the display words.
  assert.deepEqual(alignWords(display, ["It's", "$4.99", "for", "30", "count,", "okay?"]), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(alignWords(display, ["it", "s", "4", "99", "for", "thirty", "count", "okay"]), [0, 0, 1, 1, 2, 3, 4, 5]);
  // Punctuation sent as its own word stays on the word before it.
  assert.deepEqual(alignWords(captionWords("Okay, adding it"), ["Okay", ",", "adding", "it"]), [0, 0, 1, 2]);
});

test("the request asks Sonic for word timestamps in the words as written", async () => {
  const r = rig();
  const { ws } = await speakLine(r, TEXT);
  const req = ws.sent.at(-1);
  assert.equal(req.add_timestamps, true);
  assert.equal(req.use_normalized_timestamps, false);
  assert.equal(req.transcript, TEXT);
});

test("the line shows when its audio starts and the index advances with playback time", async () => {
  const r = rig();
  const { ws, id } = await speakLine(r, TEXT);
  ws.push({ type: "chunk", context_id: id, data: chunk(1) }); // scheduled at 10.05
  ws.push({ type: "timestamps", context_id: id, word_timestamps: TS });
  ws.push({ type: "done", context_id: id, done: true });
  r.at(10.0);
  assert.deepEqual(r.captions, [], "nothing before the audio is heard");
  r.at(10.06);
  assert.deepEqual(r.captions[0], { kind: "line", utteranceId: id, text: TEXT, karaoke: true });
  assert.deepEqual(r.words().map((w) => w.index), [0]);
  r.at(10.2); // still "Found"
  r.at(10.4);
  r.at(10.6);
  r.at(10.9);
  assert.deepEqual(r.words().map((w) => w.index), [0, 1, 2, 3], "one message per word, in order");
  assert.ok(r.ticking);
  r.at(11.06);
  assert.deepEqual(r.words().at(-1), { kind: "word", utteranceId: id, index: 4, done: true });
  assert.equal(r.ticking, false, "the clock stops once every line is heard");
});

test("a playback rate above Sonic's max speed is accounted for", async () => {
  const r = rig({ speed: 2 });
  const { ws, id } = await speakLine(r, TEXT);
  const rate = 2 / SONIC_MAX_SPEED;
  assert.equal(ws.sent.at(-1).generation_config.speed, SONIC_MAX_SPEED);
  ws.push({ type: "chunk", context_id: id, data: chunk(1) });
  ws.push({ type: "timestamps", context_id: id, word_timestamps: TS });
  // "dollars." starts 0.8 s into the audio, heard 0.8 / rate = 0.6 s after 10.05.
  r.at(10.05 + 0.8 / rate - 0.01);
  assert.equal(r.words().at(-1).index, 2);
  r.at(10.05 + 0.8 / rate + 0.01);
  assert.equal(r.words().at(-1).index, 3, "at rate 1 this would still be word 2");
});

test("a gap between chunks (slow network) shifts only the words after it", () => {
  const c = new WordClock({ text: "one two three", sampleRate: SR });
  c.addChunk(SR * 0.5, 10, 1); // 0 to 0.5 s of audio, heard 10 to 10.5
  c.addChunk(SR * 0.5, 11, 1); // 0.5 to 1 s, heard late, 11 to 11.5
  c.addTimestamps({ words: ["one", "two", "three"], start: [0, 0.4, 0.6] });
  assert.equal(c.indexAt(9.9), -1);
  assert.equal(c.indexAt(10.45), 1);
  assert.equal(c.indexAt(10.9), 1, "silence in the gap holds the last word");
  assert.equal(c.indexAt(11.05), 1);
  assert.equal(c.indexAt(11.15), 2);
});

test("timestamps that arrive in several messages extend the line", () => {
  const c = new WordClock({ text: TEXT, sampleRate: SR });
  c.addChunk(SR, 0, 1);
  c.addTimestamps({ words: ["Found", "it,"], start: [0, 0.3], end: [0.25, 0.45] });
  assert.equal(c.indexAt(0.9), 1);
  c.addTimestamps({ words: ["nine", "dollars."], start: [0.5, 0.8], end: [0.75, 1] });
  assert.equal(c.indexAt(0.9), 3);
});

test("stop() freezes the highlight on the word being heard and stops advancing", async () => {
  const r = rig();
  const { ws, id } = await speakLine(r, TEXT);
  ws.push({ type: "chunk", context_id: id, data: chunk(1) });
  ws.push({ type: "timestamps", context_id: id, word_timestamps: TS });
  r.at(10.4);
  r.sp.stop(); // barge-in, double-tap, TTS_STOP and standby all end here
  // "it," runs 0.3 to 0.45 s of audio: 150 ms, 50 ms of it heard at 10.4.
  assert.deepEqual(r.words().at(-1), { kind: "word", utteranceId: id, index: 1, ms: 150, elapsed: 50, frozen: true });
  const n = r.captions.length;
  r.at(10.9);
  ws.push({ type: "timestamps", context_id: id, word_timestamps: TS }); // late, from the cancelled context
  r.at(11.5);
  assert.equal(r.captions.length, n, "nothing after the freeze");
  assert.equal(r.ticking, false);
});

test("without timestamps the line falls back to the plain caption", async () => {
  const r = rig();
  const { ws, id } = await speakLine(r, TEXT);
  ws.push({ type: "chunk", context_id: id, data: chunk(2) });
  r.at(10.1);
  assert.equal(r.captions[0].kind, "line");
  assert.equal(r.words().length, 0, "waits a moment for timestamps");
  r.at(10.05 + NO_TIMESTAMPS_AFTER_S + 0.01);
  assert.deepEqual(r.words(), [{ kind: "word", utteranceId: id, fallback: true }]);
  r.at(13);
  assert.equal(r.words().length, 1, "no done for a plain line");
});

test("a line whose TTS failed is still shown, plainly", async () => {
  const r = rig();
  const { ws, id } = await speakLine(r, TEXT);
  ws.push({ type: "error", context_id: id, message: "boom" });
  r.at(10.1);
  assert.deepEqual(r.captions, [{ kind: "line", utteranceId: id, text: TEXT, karaoke: false }]);
});

test("the next line waits until the one before has been heard", async () => {
  const r = rig();
  const a = await speakLine(r, "First line.");
  const b = await speakLine(r, "Second line.");
  a.ws.push({ type: "chunk", context_id: a.id, data: chunk(0.5) });
  a.ws.push({ type: "timestamps", context_id: a.id, word_timestamps: { words: ["First", "line."], start: [0, 0.2], end: [0.2, 0.5] } });
  a.ws.push({ type: "done", context_id: a.id, done: true });
  b.ws.push({ type: "chunk", context_id: b.id, data: chunk(0.5) });
  b.ws.push({ type: "timestamps", context_id: b.id, word_timestamps: { words: ["Second", "line."], start: [0, 0.2], end: [0.2, 0.5] } });
  b.ws.push({ type: "done", context_id: b.id, done: true });
  r.at(10.3);
  assert.deepEqual(r.captions.filter((c) => c.kind === "line").map((c) => c.text), ["First line."]);
  r.at(10.6);
  assert.deepEqual(r.captions.filter((c) => c.kind === "line").map((c) => c.text), ["First line.", "Second line."]);
  assert.deepEqual(r.words().map((w) => [w.utteranceId === a.id ? "a" : "b", w.index, !!w.done]),
    [["a", 1, false], ["a", 2, true], ["b", 0, false]]);
});

test("the controller turns captions into SUBTITLE and SUBTITLE_WORD, and leaves agent_text to the speaker", () => {
  const emitted = [];
  const spoken = [];
  const c = new VoiceController({
    createStt: () => ({}), mic: {}, chime: () => {}, agent: { send() {} },
    speaker: { captions: true, speak: (t) => spoken.push(t), stop() {} },
    emit: (m) => emitted.push(m),
  });
  c.onAgentMessage({ type: "agent_text", text: TEXT });
  assert.deepEqual(spoken, [TEXT]);
  assert.equal(emitted.filter((m) => m.type === RT.SUBTITLE).length, 0, "not before it is heard");
  c.onCaption({ kind: "line", utteranceId: "u1", text: TEXT, karaoke: true });
  c.onCaption({ kind: "word", utteranceId: "u1", index: 2 });
  c.onCaption({ kind: "word", utteranceId: "u1", index: 2, frozen: true });
  assert.deepEqual(emitted, [
    { type: RT.SUBTITLE, speaker: "agent", text: TEXT, final: true, utteranceId: "u1", karaoke: true },
    { type: RT.SUBTITLE_WORD, utteranceId: "u1", index: 2 },
    { type: RT.SUBTITLE_WORD, utteranceId: "u1", index: 2, frozen: true },
  ]);
});

test("each word carries how long it lasts and how much has been heard, for the sweep", async () => {
  const r = rig({ speed: 2 });
  const { ws, id } = await speakLine(r, TEXT);
  ws.push({ type: "chunk", context_id: id, data: chunk(1) });
  ws.push({ type: "timestamps", context_id: id, word_timestamps: TS });
  const rate = 2 / SONIC_MAX_SPEED;
  // "nine" is 0.5 to 0.75 s of audio: 250 ms at rate 1, 187.5 ms here.
  r.at(10.05 + 0.55 / rate);
  const w = r.words().at(-1);
  assert.equal(w.index, 2);
  assert.equal(w.ms, Math.round(250 / rate));
  assert.ok(Math.abs(w.elapsed - 50 / rate) <= 1, `elapsed ${w.elapsed}`);
});

test("output latency is taken off the clock, so the highlight never runs ahead of the sound", async () => {
  const r = rig();
  r.ctx.baseLatency = 0.01;
  r.ctx.outputLatency = 0.2; // Bluetooth headphones
  const { ws, id } = await speakLine(r, TEXT);
  ws.push({ type: "chunk", context_id: id, data: chunk(1) });
  ws.push({ type: "timestamps", context_id: id, word_timestamps: TS });
  r.at(10.2);
  assert.deepEqual(r.captions, [], "the first sample is not audible until 10.26");
  r.at(10.05 + 0.21 + 0.31);
  assert.equal(r.words().at(-1).index, 1);
});

test("a stop just after the last word was heard reports done, not frozen", async () => {
  const r = rig();
  const { ws, id } = await speakLine(r, TEXT);
  ws.push({ type: "chunk", context_id: id, data: chunk(1) });
  ws.push({ type: "timestamps", context_id: id, word_timestamps: TS });
  ws.push({ type: "done", context_id: id, done: true });
  r.at(10.9);
  r.ctx.currentTime = 11.07; // past the end, before the next tick
  r.sp.stop();
  assert.equal(r.words().at(-1).done, true);
  assert.ok(!r.words().some((w) => w.frozen));
});
