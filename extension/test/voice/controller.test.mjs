import { test } from "node:test";
import assert from "node:assert/strict";

import { RT } from "../../lib/protocol.js";
import { VoiceController, TAIL_MS, LATCH_IDLE_MS } from "../../lib/voice/controller.js";
import { AgentSession } from "../../lib/voice/agent-session.js";
import { createTokenSource } from "../../lib/voice/token.js";

function rig({ micFails } = {}) {
  const log = [];
  const emitted = [];
  const timers = [];
  let stt = null;
  const speaker = {
    speaking: false,
    stop() { log.push("tts.stop"); },
    speak(text) { log.push(`speak:${text}`); },
    duck() { log.push("tts.duck"); },
    unduck() { log.push("tts.unduck"); },
  };
  const mic = {
    sink: null,
    async start() { if (micFails) { const e = new Error("denied"); e.name = micFails; throw e; } },
  };
  const agent = { sent: [], send(m) { this.sent.push(m); } };
  const c = new VoiceController({
    createStt: (h) => {
      stt = { h, audio: [], opened: false, finished: false, aborted: false,
        open() { this.opened = true; }, sendAudio(a) { this.audio.push(a); },
        finish() { this.finished = true; }, abort() { this.aborted = true; } };
      return stt;
    },
    speaker, mic, agent,
    chime: (k) => log.push(`chime:${k}`),
    emit: (m) => emitted.push(m),
    setTimer: (fn, ms) => timers.push({ fn, ms, cleared: false }),
    clearTimer: (n) => { if (timers[n - 1]) timers[n - 1].cleared = true; },
  });
  return { c, log, emitted, timers, agent, mic, get stt() { return stt; } };
}

const states = (emitted) => emitted.filter((m) => m.type === RT.VOICE_STATE).map((m) => m.state);

test("start: barge-in, start chime, listening, mic routed to STT", async () => {
  const r = rig();
  await r.c.start();
  assert.deepEqual(r.log, ["tts.stop", "chime:start"]);
  assert.deepEqual(states(r.emitted), ["listening"]);
  assert.equal(r.stt.opened, true);
  r.mic.sink("chunk");
  assert.deepEqual(r.stt.audio, ["chunk"]);
  await r.c.start(); // ignored while listening
  assert.deepEqual(r.log, ["tts.stop", "chime:start"]);
});

test("stop: stop chime now, finish after the tail; a final becomes user_text + subtitle", async () => {
  const r = rig();
  await r.c.start();
  r.stt.h.onPartial("cheap aller");
  r.c.stop();
  assert.equal(r.log.at(-1), "chime:stop");
  assert.equal(r.timers[0].ms, TAIL_MS);
  assert.equal(r.stt.finished, false);
  r.timers[0].fn();
  assert.equal(r.stt.finished, true);
  assert.equal(r.mic.sink, null);
  r.stt.h.onFinal("cheapest allergy pills");
  r.stt.h.onClosed();
  assert.deepEqual(r.agent.sent, [{ type: "interrupt" }, { type: "user_text", text: "cheapest allergy pills" }]);
  assert.deepEqual(r.emitted.filter((m) => m.type === RT.SUBTITLE), [
    { type: RT.SUBTITLE, speaker: "user", text: "cheap aller", final: false },
    { type: RT.SUBTITLE, speaker: "user", text: "cheapest allergy pills", final: true },
  ]);
  assert.ok(r.emitted.some((m) => m.type === RT.VOICE_FINAL && m.text === "cheapest allergy pills"));
  assert.deepEqual(states(r.emitted), ["listening", "idle", "thinking"]);
});

test("agent_text speaks, subtitles, and the state follows the speaker", async () => {
  const r = rig();
  await r.c.start();
  r.c.stop();
  r.timers[0].fn();
  r.stt.h.onFinal("hi");
  r.c.onAgentMessage({ type: "agent_text", text: "Found it." });
  r.c.onSpeakingChange(true);
  r.c.onSpeakingChange(false);
  assert.ok(r.log.includes("speak:Found it."));
  assert.ok(r.emitted.some((m) => m.type === RT.SUBTITLE && m.speaker === "agent" && m.text === "Found it." && m.final));
  assert.deepEqual(states(r.emitted), ["listening", "idle", "thinking", "speaking", "idle"]);
});

test("pressing again while it speaks barges in", async () => {
  const r = rig();
  r.c.onAgentMessage({ type: "agent_text", text: "Long reply" });
  r.c.onSpeakingChange(true);
  r.log.length = 0;
  await r.c.start();
  assert.equal(r.log[0], "tts.stop");
  r.stt.h.onTurnStart();
  assert.equal(r.log.at(-1), "tts.stop");
});

test("status and receipt are forwarded as STATUS; empty agent_text is ignored", () => {
  const r = rig();
  r.c.onAgentMessage({ type: "status", text: "navigate http://localhost:4000/search" });
  r.c.onAgentMessage({ type: "receipt", item: "Cetirizine", total: "$18.49", last4: "1111" });
  r.c.onAgentMessage({ type: "agent_text", text: "" });
  assert.deepEqual(r.emitted.filter((m) => m.type === RT.STATUS), [
    { type: RT.STATUS, kind: "status", text: "navigate http://localhost:4000/search" },
    { type: RT.STATUS, kind: "receipt", receipt: { item: "Cetirizine", total: "$18.49", last4: "1111" } },
  ]);
  assert.equal(r.log.length, 0);
});

test("blocked mic aborts STT, returns to idle and reports mic_blocked", async () => {
  const r = rig({ micFails: "NotAllowedError" });
  await r.c.start();
  assert.equal(r.stt.aborted, true);
  assert.equal(r.c.listening, false);
  const err = r.emitted.find((m) => m.type === RT.VOICE_ERROR);
  assert.equal(err.code, "mic_blocked");
  assert.deepEqual(states(r.emitted), ["listening", "idle"]);
});

test("mic failure after a silent start brings our ducked speech back up", async () => {
  const r = rig({ micFails: "NotReadableError" });
  await r.c.start({ silent: true });
  assert.deepEqual(r.log, ["tts.duck", "tts.unduck"]);
  assert.equal(r.c.listening, false);
  assert.deepEqual(r.agent.sent, []);
});

test("toggle starts then stops", async () => {
  const r = rig();
  await r.c.toggle();
  assert.equal(r.c.listening, true);
  r.c.toggle();
  assert.equal(r.c.listening, false);
});

const live = (timers) => timers.filter((t) => !t.cleared);

test("toggle latches like Option+Space", async () => {
  const r = rig();
  await r.c.toggle();
  assert.equal(r.c.latched, true);
  assert.deepEqual(r.emitted.filter((m) => m.type === RT.VOICE_STATE).at(-1), { type: RT.VOICE_STATE, state: "listening", latched: true });
});

test("a latched session holds its phrases and sends them as one user_text after stop", async () => {
  const r = rig();
  await r.c.start({ latch: true });
  assert.deepEqual(r.log, ["tts.stop", "chime:start"], "confirms at once, no silent start");
  r.stt.h.onFinal("two bags of");
  r.stt.h.onPartial("chips");
  assert.deepEqual(r.agent.sent.filter((m) => m.type === "user_text"), [], "nothing sent before Space");
  assert.equal(r.emitted.filter((m) => m.type === RT.SUBTITLE).at(-1).text, "two bags of chips");
  r.c.stop();
  assert.equal(r.c.listening, false);
  assert.equal(r.c.latched, false);
  for (const t of live(r.timers)) if (t.ms === TAIL_MS) t.fn();
  assert.equal(r.stt.finished, true);
  r.stt.h.onFinal("please");
  assert.deepEqual(r.agent.sent.filter((m) => m.type === "user_text"), [{ type: "user_text", text: "two bags of please" }]);
  r.stt.h.onClosed();
  assert.equal(r.agent.sent.filter((m) => m.type === "user_text").length, 1, "sent once");
});

test("a latched session whose last phrase was already final flushes on close", async () => {
  const r = rig();
  await r.c.start({ latch: true });
  r.stt.h.onFinal("milk");
  r.c.stop();
  r.stt.h.onClosed();
  assert.deepEqual(r.agent.sent.filter((m) => m.type === "user_text"), [{ type: "user_text", text: "milk" }]);
});

test("a latch stops itself after a minute with no speech, and speech pushes it back", async () => {
  const r = rig();
  await r.c.start({ latch: true });
  let [t] = live(r.timers).filter((x) => x.ms === LATCH_IDLE_MS);
  assert.ok(t);
  r.stt.h.onPartial("hm");
  assert.equal(t.cleared, true, "speech re-arms the timeout");
  [t] = live(r.timers).filter((x) => x.ms === LATCH_IDLE_MS);
  t.fn();
  assert.equal(r.c.listening, false);
  assert.ok(r.emitted.some((m) => m.type === RT.STATUS && /no speech/.test(m.text)));
  assert.equal(r.log.at(-1), "chime:stop");
});

test("a hold has no idle timeout; the old timer is a no-op once the latch ended", async () => {
  const r = rig();
  await r.c.start({ latch: true });
  const [t] = live(r.timers).filter((x) => x.ms === LATCH_IDLE_MS);
  r.c.stop();
  assert.equal(t.cleared, true);
  await r.c.start();
  assert.equal(live(r.timers).filter((x) => x.ms === LATCH_IDLE_MS).length, 0);
  t.fn();
  assert.equal(r.c.listening, true, "a stale latch timer doesn't stop a hold");
});

test("talking from another frame during a latch ends it", async () => {
  const r = rig();
  await r.c.start({ latch: true });
  await r.c.start({ silent: true });
  assert.equal(r.c.listening, false);
});

test("hush while speaking drops the tap's silent start, hard-stops speech and boops", async () => {
  const r = rig();
  r.c.onSpeakingChange(true);
  await r.c.start({ silent: true }); // first tap ducked the speech
  r.log.length = 0;
  assert.equal(r.c.hush(), true);
  assert.equal(r.stt.aborted, true);
  assert.equal(r.c.listening, false);
  assert.deepEqual(r.log, ["tts.stop", "chime:boop"]);
  assert.deepEqual(r.agent.sent, [{ type: "interrupt" }], "never a user_text, so it can't answer a read-back");
  assert.ok(!states(r.emitted).includes("listening"));
});

test("hush when speech already ended only brings the level back", async () => {
  const r = rig();
  await r.c.start({ silent: true });
  r.log.length = 0;
  assert.equal(r.c.hush(), false);
  assert.deepEqual(r.log, ["tts.unduck"]);
  assert.deepEqual(r.agent.sent, []);
});

test("hush never touches a confirmed turn", async () => {
  const r = rig();
  await r.c.start();
  assert.equal(r.c.hush(), false);
  assert.equal(r.c.listening, true);
});

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeWS.all.push(this); }
  send(m) { this.sent.push(m); }
  close() { this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.(); }
}

test("AgentSession queues while closed, flushes on open, parses messages and reconnects", () => {
  FakeWS.all = [];
  const got = [];
  const timers = [];
  const s = new AgentSession({ url: () => "ws://localhost:5050/session", onMessage: (m) => got.push(m), WebSocketImpl: FakeWS, setTimer: (fn, ms) => timers.push({ fn, ms }) });
  s.send({ type: "user_text", text: "hello" });
  const ws = FakeWS.all[0];
  assert.equal(ws.url, "ws://localhost:5050/session");
  ws.open();
  assert.deepEqual(ws.sent, ['{"type":"user_text","text":"hello"}']);
  ws.onmessage({ data: '{"type":"agent_text","text":"Hi"}' });
  ws.onmessage({ data: "not json" });
  assert.deepEqual(got, [{ type: "agent_text", text: "Hi" }]);
  ws.readyState = 3;
  ws.onclose({});
  assert.equal(timers.length, 1);
  timers[0].fn();
  assert.equal(FakeWS.all.length, 2);
  s.close();
  assert.equal(timers.length, 1, "no reconnect after close()");
});

test("token source caches until 15 s before expiry and shares one in-flight request", async () => {
  let calls = 0;
  let t = 0;
  const getToken = createTokenSource({
    url: () => "http://localhost:5050/cartesia-token",
    now: () => t,
    fetchImpl: async (u) => { calls++; assert.equal(u, "http://localhost:5050/cartesia-token"); return { ok: true, json: async () => ({ token: `tok${calls}`, expires_in: 60 }) }; },
  });
  const [a, b] = await Promise.all([getToken(), getToken()]);
  assert.equal(a, "tok1");
  assert.equal(b, "tok1");
  t = 44_000;
  assert.equal(await getToken(), "tok1");
  t = 46_000;
  assert.equal(await getToken(), "tok2");
  assert.equal(calls, 2);
});

test("token source surfaces server errors", async () => {
  const getToken = createTokenSource({ url: () => "u", fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(getToken(), /500/);
});

test("silent start records from the first moment but shows nothing until confirm", async () => {
  const r = rig();
  await r.c.start({ silent: true });
  assert.deepEqual(r.log, ["tts.duck"]);
  assert.deepEqual(states(r.emitted), []);
  assert.equal(r.stt.opened, true);
  r.mic.sink("first-word");
  assert.deepEqual(r.stt.audio, ["first-word"]);
  r.stt.h.onTurnStart();
  r.stt.h.onPartial("reorder");
  assert.deepEqual(r.log, ["tts.duck"]);
  assert.equal(r.emitted.length, 0);
  r.c.confirm();
  assert.deepEqual(r.log, ["tts.duck", "tts.stop", "chime:start", "tts.stop"]);
  assert.deepEqual(states(r.emitted), ["listening"]);
  assert.ok(r.emitted.some((m) => m.type === RT.SUBTITLE && m.text === "reorder"));
  r.c.stop();
  r.timers.shift().fn();
  assert.equal(r.stt.finished, true);
  r.stt.h.onFinal("reorder my allergy pills");
  assert.deepEqual(r.agent.sent, [{ type: "interrupt" }, { type: "user_text", text: "reorder my allergy pills" }]);
});

test("cancel after a silent start drops the audio with no chime, state or agent message", async () => {
  const r = rig();
  await r.c.start({ silent: true });
  r.stt.h.onFinal("uh");
  r.c.cancel();
  assert.equal(r.stt.aborted, true);
  assert.equal(r.mic.sink, null);
  assert.deepEqual(r.log, ["tts.duck", "tts.unduck"]);
  assert.deepEqual(states(r.emitted), []);
  assert.deepEqual(r.agent.sent, []);
  assert.equal(r.c.listening, false);
  r.c.confirm(); // too late, nothing happens
  assert.deepEqual(r.log, ["tts.duck", "tts.unduck"]);
});

test("a silent start ducks the agent speaking; a tap brings it back without interrupting", async () => {
  const r = rig();
  r.c.onSpeakingChange(true);
  await r.c.start({ silent: true });
  assert.deepEqual(r.log, ["tts.duck"]);
  assert.deepEqual(states(r.emitted), ["speaking"]);
  r.c.stop(); // released before confirm counts as a tap
  assert.equal(r.stt.aborted, true);
  assert.deepEqual(r.log, ["tts.duck", "tts.unduck"]);
  assert.deepEqual(r.agent.sent, []);
});

test("confirm hard-stops the speaker and sends interrupt to the agent", async () => {
  const r = rig();
  r.c.onAgentMessage({ type: "agent_text", text: "Here are three options" });
  r.c.onSpeakingChange(true);
  r.log.length = 0;
  await r.c.start({ silent: true });
  r.c.confirm();
  assert.deepEqual(r.log.slice(0, 3), ["tts.duck", "tts.stop", "chime:start"]);
  assert.deepEqual(r.agent.sent, [{ type: "interrupt" }]);
});

test("agent_text from the interrupted turn is not spoken; the next turn is", async () => {
  const r = rig();
  r.c.agent.send({ type: "user_text", text: "find allergy pills" });
  r.c.onAgentMessage({ type: "agent_text", text: "Searching the store now." });
  await r.c.start({ silent: true });
  r.c.confirm();
  r.log.length = 0;
  r.c.onAgentMessage({ type: "agent_text", text: "I found Reactine for $18." });
  assert.ok(!r.log.some((l) => l.startsWith("speak:")), "late line from the old turn is dropped");
  assert.ok(r.emitted.some((m) => m.type === RT.STATUS && /not spoken.*Reactine/.test(m.text)));
  assert.ok(!r.emitted.some((m) => m.type === RT.SUBTITLE && m.speaker === "agent" && /Reactine/.test(m.text)));
  r.c.stop();
  r.timers.shift().fn();
  r.stt.h.onFinal("actually the cheapest one");
  r.c.onAgentMessage({ type: "agent_text", text: "The cheapest is $9." });
  assert.ok(r.log.includes("speak:The cheapest is $9."));
});

test("token source says plainly when voice is off on the server", async () => {
  const get = createTokenSource({
    url: () => "http://localhost:5050/cartesia-token",
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ voice: false }) }),
  });
  await assert.rejects(get(), /Voice is off/);
});

test("an unconfirmed silent start never shows listening, even when speech ends meanwhile", async () => {
  const r = rig();
  r.c.onSpeakingChange(true);
  await r.c.start({ silent: true });
  r.c.onSpeakingChange(false);
  assert.deepEqual(states(r.emitted), ["speaking", "idle"]);
});

test("the STT closing mid-latch ends the latch and sends what was held", async () => {
  const r = rig();
  await r.c.start({ latch: true });
  r.stt.h.onFinal("eggs");
  r.stt.h.onClosed();
  assert.equal(r.c.listening, false);
  assert.equal(r.c.latched, false);
  assert.equal(r.mic.sink, null);
  assert.deepEqual(r.agent.sent.filter((m) => m.type === "user_text"), [{ type: "user_text", text: "eggs" }]);
  assert.notEqual(states(r.emitted).at(-1), "listening");
});

test("a failed latch start tells the page it is not latched", async () => {
  const r = rig({ micFails: "NotAllowedError" });
  await r.c.start({ latch: true });
  assert.equal(r.c.latched, false);
  assert.deepEqual(r.emitted.filter((m) => m.type === RT.VOICE_STATE).at(-1), { type: RT.VOICE_STATE, state: "idle" });
});

test("the toggle during a tap's silent start latches instead of doing nothing", async () => {
  const r = rig();
  await r.c.start({ silent: true });
  await r.c.toggle();
  assert.equal(r.c.listening, true);
  assert.equal(r.c.latched, true);
  r.c.cancel(); // the tap's late PTT_CANCEL is a no-op now
  assert.equal(r.c.listening, true);
});
