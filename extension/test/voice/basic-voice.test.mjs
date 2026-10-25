// Basic voice (no Cartesia key): which voice is picked, Chrome's TTS
// speaker and its captions, Chrome's speech recognition as an STT session,
// typed turns, and who may send typed words or drive chrome.tts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { RT } from "../../lib/protocol.js";
import { chooseVoice } from "../../lib/voice/engine.js";
import { basicVoice } from "../../lib/setup.js";
import { BasicSpeaker, NO_WORDS_AFTER_MS } from "../../lib/voice/basic-tts.js";
import { WebSpeechSttSession } from "../../lib/voice/webspeech-stt.js";
import { VoiceController } from "../../lib/voice/controller.js";
import { createVoiceRelay } from "../../lib/voice/relay.js";
import { createBasicTtsHost } from "../../background/basic-tts-host.js";

test("voice choice: Cartesia unless the server says it has no key", () => {
  assert.equal(chooseVoice({ cartesia: true, recognition: true }).mode, "cartesia");
  assert.equal(chooseVoice({ cartesia: null, recognition: true }).mode, "cartesia"); // unknown keeps today's voice
  assert.deepEqual(chooseVoice({ cartesia: false, recognition: true }), { mode: "basic", tts: "chrome", stt: "webspeech" });
  assert.deepEqual(chooseVoice({ cartesia: false, recognition: false }), { mode: "basic", tts: "chrome", stt: "typed" });
  // Voice off on the server stays text only, never Chrome's voice.
  assert.equal(chooseVoice({ cartesia: false, voice: false, recognition: true }).mode, "cartesia");
  assert.equal(basicVoice({ connected: true, voice: true, cartesia: false }), true);
  assert.equal(basicVoice({ connected: true, voice: false, cartesia: false }), false);
  assert.equal(basicVoice({ connected: false, voice: null, cartesia: null }), false);
});

function speakerRig() {
  const calls = [];
  const captions = [];
  const speaking = [];
  const timers = [];
  const s = new BasicSpeaker({
    engine: { speak: (m) => calls.push(["speak", m]), stop: () => calls.push(["stop"]), pause: () => calls.push(["pause"]), resume: () => calls.push(["resume"]) },
    getSpeed: () => 1.5,
    onSpeakingChange: (on) => speaking.push(on),
    onCaption: (c) => captions.push(c),
    setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimer: (n) => { if (timers[n - 1]) timers[n - 1].live = false; },
  });
  const fire = (ms) => { for (const t of timers) if (t.live && t.ms === ms) { t.live = false; t.fn(); } };
  return { s, calls, captions, speaking, timers, fire };
}

test("basic TTS: a line, its words from Chrome's word events, then done", () => {
  const r = speakerRig();
  r.s.speak("Found  three shoes");
  const [op, m] = r.calls[0];
  assert.equal(op, "speak");
  assert.equal(m.text, "Found three shoes");
  assert.equal(m.rate, 1.5);
  assert.deepEqual(r.speaking, [true]);
  r.s.onEvent({ id: m.id, event: "start" });
  assert.deepEqual(r.captions[0], { kind: "line", utteranceId: m.id, text: "Found three shoes", karaoke: true });
  r.s.onEvent({ id: m.id, event: "word", charIndex: 0 });
  r.s.onEvent({ id: m.id, event: "word", charIndex: 12 });
  assert.deepEqual(r.captions.slice(1).map((c) => c.index), [0, 2]);
  assert.ok(r.captions[2].ms > 0);
  r.s.onEvent({ id: m.id, event: "end" });
  assert.deepEqual(r.captions.at(-1), { kind: "word", utteranceId: m.id, index: 3, done: true });
  assert.deepEqual(r.speaking, [true, false]);
});

test("basic TTS: no word events shows the line plainly; stop drops late events", () => {
  const r = speakerRig();
  r.s.speak("Hello there");
  const id = r.calls[0][1].id;
  r.s.onEvent({ id, event: "start" });
  r.fire(NO_WORDS_AFTER_MS);
  assert.deepEqual(r.captions.at(-1), { kind: "word", utteranceId: id, fallback: true });
  r.s.duck();
  r.s.unduck();
  assert.deepEqual(r.calls.slice(1).map((c) => c[0]), ["pause", "resume"]);
  r.s.stop();
  assert.equal(r.calls.at(-1)[0], "stop");
  assert.deepEqual(r.speaking, [true, false]);
  const n = r.captions.length;
  r.s.onEvent({ id, event: "word", charIndex: 6 }); // from the stopped line
  r.s.onEvent({ id, event: "end" });
  assert.equal(r.captions.length, n);
  assert.deepEqual(r.speaking, [true, false]);
});

class FakeRecognition {
  static made = [];
  constructor() { FakeRecognition.made.push(this); this.started = 0; this.stopped = false; this.aborted = false; }
  start() { this.started++; }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
  result(resultIndex, list) {
    const results = list.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal }));
    this.onresult({ resultIndex, results });
  }
}

function sttRig(Recognition = FakeRecognition) {
  FakeRecognition.made = [];
  const ev = [];
  const unavailable = [];
  const s = new WebSpeechSttSession({
    Recognition,
    lang: "en-US",
    handlers: {
      onTurnStart: () => ev.push("start"),
      onPartial: (t) => ev.push(`partial:${t}`),
      onFinal: (t) => ev.push(`final:${t}`),
      onError: (m) => ev.push(`error:${m}`),
      onClosed: () => ev.push("closed"),
    },
    onUnavailable: (c) => unavailable.push(c),
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return { s, ev, unavailable };
}

test("Web Speech STT: partials and finals map onto the controller's turn events", () => {
  const r = sttRig();
  r.s.open();
  const rec = FakeRecognition.made[0];
  assert.equal(rec.continuous, true);
  assert.equal(rec.interimResults, true);
  rec.result(0, [["find red", false]]);
  rec.result(0, [["find red shoes", true]]);
  rec.result(0, [["find red shoes", true], ["size", false]]); // index 0 is not sent twice
  // Chrome ended by itself while the key is held: listen again.
  rec.onend();
  assert.equal(FakeRecognition.made.length, 2);
  r.s.finish();
  assert.equal(FakeRecognition.made[1].stopped, true);
  FakeRecognition.made[1].onend();
  assert.deepEqual(r.ev, ["start", "partial:find red", "final:find red shoes", "partial:size", "final:size", "closed"]);
});

test("Web Speech STT: blocked or missing recognition is an error and points at typing", () => {
  const r = sttRig();
  r.s.open();
  FakeRecognition.made[0].onerror({ error: "not-allowed" });
  FakeRecognition.made[0].onend();
  assert.deepEqual(r.unavailable, ["not-allowed"]);
  assert.match(r.ev[0], /^error:.*type to Orbi/i);
  assert.equal(r.ev.at(-1), "closed");
  assert.equal(FakeRecognition.made.length, 1); // not restarted

  const none = sttRig(null);
  none.s.open();
  assert.deepEqual(none.unavailable, ["unsupported"]);
  assert.equal(none.ev.at(-1), "closed");
});

function controllerRig() {
  const log = [];
  const emitted = [];
  const agent = { sent: [], send(m) { this.sent.push(m); } };
  let stt = null;
  const c = new VoiceController({
    createStt: (h) => (stt = { h, open() {}, sendAudio() {}, finish() {}, abort() { this.aborted = true; } }),
    speaker: { stop: () => log.push("tts.stop"), speak() {}, duck() {}, unduck() {} },
    mic: { sink: null, async start() {} },
    agent,
    chime: (k) => log.push(`chime:${k}`),
    emit: (m) => emitted.push(m),
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return { c, log, emitted, agent, get stt() { return stt; } };
}

test("typed words: barge in, then one user_text; ignored mid-hold", async () => {
  const r = controllerRig();
  assert.equal(r.c.typed("  buy   the blue one "), true);
  assert.deepEqual(r.agent.sent, [{ type: "interrupt" }, { type: "user_text", text: "buy the blue one" }]);
  assert.ok(r.log.includes("tts.stop"));
  assert.ok(r.emitted.some((m) => m.type === RT.SUBTITLE && m.speaker === "user" && m.text === "buy the blue one"));
  await r.c.start(); // a held turn
  assert.equal(r.c.typed("yes"), false);
  assert.equal(r.agent.sent.filter((m) => m.type === "user_text").length, 1);
});

test("typed words are taken only from Orbi's popup and new tab page", async () => {
  const sent = [];
  const chromeApi = {
    runtime: { id: "orbi", getURL: (p) => `chrome-extension://orbi/${p}`, getContexts: async () => [{}], sendMessage: async (m) => { sent.push(m); } },
    offscreen: { createDocument: async () => {} },
    tabs: { query: async () => [{ id: 1 }], sendMessage: async () => {} },
    storage: { local: {} },
  };
  const relay = createVoiceRelay({ chromeApi, getSettings: async () => ({}), ducker: { onState() {}, onError() {} } });
  relay.onMessage({ type: RT.TYPED_TEXT, text: "yes" }, { id: "orbi", url: "https://shop.example/", tab: { id: 4 } }); // a content script
  relay.onMessage({ type: RT.TYPED_TEXT, text: "yes" }, { id: "other", url: "chrome-extension://other/popup/popup.html" });
  relay.onMessage({ type: RT.TYPED_TEXT, text: "find socks" }, { id: "orbi", url: "chrome-extension://orbi/popup/popup.html" });
  relay.onMessage({ type: RT.TYPED_TEXT, text: "and hats" }, { id: "orbi", url: "chrome-extension://orbi/newtab/newtab.html", tab: { id: 9 } });
  await relay.idle();
  assert.deepEqual(sent, [
    { type: RT.VOICE_TYPED, text: "find socks", settings: {}, target: "offscreen" },
    { type: RT.VOICE_TYPED, text: "and hats", settings: {}, target: "offscreen" },
  ]);
});

test("chrome.tts host: only the offscreen document can speak; events go back with the line's id", () => {
  const spoken = [];
  const sent = [];
  const chromeApi = {
    runtime: { id: "orbi", getURL: (p) => `chrome-extension://orbi/${p}`, sendMessage: async (m) => { sent.push(m); }, lastError: null },
    tts: { speak: (text, opts, cb) => { spoken.push({ text, opts }); cb?.(); }, stop() { spoken.push("stop"); }, pause() {}, resume() {} },
  };
  const host = createBasicTtsHost({ chromeApi });
  const msg = { type: RT.BASIC_TTS, from: "offscreen", op: "speak", id: "bt-1", text: "Hi there", rate: 1.2 };
  assert.equal(host.onMessage(msg, { id: "orbi", url: "https://evil.example/", tab: { id: 2 } }), false);
  assert.equal(spoken.length, 0);
  host.onMessage(msg, { id: "orbi", url: "chrome-extension://orbi/offscreen/offscreen.html" });
  assert.equal(spoken[0].text, "Hi there");
  assert.equal(spoken[0].opts.enqueue, true);
  assert.equal(spoken[0].opts.rate, 1.2);
  spoken[0].opts.onEvent({ type: "word", charIndex: 3 });
  assert.deepEqual(sent, [{ type: RT.BASIC_TTS_EVENT, id: "bt-1", event: "word", charIndex: 3, target: "offscreen" }]);
});
