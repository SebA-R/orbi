// find, get_page_text, form_input, rect, click_ref and order_buttons, and
// the saved-card fill's frame script (content/cardfill.js), against the test
// shop's pages (tests/fixtures/shop.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HELP_LINE } from "../../../tests/fixtures/shop.mjs";
import { loadPage, shopPages } from "./harness.js";

// What the worker hands a frame for the published Visa test card.
const VALUES = { "cc-number": "4111111111111111", "cc-name": "Ada Lovelace", "cc-exp": { mm: "12", yy: "29", yyyy: "2029" }, "cc-csc": "737" };
const SECRETS = ["4111111111111111", "4111 1111", "Ada Lovelace", "12/29", "737"];
const CARDFILL_SRC = readFileSync(new URL("../../content/cardfill.js", import.meta.url), "utf8");
const BASE = "http://localhost:4100";
const pages = shopPages();

const load = (name, path) => loadPage(pages[name], { url: BASE + path });
const refOf = async (p, query, role) => {
  const r = await p.call("find", { query });
  assert.equal(r.ok, true, JSON.stringify(r));
  const m = r.result.matches.find((x) => !role || x.role === role);
  assert.ok(m, `no ${role || ""} match for ${query}: ${JSON.stringify(r.result)}`);
  return m.ref;
};

test("find ranks exact names and returns refs shared with read_page", async () => {
  const p = load("product", "/product/mug");
  const r = (await p.call("find", { query: "add to cart" })).result;
  assert.equal(r.matches[0].role, "button");
  assert.equal(r.matches[0].name, "Add to cart");
  const tree = (await p.call("read_page", {})).result.tree;
  assert.ok(tree.includes(`[${r.matches[0].ref}]`));
  const lim = (await p.call("find", { query: "a", limit: 2 })).result.matches;
  assert.equal(lim.length, 2);
  const bad = await p.call("find", {});
  assert.equal(bad.error.code, "bad_request");
});

test("find on search results locates product links", async () => {
  const p = load("search", "/search?q=mug");
  const m = (await p.call("find", { query: "mug link" })).result.matches;
  assert.ok(m.length >= 1);
  assert.ok(m.every((x) => x.role === "link"));
});

test("get_page_text puts main content first and masks card runs", async () => {
  const p = load("checkout", "/checkout");
  p.document.querySelector("main").insertAdjacentHTML("beforeend", "<p>Card on file: 4111-1111-1111-1111</p>");
  const r = (await p.call("get_page_text", {})).result;
  assert.ok(r.text.startsWith("Checkout"), r.text.slice(0, 80));
  assert.ok(r.text.includes("Order total"));
  assert.ok(r.text.includes(HELP_LINE), "text outside main comes after it");
  assert.ok(!r.text.includes("4111"), "card leaked");
  const short = (await p.call("get_page_text", { maxChars: 100 })).result;
  assert.equal(short.truncated, true);
});

test("form_input fills search and unticks the add-on checkbox with events", async () => {
  const p = load("cart", "/cart");
  const ref = await refOf(p, "subscribe", "checkbox");
  const box = p.document.getElementById("addon_subscription");
  let changes = 0;
  box.addEventListener("change", () => changes++);
  assert.equal(box.checked, true);
  assert.deepEqual((await p.call("form_input", { ref, value: false })).result, { ok: true });
  assert.equal(box.checked, false);
  assert.equal(changes, 1);
  const sref = await refOf(p, "search products", "searchbox");
  await p.call("form_input", { ref: sref, value: "batteries" });
  assert.equal(p.document.querySelector('input[name="q"]').value, "batteries");
});

test("form_input refuses payment fields and card numbers anywhere", async () => {
  const p = load("checkout", "/checkout");
  for (const q of ["card number", "security code", "expiration", "name on card"]) {
    const ref = await refOf(p, q, "textbox");
    const r = await p.call("form_input", { ref, value: "x" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "payment_field", q);
  }
  const addr = await refOf(p, "shipping address", "textbox");
  const r = await p.call("form_input", { ref: addr, value: "4111111111111111" });
  assert.equal(r.error.code, "payment_field");
  assert.equal((await p.call("form_input", { ref: addr, value: "1 Main St" })).ok, true);
});

test("form_input and rect report missing refs", async () => {
  const p = load("product", "/product/mug");
  assert.equal((await p.call("form_input", { ref: "ref_999", value: "x" })).error.code, "no_element");
  assert.equal((await p.call("rect", { ref: "nope" })).error.code, "bad_request");
  const ref = await refOf(p, "add to cart", "button");
  p.document.getElementById("add-to-cart").remove();
  assert.equal((await p.call("rect", { ref })).error.code, "no_element");
});

test("rect returns a viewport box and scrolls into view", async () => {
  const p = load("checkout", "/checkout");
  const el = p.document.getElementById("place-order");
  let scrolled = null;
  el.scrollIntoView = (o) => (scrolled = o);
  el.getBoundingClientRect = () => ({ x: 10, y: 20, width: 200, height: 40, left: 10, top: 20 });
  const ref = await refOf(p, "place order", "button");
  const r = await p.call("rect", { ref });
  assert.deepEqual(r.result, { x: 10, y: 20, width: 200, height: 40 });
  assert.equal(scrolled.block, "center");
});

test("click_ref clicks the element, and refuses the locked Place order", async () => {
  const p = load("checkout", "/checkout");
  let clicks = 0;
  let orders = 0;
  const search = p.document.querySelector('form[role=search] button');
  search.addEventListener("click", (e) => { clicks++; e.preventDefault(); });
  p.document.getElementById("place-order").addEventListener("click", (e) => { orders++; e.preventDefault(); });
  const ref = await refOf(p, "search", "button");
  assert.equal((await p.call("click_ref", { ref })).ok, true);
  assert.equal(clicks, 1);
  const locked = await p.call("click_ref", { ref: await refOf(p, "place order", "button") });
  assert.equal(locked.ok, false);
  assert.equal(locked.error.code, "locked");
  assert.match(locked.error.message, /^Locked: 'Place order/);
  assert.equal(orders, 0);
});

// cardfill.js in the page's window, the way the worker injects it after
// mask.js. Results come back through JSON, as executeScript sends them.
function cardFill(p) {
  p.window.eval(CARDFILL_SRC);
  const api = p.window.__clearcartCardFill;
  return (fn, ...a) => JSON.parse(JSON.stringify(api[fn](...a)));
}

test("cardfill scan finds the checkout's card fields by kind, never a value", async () => {
  const p = load("checkout", "/checkout");
  const cf = cardFill(p);
  p.document.querySelector('[name="cc-name"]').value = "Ada Lovelace";
  const s = cf("scan");
  assert.equal(s.href, BASE + "/checkout");
  assert.deepEqual(s.fields, [
    { kind: "cc-name", filled: true },
    { kind: "cc-number", filled: false },
    { kind: "cc-exp", filled: false },
    { kind: "cc-csc", filled: false },
  ], "the address and the search box are not card fields");
  assert.ok(!JSON.stringify(s).includes("Ada"));
});

test("cardfill fills by kind with input events, nothing reaches the page-reading tools, and clear empties the card only", async () => {
  const p = load("checkout", "/checkout");
  const d = p.document;
  const cf = cardFill(p);
  d.querySelector('[name="address"]').value = "1 Main St, Springfield";
  let inputs = 0;
  d.querySelector('[name="cc-number"]').addEventListener("input", () => inputs++);
  const r = cf("fill", VALUES);
  assert.deepEqual(r, { ok: true, filled: { "cc-number": true, "cc-name": true, "cc-exp": true, "cc-csc": true } });
  assert.equal(inputs, 1);
  assert.equal(d.querySelector('[name="cc-number"]').value, "4111111111111111");
  assert.equal(d.querySelector('[name="cc-name"]').value, "Ada Lovelace");
  assert.equal(d.querySelector('[name="cc-exp"]').value, "12/29", "the field's MM/YY");
  assert.equal(d.querySelector('[name="cc-csc"]').value, "737");
  assert.ok(cf("scan").fields.every((f) => f.filled));
  const outputs = JSON.stringify([
    r,
    cf("scan"),
    (await p.call("read_page", {})).result,
    (await p.call("read_page", { filter: "all" })).result,
    (await p.call("get_page_text", {})).result,
    (await p.call("find", { query: "card" })).result,
    (await p.call("order_buttons", {})).result,
  ]);
  for (const x of SECRETS) assert.ok(!outputs.includes(x), "leaked " + x);
  assert.deepEqual(cf("clear"), { ok: true, cleared: 4 });
  for (const n of ["cc-number", "cc-name", "cc-exp", "cc-csc"]) assert.equal(d.querySelector(`[name="${n}"]`).value, "", n);
  assert.equal(d.querySelector('[name="address"]').value, "1 Main St, Springfield");
});

test("cardfill takes split month and year selects and each field's own expiry format", async () => {
  const p = loadPage(`<form>
    <input autocomplete="cc-number" name="n">
    <select autocomplete="cc-exp-month" name="m"><option value="">MM</option><option value="01">01</option><option value="12">12</option></select>
    <select autocomplete="cc-exp-year" name="y"><option value="">YYYY</option><option value="2029">2029</option></select>
  </form>`);
  const cf = cardFill(p);
  const exp = VALUES["cc-exp"];
  assert.deepEqual(cf("fill", { "cc-number": VALUES["cc-number"], "cc-exp-month": exp, "cc-exp-year": exp }).ok, true);
  assert.equal(p.document.querySelector('[name="m"]').value, "12");
  assert.equal(p.document.querySelector('[name="y"]').value, "2029");
  const q = loadPage(`<input autocomplete="cc-exp" name="a" maxlength="4"><input autocomplete="cc-exp" name="b" placeholder="MM/YYYY">`);
  const cq = cardFill(q);
  // Two expiry fields: the kind is not clear, so neither is filled.
  assert.deepEqual(cq("fill", { "cc-exp": exp }), { ok: false, filled: { "cc-exp": false } });
  assert.equal(q.document.querySelector('[name="a"]').value + q.document.querySelector('[name="b"]').value, "");
  q.document.querySelector('[name="b"]').remove();
  assert.equal(cq("fill", { "cc-exp": exp }).ok, true);
  assert.equal(q.document.querySelector('[name="a"]').value, "1229");
  const y = loadPage(`<input autocomplete="cc-exp" name="b" placeholder="MM/YYYY">`);
  cardFill(y)("fill", { "cc-exp": exp });
  assert.equal(y.document.querySelector('[name="b"]').value, "12/2029");
});

test("cardfill guesses a kind only for payment fields: never a shipping name or ZIP, nor a hidden or disabled field", async () => {
  const p = loadPage(`<form>
    <label>Full name <input name="name"></label>
    <label>ZIP <input name="zip" autocomplete="shipping postal-code"></label>
    <label>Card number <input name="cardnumber"></label>
    <label>CVC <input name="cvc"></label>
    <label>Expiry <input name="card-expiry" placeholder="MM / YY"></label>
    <label>Billing ZIP <input name="bzip" autocomplete="billing postal-code"></label>
    <input name="cc-old" autocomplete="cc-number" hidden>
    <input name="cc-off" autocomplete="cc-csc" disabled>
    <input type="hidden" name="token" autocomplete="cc-number">
  </form>`);
  const cf = cardFill(p);
  assert.deepEqual(cf("scan").fields.map((f) => f.kind), ["cc-number", "cc-csc", "cc-exp", "postal-code"]);
  const r = cf("fill", { "cc-number": VALUES["cc-number"], "cc-csc": "737", "cc-exp": VALUES["cc-exp"], "postal-code": "94704" });
  assert.equal(r.ok, true);
  const v = (n) => p.document.querySelector(`[name="${n}"]`).value;
  assert.deepEqual([v("name"), v("zip"), v("cardnumber"), v("cvc"), v("card-expiry"), v("bzip"), v("cc-old"), v("cc-off")], ["", "", "4111111111111111", "737", "12 / 29", "94704", "", ""]);
});

test("order_buttons lists the order button with its label, masked, and never a navigation link", async () => {
  const p = load("checkout", "/checkout");
  const { buttons } = (await p.call("order_buttons", {})).result;
  assert.deepEqual(buttons.map((b) => [b.label, b.kind, b.disabled]), [[`Place order · ${pages.total}`, "order", false]]);
  assert.match(buttons[0].ref, /^ref_\d+$/);
  p.document.querySelector("main").insertAdjacentHTML("beforeend", '<button type="button">Pay with 4111 1111 1111 1111</button><a href="/checkout">Checkout</a>');
  const again = (await p.call("order_buttons", {})).result.buttons;
  assert.ok(!JSON.stringify(again).includes("4111"), JSON.stringify(again));
  assert.ok(!again.some((b) => /^Checkout$/.test(b.label)));
});

test("read_page and get_page_text report origin and path only, never the query string or fragment", async () => {
  const p = loadPage(pages.search, { url: BASE + "/search?q=mug&code=SECRET#access_token=TOKEN" });
  for (const m of ["read_page", "get_page_text"]) {
    const r = (await p.call(m, {})).result;
    assert.equal(r.url, BASE + "/search", m);
  }
});
