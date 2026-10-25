import { test } from "node:test";
import assert from "node:assert/strict";

import { RT } from "../../lib/protocol.js";
import { createVoiceRelay, installVoiceRelay, OFFSCREEN_PATH } from "../../lib/voice/relay.js";

function fakeChrome({ activeTab = 7 } = {}) {
  const state = { offscreen: false, created: [], runtimeSent: [], tabSent: [], optionsOpened: 0, listeners: {} };
  const ev = (name) => ({ addListener: (fn) => { state.listeners[name] = fn; } });
  const chromeApi = {
    runtime: {
      getURL: (p) => `chrome-extension://id/${p}`,
      getContexts: async ({ documentUrls }) => (state.offscreen && documentUrls[0].endsWith(OFFSCREEN_PATH) ? [{}] : []),
      sendMessage: async (m) => { state.runtimeSent.push(m); },
      openOptionsPage: () => { state.optionsOpened++; },
      onMessage: ev("message"),
    },
    offscreen: {
      createDocument: async (opts) => {
        await new Promise((r) => setTimeout(r, 5));
        state.created.push(opts);
        state.offscreen = true;
      },
      closeDocument: async () => { state.offscreen = false; },
    },
    tabs: {
      query: async () => [{ id: activeTab }],
      sendMessage: async (tabId, m) => { state.tabSent.push({ tabId, m }); },
      onActivated: ev("activated"),
    },
    commands: { onCommand: ev("command") },
    storage: { local: {}, onChanged: ev("storage") },
  };
  return { chromeApi, state };
}

const SETTINGS = { speed: 1.2, agentUrl: "ws://localhost:5050", hotkey: "Alt+Space", subtitles: true };
const make = (opts) => {
  const f = fakeChrome(opts);
  const relay = createVoiceRelay({ chromeApi: f.chromeApi, getSettings: async () => SETTINGS });
  return { ...f, relay };
};

test("PTT_START creates the offscreen doc once with USER_MEDIA + AUDIO_PLAYBACK and sends VOICE_START with settings", async () => {
  const { relay, state } = make();
  assert.equal(relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } }), true);
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  await relay.idle();
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].url, OFFSCREEN_PATH);
  assert.deepEqual(state.created[0].reasons, ["USER_MEDIA", "AUDIO_PLAYBACK"]);
  assert.ok(state.created[0].justification);
  assert.deepEqual(state.runtimeSent[0], { type: RT.VOICE_START, settings: SETTINGS, target: "offscreen" });
});

test("a quick PTT_STOP is not lost while the document is still being created", async () => {
  const { relay, state } = make();
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  relay.onMessage({ type: RT.PTT_STOP }, { tab: { id: 3 } });
  await relay.idle();
  assert.deepEqual(state.runtimeSent.map((m) => m.type), [RT.VOICE_START, RT.VOICE_STOP]);
});

test("PTT_STOP and TTS_STOP never create a document", async () => {
  const { relay, state } = make();
  relay.onMessage({ type: RT.PTT_STOP });
  relay.onMessage({ type: RT.TTS_STOP });
  await relay.idle();
  assert.equal(state.created.length, 0);
  assert.equal(state.runtimeSent.length, 0);
});

test("offscreen SUBTITLE and VOICE_STATE go to the tab that started talking, without routing fields", async () => {
  const { relay, state } = make({ activeTab: 9 });
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  await relay.idle();
  relay.onMessage({ type: RT.SUBTITLE, speaker: "agent", text: "Hi", final: true, from: "offscreen" });
  relay.onMessage({ type: RT.VOICE_STATE, state: "speaking", from: "offscreen" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(state.tabSent, [
    { tabId: 3, m: { type: RT.SUBTITLE, speaker: "agent", text: "Hi", final: true } },
    { tabId: 3, m: { type: RT.VOICE_STATE, state: "speaking" } },
  ]);
});

test("with no talking tab yet, offscreen messages go to the active tab; tab switches follow", async () => {
  const { relay, state } = make({ activeTab: 9 });
  relay.onMessage({ type: RT.VOICE_STATE, state: "idle", from: "offscreen" });
  await new Promise((r) => setTimeout(r, 0));
  relay.onTabActivated({ tabId: 11 });
  relay.onMessage({ type: RT.VOICE_STATE, state: "idle", from: "offscreen" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(state.tabSent.map((x) => x.tabId), [9, 11]);
});

test("the relay ignores its own outbound copies and PTT messages the offscreen doc might echo", () => {
  const { relay } = make();
  assert.equal(relay.onMessage({ type: RT.VOICE_START, target: "offscreen" }), false);
  assert.equal(relay.onMessage({ type: RT.PTT_START, from: "offscreen" }), false);
  assert.equal(relay.onMessage({ type: RT.PAGE_CALL }), false);
  assert.equal(relay.onMessage(null), false);
});

test("mic_blocked opens the options page once", async () => {
  const { relay, state } = make();
  relay.onMessage({ type: RT.VOICE_ERROR, code: "mic_blocked", message: "x", from: "offscreen" });
  relay.onMessage({ type: RT.VOICE_ERROR, code: "mic_blocked", message: "x", from: "offscreen" });
  assert.equal(state.optionsOpened, 1);
});

test("toggle-listening command sends PTT_TOGGLE; other commands are ignored", async () => {
  const { relay, state } = make();
  assert.equal(relay.onCommand("something-else"), false);
  assert.equal(relay.onCommand("toggle-listening", { id: 4 }), true);
  await relay.idle();
  assert.deepEqual(state.runtimeSent, [{ type: RT.PTT_TOGGLE, settings: SETTINGS, target: "offscreen" }]);
});

test("storage changes push SETTINGS_CHANGED only when the document exists", async () => {
  const { relay, state } = make();
  relay.onStorageChanged({ speed: {} }, "local");
  await relay.idle();
  assert.equal(state.runtimeSent.length, 0);
  await relay.ensureOffscreen();
  relay.onStorageChanged({ speed: {} }, "local");
  relay.onStorageChanged({ x: {} }, "sync");
  await relay.idle();
  assert.deepEqual(state.runtimeSent, [{ type: RT.SETTINGS_CHANGED, settings: SETTINGS, target: "offscreen" }]);
  await relay.closeOffscreen();
  assert.equal(state.offscreen, false);
});

test("installVoiceRelay registers message, command, storage and tab listeners", () => {
  const { chromeApi, state } = fakeChrome();
  installVoiceRelay({ chromeApi, getSettings: async () => SETTINGS });
  assert.deepEqual(Object.keys(state.listeners).sort(), ["activated", "command", "message", "storage"]);
});

test("PTT_START silent, PTT_CONFIRM and PTT_CANCEL reach the offscreen doc in order", async () => {
  const { relay, state } = make();
  relay.onMessage({ type: RT.PTT_START, silent: true }, { tab: { id: 7 } });
  relay.onMessage({ type: RT.PTT_CONFIRM }, { tab: { id: 7 } });
  relay.onMessage({ type: RT.PTT_CANCEL }, { tab: { id: 7 } });
  await relay.idle();
  assert.deepEqual(state.runtimeSent.map((m) => [m.type, m.silent]), [
    [RT.VOICE_START, true], [RT.VOICE_CONFIRM, undefined], [RT.VOICE_CANCEL, undefined],
  ]);
});

test("switching tabs carries the current caption and state to the new tab", async () => {
  const { relay, state } = make({ activeTab: 3 });
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  relay.onMessage({ type: RT.VOICE_STATE, state: "speaking", from: "offscreen" });
  relay.onMessage({ type: RT.SUBTITLE, speaker: "user", text: "reorder my pills", final: true, from: "offscreen" });
  relay.onMessage({ type: RT.SUBTITLE, speaker: "agent", text: "Three options.", final: false, from: "offscreen" });
  await relay.idle();
  state.tabSent.length = 0;
  await relay.onTabActivated({ tabId: 8 });
  assert.deepEqual(state.tabSent.map((x) => [x.tabId, x.m.type, x.m.text || x.m.state]), [
    [8, RT.VOICE_STATE, "speaking"], [8, RT.SUBTITLE, "reorder my pills"], [8, RT.SUBTITLE, "Three options."],
  ]);
  assert.ok(state.tabSent.every((x) => !("from" in x.m)));
  relay.onMessage({ type: RT.SUBTITLE, speaker: "agent", text: "Three options. Which one?", final: true, from: "offscreen" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(state.tabSent.at(-1).tabId, 8, "later lines go to the new tab");
});

test("an old idle caption does not follow to a new tab", async () => {
  const { relay, state } = make();
  relay.onMessage({ type: RT.VOICE_STATE, state: "idle", from: "offscreen" });
  await new Promise((r) => setTimeout(r, 0));
  state.tabSent.length = 0;
  const real = Date.now;
  Date.now = () => real() + 6000;
  try {
    await relay.onTabActivated({ tabId: 12 });
  } finally {
    Date.now = real;
  }
  assert.deepEqual(state.tabSent, []);
});

test("a new turn drops the last turn's lines, and stale lines never replay even while active", async () => {
  const { relay, state } = make({ activeTab: 3 });
  const off = (m) => relay.onMessage({ ...m, from: "offscreen" });
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  off({ type: RT.VOICE_STATE, state: "speaking" });
  off({ type: RT.SUBTITLE, speaker: "agent", text: "Old answer.", final: true });
  off({ type: RT.VOICE_STATE, state: "idle" });
  off({ type: RT.VOICE_STATE, state: "listening" }); // new turn
  await relay.idle();
  state.tabSent.length = 0;
  await relay.onTabActivated({ tabId: 8 });
  assert.deepEqual(state.tabSent.map((x) => x.m.text || x.m.state), ["listening"]);

  off({ type: RT.SUBTITLE, speaker: "user", text: "reorder", final: false });
  await new Promise((r) => setTimeout(r, 0));
  state.tabSent.length = 0;
  const real = Date.now;
  Date.now = () => real() + 6000;
  try {
    await relay.onTabActivated({ tabId: 9 });
  } finally {
    Date.now = real;
  }
  assert.deepEqual(state.tabSent.map((x) => x.m.text || x.m.state), ["listening"], "state yes, 6 s old line no");
});

test("a barge-in drops the cut-off agent line from the replay", async () => {
  const { relay, state } = make({ activeTab: 3 });
  const off = (m) => relay.onMessage({ ...m, from: "offscreen" });
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  off({ type: RT.SUBTITLE, speaker: "user", text: "find pills", final: true });
  off({ type: RT.VOICE_STATE, state: "speaking" });
  off({ type: RT.SUBTITLE, speaker: "agent", text: "I found three options", final: true });
  off({ type: RT.VOICE_STATE, state: "listening" }); // user held Space over us
  await relay.idle();
  state.tabSent.length = 0;
  await relay.onTabActivated({ tabId: 8 });
  assert.deepEqual(state.tabSent.map((x) => x.m.text || x.m.state), ["listening", "find pills"]);
});

test("a replayed line is skipped once a newer live line for that speaker has gone out", async () => {
  const { relay, state, chromeApi } = make({ activeTab: 3 });
  const off = (m) => relay.onMessage({ ...m, from: "offscreen" });
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  off({ type: RT.VOICE_STATE, state: "speaking" });
  off({ type: RT.SUBTITLE, speaker: "agent", text: "Three", final: false });
  await relay.idle();
  state.tabSent.length = 0;
  const send = chromeApi.tabs.sendMessage;
  let first = true;
  chromeApi.tabs.sendMessage = async (tabId, m) => {
    await send(tabId, m);
    if (first) { first = false; off({ type: RT.SUBTITLE, speaker: "agent", text: "Three options.", final: false }); }
  };
  await relay.onTabActivated({ tabId: 8 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(state.tabSent.map((x) => x.m.text || x.m.state), ["speaking", "Three options."]);
});
