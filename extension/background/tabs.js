// Agent tabs: the user's own open tabs plus the tabs Clearcart opens. There
// is no tab group. Instead every tab is judged by its current page:
//
//   - A tab on a page the browse mode does not allow (the blocked sites, or
//     the fixed rules: non-web pages, local and private addresses, addresses
//     with a login in them) or served from a local address (netguard.js) is
//     left out of tabsContext and refused for every call.
//   - That check runs again on every call (resolveAllowedTab), not only when
//     the tabs are listed: a tab can move between calls.
//   - Clearcart only closes tabs it opened itself.
//   - New tabs open next to the user's tab. The router brings a tab to the
//     front when Clearcart acts on it (follow.js), or on tabsActivate.
//
// Which tabs Clearcart opened is kept in chrome.storage.session so it
// survives a service-worker restart. The agent server's tab sweep only looks
// at those (agentTabs). Navigating, clicking or typing in one of the user's
// own tabs never makes it sweepable: the user may later open a blocked site
// in it, and Clearcart must then leave it alone.

import { BridgeError, ERR } from "../lib/protocol.js";
import { loadSettings } from "../lib/settings.js";
import { assertAllowed, blockReason, isAllowed, isPaySite } from "./allowlist.js";
import { assertNetSafe, flagOf } from "./netguard.js";

export { isPaySite };

// The tab group earlier versions made. Only used to undo it (ungroupLegacy).
export const LEGACY_GROUP_TITLE = "Clearcart";
export const STATE_KEY = "clearcartTabs";
export const NAV_TIMEOUT_MS = 20_000;
const TITLE_MAX = 120;
const BLANK = /^(about:blank|chrome:\/\/newtab\/?)$/;

const api = () => globalThis.chrome;

// Full URL: INTERNAL replies (tab_info, agent_tabs) only.
function info(tab) {
  return { tabId: tab.id, url: tab.url || tab.pendingUrl || "", title: tab.title || "" };
}

// Origin and path only: no query string, fragment or login. What Claude sees.
export function originPath(url) {
  try {
    const u = new URL(String(url));
    if (u.origin === "null") return u.protocol;
    return u.origin + u.pathname;
  } catch {
    return "";
  }
}

// ------------------------------------------------------------ tab state

async function loadState() {
  const { [STATE_KEY]: s } = await api().storage.session.get(STATE_KEY);
  // An older version's `driven` list is dropped here.
  return { created: [...(s?.created || [])], last: s?.last ?? null };
}

async function saveState(s) {
  await api().storage.session.set({ [STATE_KEY]: s });
}

// Serializes read-modify-write of the state.
let chain = Promise.resolve();
function update(fn) {
  const run = async () => {
    const s = await loadState();
    fn(s);
    await saveState(s);
  };
  chain = chain.then(run, run);
  return chain;
}

const add = (list, id) => (list.includes(id) ? list : list.push(id));

export const markCreated = (tabId) => update((s) => add(s.created, tabId));
export const markUsed = (tabId) => update((s) => (s.last = tabId));

// tabs.onRemoved: forget the tab.
export function onTabRemoved(tabId) {
  return update((s) => {
    s.created = s.created.filter((id) => id !== tabId);
    if (s.last === tabId) s.last = null;
  });
}

export async function isCreated(tabId) {
  return (await loadState()).created.includes(tabId);
}

// ------------------------------------------------------------ the check

// Why Clearcart may not use this tab's current page, or null. A blank tab
// Clearcart opened itself may be navigated (blankOk), nothing else.
function hiddenReason(tab, settings, { blankOk = false } = {}) {
  // The manifest keeps Clearcart out of incognito; this is a second line.
  if (tab.incognito) return "incognito";
  const url = tab.url || tab.pendingUrl || "";
  if (blankOk && BLANK.test(url)) return null;
  const why = blockReason(url, settings);
  if (why) return why;
  if (flagOf(tab.id)) return "served from a local address";
  return null;
}

async function getTab(tabId) {
  try {
    return await api().tabs.get(tabId);
  } catch {
    throw new BridgeError(ERR.NO_TAB, `no tab ${tabId}`);
  }
}

// The tab the user is looking at: the active tab of the last focused window.
export async function activeTab() {
  const [tab] = await api().tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// Every tab Clearcart may see: the user's tabs on allowed pages, and the
// tabs it opened (blank ones too). Blocked tabs are left out entirely.
export async function tabsContext() {
  const [all, settings, state, active] = await Promise.all([api().tabs.query({}), loadSettings(), loadState(), activeTab()]);
  const tabs = [];
  for (const t of all) {
    const mine = state.created.includes(t.id);
    if (hiddenReason(t, settings, { blankOk: mine })) continue;
    tabs.push({
      tabId: t.id,
      title: String(t.title || "").slice(0, TITLE_MAX),
      url: originPath(t.url || t.pendingUrl || ""),
      active: !!active && active.id === t.id,
      openedByClearcart: mine,
    });
  }
  return { tabs };
}

// The tab a call acts on. Default: the tab Clearcart used last, else the
// user's active tab. `nav` lets a navigate call reach a tab Clearcart opened
// itself even when it sits on a blocked page (that is how the sweep sends
// it back). The user's own tabs on blocked pages are never reachable, for
// any call, however Clearcart used them before.
export async function resolveTab(tabId, { nav = false } = {}) {
  if (tabId != null && !Number.isInteger(tabId)) throw new BridgeError(ERR.BAD_REQUEST, "tabId must be an integer");
  const [state, settings] = await Promise.all([loadState(), loadSettings()]);
  let tab = null;
  if (tabId != null) tab = await getTab(tabId);
  else {
    // The last used tab, unless it has since moved somewhere blocked.
    if (state.last != null) tab = await api().tabs.get(state.last).catch(() => null);
    if (tab && hiddenReason(tab, settings, { blankOk: state.created.includes(tab.id) })) tab = null;
    if (!tab) tab = await activeTab();
    if (!tab) throw new BridgeError(ERR.NO_TAB, "no open tab; call tabs_create");
  }
  const mine = state.created.includes(tab.id);
  if (!(nav && mine) && hiddenReason(tab, settings, { blankOk: mine && nav })) {
    // No origin in the message: a blocked tab of the user's stays private.
    throw new BridgeError(ERR.NOT_ALLOWED, `tab ${tab.id} is on a blocked site; Clearcart does not use it`);
  }
  return tab.id;
}

// Every call that touches a page: resolve the tab and check its current page
// again (browse mode, blocked sites, connected address) right before acting.
// `peek` (page_context) checks without making it the default tab.
export async function resolveAllowedTab(tabId, { peek = false } = {}) {
  const id = await resolveTab(tabId);
  const tab = await api().tabs.get(id);
  await assertAllowed(tab.url);
  assertNetSafe(id);
  if (!peek) await markUsed(id);
  return id;
}

// ------------------------------------------------------------ navigation

// Resolves once the tab reaches status "complete" after `start()` runs.
// The listener is installed before start() so no event is missed. If no
// "loading" event shows up (same-document navigation), a short grace check
// of the tab's own status settles it.
export function navigateAndWait(tabId, start, timeoutMs = NAV_TIMEOUT_MS) {
  const c = api();
  return new Promise((resolve, reject) => {
    let seenLoading = false;
    let done = false;
    const finish = (err, tab) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      c.tabs.onUpdated.removeListener(onUpdated);
      c.tabs.onRemoved.removeListener(onRemoved);
      if (err) reject(err);
      else resolve(tab);
    };
    const onUpdated = (id, change, tab) => {
      if (id !== tabId) return;
      if (change.status === "loading") seenLoading = true;
      if (change.status === "complete" && seenLoading) finish(null, tab);
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(new BridgeError(ERR.NO_TAB, `tab ${tabId} closed while loading`));
    };
    const timer = setTimeout(
      () => finish(new BridgeError(ERR.TIMEOUT, `page did not finish loading in ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
    let grace;
    c.tabs.onUpdated.addListener(onUpdated);
    c.tabs.onRemoved.addListener(onRemoved);
    Promise.resolve()
      .then(start)
      .then(() => {
        grace = setTimeout(async () => {
          if (seenLoading || done) return;
          try {
            const tab = await c.tabs.get(tabId);
            if (tab.status === "complete") finish(null, tab);
          } catch {
            finish(new BridgeError(ERR.NO_TAB, `no tab ${tabId}`));
          }
        }, 250);
      })
      .catch((e) => finish(e instanceof BridgeError ? e : new BridgeError(ERR.INTERNAL, e?.message || String(e))));
  });
}

// Opens a tab right after the user's current tab. It is created in the
// background; onCreated (the router's follow) may then bring it to the
// front before it loads.
export async function tabsCreate({ url, onCreated } = {}) {
  if (url != null) await assertAllowed(url);
  const cur = await activeTab();
  const props = { url: "about:blank", active: false };
  if (cur) Object.assign(props, { windowId: cur.windowId, index: cur.index + 1 });
  const tab = await api().tabs.create(props);
  await markCreated(tab.id);
  await markUsed(tab.id);
  if (typeof onCreated === "function") await Promise.resolve(onCreated(tab.id)).catch(() => {});
  if (url != null) {
    await navigateAndWait(tab.id, () => api().tabs.update(tab.id, { url }));
    assertNetSafe(tab.id);
  }
  return { tabId: tab.id };
}

export async function navigate({ tabId, url } = {}) {
  if (typeof url !== "string" || !url) throw new BridgeError(ERR.BAD_REQUEST, "url is required");
  const id = await resolveTab(tabId, { nav: true });
  let start;
  const history = (fn, dir) => async () => {
    try {
      await fn(id);
    } catch {
      // Includes entries Chrome skips because they were added without a user gesture.
      throw new BridgeError(ERR.BAD_REQUEST, `no page to go ${dir} to`);
    }
  };
  if (url === "back") start = history((i) => api().tabs.goBack(i), "back");
  else if (url === "forward") start = history((i) => api().tabs.goForward(i), "forward");
  else {
    await assertAllowed(url);
    start = () => api().tabs.update(id, { url });
  }
  await markUsed(id);
  await navigateAndWait(id, start);
  const tab = await api().tabs.get(id);
  // History or a redirect can lead to a site that is not allowed; report it
  // so callers stop driving.
  if (!(await isAllowed(tab.url))) {
    let origin = "unknown";
    try {
      origin = new URL(tab.url).origin;
    } catch {}
    throw new BridgeError(ERR.NOT_ALLOWED, `navigated to a site Clearcart does not drive: ${origin}`);
  }
  assertNetSafe(id);
  // Origin and path only: a query string or fragment can carry login codes.
  return { tabId: tab.id, url: originPath(tab.url || tab.pendingUrl || ""), title: tab.title || "" };
}

// Checks a page again right after Clearcart read from it, so a tab that
// moved to a blocked site mid-call gives nothing back. `url` is the address
// of the document that answered; without one the tab's current (and
// pending) address is checked. Throws NOT_ALLOWED to drop the result.
export async function assertPageAllowed(tabId, url) {
  const settings = await loadSettings();
  let urls = [url];
  if (url == null) {
    const t = await getTab(tabId);
    urls = [t.url || "", t.pendingUrl].filter((u) => u != null);
  }
  if (urls.some((u) => blockReason(String(u), settings)) || flagOf(tabId)) {
    throw new BridgeError(ERR.NOT_ALLOWED, `tab ${tabId} moved to a blocked site; the result was dropped`);
  }
}

// Closes a tab, only one Clearcart opened.
export async function tabsClose({ tabId } = {}) {
  if (!Number.isInteger(tabId)) throw new BridgeError(ERR.BAD_REQUEST, "tabId must be an integer");
  if (!(await isCreated(tabId))) throw new BridgeError(ERR.NOT_ALLOWED, `tab ${tabId} is one of the user's tabs; Clearcart only closes tabs it opened`);
  await getTab(tabId);
  await api().tabs.remove(tabId);
  return { ok: true };
}

// Brings a tab to the front. Only for when the user asks to see it.
export async function tabsActivate({ tabId } = {}) {
  const id = await resolveTab(tabId);
  const tab = await api().tabs.update(id, { active: true });
  if (tab?.windowId != null) await api().windows?.update(tab.windowId, { focused: true }).catch(() => {});
  return { ok: true, tabId: id };
}

// Full URL of a tab Clearcart may see. INTERNAL: the agent server's pay flow
// and unlock gate, never Claude.
export async function tabInfo({ tabId } = {}) {
  const id = await resolveTab(tabId, { nav: true });
  return info(await api().tabs.get(id));
}

// The tabs Clearcart opened, with full URLs, blocked ones included.
// INTERNAL: the agent server's tab sweep. The user's own tabs never appear,
// even ones Clearcart navigated, clicked or typed in.
export async function agentTabs() {
  const state = await loadState();
  const tabs = [];
  for (const id of state.created) {
    const t = await api().tabs.get(id).catch(() => null);
    if (t) tabs.push({ ...info(t), openedByClearcart: true });
  }
  return { tabs };
}

// Earlier versions kept agent tabs in a "Clearcart" tab group. On install or
// update, take those tabs out of it (the group goes away with its last tab)
// without closing any of them.
export async function ungroupLegacy() {
  const groups = api().tabGroups;
  if (!groups?.query) return 0;
  let n = 0;
  for (const g of await groups.query({ title: LEGACY_GROUP_TITLE })) {
    const ids = (await api().tabs.query({ groupId: g.id })).map((t) => t.id);
    if (ids.length) await api().tabs.ungroup(ids);
    n += ids.length;
  }
  return n;
}
