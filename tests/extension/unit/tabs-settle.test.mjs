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
