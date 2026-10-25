// Button lock in the worker's router: every click, key and typed newline is
// checked by the page before CDP sees it, and press_protected needs a fresh
// single-use nonce from lock_arm.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createRouter, isActivationKey, UNLOCK_TTL_MS } from "../../../extension/background/router.js";
import { INTERNAL, TOOLS } from "../../../extension/lib/protocol.js";

const LOCKED = { ok: false, error: { code: "locked", message: "Locked: 'Place order' can only be pressed by Clearcart after the user says yes." } };

function fakes({ locked = new Set(), url = "http://localhost:4000/checkout", cdpClickFails = false } = {}) {
  const calls = [];
  let clock = 1_000;
  let n = 0;
  const state = { url };
  const chromeApi = {
    scripting: { executeScript: async () => {} },
    tabs: {
      sendMessage: async (tabId, msg) => {
        calls.push(["page", msg.method, msg.params]);
        if (locked.has(msg.method)) return LOCKED;
        if (msg.method === "guard_ref" || msg.method === "rect") return { ok: true, result: { x: 10, y: 20, width: 100, height: 40 } };
        if (msg.method === "press_check_user") return { ok: true, result: { x: 10, y: 20, width: 100, height: 40, cls: msg.params.cls } };
        if (msg.method === "press_check") return { ok: true, result: { x: 10, y: 20, width: 100, height: 40, kind: "marked" } };
        if (msg.method === "focused_field") return { ok: true, result: { kind: "other", payment: false } };
        return { ok: true, result: { ok: true } };
      },
    },
  };
  const tabs = {
    resolveAllowedTab: async (id) => id ?? 7,
    tabInfo: async ({ tabId }) => ({ tabId, url: state.url, title: "t" }),
    isPaySite: async (u) => new URL(u).origin === "http://localhost:4000",
    assertPageAllowed: async () => {},
  };
  const cdp = {
    click: async (o) => {
      if (cdpClickFails) throw new Error("attach failed");
      calls.push(["cdp.click", o]);
    },
    type: async (o) => calls.push(["cdp.type", o]),
    key: async (o) => calls.push(["cdp.key", o]),
  };
  const router = createRouter({ chromeApi, tabs, cdp, now: () => clock, newNonce: () => `nonce-${++n}` });
  const sent = () => calls.filter((c) => c[0].startsWith("cdp."));
  return { calls, router, sent, state, tick: (ms) => (clock += ms) };
}

test("lock_arm and press_protected are internal, never tools", () => {
  assert.ok(INTERNAL.includes("lock_arm") && INTERNAL.includes("press_protected"));
  assert.ok(!TOOLS.includes("lock_arm") && !TOOLS.includes("press_protected"));
});

test("click by ref: a locked target never reaches CDP", async () => {
  const f = fakes({ locked: new Set(["guard_ref"]) });
  await assert.rejects(f.router.route("click", { ref: "ref_9" }), { code: "locked", message: /^Locked: 'Place order'/ });
  assert.deepEqual(f.sent(), []);
  assert.ok(!f.calls.some((c) => c[1] === "click_ref"), "no DOM fallback either");
});

test("click by coordinates: hit-tested first", async () => {
  const ok = fakes();
  await ok.router.route("click", { x: 5, y: 6 });
  assert.deepEqual(ok.calls[0], ["page", "guard_point", { x: 5, y: 6 }]);
  assert.deepEqual(ok.sent(), [["cdp.click", { tabId: 7, x: 5, y: 6 }]]);
  const no = fakes({ locked: new Set(["guard_point"]) });
  await assert.rejects(no.router.route("click", { x: 60, y: 40 }), { code: "locked" });
  assert.deepEqual(no.sent(), []);
});

test("click_ref (the DOM fallback) is checked by the page too", async () => {
  const f = fakes({ locked: new Set(["click_ref"]) });
  await assert.rejects(f.router.route("click_ref", { ref: "ref_9" }), { code: "locked" });
});

test("Enter and Space are checked against the focused element, other keys are not", async () => {
  const f = fakes({ locked: new Set(["guard_key"]) });
  for (const key of ["Enter", "Return", " ", "Space", "ctrl+Enter"]) {
    await assert.rejects(f.router.route("key", { key }), { code: "locked" }, key);
  }
  assert.deepEqual(f.sent(), []);
  await f.router.route("key", { key: "Tab" });
  await f.router.route("key", { key: "ArrowDown" });
  assert.equal(f.sent().length, 2);
});

test("typing a newline counts as Enter", async () => {
  const f = fakes({ locked: new Set(["guard_key"]) });
  await assert.rejects(f.router.route("type", { text: "1 Main St\n" }), { code: "locked" });
  await f.router.route("type", { text: "1 Main St" });
  assert.deepEqual(f.sent().map((c) => c[0]), ["cdp.type"]);
});

test("form_input lock errors keep their code", async () => {
  const f = fakes({ locked: new Set(["form_input"]) });
  await assert.rejects(f.router.route("form_input", { ref: "ref_3", value: true }), { code: "locked" });
});

test("press_protected without, with a wrong, or with a reused nonce is refused", async () => {
  const f = fakes();
  await assert.rejects(f.router.route("press_protected", { ref: "ref_9" }), { code: "locked" });
  await assert.rejects(f.router.route("press_protected", { ref: "ref_9", nonce: "guess" }), { code: "locked" });
  const { nonce } = await f.router.route("lock_arm", {});
  assert.deepEqual(await f.router.route("press_protected", { ref: "ref_9", nonce }), { ok: true, via: "cdp" });
  assert.deepEqual(f.sent(), [["cdp.click", { tabId: 7, x: 60, y: 40 }]]);
  await assert.rejects(f.router.route("press_protected", { ref: "ref_9", nonce }), { code: "locked" }, "single use");
  assert.equal(f.sent().length, 1);
});

test("press_protected: nonce bound to its tab, its origin and a short TTL", async () => {
  const f = fakes();
  const a = await f.router.route("lock_arm", { tabId: 7 });
  assert.equal(a.expiresInMs, UNLOCK_TTL_MS);
  await assert.rejects(f.router.route("press_protected", { tabId: 8, ref: "ref_9", nonce: a.nonce }), { code: "locked" });
  // Spent by the failed try.
  await assert.rejects(f.router.route("press_protected", { tabId: 7, ref: "ref_9", nonce: a.nonce }), { code: "locked" });

  const b = await f.router.route("lock_arm", { tabId: 7 });
  f.state.url = "http://localhost:4100/checkout";
  await assert.rejects(f.router.route("press_protected", { tabId: 7, ref: "ref_9", nonce: b.nonce }), { code: "locked", message: /changed origin/ });
  f.state.url = "http://localhost:4000/checkout";

  const c = await f.router.route("lock_arm", { tabId: 7 });
  f.tick(UNLOCK_TTL_MS + 1);
  await assert.rejects(f.router.route("press_protected", { tabId: 7, ref: "ref_9", nonce: c.nonce }), { code: "locked" });
  assert.deepEqual(f.sent(), []);
});

test("press_protected asks the page to confirm an order button, and falls back to press_ref", async () => {
  const f = fakes({ locked: new Set(["press_check"]) });
  const { nonce } = await f.router.route("lock_arm", {});
  await assert.rejects(f.router.route("press_protected", { ref: "ref_2", nonce }), { code: "locked" });
  assert.deepEqual(f.sent(), []);
  const g = fakes({ cdpClickFails: true });
  const n2 = (await g.router.route("lock_arm", {})).nonce;
  assert.deepEqual(await g.router.route("press_protected", { ref: "ref_9", nonce: n2 }), { ok: true, via: "dom" });
  assert.ok(g.calls.some((c) => c[1] === "press_ref"));
});

test("lock_arm refuses a site that is browsable but not a pay site", async () => {
  const f = fakes({ url: "https://www.etsy.com/checkout" });
  await assert.rejects(f.router.route("lock_arm", { tabId: 7 }), { code: "locked", message: /not a Clearcart pay site/ });
  // A tabs module without isPaySite fails closed.
  const bare = createRouter({ chromeApi: {}, tabs: { resolveAllowedTab: async () => 7, tabInfo: async () => ({ url: "http://localhost:4000/checkout" }) }, cdp: {} });
  await assert.rejects(bare.route("lock_arm", { tabId: 7 }), { code: "locked" });
});

test("press_check and press_ref are not reachable as plain page methods", async () => {
  const f = fakes();
  for (const m of ["press_check", "press_ref", "press_check_user", "press_hit_user", "press_done_user", "press_ref_user", "guard_ref", "guard_point", "guard_key"]) {
    await assert.rejects(f.router.route(m, { ref: "ref_9" }), { code: "unknown_method" }, m);
  }
});

test("isActivationKey", () => {
  assert.ok(isActivationKey("Enter") && isActivationKey(" ") && isActivationKey("Shift+Space"));
  assert.ok(!isActivationKey("Tab") && !isActivationKey("a") && !isActivationKey(undefined));
});

// Security review: the activation check must follow what parseKey sends,
// not how the key is spelled.
test("key specs that send Enter or Space under another spelling are checked or refused", async () => {
  const f = fakes({ locked: new Set(["guard_key"]) });
  for (const key of ["Shift+ ", "Ctrl+ ", "alt+Space", "Shift+Enter", "meta+Return"]) {
    await assert.rejects(f.router.route("key", { key }), { code: "locked" }, JSON.stringify(key));
  }
  // Control characters never reach CDP at all: parseKey refuses them.
  for (const key of ["\r", "\n", "Shift+\r", "\t", "\u0000", "Ctrl+\n"]) {
    await assert.rejects(f.router.route("key", { key }), { code: "bad_request" }, JSON.stringify(key));
  }
  assert.deepEqual(f.sent(), []);
  // The page saw a plain Enter or Space to check.
  const keys = f.calls.filter((c) => c[1] === "guard_key").map((c) => c[2].key);
  assert.deepEqual(keys, ["Space", "Space", "Space", "Enter", "Enter"]);
  for (const k of ["Shift+ ", "Ctrl+ ", "\r", "\n"]) assert.ok(isActivationKey(k), JSON.stringify(k));
});

// User-directed unlock (request_unlock on the server): lock_arm scope "user"
// works on any allowed site, and its nonce only fits press_unlocked.
test("user scope: arms off the pay sites, presses once, and never fits press_protected", async () => {
  const f = fakes({ url: "https://www.etsy.com/cart" });
  await assert.rejects(f.router.route("lock_arm", { tabId: 7 }), { code: "locked" }, "order scope still needs a pay site");
  const target = { tabId: 7, ref: "ref_4", label: "Proceed to checkout", cls: "checkout" };
  const a = await f.router.route("lock_arm", { tabId: 7, scope: "user" });
  assert.deepEqual(await f.router.route("press_unlocked", { ...target, nonce: a.nonce }), { ok: true, via: "cdp" });
  const check = f.calls.find((c) => c[1] === "press_check_user");
  assert.deepEqual(check[2], { ref: "ref_4", label: "Proceed to checkout", cls: "checkout" });
  await assert.rejects(f.router.route("press_unlocked", { ...target, nonce: a.nonce }), { code: "locked" }, "single use");
  const b = await f.router.route("lock_arm", { tabId: 7, scope: "user" });
  await assert.rejects(f.router.route("press_protected", { tabId: 7, ref: "ref_9", nonce: b.nonce }), { code: "locked" }, "user nonce cannot place an order");
  const g = fakes();
  const o = await g.router.route("lock_arm", { tabId: 7 });
  await assert.rejects(g.router.route("press_unlocked", { ...target, nonce: o.nonce }), { code: "locked" }, "order nonce does not fit press_unlocked");
  await assert.rejects(g.router.route("lock_arm", { tabId: 7, scope: "admin" }), { code: "bad_request" });
  assert.equal(f.sent().length, 1);
  assert.equal(g.sent().length, 0);
});

test("user scope: nonce bound to tab, origin and TTL; refused when the page says no", async () => {
  const f = fakes({ url: "https://www.etsy.com/cart" });
  const target = { ref: "ref_4", label: "Sign in", cls: "account" };
  const a = await f.router.route("lock_arm", { tabId: 7, scope: "user" });
  await assert.rejects(f.router.route("press_unlocked", { ...target, tabId: 8, nonce: a.nonce }), { code: "locked" });
  const b = await f.router.route("lock_arm", { tabId: 7, scope: "user" });
  f.state.url = "https://evil.example/";
  await assert.rejects(f.router.route("press_unlocked", { ...target, tabId: 7, nonce: b.nonce }), { message: /changed origin/ });
  f.state.url = "https://www.etsy.com/cart";
  const c = await f.router.route("lock_arm", { tabId: 7, scope: "user" });
  f.tick(UNLOCK_TTL_MS + 1);
  await assert.rejects(f.router.route("press_unlocked", { ...target, tabId: 7, nonce: c.nonce }), { code: "locked" });
  const g = fakes({ locked: new Set(["press_check_user"]) });
  const d = await g.router.route("lock_arm", { tabId: 7, scope: "user" });
  await assert.rejects(g.router.route("press_unlocked", { ...target, tabId: 7, nonce: d.nonce }), { code: "locked" });
  assert.deepEqual([...f.sent(), ...g.sent()], []);
});

test("user scope: hit-tests the point right before the click and releases the lock only after it", async () => {
  const f = fakes({ url: "https://www.etsy.com/cart" });
  const target = { ref: "ref_4", label: "Proceed to checkout", cls: "checkout" };
  const a = await f.router.route("lock_arm", { tabId: 7, scope: "user" });
  await f.router.route("press_unlocked", { ...target, tabId: 7, nonce: a.nonce });
  const seq = f.calls.filter((c) => c[0] === "cdp.click" || /^press_/.test(c[1] || "")).map((c) => (c[0] === "page" ? c[1] : c[0]));
  assert.deepEqual(seq, ["press_check_user", "press_hit_user", "cdp.click", "press_done_user"]);
  assert.deepEqual(f.calls.find((c) => c[1] === "press_hit_user")[2], { ...target, x: 60, y: 40 });
  // A swapped or covered control fails the hit test: no click.
  const g = fakes({ url: "https://www.etsy.com/cart", locked: new Set(["press_hit_user"]) });
  const b = await g.router.route("lock_arm", { tabId: 7, scope: "user" });
  await assert.rejects(g.router.route("press_unlocked", { ...target, tabId: 7, nonce: b.nonce }), { code: "locked" });
  assert.ok(!g.calls.some((c) => c[0] === "cdp.click" || c[1] === "press_done_user"));
});

test("typing into a password field is refused before CDP", async () => {
  const calls = [];
  const router = createRouter({
    chromeApi: { scripting: { executeScript: async () => {} }, tabs: { sendMessage: async (_t, m) => (calls.push(m.method), m.method === "focused_field" ? { ok: true, result: { kind: "other", payment: false, password: true } } : { ok: true, result: { ok: true } }) } },
    tabs: { resolveAllowedTab: async () => 7, tabInfo: async () => ({ url: "https://www.etsy.com/signin" }) },
    cdp: { type: async () => calls.push("cdp.type"), key: async () => calls.push("cdp.key") },
  });
  await assert.rejects(router.route("type", { text: "hunter2" }), { code: "payment_field" });
  await assert.rejects(router.route("key", { key: "a" }), { code: "payment_field" });
  assert.ok(!calls.includes("cdp.type") && !calls.includes("cdp.key"));
});
