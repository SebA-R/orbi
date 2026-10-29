// Worker-side voice wiring: owns the offscreen document's lifecycle and routes
// messages between content scripts and it. The worker only has to call
// installVoiceRelay() at top level (see "Voice and subtitles" in extension/README.md).
//
//   content PTT_START {silent, latch} -> ensure offscreen, VOICE_START {settings, silent, latch} to offscreen
//   content PTT_CONFIRM        -> VOICE_CONFIRM (the key is held: listen sound, show it)
//   content PTT_CANCEL         -> VOICE_CANCEL (a quick tap: drop the audio)
//   content PTT_STOP           -> VOICE_STOP to offscreen
//   content PTT_HUSH           -> VOICE_HUSH (double-tap Space while speaking: hard-stop
//                                 the speech), only from the tab that is talking
//   command "toggle-listening" -> PTT_TOGGLE {settings} to offscreen
//   content/popup TTS_STOP     -> TTS_STOP to offscreen
//   popup/new tab TYPED_TEXT {text} -> VOICE_TYPED {text} (typed instead of
//                                 said; only from those two extension pages)
//   content VOICE_STATE_QUERY  -> the current VOICE_STATE back to that tab (the
//                                 popup, which has no tab: as the reply). Not
//                                 known yet (a restarted worker): asks the
//                                 offscreen document first (VOICE_SYNC)
//   tab load complete          -> a new document in the talking tab (a link
//                                 followed mid-turn) starts idle: the state and
//                                 recent lines again, as on a tab switch
//   storage change             -> SETTINGS_CHANGED {settings} to offscreen (if open)
//   offscreen SUBTITLE / SUBTITLE_WORD / VOICE_STATE / VOICE_ERROR / STATUS -> the active tab
//   offscreen VOICE_ERROR code "mic_blocked" -> open the options page once
//   PTT_CONFIRM and every VOICE_STATE also go to the ducker (duck.js), which
//   quiets other tabs while listening, thinking and speaking
//   every VOICE_STATE also goes to onVoiceState(state, tabId), with the tab it
//   went to (the worker's active-tab frame, background/frame.js)
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
// The extension pages with a "Type to Orbi" box (basic voice).
export const TYPING_PAGES = Object.freeze(["popup/popup.html", "newtab/newtab.html"]);
export const TYPED_MAX = 2000;
export const COMMAND_TOGGLE = "toggle-listening";
const TO_TAB = new Set([RT.SUBTITLE, RT.SUBTITLE_WORD, RT.VOICE_STATE, RT.VOICE_ERROR, RT.STATUS, RT.VOICE_PARTIAL, RT.VOICE_FINAL]);

export function createVoiceRelay({
  chromeApi = globalThis.chrome,
  getSettings = () => loadSettings(chromeApi.storage.local),
  log = () => {},
  ducker = createDucker({ chromeApi, getSettings, log }),
  onVoiceState = () => {},
} = {}) {
  let creating = null;
  let lastTabId = null;
  let openedOptions = false;
  // What the caption card shows right now, so it can follow the user to the
  // tab they switch to: the voice state and the latest line from each speaker.
  const REPLAY_MS = 5000;
  // word is the latest SUBTITLE_WORD for the saved agent line (karaoke), so
  // a tab switched to mid-line shows the word being heard, not the first.
  const replay = { state: null, lines: [], word: null, at: 0 };
  // A tab whose switch-to replay found no content script yet (still
  // loading): it gets the replay again when its load completes.
  let retryTab = null;
  // Waiting for the offscreen document's VOICE_STATE (stateKnown).
  let stateWaiters = [];
  const STATE_WAIT_MS = 1000;
  const RELOAD_RETRY_MS = 400;

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
        justification: "Hold-to-talk: microphone capture for speech recognition and playback of spoken replies and sound cues.",
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

  // Same tab toTab picks. One chain, so states reach onVoiceState in the
  // order they came even when the tab has to be looked up.
  let stateChain = Promise.resolve();
  function noteState(state) {
    const call = (id) => { try { onVoiceState(state, id ?? null); } catch {} };
    stateChain = stateChain
      .then(() => (lastTabId != null ? lastTabId : activeTabId()))
      .then(call, () => call(null));
  }

  async function toTab(msg) {
    const tabId = lastTabId != null ? lastTabId : await activeTabId();
    if (tabId == null) return;
    const { from, target, ...clean } = msg;
    // Only the voice state is read in subframes (hotkey.js); the rest goes to the top frame.
    const opts = msg.type === RT.VOICE_STATE ? undefined : { frameId: 0 };
    try {
      await chromeApi.tabs.sendMessage(tabId, clean, opts);
    } catch {
      // Tab has no content script (chrome:// page, still loading). Nothing to show.
    }
  }

  // A restarted worker has no state on record: ask the offscreen document
  // (if there is one) to say it, and wait a moment for it. Idle otherwise.
  // One pending ask at a time, shared by every query that comes meanwhile.
  let asking = null;
  function stateKnown() {
    if (replay.state) return Promise.resolve();
    if (asking) return asking;
    asking = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        stateWaiters = stateWaiters.filter((w) => w !== finish);
        asking = null;
        resolve();
      };
      stateWaiters.push(finish);
      setTimeout(finish, STATE_WAIT_MS);
      toOffscreen({ type: RT.VOICE_SYNC }, { create: false }).then(() => hasOffscreen()).then((open) => { if (!open) finish(); }, finish);
    });
    return asking;
  }

  // Returns true when the message was ours (so callers know not to answer it).
  // sendResponse: the reply to a message with no tab (the popup's query).
  function onMessage(msg, sender = {}, sendResponse = null) {
    if (!msg || typeof msg.type !== "string") return false;
    if (msg.from === "offscreen") {
      if (!TO_TAB.has(msg.type)) return false;
      remember(msg);
      if (msg.type === RT.VOICE_STATE && stateWaiters.length) {
        const waiters = stateWaiters;
        stateWaiters = [];
        for (const w of waiters) w();
      }
      toTab(msg);
      if (msg.type === RT.VOICE_STATE) {
        ducker.onState(msg.state);
        noteState(msg.state);
      }
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
        toOffscreen(async () => ({ type: RT.VOICE_START, settings: await getSettings(), ...(msg.silent ? { silent: true } : {}), ...(msg.latch ? { latch: true } : {}) }));
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
      case RT.PTT_HUSH:
        // A double-tap in another tab must not stop this one; just drop its
        // first tap's silent start.
        if (sender.tab && sender.tab.id != null && lastTabId != null && sender.tab.id !== lastTabId) {
          toOffscreen({ type: RT.VOICE_CANCEL }, { create: false });
          return true;
        }
        toOffscreen({ type: RT.VOICE_HUSH }, { create: false });
        return true;
      case RT.PTT_TOGGLE:
        toggle(sender.tab && sender.tab.id);
        return true;
      case RT.TTS_STOP:
        toOffscreen({ type: RT.TTS_STOP }, { create: false });
        return true;
      case RT.TYPED_TEXT: {
        // The user's own words, so only from Orbi's own pages, never a
        // content script on a web page.
        if (!typingPage(sender)) return true;
        const text = typeof msg.text === "string" ? msg.text.replace(/\s+/g, " ").trim().slice(0, TYPED_MAX) : "";
        if (!text) return true;
        // Captions go to the new tab page that sent it, or (the popup) the
        // tab in front now. Settings ride along, as on VOICE_START: a
        // document this creates knows nothing else of them.
        if (sender.tab && sender.tab.id != null) lastTabId = sender.tab.id;
        const typedTab = sender.tab && sender.tab.id != null ? null : activeTabId().then((id) => { if (id != null) lastTabId = id; }, () => {});
        toOffscreen(async () => { await typedTab; return { type: RT.VOICE_TYPED, text, settings: await getSettings() }; });
        return true;
      }
      case RT.VOICE_STATE_QUERY: {
        // A tab became visible again: tell it the current state (the hotkey
        // needs it for the latch and the double-tap). It is the reply too,
        // for the popup, which has no tab to send it to.
        const tabId = sender.tab && sender.tab.id != null ? sender.tab.id : null;
        const answer = () => {
          const { from, target, ...state } = replay.state || { type: RT.VOICE_STATE, state: "idle" };
          if (typeof sendResponse === "function") { try { sendResponse(state); } catch {} }
          if (tabId != null) { try { chromeApi.tabs.sendMessage(tabId, state)?.catch?.(() => {}); } catch {} }
        };
        if (replay.state) answer();
        else stateKnown().then(answer, answer);
        return true;
      }
      default:
        return false;
    }
  }

  function typingPage(sender) {
    if (!sender || sender.id !== chromeApi.runtime.id || typeof sender.url !== "string") return false;
    const path = sender.url.split(/[?#]/)[0];
    return TYPING_PAGES.some((p) => path === chromeApi.runtime.getURL(p));
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
      if (!replay.lines.some((l) => l.msg.speaker === "agent")) replay.word = null;
      replay.state = clean;
    } else if (msg.type === RT.SUBTITLE) {
      replay.lines = [...replay.lines.filter((l) => l.msg.speaker !== clean.speaker), { msg: clean, at: now }];
      if (clean.speaker === "agent" && (!replay.word || replay.word.utteranceId !== clean.utteranceId)) replay.word = null;
    } else if (msg.type === RT.SUBTITLE_WORD) {
      // Only for the agent line on record; a line being heard stays fresh.
      const line = replay.lines.find((l) => l.msg.speaker === "agent" && l.msg.utteranceId === clean.utteranceId);
      if (!line) return;
      line.at = now;
      replay.word = clean;
      replay.wordAt = now;
    } else return;
    replay.at = now;
  }

  // Switching tabs carries the caption along while Orbi is listening,
  // thinking or speaking, or its last words are still on screen. Lines older
  // than REPLAY_MS are never replayed. Live messages keep flowing to the new
  // tab meanwhile, so a saved message that a newer one has replaced is skipped
  // rather than sent after it.
  async function onTabActivated({ tabId }) {
    if (tabId == null || tabId === lastTabId) return;
    lastTabId = tabId;
    if (retryTab !== tabId) retryTab = null;
    if ((await replayTo(tabId)) === "failed" && lastTabId === tabId) retryTab = tabId;
  }

  // The caption card's state and recent lines, to a tab that has none of
  // them yet. "failed" when the tab has no content script to take them (a
  // chrome:// page, or one still loading).
  async function replayTo(tabId) {
    const now = Date.now();
    const state = replay.state;
    const active = state && state.state !== "idle";
    const lines = replay.lines.filter((l) => now - l.at <= REPLAY_MS);
    if (!active && !lines.length) return "nothing";
    const word = replay.word && lines.some((l) => l.msg.utteranceId === replay.word.utteranceId) ? replay.word : null;
    const queue = [
      ...(state ? [{ kind: "state", msg: state }] : []),
      ...lines.map((l) => ({ kind: "line", entry: l, msg: l.msg })),
      ...(word ? [{ kind: "word", msg: word }] : []),
    ];
    for (const item of queue) {
      if (lastTabId !== tabId) return "moved"; // the user moved on again
      if (item.kind === "state" ? replay.state !== item.msg
        : item.kind === "word" ? replay.word !== item.msg
        : !replay.lines.includes(item.entry)) continue;
      // A word still being heard has gone on since it was saved: the new
      // tab's sweep across it picks up where the voice is now.
      const out = item.kind === "word" && !item.msg.frozen && Number.isFinite(item.msg.elapsed) && Number.isFinite(item.msg.ms)
        ? { ...item.msg, elapsed: Math.min(item.msg.ms, item.msg.elapsed + (Date.now() - replay.wordAt)) }
        : item.msg;
      try {
        await chromeApi.tabs.sendMessage(tabId, out);
      } catch {
        return "failed"; // no content script there (chrome:// page); nothing to show
      }
    }
    return "sent";
  }

  // A new document in the talking tab (a link followed or a page opened
  // mid-turn) starts with an idle card: once it has loaded, the state and
  // recent lines again, while Orbi is busy or a switch-to replay failed.
  // Its content scripts may load just after "complete", so a failure is
  // tried once more a moment later.
  async function onTabUpdated(tabId, change) {
    if (!change || change.status !== "complete" || tabId == null || tabId !== lastTabId) return;
    const busy = replay.state && replay.state.state !== "idle";
    if (!busy && retryTab !== tabId) return;
    retryTab = null;
    if ((await replayTo(tabId)) !== "failed") return;
    await new Promise((r) => setTimeout(r, RELOAD_RETRY_MS));
    if (tabId === lastTabId) await replayTo(tabId);
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

  return { onMessage, onCommand, onStorageChanged, onTabActivated, onTabUpdated, onWindowFocused, ensureOffscreen, closeOffscreen, toggle, resync, ducker, idle: () => chain, statesIdle: () => stateChain };
}

// Registers the listeners synchronously so Chrome can wake the worker for them.
export function installVoiceRelay(opts = {}) {
  const chromeApi = opts.chromeApi || globalThis.chrome;
  const relay = createVoiceRelay({ ...opts, chromeApi });
  chromeApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    relay.onMessage(msg, sender, sendResponse);
    // A state query may be answered after a VOICE_SYNC round trip.
    if (msg && msg.type === RT.VOICE_STATE_QUERY) return true;
  });
  chromeApi.commands?.onCommand.addListener((command, tab) => relay.onCommand(command, tab));
  chromeApi.storage.onChanged.addListener((changes, area) => relay.onStorageChanged(changes, area));
  chromeApi.tabs.onActivated?.addListener((info) => relay.onTabActivated(info));
  chromeApi.windows?.onFocusChanged?.addListener((id) => relay.onWindowFocused(id));
  chromeApi.tabs.onUpdated?.addListener((id, change) => {
    relay.ducker.onTabUpdated?.(id, change);
    relay.onTabUpdated(id, change).catch(() => {});
  });
  relay.ducker.recover?.().catch(() => {});
  relay.resync().catch(() => {});
  return relay;
}
