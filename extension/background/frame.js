// Decides which tab shows the active-tab frame (content/frame.js) and tells
// it: RT.FRAME { on: true } to that tab's top frame, { on: false } to the tab
// that had it before.
//
// The frame is on the tab Orbi is acting on while a voice turn is in
// progress (any voice state but idle), or while that tab is under agent
// control (a bridge call touched it within HOLD_MS, for turns that do not
// come through voice). Before the agent touches a tab in a turn, the frame
// is on the tab the user is talking in. A new turn starts from that tab
// again; the end of a turn (back to idle) hides it. At most one tab has it.

import { RT } from "../lib/protocol.js";

export const FRAME_FILES = ["content/frame.js"];
// How long the frame stays up after the last agent call on a text-only turn.
export const HOLD_MS = 10_000;
// Voice states that mean a turn is in progress; anything else counts as idle.
const ACTIVE = new Set(["listening", "thinking", "speaking"]);
// The framed tab, kept across worker restarts so a lost "off" can be sent.
export const SHOWN_KEY = "clearcartFrameTab";

export function createFrame({
  chromeApi = globalThis.chrome,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  holdMs = HOLD_MS,
} = {}) {
  let turn = false;     // a voice turn is in progress
  let turnTab = null;   // the tab the user is talking in
  let agentTab = null;  // the tab the agent last acted on (this turn, or within the hold)
  let held = false;     // the agent acted on agentTab within holdMs
  let holdTimer = null;
  let shown = null;     // the tab that has the frame now

  function target() {
    if (held && agentTab != null) return agentTab;
    if (turn) return agentTab != null ? agentTab : turnTab;
    return null;
  }

  // frame.js answers { frame: true }; another content script answering, or
  // none, means it is not there.
  async function deliver(tabId, on) {
    try {
      const r = await chromeApi.tabs.sendMessage(tabId, { type: RT.FRAME, on }, { frameId: 0 });
      return !!(r && r.frame === true);
    } catch {
      return false;
    }
  }

  async function send(tabId, on) {
    if (await deliver(tabId, on) || !on) return; // nothing there to hide
    // No frame script yet (a tab open since before install): add it once.
    try {
      await chromeApi.scripting.executeScript({ target: { tabId }, files: FRAME_FILES });
    } catch {
      return; // chrome:// page, error page, closed tab: nothing to show.
    }
    // The frame may have moved on while the script loaded: send what is true now.
    await deliver(tabId, shown === tabId);
  }

  function persist() {
    try {
      const area = chromeApi.storage && chromeApi.storage.session;
      if (!area) return;
      const p = shown == null ? area.remove(SHOWN_KEY) : area.set({ [SHOWN_KEY]: shown });
      Promise.resolve(p).catch(() => {});
    } catch {}
  }

  // A restarted worker forgets the frame: turn off the one it left on.
  async function recover() {
    const area = chromeApi.storage && chromeApi.storage.session;
    if (!area) return;
    const { [SHOWN_KEY]: tabId } = (await area.get(SHOWN_KEY)) || {};
    if (tabId == null || tabId === shown) return;
    await area.remove(SHOWN_KEY);
    await deliver(tabId, false);
  }

  function sync() {
    const next = target();
    if (next === shown) return;
    const prev = shown;
    shown = next;
    persist();
    if (prev != null) void send(prev, false);
    if (next != null) void send(next, true);
  }

  // Every VOICE_STATE the relay forwards, with the tab it went to.
  function onVoiceState(state, tabId) {
    const active = ACTIVE.has(state);
    const wasTurn = turn;
    if (active && !turn) {
      // A new turn starts on the tab the user is talking in.
      agentTab = null;
      release();
    }
    turn = active;
    if (active && tabId != null) turnTab = tabId;
    if (!active && wasTurn) {
      // The turn is over: no frame, even if the agent acted just now.
      agentTab = null;
      release();
    }
    sync();
  }

  // Every bridge call that acts on a tab.
  function onAgentTab(tabId) {
    if (tabId == null) return;
    agentTab = tabId;
    held = true;
    if (holdTimer != null) clearTimer(holdTimer);
    holdTimer = setTimer(() => {
      holdTimer = null;
      held = false;
      if (!turn) agentTab = null;
      sync();
    }, holdMs);
    sync();
  }

  function release() {
    held = false;
    if (holdTimer != null) clearTimer(holdTimer);
    holdTimer = null;
  }

  // A new document in the framed tab starts without the frame.
  function onTabUpdated(tabId, change) {
    if (tabId === shown && change && change.status === "complete") void send(tabId, true);
  }

  function onTabRemoved(tabId) {
    if (tabId === shown) { shown = null; persist(); }
    if (tabId === agentTab) { agentTab = null; release(); }
    if (tabId === turnTab) turnTab = null;
    sync();
  }

  return { onVoiceState, onAgentTab, onTabUpdated, onTabRemoved, recover, shownTab: () => shown };
}

// Registers the tab listeners synchronously so Chrome can wake the worker.
export function installFrame(opts = {}) {
  const chromeApi = opts.chromeApi || globalThis.chrome;
  const frame = createFrame({ ...opts, chromeApi });
  chromeApi.tabs.onUpdated?.addListener((id, change) => frame.onTabUpdated(id, change));
  chromeApi.tabs.onRemoved?.addListener((id) => frame.onTabRemoved(id));
  frame.recover().catch(() => {});
  return frame;
}
