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
