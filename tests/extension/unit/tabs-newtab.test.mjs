import { test } from "node:test";
import assert from "node:assert/strict";

// A fake chrome with one user tab on the new tab page and one on a blocked site.
const ID = "abcdefghijklmnopabcdefghijklmnop";
const own = `chrome-extension://${ID}/newtab/newtab.html`;
const store = new Map();
let tabList = [];
const updates = [];
const listeners = { updated: new Set(), removed: new Set() };
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://${ID}/${p}` },
  storage: {
    local: { get: async () => ({ browseMode: "open", blocklist: ["chase.com"] }) },
    session: { get: async (k) => ({ [k]: store.get(k) }), set: async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, v); } },
  },
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
      t.url = props.url;
      t.status = "complete";
      for (const fn of listeners.updated) fn(id, { status: "loading" }, t);
      for (const fn of listeners.updated) fn(id, { status: "complete" }, t);
      return t;
    },
    onUpdated: { addListener: (f) => listeners.updated.add(f), removeListener: (f) => listeners.updated.delete(f) },
    onRemoved: { addListener: (f) => listeners.removed.add(f), removeListener: (f) => listeners.removed.delete(f) },
  },
};

const tabs = await import("../../../extension/background/tabs.js");

test("isNewTabPage: Chrome's new tab pages and Clearcart's own, nothing else", () => {
  for (const u of ["chrome://newtab/", "chrome://newtab", "chrome://new-tab-page/", "chrome://new-tab-page-third-party/", own, `${own}?x#y`]) {
    assert.ok(tabs.isNewTabPage(u), u);
  }
  for (const u of ["chrome://settings/", "about:blank", "https://chrome.google.com/newtab", `chrome-extension://${ID}/options/options.html`, `chrome-extension://other/newtab/newtab.html`, "", null]) {
    assert.ok(!tabs.isNewTabPage(u), String(u));
  }
});

test("a user's new tab is listed and can be navigated to a store, but never read or acted on", async () => {
  tabList = [
    { id: 1, active: true, url: "chrome://newtab/", title: "New Tab" },
    { id: 2, active: false, url: "https://www.chase.com/", title: "Chase" },
  ];
  const ctx = await tabs.tabsContext();
  assert.deepEqual(ctx.tabs.map((t) => [t.tabId, t.url]), [[1, "chrome://newtab/"]]);
  await assert.rejects(tabs.resolveAllowedTab(1), /new tab page/);
  await assert.rejects(tabs.resolveAllowedTab(2), /blocked site/);
  const r = await tabs.navigate({ url: "https://www.etsy.com/" });
  assert.equal(r.tabId, 1);
  assert.deepEqual(updates.at(-1), [1, "https://www.etsy.com/"]);
  await assert.rejects(tabs.navigate({ tabId: 2, url: "https://www.etsy.com/" }), /blocked site/);
});

test("a user's new tab can't be sent through its history, and one loading a blocked site is hidden", async () => {
  tabList = [{ id: 3, active: true, url: "chrome://newtab/", title: "New Tab" }];
  await assert.rejects(tabs.navigate({ tabId: 3, url: "forward" }), /new tab page/);
  await assert.rejects(tabs.navigate({ tabId: 3, url: "back" }), /new tab page/);
  // The user typed a blocked address; the tab is on its way there.
  tabList = [{ id: 4, active: true, url: "chrome://newtab/", pendingUrl: "https://www.chase.com/", title: "Chase" }];
  assert.deepEqual((await tabs.tabsContext()).tabs, []);
  await assert.rejects(tabs.navigate({ tabId: 4, url: "https://www.etsy.com/" }), /blocked site/);
  assert.equal(tabs.onNewTab({ url: "chrome://newtab/", pendingUrl: "chrome://newtab/" }), true);
});
