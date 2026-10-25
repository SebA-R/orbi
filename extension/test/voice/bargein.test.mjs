// Barge-in end to end, on one fake clock: the real hotkey detector
// (content/hotkey.js), the real VoiceController and the real Speaker, with a
// fake AudioContext whose gain params follow their automation, a fake TTS
// socket, and the offscreen document's routing (a page's PTT_START is heard
// directly, so onPageKey ducks before VOICE_START comes round via the worker).
//
// "If it's talking and I hold Space, it just immediately stops talking and
// starts listening to me."
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { RT } from "../../lib/protocol.js";
import { VoiceController, PREDUCK_MS, pageKey } from "../../lib/voice/controller.js";
import { Speaker, DUCK_LEVEL } from "../../lib/voice/tts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOTKEY_SRC = fs.readFileSync(path.join(HERE, "..", "..", "content", "hotkey.js"), "utf8");

// --- a clock shared by the timers and the AudioContext ---------------------
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

// An AudioParam that evaluates setValueAtTime / linearRampToValueAtTime.
// Like Chrome, reading .value right after cancelScheduledValues gives the
// level it had reached (mid-ramp), and setting .value is setValueAtTime(now).
function param(ctx, initial) {
  let pinned = null;
  let base = initial;
  let events = [];
  const at = (t) => {
    let cur = base;
    let lastT = 0;
    for (const e of events) {
      if (e.t > t) {
        if (e.kind === "ramp") return cur + (e.v - cur) * ((t - lastT) / (e.t - lastT));
        break;
      }
      cur = e.v;
      lastT = e.t;
    }
    return cur;
  };
  return {
    at,
    get value() { return pinned && pinned.t === ctx.currentTime ? pinned.v : at(ctx.currentTime); },
    set value(v) { this.setValueAtTime(v, ctx.currentTime); },
    cancelScheduledValues(t) {
      pinned = { t: ctx.currentTime, v: at(ctx.currentTime) };
      events = events.filter((e) => e.t < t);
    },
    setValueAtTime(v, t) { pinned = null; events.push({ kind: "set", v, t }); events.sort((a, b) => a.t - b.t); },
    linearRampToValueAtTime(v, t) { events.push({ kind: "ramp", v, t }); events.sort((a, b) => a.t - b.t); },
  };
}

function audio(clk) {
  const sources = [];
  const ctx = {
    get currentTime() { return clk.now / 1000; },
    state: "running",
    destination: { name: "destination" },
    createGain() {
      const g = { connected: false, connect(d) { g.connected = d === ctx.destination; }, disconnect() { g.connected = false; } };
      g.gain = param(ctx, 1);
      return g;
    },
    createBuffer(_ch, length, rate) { return { duration: length / rate, copyToChannel() {} }; },
    // A source ends (onended) when its buffer has played out.
    createBufferSource() {
      const s = { playbackRate: { value: 1 }, dest: null, at: null, stopped: false, ended: false,
        connect(d) { s.dest = d; },
        start(t) {
          s.at = t;
          const end = (t + s.buffer.duration / s.playbackRate.value) * 1000;
          clk.setTimer(() => { if (s.stopped) return; s.ended = true; s.onended?.(); }, end - clk.now);
        },
        stop() { s.stopped = true; } };
      sources.push(s);
      return s;
    },
  };
  // How loud our speech is at time t (seconds): the loudest source still
  // scheduled on an output node that reaches the speakers.
  const level = (t = ctx.currentTime) => Math.max(0, ...sources
    .filter((s) => !s.stopped && !s.ended && s.dest && s.dest.connected)
    .map((s) => s.dest.gain.at(t)));
  return { ctx, sources, level };
}

// The Cartesia TTS socket: opens on the next tick, records what we send.
class FakeTtsSocket {
  static OPEN = 1;
  static last = null;
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.sent = [];
    FakeTtsSocket.last = this;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {}
  chunk(contextId, samples = 2400, done = false) {
    const data = Buffer.from(new Float32Array(samples).fill(0.5).buffer).toString("base64");
    this.onmessage?.({ data: JSON.stringify({ type: "chunk", context_id: contextId, data, ...(done ? { done: true } : {}) }) });
  }
}
const realWebSocket = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = realWebSocket; });

const flush = () => new Promise((r) => setImmediate(r));

// workerMs: how long the worker takes to pass each PTT_* on as VOICE_*
// (asleep, the document check, the settings read). The page's own broadcast
// reaches the offscreen document at once.
function rig({ workerMs = 0 } = {}) {
  globalThis.WebSocket = FakeTtsSocket;
  const clk = clock();
  const a = audio(clk);
  const emitted = [];
  const cues = [];
  let stt = null;
  const agent = { sent: [], send(m) { this.sent.push(m); } };
  const mic = { sink: null, async start() {} };
  let c;
  const speaker = new Speaker({
    ctx: a.ctx, getToken: async () => "tok", getSpeed: () => 1, voiceId: "v", log: () => {},
    onSpeakingChange: (on) => c && c.onSpeakingChange(on),
  });
  c = new VoiceController({
    createStt: (h) => {
      stt = { h, audio: [], finished: false, aborted: false,
        open() {}, sendAudio(x) { this.audio.push(x); }, finish() { this.finished = true; }, abort() { this.aborted = true; } };
      return stt;
    },
    speaker, mic, agent,
    chime: (k) => cues.push([k, clk.now]),
    emit: (m) => emitted.push(m),
    setTimer: (fn, ms) => clk.setTimer(fn, ms),
    clearTimer: (t) => clk.clearTimer(t),
    now: () => clk.now,
  });

  // The page side: the real hold detector on the same clock. Each message is
  // heard twice by the offscreen document: the page's broadcast at once
  // (pageKey -> onPageKey), then the worker's VOICE_* copy, in order.
  const hooks = {};
  vm.runInNewContext(HOTKEY_SRC, { __clearcartHotkeyTest: hooks, Promise });
  const sent = [];
  const taps = [];
  const detector = hooks.createHoldDetector({
    hotkey: "Space",
    send: (type, extra = {}) => {
      sent.push(type);
      const msg = { type, ...extra };
      const k = pageKey(msg);
      if (k) c.onPageKey(k);
      const viaWorker = () => {
        if (type === RT.PTT_START) c.start({ silent: !!extra.silent, latch: !!extra.latch });
        else if (type === RT.PTT_CONFIRM) c.confirm();
        else if (type === RT.PTT_CANCEL) c.cancel();
        else if (type === RT.PTT_STOP) c.stop();
        else if (type === RT.PTT_HUSH) c.hush();
      };
      if (workerMs) clk.setTimer(viaWorker, workerMs);
      else viaWorker();
    },
    onTap: (e) => taps.push(e.code),
    setTimer: (fn, ms) => clk.setTimer(fn, ms),
    clearTimer: (t) => clk.clearTimer(t),
  });
  const key = (code, mods = {}) => ({
    code, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, repeat: false, ...mods,
    target: { tagName: "BODY" }, preventDefault() {}, stopPropagation() {},
  });
  const down = (mods) => detector.onKeyDown(key("Space", mods));
  const up = (mods) => detector.onKeyUp(key("Space", mods));

  // Orbi starts saying a line, 8 s of audio, and it is playing.
  async function speaking(text = "Here are three options for allergy pills") {
    c.onAgentMessage({ type: "agent_text", text });
    await flush();
    const ws = FakeTtsSocket.last;
    const req = ws.sent.at(-1);
    assert.equal(req.transcript, text);
    for (let i = 0; i < 8; i++) ws.chunk(req.context_id, 44100, i === 7);
    assert.equal(c.state, "speaking");
    assert.ok(a.level() > 0.9, "speech is playing at full level");
    return { ws, contextId: req.context_id };
  }
  const states = () => emitted.filter((m) => m.type === RT.VOICE_STATE).map((m) => m.state);
  const ttsRequests = () => (FakeTtsSocket.last ? FakeTtsSocket.last.sent.filter((m) => m.transcript) : []);
  return { clk, a, c, speaker, agent, mic, emitted, cues, sent, taps, detector, down, up, speaking, states, ttsRequests, get stt() { return stt; } };
}

test("holding Space while speaking: silent within 20 ms, hard stop at 200 ms, listening, first syllables kept", async () => {
  const r = rig();
  const { ws, contextId } = await r.speaking();
  const t0 = r.clk.now / 1000;

  r.down();
  r.mic.sink("pcm-0ms"); // the user starts talking with the key
  r.clk.advance(20);
  assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9, `gain ${r.a.level()} at 20 ms`);
  r.clk.advance(60);
  assert.ok(r.a.level(t0 + 0.08) <= 0.03, "at most 3% by 80 ms");
  r.stt.h.onTurnStart();
  r.stt.h.onPartial("I want"); // the first syllables, inside the 200 ms window
  r.mic.sink("pcm-100ms");
  assert.deepEqual(r.states().at(-1), "speaking", "nothing shown yet: it may be a tap");
  assert.deepEqual(r.agent.sent, []);

  r.clk.advance(120); // 200 ms: the hold is confirmed
  assert.deepEqual(r.sent, [RT.PTT_START, RT.PTT_CONFIRM]);
  assert.equal(r.a.level(), 0, "hard-stopped");
  assert.ok(r.a.sources.every((s) => s.stopped), "every scheduled buffer is stopped");
  assert.equal(r.speaker.speaking, false);
  assert.equal(r.c.state, "listening");
  assert.deepEqual(r.states().slice(-1), ["listening"]);
  assert.deepEqual(r.agent.sent, [{ type: "interrupt" }]);
  assert.equal(r.speaker.queue.length, 0, "nothing left queued to play");
  assert.deepEqual(r.stt.audio, ["pcm-0ms", "pcm-100ms"], "audio from the first moment is kept");
  assert.ok(r.emitted.some((m) => m.type === RT.VOICE_PARTIAL && m.text === "I want"), "first syllables shown once confirmed");
  assert.deepEqual(r.cues.map(([k]) => k), ["cut", "listen"]);

  // Late audio for the cut-off line, and a late line from the old turn.
  const before = r.a.sources.length;
  ws.chunk(contextId);
  ws.chunk(contextId, 2400, true);
  r.c.onAgentMessage({ type: "agent_text", text: "The cheapest is Reactine." });
  await flush();
  assert.equal(r.a.sources.length, before, "no TTS playback after the interrupt");
  assert.equal(r.ttsRequests().length, 1, "the old turn's late line is never sent to TTS");
  r.clk.advance(1000);
  assert.equal(r.a.level(), 0);

  // Let go: sent cue, tail, the words go to the agent.
  r.mic.sink("pcm-1.2s");
  r.up();
  assert.deepEqual(r.sent.at(-1), RT.PTT_STOP);
  r.clk.advance(300);
  assert.equal(r.stt.finished, true);
  assert.deepEqual(r.stt.audio, ["pcm-0ms", "pcm-100ms", "pcm-1.2s"]);
  r.stt.h.onFinal("I want the cheapest one");
  assert.deepEqual(r.agent.sent, [{ type: "interrupt" }, { type: "user_text", text: "I want the cheapest one" }]);

  // The next turn speaks normally, at full level.
  r.c.onAgentMessage({ type: "agent_text", text: "The cheapest is $9." });
  await flush();
  const next = FakeTtsSocket.last.sent.at(-1);
  assert.equal(next.transcript, "The cheapest is $9.");
  FakeTtsSocket.last.chunk(next.context_id);
  assert.equal(r.c.state, "speaking");
  assert.ok(r.a.level() > 0.99, "the next reply is at full level");
});

test("the fade does not wait for the page to know Orbi is speaking", async () => {
  const r = rig();
  await r.speaking();
  // setVoiceState was never called: the page still thinks it is idle.
  r.down();
  r.clk.advance(20);
  assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9);
  r.clk.advance(180);
  assert.equal(r.c.state, "listening");
  assert.equal(r.a.level(), 0);
});

const unducks = (r) => {
  let n = 0;
  const real = r.speaker.unduck.bind(r.speaker);
  r.speaker.unduck = () => { n++; real(); };
  return () => n;
};

test("pageKey: only a page's own hotkey broadcast, never the worker's or the offscreen document's copies", () => {
  for (const type of [RT.PTT_START, RT.PTT_CONFIRM, RT.PTT_CANCEL, RT.PTT_STOP, RT.PTT_HUSH]) {
    assert.equal(pageKey({ type, silent: true }), type);
    assert.equal(pageKey({ type, target: "offscreen" }), null, "the worker's copy");
    assert.equal(pageKey({ type, from: "offscreen" }), null);
  }
  for (const type of [RT.VOICE_START, RT.VOICE_CONFIRM, RT.PTT_TOGGLE, RT.TTS_STOP, RT.VOICE_STATE, RT.SETTINGS_CHANGED]) {
    assert.equal(pageKey({ type }), null, type);
  }
  assert.equal(pageKey(null), null);
  assert.equal(pageKey("ptt.start"), null);
});

test("a slow worker: the touch ducks at once and stays down for the whole hold, then the hold barges in", async () => {
  const r = rig({ workerMs: 6000 }); // asleep: longer than PREDUCK_MS
  await r.speaking();
  r.down();
  r.clk.advance(20);
  assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9, "ducked before VOICE_START");
  assert.equal(r.c.listening, false, "the worker has not passed the start on yet");
  for (let t = 20; t < 5980; t += 100) { r.clk.advance(100); assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9, `ducked at ${r.clk.now} ms`); }
  r.clk.advance(300); // VOICE_START (6 s), VOICE_CONFIRM (6.2 s)
  assert.equal(r.c.state, "listening");
  assert.equal(r.a.level(), 0);
  assert.deepEqual(r.agent.sent, [{ type: "interrupt" }]);
});

test("a slow worker and back-to-back presses: the first cancel does not bring the speech back", async () => {
  const r = rig({ workerMs: 150 });
  await r.speaking();
  const count = unducks(r);
  r.down(); // the page thinks it is idle, so this tap cancels at once
  r.clk.advance(30);
  r.up();
  r.clk.advance(20);
  r.down(); // a second press, before the worker caught up with the first
  for (let t = 0; t < 200; t += 10) { r.clk.advance(10); assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9, `ducked at ${r.clk.now} ms`); }
  assert.equal(count(), 0, "no blip back up between the presses");
  r.clk.advance(200); // the second press's VOICE_CONFIRM lands
  assert.equal(r.c.state, "listening");
  assert.equal(r.a.level(), 0);
});

test("the page's touch with no start ever passed on: speech comes back after the key is let go", async () => {
  const r = rig();
  await r.speaking();
  r.c.onPageKey(RT.PTT_START); // the worker never sends VOICE_START
  r.clk.advance(20);
  assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9, "ducked without VOICE_START");
  r.c.onPageKey(RT.PTT_CONFIRM);
  r.clk.advance(PREDUCK_MS / 4); // the 8 s line is still playing throughout
  assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9, "held: stays down");
  r.c.onPageKey(RT.PTT_STOP);
  r.clk.advance(PREDUCK_MS - 10);
  assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9, "the start still gets its chance");
  r.clk.advance(100); // plus the 80 ms fade back in
  assert.ok(r.a.level() > 0.99, "no start ever came: the speech is back");
  assert.deepEqual(r.agent.sent, []);
});

test("the page's touch does nothing while idle", () => {
  const r = rig();
  let ducks = 0;
  r.speaker.duck = () => { ducks++; };
  const count = unducks(r);
  r.c.onPageKey(RT.PTT_START); // not speaking
  r.clk.advance(PREDUCK_MS + 100);
  assert.equal(ducks, 0);
  assert.equal(count(), 0);
});

test("the page's touch does nothing during a turn already listening", async () => {
  const r = rig();
  await r.speaking();
  const count = unducks(r);
  r.c.onPageKey(RT.PTT_START);
  await r.c.start({ silent: true });
  r.clk.advance(20);
  r.c.onPageKey(RT.PTT_START); // another frame, during the silent start
  r.c.start({ silent: true }); // its worker copy: ignored, the turn is on
  r.clk.advance(PREDUCK_MS + 100);
  assert.equal(count(), 0, "no timer of its own");
  assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9, "still ducked: the silent start owns it");
  r.c.cancel(); // a tap
  r.clk.advance(100);
  assert.ok(r.a.level() > 0.99, "the tap brings the speech back");
  assert.deepEqual(r.agent.sent, []);
});

test("start() takes the duck over: no late restore after the turn is done", async () => {
  const r = rig();
  await r.speaking();
  const count = unducks(r);
  r.down();
  r.clk.advance(200);
  assert.equal(r.c.state, "listening");
  r.clk.advance(300);
  r.up();
  r.clk.advance(PREDUCK_MS + 100);
  assert.equal(count(), 0, "the page press's timer was cleared by start()");
});

test("speech that ends during a touch: the next line is not left ducked", async () => {
  const r = rig({ workerMs: 6000 });
  await r.speaking();
  r.c.onPageKey(RT.PTT_START);
  r.c.onPageKey(RT.PTT_CANCEL); // a tap; the worker is far behind
  r.clk.advance(9000); // the 8 s line plays out, ducked
  assert.equal(r.c.speaking, false);
  r.clk.advance(PREDUCK_MS);
  r.c.onAgentMessage({ type: "agent_text", text: "Anything else?" });
  await flush();
  FakeTtsSocket.last.chunk(FakeTtsSocket.last.sent.at(-1).context_id, 44100);
  assert.ok(r.a.level() > 0.99, "the next line plays at full level");
});

test("a quick tap while speaking ducks, then restores the speech after the double-tap window", async () => {
  const r = rig();
  await r.speaking();
  r.detector.setVoiceState("speaking", false);
  r.down();
  r.clk.advance(60);
  r.up();
  assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9);
  r.clk.advance(300);
  assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9, "still ducked while a second tap may come");
  r.clk.advance(200); // the 350 ms window and the 80 ms fade back in
  assert.ok(r.a.level() > 0.99, "speech is back");
  assert.equal(r.c.state, "speaking");
  assert.deepEqual(r.agent.sent, []);
});

test("a tap then a hold while speaking: the hold is not delayed and still barges in", async () => {
  const r = rig();
  await r.speaking();
  r.detector.setVoiceState("speaking", false);
  r.down();
  r.clk.advance(60);
  r.up();
  r.clk.advance(90);
  r.down(); // 150 ms after the first touch, inside the double-tap window
  for (let t = 0; t < 180; t += 20) { r.clk.advance(20); assert.ok(r.a.level() <= DUCK_LEVEL + 1e-9); }
  r.clk.advance(19);
  assert.equal(r.c.confirmed, false, "199 ms: not yet");
  r.clk.advance(1); // exactly 200 ms after the second press
  assert.equal(r.c.state, "listening");
  assert.equal(r.a.level(), 0);
  assert.deepEqual(r.agent.sent, [{ type: "interrupt" }]);
});

test("Option+Space while speaking stops at once and latches listening", async () => {
  const r = rig();
  const { ws, contextId } = await r.speaking();
  r.down({ altKey: true });
  assert.deepEqual(r.sent, [RT.PTT_START]);
  assert.equal(r.a.level(), 0, "no 200 ms wait: a latch is a hard stop on press");
  assert.equal(r.c.state, "listening");
  assert.equal(r.c.latched, true);
  assert.ok(r.emitted.some((m) => m.type === RT.VOICE_STATE && m.state === "listening" && m.latched === true));
  assert.deepEqual(r.agent.sent, [{ type: "interrupt" }]);
  const before = r.a.sources.length;
  ws.chunk(contextId);
  r.c.onAgentMessage({ type: "agent_text", text: "late" });
  await flush();
  assert.equal(r.a.sources.length, before, "nothing from the old turn plays");
  r.up({ altKey: true });
  assert.equal(r.c.listening, true, "still listening after the key is let go");
});

test("a line still connecting to TTS when the hold confirms is never sent", async () => {
  const r = rig();
  r.c.onAgentMessage({ type: "agent_text", text: "Searching now" }); // socket not open yet
  r.down();
  r.clk.advance(200);
  await flush();
  assert.equal(r.c.state, "listening");
  assert.equal(r.ttsRequests().length, 0, "stopped while connecting: no request goes out");
  assert.equal(r.a.sources.length, 0);
});

test("a line still generating when the hold confirms is cancelled at Cartesia, and its late audio never plays", async () => {
  const r = rig();
  r.c.onAgentMessage({ type: "agent_text", text: "Let me read the whole list" });
  await flush();
  const ws = FakeTtsSocket.last;
  const id = ws.sent.at(-1).context_id;
  ws.chunk(id, 44100); // more is still coming
  r.down();
  r.clk.advance(200);
  assert.equal(r.c.state, "listening");
  assert.deepEqual(ws.sent.filter((m) => m.cancel).map((m) => m.context_id), [id]);
  const before = r.a.sources.length;
  ws.chunk(id, 44100);
  ws.chunk(id, 44100, true);
  r.clk.advance(3000);
  assert.equal(r.a.sources.length, before);
  assert.equal(r.a.level(), 0);
});
