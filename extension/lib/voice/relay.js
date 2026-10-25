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
import { RT } from "../protocol.js";
import { loadSettings } from "../settings.js";

export const OFFSCREEN_PATH = "offscreen/offscreen.html";
export const COMMAND_TOGGLE = "toggle-listening";
const TO_TAB = new Set([RT.SUBTITLE, RT.VOICE_STATE, RT.VOICE_ERROR, RT.STATUS, RT.VOICE_PARTIAL, RT.VOICE_FINAL]);

export function createVoiceRelay({ chromeApi = globalThis.chrome, getSettings = () => loadSettings(chromeApi.storage.local), log = () => {} } = {}) {
  let creating = null;
  let lastTabId = null;
  let openedOptions = false;

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
      toTab(msg);
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

  function onTabActivated({ tabId }) {
    lastTabId = tabId;
  }

  return { onMessage, onCommand, onStorageChanged, onTabActivated, ensureOffscreen, closeOffscreen, toggle, idle: () => chain };
}

// Registers the listeners synchronously so Chrome can wake the worker for them.
export function installVoiceRelay(opts = {}) {
  const chromeApi = opts.chromeApi || globalThis.chrome;
  const relay = createVoiceRelay({ ...opts, chromeApi });
  chromeApi.runtime.onMessage.addListener((msg, sender) => { relay.onMessage(msg, sender); });
  chromeApi.commands?.onCommand.addListener((command, tab) => relay.onCommand(command, tab));
  chromeApi.storage.onChanged.addListener((changes, area) => relay.onStorageChanged(changes, area));
  chromeApi.tabs.onActivated?.addListener((info) => relay.onTabActivated(info));
  return relay;
}
