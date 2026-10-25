// The button lock inside page.js, against real demo store HTML: markers in
// read_page and find, form_input on locked controls, the guard_* checks the
// worker runs before clicks and keys, and press_check / press_ref.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadPage, startStore, fetchHtml } from "./harness.js";

let store;
const pages = {};

before(async () => {
  store = await startStore();
  const b = store.base;
  await fetch(b + "/reset", { method: "POST", redirect: "manual" });
  pages.product = await fetchHtml(b + "/product/cetirizine-30");
  await fetch(b + "/cart/add", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "product_id=cetirizine-30&quantity=1",
    redirect: "manual",
  });
  pages.cart = await fetchHtml(b + "/cart");
  pages.checkout = await fetchHtml(b + "/checkout");
});
after(() => store && store.stop());

const load = (name, path) => loadPage(pages[name], { url: store.base + path });
const lineOf = (tree, re) => tree.split("\n").find((l) => re.test(l));
const refIn = (line) => /\[(ref_\d+)\]/.exec(line)[1];

test("read_page marks Place order [locked] and the add-on [uncheck only]; shopping controls stay plain", async () => {
  const checkout = (await load("checkout", "/checkout").call("read_page", { filter: "all" })).result.tree;
  assert.match(lineOf(checkout, /Place order/), /^\s*- button "Place order[^"]*" \[ref_\d+\] \[locked\]$/);
  const cart = (await load("cart", "/cart").call("read_page", {})).result.tree;
  assert.match(lineOf(cart, /Subscribe/), /checked \[ref_\d+\] \[uncheck only\]$/);
  assert.match(lineOf(cart, /Proceed to checkout/), /\[locked\]$/);
  assert.doesNotMatch(lineOf(cart, /"Remove"/), /locked|uncheck/);
  const product = (await load("product", "/product/cetirizine-30").call("read_page", {})).result.tree;
  assert.doesNotMatch(lineOf(product, /Add to cart/), /locked/);
  assert.doesNotMatch(product, /\[locked\]/);
});

test("find flags locked matches", async () => {
  const p = load("checkout", "/checkout");
  const m = (await p.call("find", { query: "place order" })).result.matches.find((x) => x.role === "button");
  assert.equal(m.locked, true);
  const add = (await load("product", "/product/cetirizine-30").call("find", { query: "add to cart" })).result.matches[0];
  assert.equal(add.locked, undefined);
});

test("form_input may uncheck the add-on but never check it again", async () => {
  const p = load("cart", "/cart");
  const ref = refIn(lineOf((await p.call("read_page", {})).result.tree, /Subscribe/));
  assert.deepEqual(await p.call("form_input", { ref, value: false }), { ok: true, result: { ok: true } });
  assert.equal(p.document.getElementById("addon_subscription").checked, false);
  const again = await p.call("form_input", { ref, value: true });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, "locked");
  assert.match(again.error.message, /can only be unchecked/);
  assert.equal(p.document.getElementById("addon_subscription").checked, false);
});

test("guard_ref and guard_point refuse locked targets and pass normal ones", async () => {
  const p = load("checkout", "/checkout");
  const tree = (await p.call("read_page", { filter: "all" })).result.tree;
  const r = await p.call("guard_ref", { ref: refIn(lineOf(tree, /Place order/)) });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "locked");
  assert.equal(r.error.message, "Locked: 'Place order · $" + /Place order · \$([0-9.]+)/.exec(tree)[1] + "' can only be pressed by Clearcart after the user says yes.");
  const ok = await p.call("guard_ref", { ref: refIn(lineOf(tree, /textbox "Name on card"/)) });
  assert.equal(ok.ok, true);

  // jsdom has no layout: point elementFromPoint at the button's text.
  const btn = p.document.getElementById("place-order");
  p.document.elementFromPoint = () => btn.firstChild.parentElement;
  assert.equal((await p.call("guard_point", { x: 5, y: 5 })).error.code, "locked");
  p.document.elementFromPoint = () => p.document.querySelector("h1") || p.document.body;
  assert.equal((await p.call("guard_point", { x: 5, y: 5 })).ok, true);
  assert.equal((await p.call("guard_point", { x: "a", y: 5 })).error.code, "bad_request");
});

test("guard_key refuses Enter on Place order and in the checkout form, allows Tab and search", async () => {
  const p = load("checkout", "/checkout");
  p.document.getElementById("place-order").focus();
  assert.equal((await p.call("guard_key", { key: "Enter" })).error.code, "locked");
  assert.equal((await p.call("guard_key", { key: " " })).error.code, "locked");
  assert.equal((await p.call("guard_key", { key: "Tab" })).ok, true);
  p.document.querySelector('[name="cc-name"]').focus();
  const enter = await p.call("guard_key", { key: "Enter" });
  assert.equal(enter.error.code, "locked", "Enter in a field would submit the payment form");
  p.document.querySelector('form[role=search] input').focus();
  assert.equal((await p.call("guard_key", { key: "Enter" })).ok, true);
});

test("press_check and press_ref accept only order buttons", async () => {
  const p = load("checkout", "/checkout");
  const tree = (await p.call("read_page", { filter: "all" })).result.tree;
  const place = refIn(lineOf(tree, /Place order/));
  const btn = p.document.getElementById("place-order");
  btn.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, width: 100, height: 40, right: 110, bottom: 60 });
  p.document.elementFromPoint = () => btn;
  const ok = await p.call("press_check", { ref: place });
  assert.deepEqual(ok, { ok: true, result: { x: 10, y: 20, width: 100, height: 40, kind: "marked" } });
  // Covered by something else: refused.
  p.document.elementFromPoint = () => p.document.body;
  assert.equal((await p.call("press_check", { ref: place })).error.code, "no_element");
  // Not an order button: refused.
  const name = refIn(lineOf(tree, /textbox "Name on card"/));
  assert.equal((await p.call("press_check", { ref: name })).error.code, "locked");
  assert.equal((await p.call("press_ref", { ref: name })).error.code, "locked");
  let clicks = 0;
  btn.addEventListener("click", (e) => { clicks++; e.preventDefault(); });
  assert.equal((await p.call("press_ref", { ref: place })).ok, true);
  assert.equal(clicks, 1);
});

test("badges come up when the page script loads, outside what read_page and get_page_text see", async () => {
  const p = load("checkout", "/checkout");
  const host = p.document.getElementById("clearcart-lock-badges");
  assert.ok(host, "badge host");
  assert.equal(host.getAttribute("aria-hidden"), "true");
  const text = (await p.call("get_page_text", {})).result.text;
  assert.doesNotMatch(text, /Locked for AI/);
  assert.doesNotMatch((await p.call("read_page", { filter: "all" })).result.tree, /Locked for AI/);
});

test("page calls fail closed without protect.js", async () => {
  const p = loadPage(pages.checkout, { url: store.base + "/checkout", page: false });
  delete p.window.ClearcartProtect;
  p.inject = null;
  p.window.eval(await (await import("node:fs")).promises.readFile(new URL("../../content/page.js", import.meta.url), "utf8"));
  const r = await p.call("read_page", {});
  assert.equal(r.ok, false);
  assert.match(r.error.message, /protect\.js was not injected/);
});
