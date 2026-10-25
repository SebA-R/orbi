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
import { VoiceController } from "../../lib/voice/controller.js";

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
    setTimer: (fn) => fn(),
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
