import { test } from "node:test";
import assert from "node:assert/strict";

// A fake chrome: tabs, windows and storage.session, enough for errpage.js
// and tabs.js.
const ID = "abcdefghijklmnopabcdefghijklmnop";
const BASE = `chrome-extension://${ID}/newtab/error.html`;
const session = new Map();
let tabList = [];
let local = { browseMode: "open", blocklist: ["chase.com"] };
const updates = [];
globalThis.chrome = {
  runtime: { id: ID, getURL: (p) => `chrome-extension://${ID}/${p}` },
  storage: {
    local: { get: async () => ({ ...local }) },
    session: {
      get: async (k) => ({ [k]: session.has(k) ? structuredClone(session.get(k)) : undefined }),
      set: async (o) => { for (const [k, v] of Object.entries(o)) session.set(k, structuredClone(v)); },
    },
  },
  windows: { get: async (id) => ({ id, type: id === 99 ? "popup" : "normal" }) },
  tabs: {
    query: async (q) => (q.active ? tabList.filter((t) => t.active) : tabList),
    get: async (id) => {
      const t = tabList.find((x) => x.id === id);
      if (!t) throw new Error("no tab");
      return t;
    },
    update: async (id, props) => {
      updates.push([id, props.url]);
      const t = tabList.find((x) => x.id === id);
      if (t) t.url = props.url;
      return t;
    },
  },
};

const { createErrorPages, recordFor, isErrorPage, keyOf, NET_ERRORS } = await import("../../../extension/background/errpage.js");
const tabs = await import("../../../extension/background/tabs.js");
const { loadSettings } = await import("../../../extension/lib/settings.js");

let clock = 1_000_000;
const now = () => clock;
const pages = createErrorPages({ loadSettings, now });

const fail = (tabId, url, error = "net::ERR_NAME_NOT_RESOLVED") =>
  pages.onRequestError({ tabId, frameId: 0, type: "main_frame", url, error });

// Chrome's sequence for a failure: the request error, then the tab loads
// the failed address (as its error page) and completes.
async function failAndShow(tab, url, error) {
  fail(tab.id, url, error);
  tab.url = url;
  tab.status = "loading";
  await pages.onTabUpdated(tab.id, { status: "loading", url }, tab);
  tab.status = "complete";
  return pages.onTabUpdated(tab.id, { status: "complete" }, tab);
}
// The tab lands on whatever tabs.update set (our page).
const landed = (tab) => pages.onTabUpdated(tab.id, { status: "loading", url: tab.url }, tab).then(() => pages.onTabUpdated(tab.id, { status: "complete" }, tab));

test("a reload while the redirect is decided, and an address with a fragment", async () => {
  const tab = { id: 9, windowId: 1, url: "https://a.example/", status: "complete" };
  tabList = [tab];
  // webRequest reports no fragment; the tab keeps it.
  fail(9, "https://frag.test/p");
  tab.url = "https://frag.test/p#sec";
  tab.status = "complete";
  await pages.onTabUpdated(9, { status: "loading", url: tab.url }, tab);
  assert.equal(await pages.onTabUpdated(9, { status: "complete" }, tab), true);
  assert.equal((await recordFor(updates.splice(0)[0][1])).url, "https://frag.test/p#sec");
  // A reload starts before the redirect goes out: no redirect.
  clock += 5000;
  tab.url = "https://reload.test/";
  fail(9, "https://reload.test/");
  const done = pages.onTabUpdated(9, { status: "complete" }, tab);
  await pages.onTabUpdated(9, { status: "loading" }, tab);
  assert.equal(await done, false);
  assert.deepEqual(updates.splice(0), []);
});

test("a network error in a normal tab goes to Clearcart's page, with the address kept out of the URL", async () => {
  const tab = { id: 1, windowId: 1, url: "https://a.example/" };
  tabList = [tab];
  assert.equal(await failAndShow(tab, "https://nowhere.test/path?q=1"), true);
  const [[id, url]] = updates.splice(0);
  assert.equal(id, 1);
  assert.ok(isErrorPage(url) && keyOf(url), url);
  assert.ok(!url.includes("nowhere"), url);
  assert.deepEqual(await recordFor(url), { url: "https://nowhere.test/path?q=1", error: "net::ERR_NAME_NOT_RESOLVED" });
  await landed(tab);
});

test("Back from the page to the failed address keeps Chrome's page; Retry gets the page again", async () => {
  const tab = tabList[0];
  const ours = tab.url;
  clock += 5000;
  // Back: the failed entry loads again and fails.
  assert.equal(await failAndShow(tab, "https://nowhere.test/path?q=1"), false);
  assert.deepEqual(updates.splice(0), []);
  // Forward to our page, then Retry from it.
  tab.url = ours;
  await landed(tab);
  assert.deepEqual(await pages.onRetry({ tab: { id: 1 }, url: ours }), { url: "https://nowhere.test/path?q=1" });
  clock += 5000;
  assert.equal(await failAndShow(tab, "https://nowhere.test/path?q=1"), true);
  assert.equal(updates.splice(0).length, 1);
  await landed(tab);
});

test("Retry is refused for a page that is not Clearcart's error page", async () => {
  assert.deepEqual(await pages.onRetry({ tab: { id: 1 }, url: `chrome-extension://${ID}/options/options.html` }), { url: null });
  assert.deepEqual(await pages.onRetry({ tab: { id: 1 }, url: `${BASE}#k=00000000-0000-4000-8000-000000000000` }), { url: null });
  assert.deepEqual(await pages.onRetry({ url: tabList[0].url }), { url: null });
});

test("only network errors, main frames, normal windows, the setting on, and no loop", async () => {
  const tab = { id: 2, windowId: 1, url: "https://a.example/" };
  tabList = [tab];
  for (const error of ["net::ERR_ABORTED", "net::ERR_BLOCKED_BY_CLIENT", "net::ERR_CERT_DATE_INVALID", "net::ERR_CACHE_MISS", "net::ERR_UNSAFE_PORT"]) {
    assert.ok(!NET_ERRORS.has(error));
    assert.equal(await failAndShow(tab, "https://b.test/", error), false, error);
  }
  pages.onRequestError({ tabId: 2, frameId: 3, type: "sub_frame", url: "https://c.test/", error: "net::ERR_NAME_NOT_RESOLVED" });
  tab.url = "https://c.test/";
  assert.equal(await pages.onTabUpdated(2, { status: "complete" }, tab), false);
  pages.onRequestError({ tabId: -1, frameId: 0, type: "main_frame", url: "https://d.test/", error: "net::ERR_NAME_NOT_RESOLVED" });
  // A popup window.
  const pop = { id: 3, windowId: 99, url: "https://a.example/" };
  tabList.push(pop);
  assert.equal(await failAndShow(pop, "https://e.test/"), false);
  // The setting off.
  local = { ...local, errorPages: false };
  assert.equal(await failAndShow(tab, "https://f.test/"), false);
  local = { ...local, errorPages: true };
  // The tab moved on before it completed.
  fail(2, "https://g.test/");
  tab.url = "https://h.example/";
  assert.equal(await pages.onTabUpdated(2, { status: "complete" }, tab), false);
  // Loop guard: the same address twice at once.
  assert.equal(await failAndShow(tab, "https://i.test/"), true);
  tab.url = "https://i.test/";
  clock += 10;
  pages.onRequestError({ tabId: 2, frameId: 0, type: "main_frame", url: "https://i.test/", error: "net::ERR_NAME_NOT_RESOLVED" });
  assert.equal(await pages.onTabUpdated(2, { status: "complete" }, tab), false);
  assert.equal(updates.splice(0).length, 1);
});

test("the agent sees the page as navigable chrome-error://chromewebdata/, the failed address only when allowed", async () => {
  clock += 60_000;
  const tab = { id: 5, windowId: 1, active: true, url: "https://a.example/", title: "A" };
  const blocked = { id: 6, windowId: 1, url: "https://a.example/", title: "B" };
  tabList = [tab, blocked];
  await failAndShow(tab, "https://shop.test/cart");
  await failAndShow(blocked, "https://www.chase.com/login");
  await landed(tab);
  await landed(blocked);
  assert.ok(isErrorPage(tab.url) && isErrorPage(blocked.url));
  blocked.title = tab.title = "Can't reach this site";
  const ctx = await tabs.tabsContext();
  // The user's error page for a blocked site is hidden, as Chrome's would be.
  assert.deepEqual(ctx.tabs.map((t) => [t.tabId, t.url, t.title]), [[5, "chrome-error://chromewebdata/", "Can't reach this site"]]);
  assert.equal(await tabs.failedAddress(tab), "https://shop.test/cart");
  assert.equal(await tabs.failedAddress(blocked), null);
  await assert.rejects(tabs.resolveTab(6, { nav: true }), /blocked/);
  // Listed and navigable, never read; no Back into the failed address.
  assert.equal(await tabs.resolveTab(5, { nav: true }), 5);
  await assert.rejects(tabs.resolveAllowedTab(5), /could not reach/);
  await assert.rejects(tabs.navigate({ tabId: 5, url: "back" }), /error page/);
  assert.equal((await tabs.tabInfo({ tabId: 5 })).url, "chrome-error://chromewebdata/");
});

test("closing the tab forgets its pages", async () => {
  const url = tabList[1].url;
  await pages.forget(6);
  assert.equal(await recordFor(url), null);
});
