import { test } from "node:test";
import assert from "node:assert/strict";

import { RT } from "../../lib/protocol.js";
import { VoiceController, TAIL_MS, LATCH_IDLE_MS, FINAL_WAIT_MS, BUSY_WATCHDOG_MS } from "../../lib/voice/controller.js";
import { AgentSession } from "../../lib/voice/agent-session.js";
import { createTokenSource } from "../../lib/voice/token.js";

function rig({ micFails, speakReplies = true } = {}) {
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
    speakReplies: () => speakReplies,
  });
  return { c, log, emitted, timers, agent, mic, get stt() { return stt; } };
}

const states = (emitted) => emitted.filter((m) => m.type === RT.VOICE_STATE).map((m) => m.state);

test("start: barge-in, start chime, listening, mic routed to STT", async () => {
  const r = rig();
  await r.c.start();
  assert.deepEqual(r.log, ["tts.stop", "chime:listen"]);
  assert.deepEqual(states(r.emitted), ["listening"]);
  assert.equal(r.stt.opened, true);
  r.mic.sink("chunk");
  assert.deepEqual(r.stt.audio, ["chunk"]);
  await r.c.start(); // ignored while listening
  assert.deepEqual(r.log, ["tts.stop", "chime:listen"]);
});

test("stop: stop chime now, finish after the tail; a final becomes user_text + subtitle", async () => {
  const r = rig();
  await r.c.start();
  r.stt.h.onPartial("cheap aller");
  r.c.stop();
  assert.equal(r.log.at(-1), "chime:sent");
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
  assert.deepEqual(states(r.emitted), ["listening", "thinking"], "a partial was heard: thinking at once, no idle blip");
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
  assert.deepEqual(states(r.emitted), ["listening", "thinking", "speaking", "idle"], "thinking from the release, before any word was heard");
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
  r.c.onAgentMessage({ type: "status", text: "navigate https://shop.example/search" });
  r.c.onAgentMessage({ type: "receipt", item: "Cetirizine", total: "$18.49", last4: "1111" });
  r.c.onAgentMessage({ type: "agent_text", text: "" });
  assert.deepEqual(r.emitted.filter((m) => m.type === RT.STATUS), [
    { type: RT.STATUS, kind: "status", text: "navigate https://shop.example/search" },
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
  assert.deepEqual(r.log, ["tts.stop", "chime:listen"], "confirms at once, no silent start");
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
  assert.equal(r.log.at(-1), "chime:sent");
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
  assert.deepEqual(r.log, ["tts.stop", "chime:cut"]);
  assert.deepEqual(r.agent.sent, [{ type: "interrupt" }], "never a user_text, so it can't answer a read-back");
  assert.ok(!states(r.emitted).includes("listening"));
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
  assert.equal(s.send({ type: "user_text", text: "hello" }), false, "queued");
  const ws = FakeWS.all[0];
  assert.equal(ws.url, "ws://localhost:5050/session");
  ws.open();
  assert.deepEqual(ws.sent, ['{"type":"user_text","text":"hello"}']);
  assert.equal(s.send({ type: "interrupt" }), true, "written");
  ws.readyState = 2; // closing
  assert.equal(s.send({ type: "user_text", text: "again" }), false, "queued for the next socket");
  ws.sent.length = 0;
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
  assert.deepEqual(r.log, ["tts.duck", "tts.stop", "chime:listen", "tts.stop"]);
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
  assert.deepEqual(r.log.slice(0, 4), ["tts.duck", "tts.stop", "chime:cut", "chime:listen"]);
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

// ---- earcons: which cue each trigger plays ----
const cues = (log) => log.filter((l) => l.startsWith("chime:")).map((l) => l.slice(6));

test("cues: listen on confirm, sent on release", async () => {
  const r = rig();
  await r.c.start({ silent: true });
  assert.deepEqual(cues(r.log), [], "a touch is silent");
  r.c.confirm();
  assert.deepEqual(cues(r.log), ["listen"]);
  r.c.stop();
  assert.deepEqual(cues(r.log), ["listen", "sent"]);
});

test("cues: a quick tap plays nothing", async () => {
  const r = rig();
  await r.c.start({ silent: true });
  r.c.cancel();
  assert.deepEqual(cues(r.log), []);
});

test("cues: confirm_done paid -> placed, failed -> failed, declined -> nothing", () => {
  const r = rig();
  r.c.onAgentMessage({ type: "confirm_done", outcome: "declined" });
  assert.deepEqual(cues(r.log), []);
  r.c.onAgentMessage({ type: "confirm_done", outcome: "paid" });
  r.c.onAgentMessage({ type: "confirm_done", outcome: "failed" });
  assert.deepEqual(cues(r.log), ["placed", "failed"]);
});

test("cues: mic blocked buzzes on a held start", async () => {
  const r = rig({ micFails: "NotAllowedError" });
  await r.c.start();
  assert.deepEqual(cues(r.log), ["listen", "error"]);
});

// Send on release: Ink ends a turn on every pause, so its finals mid-hold are
// segments of one user turn, sent once when the key comes up.
const userTexts = (r) => r.agent.sent.filter((m) => m.type === "user_text");
const fire = (r, ms) => { for (const t of live(r.timers)) if (t.ms === ms && !t.fired) { t.fired = true; t.fn(); } };

test("send on release: finals mid-hold send nothing; partials still subtitle", async () => {
  const r = rig();
  await r.c.start();
  r.stt.h.onFinal("two bags");
  r.stt.h.onPartial("of chi");
  r.stt.h.onFinal("of chips");
  assert.deepEqual(userTexts(r), []);
  assert.equal(r.c.state, "listening");
  const subs = r.emitted.filter((m) => m.type === RT.SUBTITLE);
  assert.ok(subs.some((m) => m.text === "two bags of chi" && m.final === false));
  assert.ok(!subs.some((m) => m.final === true));
});

test("send on release: release sends the segments as one user_text, once", async () => {
  const r = rig();
  await r.c.start();
  r.stt.h.onFinal("two bags");
  r.stt.h.onFinal("of chips");
  r.c.stop();
  assert.equal(r.log.at(-1), "chime:sent");
  assert.deepEqual(userTexts(r), [], "nothing before the tail");
  fire(r, TAIL_MS);
  assert.equal(r.stt.finished, true);
  r.stt.h.onFinal("please");
  assert.deepEqual(userTexts(r), [{ type: "user_text", text: "two bags of chips please" }]);
  r.stt.h.onClosed();
  fire(r, FINAL_WAIT_MS);
  assert.equal(userTexts(r).length, 1, "sent once");
});

test("send on release: a late final within the wait window is included; after it, dropped", async () => {
  const r = rig();
  await r.c.start();
  r.stt.h.onFinal("milk");
  r.stt.h.onPartial("and eg");
  r.c.stop();
  fire(r, TAIL_MS);
  assert.deepEqual(userTexts(r), [], "waits for the trailing final");
  r.stt.h.onFinal("and eggs");
  assert.deepEqual(userTexts(r), [{ type: "user_text", text: "milk and eggs" }]);

  // No trailing final in time: the open partial goes with it, and a later final is dropped.
  const q = rig();
  await q.c.start();
  q.stt.h.onFinal("milk");
  q.stt.h.onPartial("and bread");
  q.c.stop();
  fire(q, TAIL_MS);
  fire(q, FINAL_WAIT_MS);
  assert.deepEqual(userTexts(q), [{ type: "user_text", text: "milk and bread" }]);
  q.stt.h.onFinal("and bread too");
  q.stt.h.onClosed();
  assert.equal(userTexts(q).length, 1);
});

test("send on release: a tap, a cancel or a mic error discards the buffer", async () => {
  const r = rig();
  await r.c.start({ silent: true });
  r.stt.h.onFinal("hm");
  r.c.cancel();
  r.stt.h.onFinal("hm more");
  r.stt.h.onClosed();
  for (const t of live(r.timers)) t.fn();
  assert.deepEqual(userTexts(r), []);

  const m = rig({ micFails: "NotFoundError" });
  await m.c.start();
  m.stt.h.onFinal("lost");
  m.stt.h.onClosed();
  m.c.stop();
  for (const t of live(m.timers)) t.fn();
  assert.deepEqual(userTexts(m), []);
});

test("send on release: the STT closing mid-hold keeps the words for the release", async () => {
  const r = rig();
  await r.c.start();
  r.stt.h.onFinal("oat milk");
  r.stt.h.onClosed();
  assert.deepEqual(userTexts(r), []);
  r.c.stop();
  fire(r, TAIL_MS);
  assert.deepEqual(userTexts(r), [{ type: "user_text", text: "oat milk" }]);
});

test("send on release: standby moved after release drops the unsent turn", async () => {
  const r = rig();
  await r.c.start();
  r.stt.h.onFinal("eggs");
  r.c.stop();
  r.c.onAgentMessage({ type: "standby", reason: "moved" });
  fire(r, TAIL_MS);
  r.stt.h.onFinal("and milk");
  fire(r, FINAL_WAIT_MS);
  assert.deepEqual(userTexts(r), []);
  assert.ok(r.log.includes("chime:error"));
});

test("turn timing: with a wallClock, user_text carries the release and final times, and the first audio is reported once", async () => {
  const r = rig();
  let t = 1_700_000_000_000;
  r.c.wallClock = () => t;
  await r.c.start();
  r.stt.h.onPartial("milk");
  t += 10;
  r.c.onPageKey(RT.PTT_STOP); // the page's own key-up, ahead of the worker's copy
  t += 20;
  r.c.stop();
  r.timers[0].fn();
  t += 300;
  r.stt.h.onFinal("milk");
  assert.deepEqual(userTexts(r), [{ type: "user_text", text: "milk", timing: { releasedAt: 1_700_000_000_010, stopAt: 1_700_000_000_030, finalAt: 1_700_000_000_330 } }]);
  r.c.onFirstAudio(1_700_000_001_000.4);
  r.c.onFirstAudio(1_700_000_002_000);
  assert.deepEqual(r.agent.sent.filter((m) => m.type === "timing"), [{ type: "timing", event: "first_audio", at: 1_700_000_001_000 }]);
});

// --- busy from the agent server ---------------------------------------------
const busy = (r, on, seq) => r.c.onAgentMessage({ type: "busy", on, seq });
const opened = () => { const r = rig(); r.c.onAgentState("open"); return r; };

test("busy: a spoken ack ending mid-turn goes back to thinking; only busy off ends the turn", () => {
  const r = opened();
  r.c.typed("find socks");
  busy(r, true, 1);
  r.c.onAgentMessage({ type: "agent_text", text: "On it." });
  r.c.onSpeakingChange(true);
  r.c.onSpeakingChange(false); // the ack is over, tools still running
  assert.equal(r.c.state, "thinking");
  r.c.onAgentMessage({ type: "status", text: "navigate https://shop.example" });
  r.c.onAgentMessage({ type: "agent_text", text: "Found three." });
  r.c.onSpeakingChange(true);
  busy(r, false, 1); // the turn's result, while the reply is heard
  assert.equal(r.c.state, "speaking");
  r.c.onSpeakingChange(false);
  assert.deepEqual(states(r.emitted), ["thinking", "speaking", "thinking", "speaking", "idle"]);
});

test("busy: an off for older words is stale and ignored; the one for the latest ends it", () => {
  const r = opened();
  r.c.typed("find socks");
  busy(r, true, 1);
  r.c.typed("actually, wool ones"); // barges in on the first turn
  busy(r, false, 1); // the first turn's end, sent before the server had the second
  assert.equal(r.c.state, "thinking");
  assert.equal(r.c.awaitingReply, true);
  busy(r, true, 2);
  busy(r, false, 2);
  assert.equal(r.c.state, "idle");
});

test("busy: with Speak replies off, a read line, a receipt or a TTS failure no longer end thinking", () => {
  const r = rig({ speakReplies: false });
  r.c.onAgentState("open");
  r.c.typed("buy it");
  busy(r, true, 1);
  r.c.onAgentMessage({ type: "agent_text", text: "On it." });
  assert.equal(r.c.state, "thinking");
  r.c.onAgentMessage({ type: "receipt", item: "Mug", total: "$9", last4: "1111" });
  assert.equal(r.c.state, "thinking");
  busy(r, false, 1);
  assert.equal(r.c.state, "idle");
  const s = opened();
  s.c.typed("hi");
  busy(s, true, 1);
  s.c.onAgentMessage({ type: "agent_text", text: "Hello." });
  s.c.onSpeakingChange(true);
  s.c.onSpeakingChange(false); // Sonic failed: no audio
  assert.equal(s.c.state, "thinking");
});

test("busy: a question the agent asks ends thinking; a question dropped by the agent brings it back", () => {
  const r = opened();
  r.c.typed("buy the mug");
  busy(r, true, 1);
  r.c.onAgentMessage({ type: "agent_text", text: "Mug for $9. Say yes to place it." });
  r.c.onSpeakingChange(true);
  busy(r, false, 1); // waiting for the answer
  r.c.onSpeakingChange(false);
  assert.equal(r.c.state, "idle");
  busy(r, true, 1); // the question timed out; the agent goes on
  assert.equal(r.c.state, "thinking");
});

test("busy: after a barge-in, the cut-off turn's busy on does not bring thinking back", async () => {
  const r = opened();
  r.c.typed("find socks");
  busy(r, true, 1);
  await r.c.start(); // a hold: barges in
  r.c.stop();
  r.timers.find((t) => t.ms === TAIL_MS).fn();
  r.stt.h.onClosed(); // said nothing
  assert.equal(r.c.state, "idle");
  busy(r, true, 1); // the cut-off turn is still winding down
  assert.equal(r.c.state, "idle");
});

test("busy: the agent socket closing mid-turn ends thinking; words sent while down count on the next socket", () => {
  const r = opened();
  r.c.typed("find socks");
  busy(r, true, 1);
  r.c.onAgentState("closed");
  assert.equal(r.c.state, "idle");
  r.c.typed("are you there"); // queued until the socket is back
  assert.equal(r.c.state, "thinking");
  r.c.onAgentState("open");
  busy(r, true, 1);
  busy(r, false, 1);
  assert.equal(r.c.state, "idle", "the queued words were the new socket's first");
});

test("busy: words sent while the socket is closing count on the next socket, not this one", () => {
  const r = opened();
  r.agent.send = function (m) { this.sent.push(m); return false; }; // closing: queued
  r.c.typed("find socks");
  r.c.onAgentState("closed");
  r.c.onAgentState("open"); // the queued words go out first
  r.agent.send = function (m) { this.sent.push(m); return true; };
  busy(r, true, 1);
  r.c.typed("wool ones");
  busy(r, false, 1); // the first words' turn ending
  assert.equal(r.c.state, "thinking", "an off for the older words is stale");
  busy(r, true, 2);
  busy(r, false, 2);
  assert.equal(r.c.state, "idle");
});

test("busy: no word from the agent for BUSY_WATCHDOG_MS stops thinking; any message pushes it back", () => {
  const r = opened();
  r.c.typed("find socks");
  busy(r, true, 1);
  const pending = () => r.timers.filter((t) => !t.cleared && t.ms === BUSY_WATCHDOG_MS);
  assert.equal(pending().length, 1);
  r.c.onAgentMessage({ type: "status", text: "computer screenshot" });
  const [t] = pending();
  assert.equal(pending().length, 1, "the status re-armed it");
  t.fn();
  assert.equal(r.c.state, "idle");
  assert.ok(r.emitted.some((m) => m.type === RT.STATUS && /stopped waiting/.test(m.text)));
});

test("without busy from the server (echo mode), the first agent_text heard still ends thinking", () => {
  const r = rig();
  r.c.onAgentState("open");
  r.c.typed("hi");
  r.c.onAgentMessage({ type: "agent_text", text: "You said: hi" });
  r.c.onSpeakingChange(true);
  r.c.onSpeakingChange(false);
  assert.equal(r.c.state, "idle");
  assert.equal(r.timers.filter((t) => t.ms === BUSY_WATCHDOG_MS).length, 0);
});

test("a release with nothing heard yet shows thinking at once; an empty turn then goes idle", async () => {
  const r = rig();
  await r.c.start();
  r.c.stop();
  assert.deepEqual(states(r.emitted), ["listening", "thinking"]);
  r.timers[0].fn();
  r.stt.h.onClosed(); // nothing was said
  assert.deepEqual(states(r.emitted), ["listening", "thinking", "idle"]);
  assert.ok(!r.agent.sent.some((m) => m.type === "user_text"));
});

test("a mic that fails after the release does not leave it thinking", async () => {
  const r = rig({ micFails: "NotReadableError" });
  const p = r.c.start();
  r.c.stop(); // released before getUserMedia rejected
  await p;
  assert.equal(r.c.awaitingReply, false);
  assert.equal(r.c.state, "idle");
});

test("busy: the barged-in turn's off during the release tail is not this turn's end", async () => {
  const r = opened();
  r.c.typed("find socks");
  busy(r, true, 1);
  await r.c.start(); // barge in
  r.stt.h.onPartial("wool");
  r.c.stop();
  busy(r, false, 1); // the interrupted turn ends before our words go out
  assert.equal(r.c.state, "thinking");
  r.timers.find((t) => t.ms === TAIL_MS).fn();
  r.stt.h.onFinal("wool ones");
  busy(r, true, 2);
  busy(r, false, 2);
  assert.equal(r.c.state, "idle");
  assert.deepEqual(states(r.emitted).slice(-3), ["listening", "thinking", "idle"], "no idle blip on release");
});
