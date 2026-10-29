import { test } from "node:test";
import assert from "node:assert/strict";

// tabs.actAndSettle: a click or key, then where the tab is once a page it
// opened has loaded.
const listeners = new Set();
let tab = { id: 4, url: "https://www.etsy.com/c/mugs?q=1", title: "Mugs", status: "complete" };
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://x/${p}` },
  storage: {
    local: { get: async () => ({ browseMode: "open", blocklist: ["chase.com"] }) },
    session: { get: async () => ({}), set: async () => {} },
  },
  tabs: {
    get: async () => ({ ...tab }),
    onUpdated: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
  },
};
const fire = (change) => {
  if (change.url) tab.url = change.url;
  if (change.status) tab.status = change.status;
  if (change.title) tab.title = change.title;
  for (const f of listeners) f(tab.id, change, tab);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { actAndSettle } = await import("../../../extension/background/tabs.js");

test("no load after the action: answers after the short window, not navigated, origin and path only", async () => {
  tab = { id: 4, url: "https://www.etsy.com/c/mugs?q=1", title: "Mugs", status: "complete" };
  const t0 = Date.now();
  const r = await actAndSettle(4, async () => ({ ok: true, via: "cdp" }), { windowMs: 60 });
  assert.deepEqual(r, { ok: true, via: "cdp", navigated: false, url: "https://www.etsy.com/c/mugs", title: "Mugs" });
  assert.ok(Date.now() - t0 < 300);
  assert.equal(listeners.size, 0, "listener removed");
});

test("a load that starts just after the action is waited for until complete", async () => {
  tab = { id: 4, url: "https://www.etsy.com/c/mugs", title: "Mugs", status: "complete" };
  const r = await actAndSettle(
    4,
    async () => {
      setTimeout(() => fire({ status: "loading", url: "https://www.etsy.com/c/jackets#top" }), 20);
      setTimeout(() => fire({ status: "complete", title: "Jackets" }), 120);
      return { ok: true };
    },
    { windowMs: 80, timeoutMs: 2_000 }
  );
  assert.deepEqual(r, { ok: true, navigated: true, url: "https://www.etsy.com/c/jackets", title: "Jackets" });
});

test("a load that never finishes is reported as it stands after the timeout, not failed", async () => {
  tab = { id: 4, url: "https://www.etsy.com/c/mugs", title: "Mugs", status: "complete" };
  const r = await actAndSettle(4, async () => (fire({ status: "loading", url: "https://www.etsy.com/slow" }), { ok: true }), { windowMs: 50, timeoutMs: 150 });
  assert.equal(r.navigated, true);
  assert.equal(r.url, "https://www.etsy.com/slow");
});

test("a blocked page gives no url or title; an action that fails rethrows and cleans up", async () => {
  tab = { id: 4, url: "https://www.etsy.com/", title: "Etsy", status: "complete" };
  const r = await actAndSettle(4, async () => {
    fire({ status: "loading", url: "https://www.chase.com/login" });
    await sleep(5);
    fire({ status: "complete", title: "Chase" });
    return { ok: true };
  }, { windowMs: 50 });
  assert.deepEqual(r, { ok: true, navigated: true });
  await assert.rejects(actAndSettle(4, async () => { throw new Error("locked"); }), /locked/);
  assert.equal(listeners.size, 0);
});

test("an address change with no load (pushState) waits only the render time", async () => {
  tab = { id: 4, url: "https://www.etsy.com/c/mugs", title: "Mugs", status: "complete" };
  const t0 = Date.now();
  const r = await actAndSettle(4, async () => (fire({ url: "https://www.etsy.com/c/cups" }), { ok: true }), { windowMs: 2_000, renderMs: 80 });
  const took = Date.now() - t0;
  assert.equal(r.navigated, true);
  assert.equal(r.url, "https://www.etsy.com/c/cups");
  assert.ok(took >= 70 && took < 1_000, String(took));
});

test("stop() (an interrupt) ends the wait for a slow load at once", async () => {
  tab = { id: 4, url: "https://www.etsy.com/c/mugs", title: "Mugs", status: "complete" };
  let stopped = false;
  setTimeout(() => (stopped = true), 50);
  const t0 = Date.now();
  await actAndSettle(4, async () => (fire({ status: "loading" }), { ok: true }), { windowMs: 50, timeoutMs: 5_000, stop: () => stopped });
  assert.ok(Date.now() - t0 < 1_000);
});

test("still loading at the cap: reports where the tab is going, without the old page's title", async () => {
  tab = { id: 4, url: "https://www.etsy.com/cart", title: "Cart", status: "complete" };
  const r = await actAndSettle(4, async () => {
    tab.pendingUrl = "https://www.etsy.com/checkout";
    fire({ status: "loading" });
    return { ok: true };
  }, { windowMs: 50, timeoutMs: 120 });
  delete tab.pendingUrl;
  assert.deepEqual(r, { ok: true, navigated: true, url: "https://www.etsy.com/checkout", title: "" });
});
