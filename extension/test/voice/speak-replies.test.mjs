// The Speak replies setting: off, no speech is requested from Sonic, the
// reply shows whole in the subtitles and the state never says speaking.
// A real Speaker and VoiceController, wired as offscreen.js wires them, with
// a fake Sonic socket, AudioContext, STT and mic. No network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { RT } from "../../lib/protocol.js";
import { Speaker } from "../../lib/voice/tts.js";
import { VoiceController } from "../../lib/voice/controller.js";
import { TTS_SAMPLE_RATE } from "../../lib/voice/config.js";

class FakeSocket {
  static OPEN = 1;
  static all = [];
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.sent = [];
    FakeSocket.all.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {}
  push(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
globalThis.WebSocket = FakeSocket;

const chunk = (seconds) => Buffer.alloc(Math.round(seconds * TTS_SAMPLE_RATE) * 4).toString("base64");
const flush = () => new Promise((r) => setTimeout(r, 0));
const TEXT = "Found it, nine dollars.";
const TS = { words: ["Found", "it,", "nine", "dollars."], start: [0, 0.3, 0.5, 0.8], end: [0.25, 0.45, 0.75, 1.0] };

function rig({ speak = true } = {}) {
  FakeSocket.all = [];
  const settings = { speakReplies: speak };
  const ctx = {
    currentTime: 10,
    destination: {},
    createGain: () => ({ gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }),
    createBuffer: (_ch, length, rate) => ({ length, duration: length / rate, copyToChannel() {} }),
    createBufferSource: () => ({ playbackRate: { value: 1 }, connect() {}, start() {}, stop() {} }),
  };
  const emitted = [];
  const chimes = [];
  const sent = [];
  let tokens = 0;
  let stt = null;
  let c;
  const speaker = new Speaker({
    ctx, getToken: async () => { tokens++; return "t"; }, getSpeed: () => 1, voiceId: "v", log: () => {},
    onSpeakingChange: (on) => c.onSpeakingChange(on),
    onCaption: (cap) => c.onCaption(cap),
    setInterval: () => 1, clearInterval: () => {},
  });
  c = new VoiceController({
    createStt: (h) => (stt = { h, open() {}, sendAudio() {}, finish() {}, abort() {} }),
    speaker,
    mic: { sink: null, async start() {} },
    chime: (k) => chimes.push(k),
    agent: { send: (m) => sent.push(m) },
    emit: (m) => emitted.push(m),
    setTimer: (fn) => { fn(); return 1; },
    clearTimer: () => {},
    speakReplies: () => settings.speakReplies !== false,
  });
  // offscreen.js applySettings: turning it off mid-reply releases the speech.
  const set = (on) => {
    const prev = settings.speakReplies;
    settings.speakReplies = on;
    if (prev && !on) c.releaseSpeech();
  };
  const states = () => emitted.filter((m) => m.type === RT.VOICE_STATE).map((m) => m.state);
  const subs = () => emitted.filter((m) => m.type === RT.SUBTITLE && m.speaker === "agent");
  const transcripts = () => FakeSocket.all.flatMap((ws) => ws.sent.filter((m) => m.transcript != null));
  const at = (t) => { ctx.currentTime = t; speaker.tick(); };
  return { c, speaker, emitted, chimes, sent, set, states, subs, transcripts, at, get tokens() { return tokens; }, get stt() { return stt; } };
}

// Hold, say something, let go: the user's turn goes out.
async function ask(r, text) {
  await r.c.start();
  r.c.stop();
  r.stt.h.onFinal(text);
}

test("speak off: no TTS is requested, no Sonic socket, no speech token", async () => {
  const r = rig({ speak: false });
  await ask(r, "cheapest allergy pills");
  r.c.onAgentMessage({ type: "agent_text", text: TEXT });
  await flush();
  assert.equal(FakeSocket.all.length, 0, "no Sonic socket is opened");
  assert.deepEqual(r.transcripts(), []);
  assert.equal(r.tokens, 0, "the speaker never asks for a token");
  assert.equal(r.speaker.speaking, false);
});

test("speak off: the reply shows whole at once, with no karaoke, so subtitles.js times its reading", async () => {
  const r = rig({ speak: false });
  await ask(r, "cheapest allergy pills");
  r.c.onAgentMessage({ type: "agent_text", text: TEXT });
  r.c.onAgentMessage({ type: "agent_text", text: "Want me to add it?" });
  assert.deepEqual(r.subs(), [
    { type: RT.SUBTITLE, speaker: "agent", text: TEXT, final: true },
    { type: RT.SUBTITLE, speaker: "agent", text: "Want me to add it?", final: true },
  ]);
  assert.equal(r.emitted.filter((m) => m.type === RT.SUBTITLE_WORD).length, 0);
});

test("speak off: the state goes listening, thinking, idle and never sticks in speaking", async () => {
  const r = rig({ speak: false });
  await ask(r, "cheapest allergy pills");
  assert.equal(r.c.state, "thinking");
  r.c.onAgentMessage({ type: "agent_text", text: TEXT });
  assert.equal(r.c.state, "idle");
  assert.ok(!r.states().includes("speaking"));
  assert.deepEqual(r.states().filter((s) => s !== "idle"), ["listening", "thinking"]);
  // Earcons are untouched (Sounds decides those).
  assert.deepEqual(r.chimes, ["listen", "sent"]);
});

test("speak off: barge-in and double-tap still behave, with nothing to stop", async () => {
  const r = rig({ speak: false });
  await ask(r, "eggs");
  r.c.stop(); // already sent: a no-op
  await r.c.start(); // talking again while thinking interrupts the turn
  assert.ok(r.sent.some((m) => m.type === "interrupt"));
  assert.ok(r.chimes.includes("cut"));
  r.c.stop();
  r.stt.h.onClosed();
  r.c.onAgentMessage({ type: "agent_text", text: "late, from the interrupted turn" });
  assert.equal(r.subs().length, 0, "dropped like any interrupted reply");
  await r.c.start({ silent: true });
  assert.equal(r.c.hush(), false, "nothing speaking: hush stops nothing");
  assert.equal(r.c.state, "idle");
  assert.ok(!r.states().includes("speaking"));
  assert.equal(FakeSocket.all.length, 0);
});

test("turned off mid-reply: the speech stops, the line stays in full, the turn goes on", async () => {
  const r = rig();
  await ask(r, "cheapest allergy pills");
  await r.speaker.speak(TEXT); // what agent_text does with speech on
  await flush();
  r.c.onAgentMessage({ type: "agent_text", text: "And a second line." });
  await flush();
  const ws = FakeSocket.all[0];
  const [a, b] = ws.sent.map((m) => m.context_id);
  ws.push({ type: "chunk", context_id: a, data: chunk(1) });
  ws.push({ type: "timestamps", context_id: a, word_timestamps: TS });
  r.at(10.4);
  assert.equal(r.c.state, "speaking");
  const sentBefore = r.sent.length;
  r.set(false);
  assert.equal(r.c.state, "idle", "not stuck in speaking");
  assert.equal(r.speaker.speaking, false);
  assert.deepEqual(ws.sent.filter((m) => m.cancel).map((m) => m.context_id), [a, b], "Sonic stops generating");
  assert.equal(r.sent.length, sentBefore, "no interrupt: the agent's turn goes on");
  assert.ok(!r.chimes.includes("cut"), "not a barge-in");
  // Nothing frozen mid-word: the line being heard and the one still to come show whole.
  const words = r.emitted.filter((m) => m.type === RT.SUBTITLE_WORD);
  assert.ok(!words.some((w) => w.frozen));
  assert.deepEqual(r.subs().at(-1), { type: RT.SUBTITLE, speaker: "agent", text: `${TEXT} And a second line.`, final: true, utteranceId: b, karaoke: false });
  // The next reply is read, not heard.
  const n = r.transcripts().length;
  r.c.onAgentMessage({ type: "agent_text", text: "Added." });
  await flush();
  assert.equal(r.transcripts().length, n);
  assert.deepEqual(r.subs().at(-1), { type: RT.SUBTITLE, speaker: "agent", text: "Added.", final: true });
});

test("turned off while one shown line plays: its karaoke drops to the plain line", async () => {
  const r = rig();
  await r.speaker.speak(TEXT);
  await flush();
  const ws = FakeSocket.all[0];
  const id = ws.sent[0].context_id;
  ws.push({ type: "chunk", context_id: id, data: chunk(1) });
  ws.push({ type: "timestamps", context_id: id, word_timestamps: TS });
  ws.push({ type: "done", context_id: id, done: true });
  r.at(10.4);
  r.set(false);
  assert.deepEqual(r.emitted.filter((m) => m.type === RT.SUBTITLE_WORD).at(-1), { type: RT.SUBTITLE_WORD, utteranceId: id, fallback: true });
  assert.equal(r.c.state, "idle");
});

test("turned back on: the next reply is spoken", async () => {
  const r = rig({ speak: false });
  await ask(r, "eggs");
  r.c.onAgentMessage({ type: "agent_text", text: "Read only." });
  r.set(true);
  await ask(r, "and milk");
  r.c.onAgentMessage({ type: "agent_text", text: "Spoken now." });
  await flush();
  assert.deepEqual(r.transcripts().map((m) => m.transcript), ["Spoken now."]);
  assert.equal(r.c.state, "speaking");
});
