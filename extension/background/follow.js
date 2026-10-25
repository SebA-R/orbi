// Follow Clearcart to its tab. When Clearcart acts on a tab (opens it,
// navigates, clicks, types, presses a key, scrolls), that tab is made active
// and its window focused, so the user sees what it is doing. Reading a tab
// (read_page, find, get_page_text, screenshot...) never switches.
//
// The user wins: if they switch to another tab or window themselves during
// a turn, following stops for the rest of that turn and starts again on
// their next turn (newTurn: they start talking, or the agent server asks
// for page_context, which it does once per user turn).
//
// Setting: followTab (default on). Subtitles follow on their own: the voice
// relay replays the caption on tabs.onActivated (lib/voice/relay.js).

import { loadSettings } from "../lib/settings.js";

// Router methods that act on a page. Everything else only reads.
export const ACT_METHODS = new Set([
  "navigate",
  "click",
  "type",
  "key",
  "scroll",
  "dismiss_overlay",
  "form_input",
  "click_ref",
  "press_protected",
  "press_unlocked",
  "fill_payment",
  "clear_payment",
]);

// After Clearcart itself activates or closes a tab, Chrome's events for that
// change can arrive a little later. They are not the user switching away.
const OWN_SWITCH_GRACE_MS = 500;

// Kept in chrome.storage.session so a service-worker restart mid-turn does
// not forget that the user switched away.
export const FOLLOW_KEY = "clearcartFollow";

export function createFollower({
  chromeApi = globalThis.chrome,
  getSettings = () => loadSettings(chromeApi.storage.local),
  now = () => Date.now(),
} = {}) {
  // The tab (and its window) Clearcart is working in this turn, once it has
  // acted somewhere. A switch to anything else is the user's.
  let target = null;
  let targetWindow = null;
  let paused = false;
  let quietUntil = 0;
  let quietDepth = 0;

  const store = chromeApi?.storage?.session;
  let loaded = !store;
  const ready = store
    ? Promise.resolve()
        .then(() => store.get(FOLLOW_KEY))
        .then((r) => {
          const v = r && r[FOLLOW_KEY];
          if (v && !loaded) ({ target = null, targetWindow = null, paused = false } = v);
        })
        .catch(() => {})
        .finally(() => (loaded = true))
    : Promise.resolve();
  // Event handlers run at once when the state is loaded, else right after.
  const whenReady = (fn) => (loaded ? fn() : void ready.then(fn));
  function save() {
    if (!store) return;
    Promise.resolve()
      .then(() => store.set({ [FOLLOW_KEY]: { target, targetWindow, paused } }))
      .catch(() => {});
  }

  const quiet = () => quietDepth > 0 || now() < quietUntil;

  function newTurn() {
    loaded = true; // a new turn replaces whatever is still loading
    paused = false;
    target = null;
    targetWindow = null;
    save();
  }

  // Runs one of Clearcart's own tab changes (its switches, tabs_activate,
  // tabs_close) without reading the events it causes as the user switching
  // away.
  async function own(fn) {
    quietDepth++;
    try {
      return await fn();
    } finally {
      quietDepth--;
      quietUntil = now() + OWN_SWITCH_GRACE_MS;
    }
  }

  // Brings tabId to the front unless following is off or paused. Switches
  // run one at a time, so parallel calls on two tabs cannot read each
  // other's events as the user's. Never throws: a failed switch must not
  // fail the action.
  let chain = Promise.resolve();
  function to(tabId) {
    const run = () => switchTo(tabId);
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  async function switchTo(tabId) {
    await ready;
    if (paused || !Number.isInteger(tabId)) return false;
    try {
      const s = await getSettings();
      if (!s.followTab || paused) return false;
      const tab = await chromeApi.tabs.get(tabId);
      target = tabId;
      targetWindow = tab.windowId ?? null;
      save();
      await own(async () => {
        if (!tab.active) await chromeApi.tabs.update(tabId, { active: true });
        if (tab.windowId != null && chromeApi.windows?.update) {
          const win = await chromeApi.windows.get?.(tab.windowId).catch(() => null);
          if (!win || !win.focused) await chromeApi.windows.update(tab.windowId, { focused: true });
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  // Clearcart showed this tab on purpose (tabs_activate): it is the tab now.
  function claim(tabId, windowId = null) {
    if (!Number.isInteger(tabId)) return;
    target = tabId;
    targetWindow = windowId;
    save();
  }

  function forget(tabId) {
    whenReady(() => {
      if (tabId !== target) return;
      target = null;
      targetWindow = null;
      save();
    });
  }

  // tabs.onActivated
  function onActivated({ tabId, windowId } = {}) {
    whenReady(() => {
      if (target == null || quiet()) return;
      if (tabId === target) {
        if (windowId != null && windowId !== targetWindow) (targetWindow = windowId), save();
        return;
      }
      paused = true;
      save();
    });
  }

  // windows.onFocusChanged. Leaving Chrome (WINDOW_ID_NONE, -1) is not a
  // switch to another tab.
  function onWindowFocused(windowId) {
    whenReady(() => {
      if (target == null || quiet() || windowId == null || windowId < 0) return;
      if (targetWindow != null && windowId !== targetWindow) {
        paused = true;
        save();
      }
    });
  }

  return { to, own, claim, forget, newTurn, onActivated, onWindowFocused, ready, get paused() { return paused; } };
}
