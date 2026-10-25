// Clearcart's "Can't reach this site" page (newtab/error.html). Chrome's own
// network error page (chrome-error://chromewebdata/) runs no content
// scripts and refuses scripting.executeScript, so Space to talk and the
// subtitles can't work there. The browser-wide toggle shortcut does.
//
// When a normal tab's main frame fails with a network error, this sends the
// tab on to Clearcart's page, which loads the same scripts as the new tab
// page and offers Retry. Only network errors (no connection, unknown
// address, refused, timed out): never a stop, a download, a blocked request,
// a certificate warning or a form resubmission.
//
// History: Chrome keeps the failed entry, so Back from Clearcart's page
// loads the failed address again. That failure is left on Chrome's page
// (the tab was just on Clearcart's page for the same address), so Back
// keeps working. Retry tells the worker first and is replaced again if it
// fails. The failed address is kept in chrome.storage.session under a random
// key in the page's fragment, never in the page's address, so the agent
// never sees it there (tabs.js reports the page as chrome-error://chromewebdata/).

export const ERROR_PATH = "newtab/error.html";
export const ERROR_URL = "chrome-error://chromewebdata/";
export const STATE_KEY = "clearcartErrorPages";
export const FILTER = { urls: ["<all_urls>"], types: ["main_frame"] };

export const NET_ERRORS = new Set([
  "net::ERR_INTERNET_DISCONNECTED",
  "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_NAME_RESOLUTION_FAILED",
  "net::ERR_CONNECTION_REFUSED",
  "net::ERR_CONNECTION_RESET",
  "net::ERR_CONNECTION_CLOSED",
  "net::ERR_CONNECTION_FAILED",
  "net::ERR_CONNECTION_TIMED_OUT",
  "net::ERR_TIMED_OUT",
  "net::ERR_ADDRESS_UNREACHABLE",
  "net::ERR_ADDRESS_INVALID",
  "net::ERR_NETWORK_CHANGED",
  "net::ERR_EMPTY_RESPONSE",
  "net::ERR_PROXY_CONNECTION_FAILED",
  "net::ERR_TUNNEL_CONNECTION_FAILED",
]);

// A failure is redirected only if the tab shows it soon after.
const PENDING_MS = 30_000;
// Retry pressed on Clearcart's page counts for the next failure this long.
const RETRY_MS = 30_000;
// Never twice for the same tab and address within this: a loop guard.
const REPEAT_MS = 1500;
const MAX_PAGES = 50;

const api = () => globalThis.chrome;

export function errorPageBase() {
  return api()?.runtime?.getURL?.(ERROR_PATH) || null;
}

// Clearcart's error page (any key), nothing else.
export function isErrorPage(url) {
  const base = errorPageBase();
  return !!base && String(url || "").split(/[?#]/)[0] === base;
}

export function keyOf(url) {
  if (!isErrorPage(url)) return null;
  const m = /#k=([0-9a-f-]{36})$/.exec(String(url));
  return m ? m[1] : null;
}

// { pages: { key: { url, error, tabId, at } }, shown: { tabId: key }, retry: { tabId: { url, at } } }
async function loadState() {
  const { [STATE_KEY]: s } = (await api().storage.session.get(STATE_KEY)) || {};
  return { pages: { ...(s?.pages || {}) }, shown: { ...(s?.shown || {}) }, retry: { ...(s?.retry || {}) } };
}

let chain = Promise.resolve();
function update(fn) {
  const run = async () => {
    const s = await loadState();
    const out = fn(s);
    await api().storage.session.set({ [STATE_KEY]: s });
    return out;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// A read after every queued write.
const read = () => chain.then(loadState, loadState);

// The failure Clearcart's page at `url` is about: { url, error }, or null.
// Full address: for the page itself and tabs.js, which decides what the
// agent may hear of it.
export async function recordFor(url) {
  const k = keyOf(url);
  if (!k) return null;
  const rec = (await read()).pages[k];
  return rec ? { url: rec.url, error: rec.error } : null;
}

export function createErrorPages({ loadSettings, now = () => Date.now() } = {}) {
  const pending = new Map(); // tabId -> { url, error, at }
  const last = new Map(); // tabId -> { url, at }, the loop guard

  const unmark = (tabId) => update((s) => { delete s.shown[tabId]; });

  // webRequest.onErrorOccurred (FILTER).
  function onRequestError(d) {
    if (!d || d.type !== "main_frame" || d.frameId !== 0) return;
    if (!Number.isInteger(d.tabId) || d.tabId < 0) return;
    if (!NET_ERRORS.has(d.error) || !/^https?:/i.test(String(d.url || ""))) return;
    pending.set(d.tabId, { url: d.url, error: d.error, at: now() });
  }

  // tabs.onUpdated: which Clearcart error page the tab is on, and, once the
  // failed address finishes loading as Chrome's error page, the redirect.
  async function onTabUpdated(tabId, change, tab) {
    if (change && typeof change.url === "string") {
      const k = keyOf(change.url);
      if (k) await update((s) => { s.shown[tabId] = k; });
      else {
        // Back to the address it failed on keeps the mark; anything else drops it.
        const s = await read();
        const k0 = s.shown[tabId];
        if (k0 && s.pages[k0]?.url !== change.url) await unmark(tabId);
      }
    }
    if (!change || change.status !== "complete") return false;
    const p = pending.get(tabId);
    if (!p) {
      // A page that loaded fine: the tab has left Clearcart's page behind.
      if (tab && !isErrorPage(tab.url) && (await read()).shown[tabId]) await unmark(tabId);
      return false;
    }
    pending.delete(tabId);
    if (now() - p.at > PENDING_MS || !tab || tab.url !== p.url || tab.incognito) return false;
    return maybeReplace(tabId, tab, p);
  }

  async function maybeReplace(tabId, tab, p) {
    const settings = await loadSettings();
    if (!settings.errorPages) return false;
    const win = await api().windows?.get?.(tab.windowId).catch(() => null);
    if (win && win.type !== "normal") return false;
    const prev = last.get(tabId);
    if (prev && prev.url === p.url && now() - prev.at < REPEAT_MS) return false;
    const s = await read();
    const retry = s.retry[tabId];
    const retried = !!retry && retry.url === p.url && now() - retry.at < RETRY_MS;
    const from = s.shown[tabId] && s.pages[s.shown[tabId]];
    // Back (or the same address typed again) from Clearcart's page for it:
    // leave Chrome's page, so Back goes on past it.
    if (!retried && from && from.url === p.url) return false;
    const key = crypto.randomUUID();
    await update((st) => {
      delete st.retry[tabId];
      st.pages[key] = { url: p.url, error: p.error, tabId, at: now() };
      const keys = Object.keys(st.pages);
      if (keys.length > MAX_PAGES) {
        keys.sort((a, b) => st.pages[a].at - st.pages[b].at);
        for (const k of keys.slice(0, keys.length - MAX_PAGES)) delete st.pages[k];
      }
    });
    last.set(tabId, { url: p.url, at: now() });
    // The tab may have moved on while this ran.
    const cur = await api().tabs.get(tabId).catch(() => null);
    if (!cur || cur.url !== p.url) return false;
    await api().tabs.update(tabId, { url: `${errorPageBase()}#k=${key}` });
    return true;
  }

  // RT.ERROR_PAGE_RETRY from Clearcart's error page: the next failure of
  // its address in this tab gets the page again. Replies { url } (the page
  // then loads it with location.replace) or { url: null }.
  async function onRetry(sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId) || !isErrorPage(sender.url)) return { url: null };
    const rec = await recordFor(sender.url);
    if (!rec) return { url: null };
    await update((s) => { s.retry[tabId] = { url: rec.url, at: now() }; });
    return { url: rec.url };
  }

  function forget(tabId) {
    pending.delete(tabId);
    last.delete(tabId);
    return update((s) => {
      delete s.shown[tabId];
      delete s.retry[tabId];
      for (const [k, v] of Object.entries(s.pages)) if (v.tabId === tabId) delete s.pages[k];
    }).catch(() => {});
  }

  return { onRequestError, onTabUpdated, onRetry, forget };
}
