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

test("PTT_START latch passes through to VOICE_START", async () => {
  const { relay, state } = make();
  relay.onMessage({ type: RT.PTT_START, latch: true }, { tab: { id: 3 } });
  await relay.idle();
  assert.deepEqual(state.runtimeSent[0], { type: RT.VOICE_START, settings: SETTINGS, latch: true, target: "offscreen" });
});

test("PTT_HUSH reaches the offscreen doc only from the tab that is talking", async () => {
  const { relay, state } = make();
  relay.onMessage({ type: RT.PTT_START, silent: true }, { tab: { id: 3 } });
  relay.onMessage({ type: RT.PTT_HUSH }, { tab: { id: 9 } });
  relay.onMessage({ type: RT.PTT_HUSH }, { tab: { id: 3 } });
  await relay.idle();
  assert.deepEqual(state.runtimeSent.map((m) => m.type), [RT.VOICE_START, RT.VOICE_CANCEL, RT.VOICE_HUSH]);
});

test("a latched listening state follows to the next tab with latched kept", async () => {
  const { relay, state } = make();
  relay.onMessage({ type: RT.PTT_START, latch: true }, { tab: { id: 3 } });
  relay.onMessage({ type: RT.VOICE_STATE, state: "listening", latched: true, from: "offscreen" });
  await relay.idle();
  await relay.onTabActivated({ tabId: 4 });
  assert.deepEqual(state.tabSent.filter((s) => s.tabId === 4).map((s) => s.m), [{ type: RT.VOICE_STATE, state: "listening", latched: true }]);
});

test("a hush from another tab only drops that tab's silent start", async () => {
  const { relay, state } = make();
  relay.onMessage({ type: RT.PTT_START, silent: true }, { tab: { id: 3 } });
  relay.onMessage({ type: RT.PTT_HUSH }, { tab: { id: 9 } });
  await relay.idle();
  assert.deepEqual(state.runtimeSent.map((m) => m.type), [RT.VOICE_START, RT.VOICE_CANCEL]);
});

test("VOICE_STATE_QUERY answers the asking tab with the current state", async () => {
  const { relay, state } = make();
  relay.onMessage({ type: RT.VOICE_STATE_QUERY }, { tab: { id: 5 } });
  await new Promise((r) => setTimeout(r, 10)); // no offscreen document: idle
  relay.onMessage({ type: RT.VOICE_STATE, state: "listening", latched: true, from: "offscreen" });
  relay.onMessage({ type: RT.VOICE_STATE_QUERY }, { tab: { id: 5 } });
  await relay.idle();
  const to5 = state.tabSent.filter((s) => s.tabId === 5).map((s) => s.m);
  assert.deepEqual(to5[0], { type: RT.VOICE_STATE, state: "idle" });
  assert.deepEqual(to5.at(-1), { type: RT.VOICE_STATE, state: "listening", latched: true });
});

test("karaoke: a tab switched to mid-line gets the line, then the word being heard", async () => {
  const { relay, state } = make({ activeTab: 3 });
  const off = (m) => relay.onMessage({ ...m, from: "offscreen" });
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  off({ type: RT.VOICE_STATE, state: "speaking" });
  off({ type: RT.SUBTITLE, speaker: "agent", text: "Found it, nine dollars.", final: true, utteranceId: "u1", karaoke: true });
  off({ type: RT.SUBTITLE_WORD, utteranceId: "u1", index: 1 });
  off({ type: RT.SUBTITLE_WORD, utteranceId: "u1", index: 2 });
  await relay.idle();
  assert.ok(state.tabSent.some((x) => x.tabId === 3 && x.m.type === RT.SUBTITLE_WORD && x.m.index === 2), "live words go to the tab");
  state.tabSent.length = 0;
  await relay.onTabActivated({ tabId: 8 });
  assert.deepEqual(state.tabSent.map((x) => [x.tabId, x.m.type, x.m.index ?? x.m.text ?? x.m.state]), [
    [8, RT.VOICE_STATE, "speaking"], [8, RT.SUBTITLE, "Found it, nine dollars."], [8, RT.SUBTITLE_WORD, 2],
  ]);
});

test("karaoke: a word for another line is not replayed; a barge-in or a new line drops it", async () => {
  const { relay, state } = make({ activeTab: 3 });
  const off = (m) => relay.onMessage({ ...m, from: "offscreen" });
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  off({ type: RT.VOICE_STATE, state: "speaking" });
  off({ type: RT.SUBTITLE, speaker: "agent", text: "First.", final: true, utteranceId: "u1", karaoke: true });
  off({ type: RT.SUBTITLE_WORD, utteranceId: "u1", index: 0 });
  off({ type: RT.SUBTITLE, speaker: "agent", text: "Second one.", final: true, utteranceId: "u2", karaoke: true });
  off({ type: RT.SUBTITLE_WORD, utteranceId: "u9", index: 0 }); // not the line on record
  await relay.idle();
  state.tabSent.length = 0;
  await relay.onTabActivated({ tabId: 8 });
  assert.deepEqual(state.tabSent.map((x) => x.m.type), [RT.VOICE_STATE, RT.SUBTITLE]);

  off({ type: RT.SUBTITLE_WORD, utteranceId: "u2", index: 1 });
  off({ type: RT.VOICE_STATE, state: "listening" }); // barge-in
  await new Promise((r) => setTimeout(r, 0));
  state.tabSent.length = 0;
  await relay.onTabActivated({ tabId: 9 });
  assert.deepEqual(state.tabSent.map((x) => x.m.type), [RT.VOICE_STATE]);
});

test("a page loading in the talking tab mid-turn gets the state and recent lines again", async () => {
  const { relay, state } = make({ activeTab: 3 });
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  await relay.idle();
  relay.onMessage({ type: RT.SUBTITLE, speaker: "user", text: "find socks", final: true, from: "offscreen" });
  relay.onMessage({ type: RT.VOICE_STATE, state: "thinking", from: "offscreen" });
  await new Promise((r) => setTimeout(r, 0));
  state.tabSent.length = 0;
  await relay.onTabUpdated(3, { status: "loading" });
  await relay.onTabUpdated(9, { status: "complete" }); // not the talking tab
  assert.deepEqual(state.tabSent, []);
  await relay.onTabUpdated(3, { status: "complete" });
  assert.deepEqual(state.tabSent.map((x) => [x.tabId, x.m.type, x.m.state || x.m.text]), [
    [3, RT.VOICE_STATE, "thinking"], [3, RT.SUBTITLE, "find socks"],
  ]);
});

test("a load completing again in the same document (a frame, a same-page navigation) replays nothing", async () => {
  const { relay, state, chromeApi } = make({ activeTab: 3 });
  let doc = "doc-1";
  chromeApi.scripting = { executeScript: async () => [{ frameId: 0, documentId: doc }] };
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 }, frameId: 0, documentId: "doc-1" });
  await relay.idle();
  relay.onMessage({ type: RT.SUBTITLE, speaker: "user", text: "find socks", final: true, from: "offscreen" });
  relay.onMessage({ type: RT.VOICE_STATE, state: "thinking", from: "offscreen" });
  await new Promise((r) => setTimeout(r, 0));
  state.tabSent.length = 0;
  await relay.onTabUpdated(3, { status: "complete" }); // an ad frame loaded
  assert.deepEqual(state.tabSent, [], "the page that pressed the key has the card");
  doc = "doc-2"; // a link followed
  await relay.onTabUpdated(3, { status: "complete" });
  assert.deepEqual(state.tabSent.map((x) => x.m.type), [RT.VOICE_STATE, RT.SUBTITLE]);
  state.tabSent.length = 0;
  await relay.onTabUpdated(3, { status: "complete" });
  assert.deepEqual(state.tabSent, [], "replayed once per document");
});

test("an idle tab's load replays nothing", async () => {
  const { relay, state } = make({ activeTab: 3 });
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  await relay.idle();
  relay.onMessage({ type: RT.VOICE_STATE, state: "idle", from: "offscreen" });
  await new Promise((r) => setTimeout(r, 0));
  state.tabSent.length = 0;
  await relay.onTabUpdated(3, { status: "complete" });
  assert.deepEqual(state.tabSent, []);
});

test("a switch-to replay that found no content script is sent again when that tab loads", async () => {
  const { relay, state, chromeApi } = make({ activeTab: 3 });
  relay.onMessage({ type: RT.PTT_START }, { tab: { id: 3 } });
  await relay.idle();
  relay.onMessage({ type: RT.SUBTITLE, speaker: "agent", text: "All done.", final: true, from: "offscreen" });
  relay.onMessage({ type: RT.VOICE_STATE, state: "idle", from: "offscreen" });
  await new Promise((r) => setTimeout(r, 0));
  const send = chromeApi.tabs.sendMessage;
  chromeApi.tabs.sendMessage = async () => { throw new Error("Receiving end does not exist"); };
  await relay.onTabActivated({ tabId: 8 }); // still loading
  chromeApi.tabs.sendMessage = send;
  state.tabSent.length = 0;
  await relay.onTabUpdated(8, { status: "complete" });
  assert.deepEqual(state.tabSent.map((x) => [x.tabId, x.m.type, x.m.state || x.m.text]), [
    [8, RT.VOICE_STATE, "idle"], [8, RT.SUBTITLE, "All done."],
  ]);
  state.tabSent.length = 0;
  await relay.onTabUpdated(8, { status: "complete" });
  assert.deepEqual(state.tabSent, [], "only once: it is idle");
});

test("the popup's VOICE_STATE_QUERY is answered as the reply", async () => {
  const { relay, state } = make();
  relay.onMessage({ type: RT.VOICE_STATE, state: "thinking", from: "offscreen" });
  const got = [];
  relay.onMessage({ type: RT.VOICE_STATE_QUERY }, { id: "id" }, (r) => got.push(r));
  assert.deepEqual(got, [{ type: RT.VOICE_STATE, state: "thinking" }]);
  assert.ok(!state.tabSent.some((x) => x.m.type === RT.VOICE_STATE && x.tabId == null));
});

test("a restarted worker asks the offscreen document before answering a state query", async () => {
  const f = fakeChrome();
  f.state.offscreen = true;
  let relay;
  f.chromeApi.runtime.sendMessage = async (m) => {
    f.state.runtimeSent.push(m);
    if (m.type === RT.VOICE_SYNC) setTimeout(() => relay.onMessage({ type: RT.VOICE_STATE, state: "thinking", from: "offscreen" }), 1);
  };
  relay = createVoiceRelay({ chromeApi: f.chromeApi, getSettings: async () => SETTINGS });
  const got = await new Promise((resolve) => relay.onMessage({ type: RT.VOICE_STATE_QUERY }, {}, resolve));
  assert.deepEqual(got, { type: RT.VOICE_STATE, state: "thinking" }, "not idle: a turn is in progress");
  assert.ok(f.state.runtimeSent.some((m) => m.type === RT.VOICE_SYNC));
  relay.onMessage({ type: RT.VOICE_STATE_QUERY }, { tab: { id: 5 } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(f.state.tabSent.filter((x) => x.tabId === 5).map((x) => x.m.state), ["thinking"]);
});

test("installVoiceRelay keeps the channel open for a state query only", () => {
  const { chromeApi, state } = fakeChrome();
  installVoiceRelay({ chromeApi, getSettings: async () => SETTINGS });
  assert.equal(state.listeners.message({ type: RT.VOICE_STATE_QUERY }, {}, () => {}), true);
  assert.equal(state.listeners.message({ type: RT.VOICE_STATE_QUERY }, { tab: { id: 2 } }, () => {}), true);
  assert.equal(state.listeners.message({ type: RT.PTT_STOP }, { tab: { id: 2 } }, () => {}), undefined);
});
