// Worker-side voice wiring: owns the offscreen document's lifecycle and routes
// messages between content scripts and it. The worker only has to call
// installVoiceRelay() at top level (see "Voice and subtitles" in extension/README.md).
//
//   content PTT_START {silent} -> ensure offscreen, VOICE_START {settings, silent} to offscreen
//   content PTT_CONFIRM        -> VOICE_CONFIRM (the key is held: chime, show it)
//   content PTT_CANCEL         -> VOICE_CANCEL (a quick tap: drop the audio)
//   content PTT_STOP           -> VOICE_STOP to offscreen
//   command "toggle-listening" -> PTT_TOGGLE {settings} to offscreen
//   content/popup TTS_STOP     -> TTS_STOP to offscreen
//   storage change             -> SETTINGS_CHANGED {settings} to offscreen (if open)
//   offscreen SUBTITLE / VOICE_STATE / VOICE_ERROR / STATUS -> the active tab
//   offscreen VOICE_ERROR code "mic_blocked" -> open the options page once
//   PTT_CONFIRM and every VOICE_STATE also go to the ducker (duck.js), which
//   quiets other tabs while listening, thinking and speaking
//
// There is one offscreen document, so one mic and one voice turn for every
// tab and frame: a press from another tab while a turn is listening goes to
// that turn, never to a second listener (controller.js). The document
// outlives a worker restart; the new worker sends it VOICE_SYNC and learns
// the state of a turn already in progress from its VOICE_STATE reply.
import { RT } from "../protocol.js";
import { loadSettings } from "../settings.js";
import { createDucker } from "./duck.js";

export const OFFSCREEN_PATH = "offscreen/offscreen.html";
export const COMMAND_TOGGLE = "toggle-listening";
const TO_TAB = new Set([RT.SUBTITLE, RT.VOICE_STATE, RT.VOICE_ERROR, RT.STATUS, RT.VOICE_PARTIAL, RT.VOICE_FINAL]);

export function createVoiceRelay({
  chromeApi = globalThis.chrome,
  getSettings = () => loadSettings(chromeApi.storage.local),
  log = () => {},
  ducker = createDucker({ chromeApi, getSettings, log }),
} = {}) {
  let creating = null;
  let lastTabId = null;
  let openedOptions = false;
  // What the caption card shows right now, so it can follow the user to the
  // tab they switch to: the voice state and the latest line from each speaker.
  const REPLAY_MS = 5000;
  const replay = { state: null, lines: [], at: 0 };

  async function hasOffscreen() {
    const url = chromeApi.runtime.getURL(OFFSCREEN_PATH);
    if (chromeApi.runtime.getContexts) {
      const ctxs = await chromeApi.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
      return ctxs.length > 0;
    }
    return chromeApi.offscreen.hasDocument ? chromeApi.offscreen.hasDocument() : false;
  }

  async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    if (!creating) {
      creating = chromeApi.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
        justification: "Hold-to-talk: microphone capture for speech recognition and playback of spoken replies and chimes.",
      }).catch((err) => {
        // Another caller won the race; that's fine.
        if (!/single offscreen|already exists/i.test(String(err && err.message))) throw err;
      }).finally(() => { creating = null; });
    }
    await creating;
  }

  async function closeOffscreen() {
    if (await hasOffscreen()) await chromeApi.offscreen.closeDocument();
  }

  // Messages to the offscreen document go out strictly in order, so a quick
  // PTT_STOP can't overtake the PTT_START that is still creating the document.
  let chain = Promise.resolve();
  function toOffscreen(build, { create = true } = {}) {
    const run = async () => {
      if (create) await ensureOffscreen();
      else if (!(await hasOffscreen())) return;
      const msg = { ...(typeof build === "function" ? await build() : build), target: "offscreen" };
      try {
        await chromeApi.runtime.sendMessage(msg);
      } catch {
        // A just-created document may not have registered its listener yet.
        await new Promise((r) => setTimeout(r, 100));
        try { await chromeApi.runtime.sendMessage(msg); } catch (err) { log(`offscreen message failed: ${err && err.message}`); }
      }
    };
    chain = chain.then(run, run);
    return chain;
  }

  async function activeTabId() {
    const [tab] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
    return tab && tab.id != null ? tab.id : lastTabId;
  }

  async function toTab(msg) {
    const tabId = lastTabId != null ? lastTabId : await activeTabId();
    if (tabId == null) return;
    const { from, target, ...clean } = msg;
    try {
      await chromeApi.tabs.sendMessage(tabId, clean);
    } catch {
      // Tab has no content script (chrome:// page, still loading). Nothing to show.
    }
  }

  // Returns true when the message was ours (so callers know not to answer it).
  function onMessage(msg, sender = {}) {
    if (!msg || typeof msg.type !== "string") return false;
    if (msg.from === "offscreen") {
      if (!TO_TAB.has(msg.type)) return false;
      remember(msg);
      toTab(msg);
      if (msg.type === RT.VOICE_STATE) ducker.onState(msg.state);
      if (msg.type === RT.VOICE_ERROR) ducker.onError?.();
      if (msg.type === RT.VOICE_ERROR && msg.code === "mic_blocked" && !openedOptions) {
        openedOptions = true;
        chromeApi.runtime.openOptionsPage?.();
      }
      return true;
    }
    if (msg.target === "offscreen") return false; // our own outbound copy
    switch (msg.type) {
      case RT.PTT_START:
        if (sender.tab && sender.tab.id != null) lastTabId = sender.tab.id;
        toOffscreen(async () => ({ type: RT.VOICE_START, settings: await getSettings(), ...(msg.silent ? { silent: true } : {}) }));
        return true;
      case RT.PTT_CONFIRM:
        // Ducking waits for the offscreen doc's "listening" state, so a turn
        // that never starts (mic blocked or failed) mutes nothing.
        toOffscreen({ type: RT.VOICE_CONFIRM }, { create: false });
        return true;
      case RT.PTT_CANCEL:
        toOffscreen({ type: RT.VOICE_CANCEL }, { create: false });
        return true;
      case RT.PTT_STOP:
        toOffscreen({ type: RT.VOICE_STOP }, { create: false });
        return true;
      case RT.PTT_TOGGLE:
        toggle(sender.tab && sender.tab.id);
        return true;
      case RT.TTS_STOP:
        toOffscreen({ type: RT.TTS_STOP }, { create: false });
        return true;
      default:
        return false;
    }
  }

  async function toggle(tabId) {
    const done = toOffscreen(async () => ({ type: RT.PTT_TOGGLE, settings: await getSettings() }));
    lastTabId = tabId != null ? tabId : await activeTabId();
    return done;
  }

  function onCommand(command, tab) {
    if (command !== COMMAND_TOGGLE) return false;
    toggle(tab && tab.id);
    return true;
  }

  function onStorageChanged(_changes, area) {
    if (area !== "local") return;
    toOffscreen(async () => ({ type: RT.SETTINGS_CHANGED, settings: await getSettings() }), { create: false });
  }

  // Each saved line keeps the time it arrived; a new turn (idle -> listening)
  // drops the last turn's lines; a barge-in (speaking -> listening) drops the
  // agent line that was cut off.
  function remember(msg) {
    const { from, target, ...clean } = msg;
    const now = Date.now();
    if (msg.type === RT.VOICE_STATE) {
      const was = replay.state ? replay.state.state : "idle";
      if (clean.state === "listening" && was === "idle") replay.lines = [];
      // Barge-in: the agent line the user cut off is not carried to other tabs.
      else if (clean.state === "listening" && was === "speaking") replay.lines = replay.lines.filter((l) => l.msg.speaker !== "agent");
      replay.state = clean;
    } else if (msg.type === RT.SUBTITLE) {
      replay.lines = [...replay.lines.filter((l) => l.msg.speaker !== clean.speaker), { msg: clean, at: now }];
    } else return;
    replay.at = now;
  }

  // Switching tabs carries the caption along while Clearcart is listening,
  // thinking or speaking, or its last words are still on screen. Lines older
  // than REPLAY_MS are never replayed. Live messages keep flowing to the new
  // tab meanwhile, so a saved message that a newer one has replaced is skipped
  // rather than sent after it.
  async function onTabActivated({ tabId }) {
    if (tabId == null || tabId === lastTabId) return;
    lastTabId = tabId;
    const now = Date.now();
    const state = replay.state;
    const active = state && state.state !== "idle";
    const lines = replay.lines.filter((l) => now - l.at <= REPLAY_MS);
    if (!active && !lines.length) return;
    const queue = [...(state ? [{ kind: "state", msg: state }] : []), ...lines.map((l) => ({ kind: "line", entry: l, msg: l.msg }))];
    for (const item of queue) {
      if (lastTabId !== tabId) return; // the user moved on again
      if (item.kind === "state" ? replay.state !== item.msg : !replay.lines.includes(item.entry)) continue;
      try {
        await chromeApi.tabs.sendMessage(tabId, item.msg);
      } catch {
        return; // no content script there (chrome:// page); nothing to show
      }
    }
  }

  // Switching windows changes the visible tab too.
  async function onWindowFocused(windowId) {
    if (windowId == null || windowId < 0) return;
    const [tab] = await chromeApi.tabs.query({ active: true, windowId }).catch(() => []);
    if (tab && tab.id != null) await onTabActivated({ tabId: tab.id });
  }

  // Worker start: an open offscreen document may be mid-turn (listening,
  // speaking). Ask it to say its state again, so ducking does not restore
  // tabs under a live turn and captions can follow it. Never creates one.
  function resync() {
    return toOffscreen({ type: RT.VOICE_SYNC }, { create: false });
  }

  return { onMessage, onCommand, onStorageChanged, onTabActivated, onWindowFocused, ensureOffscreen, closeOffscreen, toggle, resync, ducker, idle: () => chain };
}

// Registers the listeners synchronously so Chrome can wake the worker for them.
export function installVoiceRelay(opts = {}) {
  const chromeApi = opts.chromeApi || globalThis.chrome;
  const relay = createVoiceRelay({ ...opts, chromeApi });
  chromeApi.runtime.onMessage.addListener((msg, sender) => { relay.onMessage(msg, sender); });
  chromeApi.commands?.onCommand.addListener((command, tab) => relay.onCommand(command, tab));
  chromeApi.storage.onChanged.addListener((changes, area) => relay.onStorageChanged(changes, area));
  chromeApi.tabs.onActivated?.addListener((info) => relay.onTabActivated(info));
  chromeApi.windows?.onFocusChanged?.addListener((id) => relay.onWindowFocused(id));
  chromeApi.tabs.onUpdated?.addListener((id, change) => relay.ducker.onTabUpdated?.(id, change));
  relay.ducker.recover?.().catch(() => {});
  relay.resync().catch(() => {});
  return relay;
}
