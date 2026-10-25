import { test } from "node:test";
import assert from "node:assert/strict";

import { RT } from "../../lib/protocol.js";
import { createDucker, fadeMedia, STORE_KEY } from "../../lib/voice/duck.js";
import { createVoiceRelay } from "../../lib/voice/relay.js";

const OUR_ID = "dhgknfenfoidnchmjfaicafhieepefoc";

// Tabs: { id, audible, muted, reason? }. Mutes made through tabs.update are
// recorded as this extension's, like Chrome does.
function fakeChrome(tabs, { failInject = [] } = {}) {
  const byId = new Map(tabs.map((t) => [t.id, { id: t.id, audible: t.audible, mutedInfo: { muted: !!t.muted, ...(t.muted ? { reason: t.reason || "user" } : {}) } }]));
  const state = { updates: [], injected: [], session: {} };
  const chromeApi = {
    runtime: { id: OUR_ID, getURL: (p) => `chrome-extension://${OUR_ID}/${p}`, getContexts: async () => [{}], sendMessage: async () => {} },
    tabs: {
      query: async (q) => [...byId.values()].filter((t) => q.audible == null || t.audible === q.audible).map((t) => structuredClone(t)),
      get: async (id) => { if (!byId.has(id)) throw new Error("No tab"); return structuredClone(byId.get(id)); },
      update: async (id, { muted }) => {
        state.updates.push({ id, muted });
        byId.get(id).mutedInfo = muted ? { muted: true, reason: "extension", extensionId: OUR_ID } : { muted: false };
      },
      sendMessage: async () => {},
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        state.injected.push({ tabId: target.tabId, allFrames: target.allFrames, func, down: args[0] });
        if (failInject.includes(target.tabId)) throw new Error("Cannot access a chrome:// URL");
        return [{ result: 0 }];
      },
    },
    storage: {
      local: {},
      session: {
        get: async (k) => (k in state.session ? { [k]: state.session[k] } : {}),
        set: async (o) => { Object.assign(state.session, o); },
      },
    },
  };
  const userMutes = (id, muted) => { byId.get(id).mutedInfo = muted ? { muted: true, reason: "user" } : { muted: false }; };
  return { chromeApi, state, byId, userMutes };
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => pending.delete(id),
    // Fires the grace timer (fade caps resolve on their own in these fakes).
    fireGrace(ms = 600) { for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.fn(); } },
    hasGrace: (ms = 600) => [...pending.values()].some((t) => t.ms === ms),
  };
}

function make(tabs, { quietTabs = true, failInject } = {}) {
  const f = fakeChrome(tabs, { failInject });
  const timers = fakeTimers();
  const settings = { quietTabs };
  const ducker = createDucker({ chromeApi: f.chromeApi, getSettings: async () => settings, timers });
  const relay = createVoiceRelay({ chromeApi: f.chromeApi, getSettings: async () => settings, ducker });
  const voiceState = (state) => relay.onMessage({ from: "offscreen", type: RT.VOICE_STATE, state });
  return { ...f, timers, ducker, relay, voiceState };
}

const TABS = [
  { id: 1, audible: true },              // YouTube playing
  { id: 2, audible: true, muted: true }, // the user muted this one
  { id: 3, audible: false },             // silent tab
];

test("listening fades and mutes only audible tabs the user hasn't muted", async () => {
  const { relay, ducker, state, voiceState } = make(TABS);
  relay.onMessage({ type: RT.PTT_START, silent: true }, { tab: { id: 3 } });
  relay.onMessage({ type: RT.PTT_CONFIRM }, { tab: { id: 3 } });
  await ducker.idle();
  assert.equal(state.updates.length, 0, "PTT_CONFIRM alone ducks nothing");
  voiceState("listening");
  await ducker.idle();
  assert.deepEqual(state.injected.map((i) => [i.tabId, i.allFrames, i.down, i.func]), [[1, true, true, fadeMedia]]);
  assert.deepEqual(state.updates, [{ id: 1, muted: true }]);
  assert.deepEqual(state.session[STORE_KEY], [1]);
});

test("a quick tap (PTT_START silent, then PTT_CANCEL) never ducks", async () => {
  const { relay, ducker, state, voiceState } = make(TABS);
  relay.onMessage({ type: RT.PTT_START, silent: true }, { tab: { id: 3 } });
  relay.onMessage({ type: RT.PTT_CANCEL }, { tab: { id: 3 } });
  voiceState("idle");
  await relay.idle();
  await ducker.idle();
  assert.equal(state.injected.length, 0);
  assert.equal(state.updates.length, 0);
});

test("restores after idle plus the grace, only the tabs we ducked, and a new turn cancels it", async () => {
  const { relay, ducker, state, timers, voiceState } = make(TABS);
  voiceState("listening");
  voiceState("thinking");
  voiceState("speaking");
  await ducker.idle();
  voiceState("idle");
  assert.ok(timers.hasGrace());
  voiceState("listening"); // back-to-back turn within the grace: stay ducked
  assert.ok(!timers.hasGrace());
  await ducker.idle();
  voiceState("idle");
  state.updates.length = 0;
  state.injected.length = 0;
  await ducker.idle();
  assert.equal(state.updates.length, 0, "nothing before the grace ends");
  timers.fireGrace();
  await ducker.idle();
  assert.deepEqual(state.updates, [{ id: 1, muted: false }]);
  assert.deepEqual(state.injected.map((i) => [i.tabId, i.down]), [[1, false]]);
  assert.deepEqual(state.session[STORE_KEY], []);
});

test("a tab whose mute the user changed meanwhile keeps the user's choice", async () => {
  const { relay, ducker, state, timers, voiceState, byId, userMutes } = make([{ id: 1, audible: true }, { id: 4, audible: true }]);
  voiceState("listening");
  await ducker.idle();
  userMutes(1, false); // unmuted by hand
  userMutes(4, true);  // muted again by hand
  state.updates.length = 0;
  voiceState("idle");
  timers.fireGrace();
  await ducker.idle();
  assert.deepEqual(state.updates, []);
  assert.equal(byId.get(4).mutedInfo.muted, true);
});

test("an injection failure (chrome:// page) still mutes the tab", async () => {
  const { ducker, state, voiceState } = make([{ id: 5, audible: true }], { failInject: [5] });
  voiceState("listening");
  await ducker.idle();
  assert.deepEqual(state.updates, [{ id: 5, muted: true }]);
});

test("with the setting off nothing is ducked", async () => {
  const { ducker, state, voiceState } = make(TABS, { quietTabs: false });
  voiceState("listening");
  voiceState("speaking");
  await ducker.idle();
  assert.equal(state.injected.length, 0);
  assert.equal(state.updates.length, 0);
});

test("a blocked or failed mic leaves no tab muted", async () => {
  const { relay, ducker, state } = make(TABS);
  relay.onMessage({ type: RT.PTT_START, silent: true }, { tab: { id: 3 } });
  relay.onMessage({ type: RT.PTT_CONFIRM }, { tab: { id: 3 } });
  // The controller settles to idle (already its state, so no VOICE_STATE) and reports the error.
  relay.onMessage({ from: "offscreen", type: RT.VOICE_ERROR, code: "mic_failed", message: "x" });
  await relay.idle();
  await ducker.idle();
  assert.equal(state.updates.length, 0);
  assert.equal(state.injected.length, 0);
});

test("VOICE_ERROR restores right away, without the grace", async () => {
  const { relay, ducker, state, timers, voiceState } = make(TABS);
  voiceState("speaking");
  await ducker.idle();
  state.updates.length = 0;
  relay.onMessage({ from: "offscreen", type: RT.VOICE_ERROR, message: "x" });
  await ducker.idle();
  assert.deepEqual(state.updates, [{ id: 1, muted: false }]);
  assert.ok(!timers.hasGrace());
  assert.deepEqual(state.session[STORE_KEY], []);
});

test("backstop: a duck with no non-idle state in force restores after BACKSTOP_MS", async () => {
  const { ducker, state, timers, voiceState } = make(TABS);
  ducker.duck();
  await ducker.idle();
  state.updates.length = 0;
  timers.fireGrace(2000);
  await ducker.idle();
  assert.deepEqual(state.updates, [{ id: 1, muted: false }]);

  // A real turn keeps the duck past the backstop.
  voiceState("listening");
  await ducker.idle();
  state.updates.length = 0;
  timers.fireGrace(2000);
  await ducker.idle();
  assert.deepEqual(state.updates, []);
});

test("restore removes each id from storage only after its own unmute", async () => {
  const { ducker, state, timers, voiceState, chromeApi } = make([{ id: 1, audible: true }, { id: 4, audible: true }]);
  voiceState("speaking");
  await ducker.idle();
  const seen = [];
  const update = chromeApi.tabs.update;
  chromeApi.tabs.update = async (id, opts) => {
    seen.push([id, [...state.session[STORE_KEY]]]); // what storage held when this unmute ran
    return update(id, opts);
  };
  voiceState("idle");
  timers.fireGrace();
  await ducker.idle();
  for (const [id, stored] of seen) assert.ok(stored.includes(id), `tab ${id} still tracked while unmuting`);
  assert.deepEqual(state.session[STORE_KEY], []);
});

test("a tab that starts playing mid-turn is ducked too", async () => {
  const { ducker, state, voiceState, byId } = make([{ id: 1, audible: true }, { id: 6, audible: false }]);
  voiceState("speaking");
  await ducker.idle();
  byId.get(6).audible = true;
  ducker.onTabUpdated(6, { audible: true });
  await ducker.idle();
  assert.deepEqual(state.updates, [{ id: 1, muted: true }, { id: 6, muted: true }]);
  assert.deepEqual(state.session[STORE_KEY], [1, 6]);

  // Not while idle.
  voiceState("idle");
  ducker.onTabUpdated(6, { audible: true });
  await ducker.idle();
  assert.equal(state.updates.length, 2);
});
