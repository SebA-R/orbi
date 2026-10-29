// Agent tabs: the user's own open tabs plus the tabs Orbi opens. There
// is no tab group. Instead every tab is judged by its current page:
//
//   - A tab on a page the browse mode does not allow (the blocked sites, or
//     the fixed rules: non-web pages, local and private addresses, addresses
//     with a login in them) or served from a local address (netguard.js) is
//     left out of tabsContext and refused for every call.
//   - A new tab page (Chrome's or Orbi's, isNewTabPage) and Orbi's
//     "Can't reach this site" page (errpage.js) are listed and may be
//     navigated to a site, but are never read or acted on. The error page
//     is listed as chrome-error://chromewebdata/, without the address that
//     failed; a user's error page for a blocked site is hidden.
//   - That check runs again on every call (resolveAllowedTab), not only when
//     the tabs are listed: a tab can move between calls.
//   - Orbi only closes tabs it opened itself.
//   - New tabs open next to the user's tab. The router brings a tab to the
//     front when Orbi acts on it (follow.js), or on tabsActivate.
//
// Which tabs Orbi opened is kept in chrome.storage.session so it
// survives a service-worker restart. The agent server's tab sweep only looks
// at those (agentTabs). Navigating, clicking or typing in one of the user's
// own tabs never makes it sweepable: the user may later open a blocked site
// in it, and Orbi must then leave it alone.

import { BridgeError, ERR } from "../lib/protocol.js";
import { loadSettings } from "../lib/settings.js";
import { assertAllowed, blockReason, frameAllowed, isAllowed } from "./allowlist.js";
import { assertNetSafe, flagOf } from "./netguard.js";
import { ERROR_URL, isErrorPage, recordFor } from "./errpage.js";

// The router's lock_arm checks the site again with isAllowed, and saved-card
// fill checks payment frames with frameAllowed.
export { frameAllowed, isAllowed };

// The tab group earlier versions made. Only used to undo it (ungroupLegacy).
export const LEGACY_GROUP_TITLE = "Clearcart";
export const STATE_KEY = "clearcartTabs";
export const NAV_TIMEOUT_MS = 20_000;
const TITLE_MAX = 120;
export const ERROR_TITLE = "Can't reach this site";
const BLANK = /^(about:blank|chrome:\/\/newtab\/?)$/;
// Chrome's own new tab pages. Tabs report Orbi's new tab page
// (newtab/newtab.html) as chrome://newtab/ too.
const NEW_TAB = /^chrome:\/\/(newtab|new-tab-page|new-tab-page-third-party)\/?$/;
export const NEW_TAB_PATH = "newtab/newtab.html";

const api = () => globalThis.chrome;

// Full URL: INTERNAL replies (tab_info, agent_tabs) only. Orbi's error
// page is chrome-error://chromewebdata/ there too, the address Chrome's own
// error page would have.
function info(tab) {
  const url = onErrorPage(tab) ? ERROR_URL : tab.url || tab.pendingUrl || "";
  return { tabId: tab.id, url, title: tab.title || "" };
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

// A new tab page, Chrome's or Orbi's. Nothing on it is the user's, so
// Orbi lists the tab and may navigate it to a site, like a blank tab
// it opened itself. It never reads or acts on the page.
export function isNewTabPage(url) {
  const u = String(url || "");
  if (NEW_TAB.test(u)) return true;
  const own = api()?.runtime?.getURL?.(NEW_TAB_PATH);
  return !!own && u.split(/[?#]/)[0] === own;
}

// The tab is on a new tab page and not on its way somewhere else: while the
// user types an address, url is still the new tab and pendingUrl the site.
export function onNewTab(tab) {
  if (!tab) return false;
  const pending = tab.pendingUrl;
  return isNewTabPage(tab.url || pending) && (!pending || isNewTabPage(pending));
}

// The tab is on Orbi's "Can't reach this site" page and not on its way
// somewhere else.
export function onErrorPage(tab) {
  if (!tab) return false;
  const pending = tab.pendingUrl;
  return isErrorPage(tab.url || pending) && (!pending || isErrorPage(pending));
}

// A page of Orbi's own with nothing on it to read: a new tab page or
// the error page. Listed, may be navigated, never read or acted on.
export const onEmptyPage = (tab) => onNewTab(tab) || onErrorPage(tab);

// The user's tab is on Orbi's error page for a site the browse mode
// does not allow: hidden like Chrome's own error page for it would be.
async function errorPageHidden(tab, settings, mine) {
  if (mine || !onErrorPage(tab)) return false;
  const rec = await recordFor(tab.url || tab.pendingUrl).catch(() => null);
  return !!rec && !!blockReason(rec.url, settings);
}

// The tab is kept from Orbi: on a page the settings hide, or on the error
// page for one. blankOk lets a blank tab through.
async function tabHidden(tab, settings, { mine, blankOk }) {
  return !!hiddenReason(tab, settings, { blankOk }) || (await errorPageHidden(tab, settings, mine));
}

// The address Orbi's error page in this tab failed on, origin and path
// only, or null. Null too when that address is not allowed: a blocked
// site's address never reaches the agent.
export async function failedAddress(tab) {
  if (!onErrorPage(tab)) return null;
  const rec = await recordFor(tab.url || tab.pendingUrl).catch(() => null);
  if (!rec || !(await isAllowed(rec.url).catch(() => false))) return null;
  return originPath(rec.url) || null;
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

// Serializes read-modify-write of the state. Nothing changed, nothing written.
let chain = Promise.resolve();
function update(fn) {
  const run = async () => {
    const s = await loadState();
    const before = JSON.stringify(s);
    fn(s);
    if (JSON.stringify(s) !== before) await saveState(s);
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

// Why Orbi may not use this tab's current page, or null. A blank tab
// Orbi opened itself may be navigated (blankOk), nothing else.
function hiddenReason(tab, settings, { blankOk = false } = {}) {
  // The manifest keeps Orbi out of incognito; this is a second line.
  if (tab.incognito) return "incognito";
  const url = tab.url || tab.pendingUrl || "";
  if (blankOk && BLANK.test(url)) return null;
  if (onEmptyPage(tab)) return null;
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

// Every tab Orbi may see: the user's tabs on allowed pages, and the
// tabs it opened (blank ones too). Blocked tabs are left out entirely.
export async function tabsContext() {
  const [all, settings, state, active] = await Promise.all([api().tabs.query({}), loadSettings(), loadState(), activeTab()]);
  const tabs = [];
  for (const t of all) {
    const mine = state.created.includes(t.id);
    if (await tabHidden(t, settings, { mine, blankOk: mine })) continue;
    const newTab = onNewTab(t);
    const errorPage = !newTab && onErrorPage(t);
    tabs.push({
      tabId: t.id,
      title: errorPage ? ERROR_TITLE : String(t.title || "").slice(0, TITLE_MAX),
      url: newTab ? "chrome://newtab/" : errorPage ? ERROR_URL : originPath(t.url || t.pendingUrl || ""),
      active: !!active && active.id === t.id,
      openedByClearcart: mine,
    });
  }
  return { tabs };
}

// The tab a call acts on. Default: the tab Orbi used last, else the
// user's active tab. `nav` lets a navigate call reach a tab Orbi opened
// itself even when it sits on a blocked page (that is how the sweep sends
// it back). The user's own tabs on blocked pages are never reachable, for
// any call, however Orbi used them before.
export async function resolveTab(tabId, { nav = false } = {}) {
  if (tabId != null && !Number.isInteger(tabId)) throw new BridgeError(ERR.BAD_REQUEST, "tabId must be an integer");
  const [state, settings] = await Promise.all([loadState(), loadSettings()]);
  let tab = null;
  if (tabId != null) tab = await getTab(tabId);
  else {
    // The last used tab, unless it has since moved somewhere blocked.
    if (state.last != null) tab = await api().tabs.get(state.last).catch(() => null);
    const mine0 = tab && state.created.includes(tab.id);
    if (tab && (await tabHidden(tab, settings, { mine: mine0, blankOk: mine0 }))) tab = null;
    if (!tab) tab = await activeTab();
    if (!tab) throw new BridgeError(ERR.NO_TAB, "no open tab; call tabs_create");
  }
  const mine = state.created.includes(tab.id);
  if (!(nav && mine) && (await tabHidden(tab, settings, { mine, blankOk: mine && nav }))) {
    // No origin in the message: a blocked tab of the user's stays private.
    throw new BridgeError(ERR.NOT_ALLOWED, `tab ${tab.id} is on a blocked site; Orbi does not use it`);
  }
  return tab.id;
}

// Every call that touches a page: resolve the tab and check its current page
// again (browse mode, blocked sites, connected address) right before acting.
// `peek` (page_context) checks without making it the default tab.
export async function resolveAllowedTab(tabId, { peek = false } = {}) {
  const id = await resolveTab(tabId);
  const tab = await api().tabs.get(id);
  if (onNewTab(tab)) {
    throw new BridgeError(ERR.NOT_ALLOWED, `tab ${id} is a new tab page with nothing to use; navigate it to a web address first`);
  }
  if (onErrorPage(tab)) {
    throw new BridgeError(ERR.NOT_ALLOWED, `tab ${id} is a page saying Chrome could not reach the site; navigate it somewhere else first`);
  }
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
      clearInterval(poll);
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
    // Also asks the tab itself: a same-document change (pushState, or Back
    // within a single page app) may send no status events at all, or a
    // "loading" with no "complete" after it.
    let poll;
    c.tabs.onUpdated.addListener(onUpdated);
    c.tabs.onRemoved.addListener(onRemoved);
    Promise.resolve()
      .then(start)
      .then(() => {
        if (done) return;
        poll = setInterval(async () => {
          if (done) return;
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

// How long after a click or key a page load may start and still count as
// its doing, how long that load then gets to finish, and how long a page
// whose address changed without a load (pushState) gets to render.
export const SETTLE_WINDOW_MS = 500;
export const SETTLE_TIMEOUT_MS = 8_000;
export const SETTLE_RENDER_MS = 300;

// Runs act() (a click or key press in tab tabId), then waits for the page
// it may have started to load: if the tab starts loading within windowMs
// after act() returns, this waits for "complete", at most timeoutMs (a slow
// page is reported as it is then, not failed). An address change with no
// load (a single page app) gets renderMs to draw. Otherwise it answers
// after windowMs. stop() answering true (an interrupt) ends any wait at
// once. The listener is installed before act() runs, so a load that starts
// during the press is seen too.
// Answers act()'s result plus { navigated, url, title } of where the tab
// is now. url is origin and path only, like navigate's; a page Orbi may not
// use gives no url or title.
export async function actAndSettle(tabId, act, { windowMs = SETTLE_WINDOW_MS, timeoutMs = SETTLE_TIMEOUT_MS, renderMs = SETTLE_RENDER_MS, stop = () => false } = {}) {
  const c = api();
  const before = await c.tabs.get(tabId).catch(() => null);
  let loading = false;
  let complete = false;
  let moved = false;
  let wake = null;
  const onUpdated = (id, change) => {
    if (id !== tabId || !change) return;
    if (change.status === "loading") loading = true;
    if (change.status === "complete" && loading) complete = true;
    if (change.url != null) moved = true;
    if (wake) wake();
  };
  c.tabs.onUpdated.addListener(onUpdated);
  // Waits until done() or ms pass, waking on every tab update. It polls
  // stop(), and with poll the tab's own status too, as navigateAndWait
  // does, for a missed "complete".
  const until = (done, ms, poll = false) =>
    new Promise((resolve) => {
      const over = () => stop() || done();
      if (over()) return resolve();
      const end = () => {
        clearTimeout(timer);
        clearInterval(iv);
        wake = null;
        resolve();
      };
      const timer = setTimeout(end, ms);
      wake = () => over() && end();
      const iv = setInterval(async () => {
        if (poll) {
          const t = await c.tabs.get(tabId).catch(() => null);
          if (!t || t.status === "complete") complete = true;
        }
        if (over()) end();
      }, poll ? 250 : 100);
    });
  let result;
  try {
    result = await act();
    await until(() => loading || moved, windowMs);
    // A pushState first may still be followed by a real load.
    if (moved && !loading) await until(() => loading, renderMs);
    if (loading) await until(() => complete, timeoutMs, true);
  } finally {
    c.tabs.onUpdated.removeListener(onUpdated);
  }
  const tab = await c.tabs.get(tabId).catch(() => null);
  // Still loading (the cap hit before the page committed): where it is going.
  const urlOf = (t) => (t ? (t.status === "loading" && t.pendingUrl) || t.url || t.pendingUrl || "" : "");
  const navigated = loading || moved || (!!before && !!tab && urlOf(before) !== urlOf(tab));
  const out = { ...(result && typeof result === "object" ? result : {}), navigated };
  if (!tab) return out;
  if (onErrorPage(tab)) return { ...out, url: ERROR_URL, title: ERROR_TITLE };
  if (flagOf(tabId) || !(await isAllowed(urlOf(tab)).catch(() => false))) return out;
  const pending = tab.status === "loading" && tab.pendingUrl && tab.pendingUrl !== tab.url;
  return { ...out, url: originPath(urlOf(tab)), title: pending ? "" : String(tab.title || "").slice(0, TITLE_MAX) };
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
    // Where it went, origin and path only, like navigate.
    const now = await api().tabs.get(tab.id).catch(() => null);
    if (now && !onEmptyPage(now) && (await isAllowed(now.url || "").catch(() => false))) {
      return { tabId: tab.id, url: originPath(now.url || ""), title: String(now.title || "").slice(0, TITLE_MAX) };
    }
  }
  return { tabId: tab.id };
}

// Where the agent server's tab sweep sends a stray tab Orbi opened.
export const BLANK_PAGE = "about:blank";

export async function navigate({ tabId, url } = {}) {
  if (typeof url !== "string" || !url) throw new BridgeError(ERR.BAD_REQUEST, "url is required");
  const id = await resolveTab(tabId, { nav: true });
  const mine = await isCreated(id);
  // A user's new tab or error page may only be sent to an allowed address:
  // its history can hold sites the user visited, blocked ones included
  // (Back from the error page loads the address that failed).
  if ((url === "back" || url === "forward") && !mine && onEmptyPage(await api().tabs.get(id))) {
    throw new BridgeError(ERR.NOT_ALLOWED, `tab ${id} is a new tab page or an error page; navigate it to a web address instead`);
  }
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
  else if (url === BLANK_PAGE) {
    // Only a tab Orbi opened; the user's own tabs keep their page.
    if (!mine) throw new BridgeError(ERR.NOT_ALLOWED, `tab ${id} is one of the user's tabs; Orbi only blanks tabs it opened`);
    start = () => api().tabs.update(id, { url });
  } else {
    await assertAllowed(url);
    start = () => api().tabs.update(id, { url });
  }
  await markUsed(id);
  await navigateAndWait(id, start);
  const tab = await api().tabs.get(id);
  // The address did not load and the tab is already on Orbi's error page.
  if (onErrorPage(tab)) return { tabId: tab.id, url: ERROR_URL, title: ERROR_TITLE };
  // History or a redirect can lead to a site that is not allowed; report it
  // so callers stop driving. A blank page in a tab Orbi opened is fine.
  if (!(mine && BLANK.test(tab.url || "")) && !(await isAllowed(tab.url))) {
    let origin = "unknown";
    try {
      origin = new URL(tab.url).origin;
    } catch {}
    throw new BridgeError(ERR.NOT_ALLOWED, `navigated to a site Orbi does not drive: ${origin}`);
  }
  assertNetSafe(id);
  // Origin and path only: a query string or fragment can carry login codes.
  return { tabId: tab.id, url: originPath(tab.url || tab.pendingUrl || ""), title: tab.title || "" };
}

// Checks a page again right after Orbi read from it, so a tab that
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

// Closes a tab, only one Orbi opened.
export async function tabsClose({ tabId } = {}) {
  if (!Number.isInteger(tabId)) throw new BridgeError(ERR.BAD_REQUEST, "tabId must be an integer");
  if (!(await isCreated(tabId))) throw new BridgeError(ERR.NOT_ALLOWED, `tab ${tabId} is one of the user's tabs; Orbi only closes tabs it opened`);
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

// Full URL of a tab Orbi may see. INTERNAL: the agent server's pay flow
// and unlock gate, never Claude.
export async function tabInfo({ tabId } = {}) {
  const id = await resolveTab(tabId, { nav: true });
  return info(await api().tabs.get(id));
}

// The tabs Orbi opened, with full URLs, blocked ones included.
// INTERNAL: the agent server's tab sweep. The user's own tabs never appear,
// even ones Orbi navigated, clicked or typed in.
export async function agentTabs() {
  const state = await loadState();
  const found = await Promise.all(state.created.map((id) => api().tabs.get(id).catch(() => null)));
  return { tabs: found.filter(Boolean).map((t) => ({ ...info(t), openedByClearcart: true })) };
}

// Earlier versions kept agent tabs in a "Orbi" tab group. On install or
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
