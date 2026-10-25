import { test } from "node:test";
import assert from "node:assert/strict";

import { RT } from "../../../extension/lib/protocol.js";
import { createFrame, FRAME_FILES } from "../../../extension/background/frame.js";
import { createRouter } from "../../../extension/background/router.js";
import { createVoiceRelay } from "../../../extension/lib/voice/relay.js";

function setup({ noScript = new Set(), session = {}, slowInject = null } = {}) {
  const sent = [];
  const injected = [];
  const timers = new Map();
  let id = 0;
  const chromeApi = {
    tabs: {
      sendMessage: async (tabId, msg, opts) => {
        if (noScript.has(tabId)) throw new Error("Could not establish connection");
        sent.push({ tabId, on: msg.on, type: msg.type, frameId: opts && opts.frameId });
        return { frame: true };
      },
    },
    scripting: { executeScript: async (o) => { if (slowInject) await slowInject; injected.push(o); noScript.delete(o.target.tabId); } },
    storage: { session: {
      get: async (k) => (k in session ? { [k]: session[k] } : {}),
      set: async (o) => { Object.assign(session, o); },
      remove: async (k) => { delete session[k]; },
    } },
  };
  const frame = createFrame({
    chromeApi,
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimer: (t) => timers.delete(t),
  });
  const fire = () => { for (const [k, t] of [...timers]) { timers.delete(k); t.fn(); } };
  const flush = () => new Promise((r) => setImmediate(r));
  return { frame, sent, injected, timers, fire, flush };
}

test("a voice turn shows the frame on the talking tab and idle hides it", async () => {
  const { frame, sent, flush } = setup();
  frame.onVoiceState("listening", 3);
  frame.onVoiceState("thinking", 3);
  await flush();
  assert.deepEqual(sent, [{ tabId: 3, on: true, type: RT.FRAME, frameId: 0 }]);
  assert.equal(frame.shownTab(), 3);
  frame.onVoiceState("idle", 3);
  await flush();
  assert.deepEqual(sent.at(-1), { tabId: 3, on: false, type: RT.FRAME, frameId: 0 });
  assert.equal(frame.shownTab(), null);
});

test("the frame moves to the tab the agent acts on, and only one tab has it", async () => {
  const { frame, sent, flush } = setup();
  frame.onVoiceState("thinking", 3);
  frame.onAgentTab(9);
  frame.onAgentTab(9);
  await flush();
  assert.deepEqual(sent.map((s) => [s.tabId, s.on]), [[3, true], [3, false], [9, true]]);
  // The hold running out mid-turn keeps it on the agent tab.
  frame.onVoiceState("speaking", 3);
  assert.equal(frame.shownTab(), 9);
  frame.onVoiceState("idle", 3);
  await flush();
  assert.deepEqual(sent.at(-1), { tabId: 9, on: false, type: RT.FRAME, frameId: 0 });
});

test("agent calls without a voice turn show the frame until the hold ends", async () => {
  const { frame, sent, fire, timers, flush } = setup();
  frame.onAgentTab(5);
  await flush();
  assert.equal(frame.shownTab(), 5);
  assert.equal([...timers.values()][0].ms, 10_000);
  fire();
  await flush();
  assert.equal(frame.shownTab(), null);
  assert.deepEqual(sent.map((s) => [s.tabId, s.on]), [[5, true], [5, false]]);
});

test("a new turn starts on the talking tab, not the last turn's agent tab", async () => {
  const { frame, flush } = setup();
  frame.onVoiceState("thinking", 3);
  frame.onAgentTab(9);
  frame.onVoiceState("idle", 3);
  frame.onVoiceState("listening", 4);
  await flush();
  assert.equal(frame.shownTab(), 4);
});

test("a reloaded framed tab gets the frame again; a closed one is dropped", async () => {
  const { frame, sent, flush } = setup();
  frame.onAgentTab(5);
  frame.onTabUpdated(5, { status: "loading" });
  frame.onTabUpdated(5, { status: "complete" });
  frame.onTabUpdated(6, { status: "complete" });
  await flush();
  assert.deepEqual(sent.map((s) => [s.tabId, s.on]), [[5, true], [5, true]]);
  frame.onTabRemoved(5);
  assert.equal(frame.shownTab(), null);
});

test("a tab without the frame script gets it injected once, then the message", async () => {
  const { frame, sent, injected, flush } = setup({ noScript: new Set([7]) });
  frame.onVoiceState("listening", 7);
  await flush(); await flush();
  assert.deepEqual(injected, [{ target: { tabId: 7 }, files: FRAME_FILES }]);
  assert.deepEqual(sent, [{ tabId: 7, on: true, type: RT.FRAME, frameId: 0 }]);
});

test("the router reports every call that touches a tab", async () => {
  const seen = [];
  const router = createRouter({
    chromeApi: { scripting: { executeScript: async () => [] } },
    tabs: { resolveAllowedTab: async (t) => t, navigate: async ({ tabId }) => ({ tabId }) },
    cdp: { scroll: async () => {} },
    onAgentTab: (t) => seen.push(t),
  });
  await router.route("scroll", { tabId: 4, x: 1, y: 1, dx: 0, dy: 10 });
  await router.route("scroll", { tabId: 4, x: 1, y: 1, dx: 0, dy: 10 });
  await router.route("navigate", { tabId: 8, url: "https://example.com" });
  assert.deepEqual(seen, [4, 4, 8]);
});

test("the relay reports each voice state with the tab it went to", async () => {
  const seen = [];
  const chromeApi = {
    runtime: { getURL: (p) => p, getContexts: async () => [], sendMessage: async () => {} },
    offscreen: { createDocument: async () => {} },
    tabs: { query: async () => [{ id: 7 }], sendMessage: async () => {} },
  };
  const relay = createVoiceRelay({
    chromeApi, getSettings: async () => ({}),
    ducker: { onState() {} },
    onVoiceState: (state, tabId) => seen.push([state, tabId]),
  });
  relay.onMessage({ from: "offscreen", type: RT.VOICE_STATE, state: "listening" });
  await relay.statesIdle();
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  relay.onMessage({ from: "offscreen", type: RT.VOICE_STATE, state: "thinking" });
  relay.onMessage({ from: "offscreen", type: RT.VOICE_STATE, state: "idle" });
  await relay.statesIdle();
  assert.deepEqual(seen, [["listening", 7], ["thinking", 3], ["idle", 3]]);
  await relay.idle();
});

test("a quick on/off while the script is being injected ends with the frame off", async () => {
  let go;
  const slowInject = new Promise((r) => { go = r; });
  const { frame, sent, flush } = setup({ noScript: new Set([7]), slowInject });
  frame.onVoiceState("listening", 7);
  frame.onVoiceState("idle", 7);
  await flush();
  go();
  await flush(); await flush(); await flush();
  assert.deepEqual(sent.map((s) => [s.tabId, s.on]), [[7, false]]);
});

test("a reply from another content script is not taken for the frame script", async () => {
  const f = setup();
  f.frame.onVoiceState("idle", 1); // nothing
  const injected = [];
  const other = createFrame({
    chromeApi: {
      tabs: { sendMessage: async () => undefined },
      scripting: { executeScript: async (o) => { injected.push(o); } },
    },
  });
  other.onVoiceState("thinking", 2);
  await f.flush(); await f.flush();
  assert.equal(injected.length, 1);
});

test("repeated idle states do not cut the hold of agent calls short; unknown states are idle", async () => {
  const { frame, flush } = setup();
  frame.onAgentTab(5);
  frame.onVoiceState("idle", 3);
  frame.onVoiceState("idle", 3);
  await flush();
  assert.equal(frame.shownTab(), 5);
  frame.onVoiceState("error", 3);
  frame.onVoiceState(undefined, 3);
  assert.equal(frame.shownTab(), 5);
});

test("a restarted worker turns off the frame the last one left on", async () => {
  const session = {};
  const a = setup({ session });
  a.frame.onAgentTab(5);
  await a.flush();
  assert.equal(session.clearcartFrameTab, 5);
  const b = setup({ session });
  await b.frame.recover();
  assert.deepEqual(b.sent, [{ tabId: 5, on: false, type: RT.FRAME, frameId: 0 }]);
  assert.equal("clearcartFrameTab" in session, false);
});
