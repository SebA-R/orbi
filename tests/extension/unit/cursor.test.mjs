import { test } from "node:test";
import assert from "node:assert/strict";

import { createCursorRelay } from "../../../extension/background/cursor.js";
import { createActor } from "../../../extension/background/actor.js";
import { createRng } from "../../../extension/background/humanize.js";
import { DEFAULTS, normalize } from "../../../extension/lib/settings.js";
import { RT } from "../../../extension/lib/protocol.js";

function fakeChrome() {
  const sent = [];
  return { sent, tabs: { sendMessage: async (tabId, msg, opts) => void sent.push({ tabId, msg, opts }) } };
}

test("relay: every hook sample goes to the tab's top frame as RT.CURSOR, with the voice state", () => {
  const chromeApi = fakeChrome();
  const relay = createCursorRelay({ chromeApi });
  relay.onVoiceState("speaking");
  relay.onPointer({ tabId: 4, x: 10, y: 20, t: 1, action: "click", phase: "move", to: { x: 50, y: 60 } });
  relay.onPointer({ tabId: 4, x: 50, y: 60, t: 2, action: "click", phase: "press", rect: { x: 40, y: 50, width: 20, height: 20 } });
  relay.onPointer({ tabId: 4, x: 50, y: 60, t: 3, action: "type", phase: "type", text: "  linen\n pants  " });
  assert.equal(chromeApi.sent.length, 3);
  for (const s of chromeApi.sent) {
    assert.equal(s.tabId, 4);
    assert.deepEqual(s.opts, { frameId: 0 });
    assert.equal(s.msg.type, RT.CURSOR);
    assert.equal(s.msg.voice, "speaking");
  }
  assert.deepEqual(chromeApi.sent[0].msg.to, { x: 50, y: 60 });
  assert.deepEqual(chromeApi.sent[1].msg.rect, { x: 40, y: 50, width: 20, height: 20 });
  assert.equal(chromeApi.sent[2].msg.text, "linen pants");
});

test("relay: hides on tab switch, interrupt, turn end and moving to another tab", () => {
  const chromeApi = fakeChrome();
  const relay = createCursorRelay({ chromeApi });
  const hides = () => chromeApi.sent.filter((s) => s.msg.phase === "hide").map((s) => s.tabId);
  relay.onPointer({ tabId: 1, x: 1, y: 1, action: "click", phase: "move" });
  relay.onTabActivated({ tabId: 1 });
  assert.deepEqual(hides(), []);
  relay.onTabActivated({ tabId: 2 });
  assert.deepEqual(hides(), [1]);
  relay.onPointer({ tabId: 1, x: 1, y: 1, action: "click", phase: "move" });
  relay.onPointer({ tabId: null, phase: "stop" });
  assert.deepEqual(hides(), [1, 1]);
  relay.onPointer({ tabId: 3, x: 1, y: 1, action: "click", phase: "move" });
  relay.onVoiceState("thinking");
  relay.onVoiceState("idle");
  assert.deepEqual(hides(), [1, 1, 3]);
  relay.onPointer({ tabId: 3, x: 1, y: 1, action: "click", phase: "move" });
  relay.onPointer({ tabId: 5, x: 1, y: 1, action: "click", phase: "move" });
  assert.deepEqual(hides(), [1, 1, 3, 3]);
  assert.equal(relay.shownTab(), 5);
});

test("relay: the setting off sends nothing", () => {
  const chromeApi = fakeChrome();
  let on = false;
  const relay = createCursorRelay({ chromeApi, enabled: () => on });
  relay.onPointer({ tabId: 1, x: 1, y: 1, action: "click", phase: "move" });
  assert.equal(chromeApi.sent.length, 0);
  on = true;
  relay.onPointer({ tabId: 1, x: 1, y: 1, action: "click", phase: "move" });
  assert.equal(chromeApi.sent.length, 1);
  assert.equal(DEFAULTS.showCursor, true);
  assert.equal(normalize({ showCursor: false }).showCursor, false);
  assert.equal(normalize({ showCursor: "no" }).showCursor, true);
});

test("actor: typing reports its text once and each key, abortAll reports a stop", async () => {
  const sent = [];
  const cdp = { send: async (tabId, method, params) => void sent.push({ method, ...params }) };
  const timers = [];
  const actor = createActor({ cdp, rng: createRng(3), now: () => 0, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer() {}, tabWindow: async () => 1 });
  const events = [];
  actor.onPointer((e) => events.push(e));
  actor.notePointer(2, 30, 40);
  const p = actor.type(2, "ab", { check: async () => ({ keys: true }) });
  for (let i = 0; i < 200 && events.filter((e) => e.phase === "key").length < 2; i++) {
    await new Promise((r) => setImmediate(r));
    while (timers.length) timers.shift()();
  }
  await p;
  const typed = events.filter((e) => e.action === "type");
  assert.deepEqual(typed.map((e) => e.phase), ["type", "key", "key"]);
  assert.equal(typed[0].text, "ab");
  assert.deepEqual([typed[0].x, typed[0].y], [30, 40]);
  actor.abortAll("the user started talking");
  assert.equal(events.at(-1).phase, "stop");
  assert.equal(events.at(-1).tabId, null);
});
