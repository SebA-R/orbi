// Real-layout check in Playwright's isolated Chromium (never the user's
// Chrome): mask.js + page.js injected in worker order into live store pages.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startStore } from "./harness.js";

const file = (p) => fileURLToPath(new URL(p, import.meta.url));
let store, browser;

before(async () => {
  store = await startStore();
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  store?.stop();
});

async function open(path) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.goto(store.base + path);
  await page.addScriptTag({ path: file("../../content/mask.js") });
  await page.addScriptTag({ path: file("../../content/protect.js") });
  await page.addScriptTag({ path: file("../../content/page.js") });
  await page.addScriptTag({ path: file("../../content/page.js") }); // idempotent re-inject
  const call = (method, params = {}) =>
    page.evaluate(([m, p]) => globalThis.__clearcartPage.handle({ method: m, params: p }), [method, params]);
  return { page, call };
}

test("checkout: fill_payment, masked read_page, rect hits #place-order", async () => {
  await fetch(store.base + "/reset", { method: "POST", redirect: "manual" });
  await fetch(store.base + "/cart/add", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "product_id=cetirizine-30&quantity=1",
    redirect: "manual",
  });
  const { page, call } = await open("/checkout");
  const fill = await call("fill_payment", { card: { name: "Ada Lovelace", number: "4111111111111111", exp: "12/29", csc: "737" }, address: "1 Main St" });
  assert.deepEqual(fill, { ok: true, result: { ok: true, last4: "1111" } });
  const tree = (await call("read_page", { filter: "all" })).result.tree;
  for (const s of ["4111111111111111", "Ada Lovelace", "12/29", "737"]) assert.ok(!tree.includes(s), "leaked " + s);
  const ref = (await call("find", { query: "place order" })).result.matches[0].ref;
  const r = (await call("rect", { ref })).result;
  assert.ok(r.width > 0 && r.height > 0, JSON.stringify(r));
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [r.x + r.width / 2, r.y + r.height / 2]);
  assert.equal(hit, "place-order");
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await page.waitForURL(/\/order\//);
  assert.equal(await page.textContent("#card-last4"), "1111");
  await page.close();
});

test("cart: hidden addon line is skipped after unticking the add-on", async () => {
  await fetch(store.base + "/cart/add", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "product_id=cetirizine-30&quantity=1",
    redirect: "manual",
  });
  const { page, call } = await open("/cart");
  const ref = (await call("find", { query: "subscribe", limit: 5 })).result.matches.find((m) => m.role === "checkbox").ref;
  assert.equal((await call("form_input", { ref, value: false })).ok, true);
  await page.waitForFunction(() => document.getElementById("addon-line").hidden);
  const text = (await call("get_page_text", {})).result.text;
  assert.ok(!text.includes("Subscribe & Save membership"), text);
  await page.close();
});

test("button lock: real hit-testing, label clicks, the badge never blocks a person's click", async () => {
  await fetch(store.base + "/reset", { method: "POST", redirect: "manual" });
  await fetch(store.base + "/cart/add", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "product_id=cetirizine-30&quantity=1",
    redirect: "manual",
  });
  const { page, call } = await open("/checkout");
  const ref = (await call("find", { query: "place order" })).result.matches.find((m) => m.role === "button").ref;
  const r = (await call("rect", { ref })).result;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;

  // A coordinate click on the button, or on its edge, is refused.
  for (const [x, y] of [[cx, cy], [r.x + 3, r.y + 3]]) {
    const g = await call("guard_point", { x, y });
    assert.equal(g.ok, false, `${x},${y}`);
    assert.equal(g.error.code, "locked");
  }
  assert.equal((await call("guard_ref", { ref })).error.code, "locked");
  // Somewhere plain is fine.
  assert.equal((await call("guard_point", { x: 5, y: 5 })).ok, true);

  // The badge is drawn over the button, but the hit test goes straight through it.
  const badge = await page.evaluate(() => {
    const host = document.getElementById("clearcart-lock-badges");
    return host && { aria: host.getAttribute("aria-hidden"), pe: getComputedStyle(host).pointerEvents };
  });
  assert.deepEqual(badge, { aria: "true", pe: "none" });
  const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [r.x + 4, r.y - 6 > 0 ? r.y - 6 : r.y + 2]);
  assert.notEqual(under, "clearcart-lock-badges");

  // Enter from a field of the payment form is refused.
  await page.focus('[name="cc-name"]');
  assert.equal((await call("guard_key", { key: "Enter" })).error.code, "locked");

  // The lock is for the agent only: a person's own click places the order.
  await call("fill_payment", { card: { name: "Ada Lovelace", number: "4111111111111111", exp: "12/29", csc: "737" }, address: "1 Main St" });
  await page.mouse.click(cx, cy);
  await page.waitForURL(/\/order\//);
  await page.close();
});

test("button lock: a label click would check the add-on back on, so it is refused once unchecked", async () => {
  await fetch(store.base + "/cart/add", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "product_id=cetirizine-30&quantity=1",
    redirect: "manual",
  });
  const { page, call } = await open("/cart");
  const box = (await call("find", { query: "subscribe", limit: 5 })).result.matches.find((m) => m.role === "checkbox");
  assert.equal(box.uncheckOnly, true);
  const label = await page.evaluate(() => {
    const r = document.querySelector('label:has(#addon_subscription)').getBoundingClientRect();
    return { x: r.right - 20, y: r.top + r.height / 2 };
  });
  // Checked: clicking the label unchecks it, which is allowed.
  if (await page.isChecked("#addon_subscription")) assert.equal((await call("guard_point", label)).ok, true);
  assert.equal((await call("form_input", { ref: box.ref, value: false })).ok, true);
  const g = await call("guard_point", label);
  assert.equal(g.ok, false);
  assert.match(g.error.message, /can only be unchecked/);
  await page.close();
});
