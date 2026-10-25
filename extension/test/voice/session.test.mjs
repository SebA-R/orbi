// One mic and one voice turn across tabs, frames and worker restarts: the
// relay, a real VoiceController standing in for the offscreen document, and
// the hotkey content script.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { RT } from "../../lib/protocol.js";
import { createDucker } from "../../lib/voice/duck.js";
import { createVoiceRelay, installVoiceRelay } from "../../lib/voice/relay.js";
import { VoiceController, TAIL_MS } from "../../lib/voice/controller.js";

const OUR_ID = "dhgknfenfoidnchmjfaicafhieepefoc";
const SETTINGS = { speed: 1, agentUrl: "ws://localhost:5050", hotkey: "Space", subtitles: true, quietTabs: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A VoiceController with fake STT, mic, speaker and agent socket.
function voice(emit = () => {}) {
  const stts = [];
  const log = [];
  const agent = { sent: [], send(m) { this.sent.push(m); } };
  const mic = { starts: 0, sink: null, async start() { this.starts++; } };
  const controller = new VoiceController({
    createStt: (h) => {
      const s = { h, open() {}, sendAudio() {}, finish() { s.finished = true; }, abort() { s.aborted = true; h.onClosed(); } };
      stts.push(s);
      return s;
    },
    speaker: { stop() { log.push("tts.stop"); }, speak(t) { log.push(`speak:${t}`); }, duck() {}, unduck() {} },
    mic,
    agent,
    chime: () => {},
    emit,
    // The release tail runs at once; the latch's idle stop never fires here.
    setTimer: (fn, ms) => (ms === TAIL_MS ? fn() : null),
    clearTimer: () => {},
  });
  return { controller, stts, agent, mic, log };
}

// Chrome for the worker: tabs (id, audible, muted by us?), session storage,
// and an offscreen document whose messages go to `offscreen(msg)`.
function fakeChrome({ hasDoc = false, tabs = [] } = {}) {
  const byId = new Map(tabs.map((t) => [t.id, { id: t.id, audible: !!t.audible, mutedInfo: t.ours ? { muted: true, reason: "extension", extensionId: OUR_ID } : { muted: false } }]));
  const state = { doc: hasDoc, created: 0, toDoc: [], updates: [], session: {}, listeners: {} };
  const ev = (name) => ({ addListener: (fn) => { state.listeners[name] = fn; } });
  let offscreen = () => {};
  const chromeApi = {
    runtime: {
      id: OUR_ID,
      getURL: (p) => `chrome-extension://${OUR_ID}/${p}`,
      getContexts: async () => (state.doc ? [{}] : []),
      sendMessage: async (m) => {
        if (m.target !== "offscreen" || !state.doc) return;
        state.toDoc.push(m.type);
        offscreen(m);
      },
      onMessage: ev("message"),
    },
    offscreen: {
      createDocument: async () => {
        await sleep(5);
        if (state.doc) throw new Error("Only a single offscreen document may be created.");
        state.created++;
        state.doc = true;
      },
    },
    tabs: {
      query: async (q) => [...byId.values()].filter((t) => q.audible == null || t.audible === q.audible).map((t) => structuredClone(t)),
      get: async (id) => structuredClone(byId.get(id)),
      update: async (id, { muted }) => {
        state.updates.push({ id, muted });
        byId.get(id).mutedInfo = muted ? { muted: true, reason: "extension", extensionId: OUR_ID } : { muted: false };
      },
      sendMessage: async () => {},
      onActivated: ev("activated"),
      onUpdated: ev("updated"),
    },
    scripting: { executeScript: async () => [{ result: 0 }] },
    commands: { onCommand: ev("command") },
    windows: { onFocusChanged: ev("focus") },
    storage: {
      local: {},
      session: {
        get: async (k) => (k in state.session ? { [k]: state.session[k] } : {}),
        set: async (o) => { Object.assign(state.session, o); },
      },
      onChanged: ev("storage"),
    },
  };
  return { chromeApi, state, setOffscreen: (fn) => { offscreen = fn; } };
}

// The offscreen document's message switch (offscreen/offscreen.js), driving `c`.
function offscreenFor(c) {
  return (msg) => {
    if (msg.type === RT.VOICE_START) c.start({ silent: !!msg.silent });
    else if (msg.type === RT.VOICE_CONFIRM) c.confirm();
    else if (msg.type === RT.VOICE_CANCEL) c.cancel();
    else if (msg.type === RT.VOICE_STOP) c.stop();
    else if (msg.type === RT.VOICE_SYNC) c.announce();
  };
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => pending.delete(id),
    fire(ms) { for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.fn(); } },
  };
}

test("two tabs pressing at once share one turn: one offscreen document, one STT session, one mic start", async () => {
  const f = fakeChrome();
  const relay = createVoiceRelay({ chromeApi: f.chromeApi, getSettings: async () => SETTINGS, ducker: { onState() {}, onError() {} } });
  const v = voice((m) => relay.onMessage({ ...m, from: "offscreen" }));
  f.setOffscreen(offscreenFor(v.controller));
  relay.onMessage({ type: RT.PTT_START, silent: true }, { tab: { id: 1 }, frameId: 0 });
  relay.onMessage({ type: RT.PTT_START, silent: true }, { tab: { id: 2 }, frameId: 3 }); // an iframe in another tab
  relay.onMessage({ type: RT.PTT_CONFIRM }, { tab: { id: 1 }, frameId: 0 });
  await relay.idle();
  assert.equal(f.state.created, 1);
  assert.equal(v.stts.length, 1, "never a second listener");
  assert.equal(v.mic.starts, 1);
  assert.equal(v.controller.state, "listening");
  relay.onMessage({ type: RT.PTT_STOP }, { tab: { id: 1 }, frameId: 0 });
  await relay.idle();
  v.stts[0].h.onFinal("buy the advil");
  assert.deepEqual(v.agent.sent.filter((m) => m.type === "user_text"), [{ type: "user_text", text: "buy the advil" }]);
});

test("worker restart mid-turn: the new worker asks the open document for its state and keeps other tabs quiet", async () => {
  // Tab 1 was ducked by the old worker; the offscreen document is still listening.
  for (const live of [true, false]) {
    const f = fakeChrome({ hasDoc: true, tabs: [{ id: 1, audible: true, ours: true }] });
    f.state.session.duckedTabs = [1];
    const timers = fakeTimers();
    const getSettings = async () => SETTINGS;
    const ducker = createDucker({ chromeApi: f.chromeApi, getSettings, timers });
    let relay = null; // the new worker's relay, once it starts
    const v = voice((m) => relay?.onMessage({ ...m, from: "offscreen" }));
    if (live) await v.controller.start();
    f.setOffscreen(offscreenFor(v.controller));
    relay = installVoiceRelay({ chromeApi: f.chromeApi, getSettings, ducker });
    await relay.idle();
    await sleep(0);
    await ducker.idle();
    assert.deepEqual(f.state.toDoc, [RT.VOICE_SYNC], "asks, never creates a document");
    assert.equal(f.state.created, 0);
    timers.fire(600); // recover()'s grace restore
    await ducker.idle();
    const unmuted = f.state.updates.some((u) => u.id === 1 && u.muted === false);
    assert.equal(unmuted, !live, live ? "a live turn keeps tab 1 quiet" : "an idle document lets tab 1 come back");
    if (live) {
      // The hold that started before the restart still ends the one turn.
      f.state.listeners.message({ type: RT.PTT_STOP }, { tab: { id: 1 } });
      await relay.idle();
      assert.equal(v.controller.listening, false);
      assert.equal(f.state.created, 0);
    }
  }
});

test("standby moved: speech stops and a turn still listening ends unsent", async () => {
  const emitted = [];
  const v = voice((m) => emitted.push(m));
  await v.controller.start();
  v.controller.onAgentMessage({ type: "standby", reason: "moved", text: "Clearcart moved to another window." });
  assert.equal(v.controller.listening, false);
  assert.equal(v.stts[0].aborted, true);
  assert.equal(v.mic.sink, null);
  assert.ok(v.log.includes("tts.stop"));
  assert.equal(v.controller.state, "idle");
  v.controller.stop(); // the key comes up afterwards
  assert.ok(!v.agent.sent.some((m) => m.type === "user_text"));
  assert.ok(emitted.some((m) => m.type === RT.STATUS && /another window/.test(m.text)));
});

test("standby moved ends a hands-free latch too, and its held phrases are never sent", async () => {
  const emitted = [];
  const v = voice((m) => emitted.push(m));
  await v.controller.start({ latch: true });
  v.stts[0].h.onFinal("add the advil"); // held until the latch ends
  v.controller.onAgentMessage({ type: "standby", reason: "moved", text: "Clearcart moved to another window." });
  assert.equal(v.controller.listening, false);
  assert.equal(v.controller.latched, false);
  assert.ok(!v.agent.sent.some((m) => m.type === "user_text"));
  assert.deepEqual(emitted.filter((m) => m.type === RT.VOICE_STATE).at(-1), { type: RT.VOICE_STATE, state: "idle" });
});

test("a restarted worker hears the latch too, so Space still ends it on the page", async () => {
  const emitted = [];
  const v = voice((m) => emitted.push(m));
  await v.controller.start({ latch: true });
  emitted.length = 0;
  v.controller.announce();
  assert.deepEqual(emitted, [{ type: RT.VOICE_STATE, state: "listening", latched: true }]);
});

test("standby stale: waiting for a reply ends, but a newer turn already listening is left alone", async () => {
  const v = voice();
  await v.controller.start();
  v.controller.stop();
  v.stts[0].h.onFinal("buy the advil"); // sent, but the server dropped it
  assert.equal(v.controller.state, "thinking");
  v.controller.onAgentMessage({ type: "standby", reason: "stale", text: "Not sent." });
  assert.equal(v.controller.state, "idle", "not stuck thinking, so other tabs are not kept quiet");
  await v.controller.start(); // a newer press, which takes the session back
  v.controller.onAgentMessage({ type: "standby", reason: "stale", text: "Not sent." });
  assert.equal(v.controller.listening, true);
  assert.equal(v.stts[1].aborted, undefined);
});

// The hotkey content script, loaded the way hotkey.test.mjs does.
const HOTKEY = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "content", "hotkey.js"), "utf8");

function page() {
  const hooks = {};
  vm.runInNewContext(HOTKEY, { __clearcartHotkeyTest: hooks, Promise, setTimeout, clearTimeout });
  const listeners = {};
  const win = { addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); }, removeEventListener() {} };
  const doc = { visibilityState: "visible", addEventListener: () => {} };
  const sent = [];
  const chromeApi = { runtime: { id: OUR_ID, sendMessage: (m) => { sent.push(m.type); return Promise.resolve(); } } };
  hooks.install({ win, doc, chromeApi });
  const fire = (t, e) => (listeners[t] || []).forEach((fn) => fn(e));
  return { fire, sent };
}

function key(code, extra = {}) {
  const e = { code, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, repeat: false, target: { tagName: "DIV" }, defaultPrevented: false, ...extra };
  e.preventDefault = () => { e.defaultPrevented = true; };
  e.stopPropagation = () => {};
  return e;
}

test("hotkey: navigating away or removing the frame mid-hold releases it, so nothing keeps listening", () => {
  const a = page();
  a.fire("keydown", key("Space"));
  a.fire("pagehide", {});
  assert.deepEqual(a.sent, [RT.PTT_START, RT.PTT_CANCEL]);
  a.fire("keyup", key("Space")); // arrives in the new page, if at all
  assert.deepEqual(a.sent, [RT.PTT_START, RT.PTT_CANCEL]);
});

test("hotkey: a press another Clearcart build already took is left to it", () => {
  const p = page();
  for (const alt of [false, true]) {
    p.fire("keydown", key("Space", { altKey: alt, defaultPrevented: true }));
    p.fire("keyup", key("Space", { altKey: alt, defaultPrevented: true }));
  }
  assert.deepEqual(p.sent, []);
  p.fire("keydown", key("Space", { altKey: true }));
  assert.deepEqual(p.sent, [RT.PTT_START], "an untaken press still talks");
});
