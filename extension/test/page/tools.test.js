// find, get_page_text, form_input, rect, click_ref, read_fields,
// fill_payment, clear_payment against the test shop's pages
// (tests/fixtures/shop.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_LINE } from "../../../tests/fixtures/shop.mjs";
import { loadPage, shopPages } from "./harness.js";

const CARD = { name: "Ada Lovelace", number: "4111 1111 1111 1111", exp: "12/29", csc: "737" };
const SECRETS = ["4111111111111111", "4111 1111", "Ada Lovelace", "12/29", "737"];
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

test("read_fields classifies checkout fields without values", async () => {
  const p = load("checkout", "/checkout");
  const { fields } = (await p.call("read_fields", {})).result;
  const kinds = Object.fromEntries(fields.map((f) => [f.name, f.kind]));
  assert.equal(kinds["cc-number"], "cc-number");
  assert.equal(kinds["cc-name"], "cc-name");
  assert.equal(kinds["cc-exp"], "cc-exp");
  assert.equal(kinds["cc-csc"], "cc-csc");
  assert.equal(kinds.address, "address");
  assert.equal(kinds.q, "other");
  assert.ok(fields.every((f) => f.filled === false || f.name === "q"));
  for (const f of fields) assert.deepEqual(Object.keys(f).sort(), ["autocomplete", "filled", "kind", "name"]);
});

test("fill_payment fills by kind, returns last4 only, and nothing leaks after", async () => {
  const p = load("checkout", "/checkout");
  const d = p.document;
  let inputs = 0;
  d.querySelector('[name="cc-number"]').addEventListener("input", () => inputs++);
  const r = await p.call("fill_payment", { card: CARD, address: "1 Main St, Springfield" });
  assert.deepEqual([r.ok, r.result], [true, { ok: true, last4: "1111" }]);
  assert.equal(inputs, 1);
  assert.equal(d.querySelector('[name="cc-number"]').value, "4111111111111111");
  assert.equal(d.querySelector('[name="cc-name"]').value, "Ada Lovelace");
  assert.equal(d.querySelector('[name="cc-exp"]').value, "12/29");
  assert.equal(d.querySelector('[name="cc-csc"]').value, "737");
  assert.equal(d.querySelector('[name="address"]').value, "1 Main St, Springfield");
  const filled = (await p.call("read_fields", {})).result.fields.filter((f) => f.kind !== "other");
  assert.ok(filled.every((f) => f.filled));
  const outputs = JSON.stringify([
    (await p.call("read_page", {})).result,
    (await p.call("read_page", { filter: "all" })).result,
    (await p.call("get_page_text", {})).result,
    (await p.call("find", { query: "card" })).result,
    (await p.call("read_fields", {})).result,
  ]);
  for (const s of SECRETS) assert.ok(!outputs.includes(s), "leaked " + s);
  assert.equal((await p.call("clear_payment", {})).ok, true);
  for (const n of ["cc-number", "cc-name", "cc-exp", "cc-csc"]) assert.equal(d.querySelector(`[name="${n}"]`).value, "", n);
  assert.equal(d.querySelector('[name="address"]').value, "1 Main St, Springfield");
});

test("fill_payment validates input and errors never echo the card", async () => {
  const p = load("checkout", "/checkout");
  const bad = await p.call("fill_payment", { card: { ...CARD, number: "4111 1111 1111 111x" } });
  assert.equal(bad.error.code, "bad_request");
  assert.ok(!JSON.stringify(bad).includes("4111"));
  const noField = load("product", "/product/mug");
  const r = await noField.call("fill_payment", { card: CARD });
  assert.equal(r.error.code, "no_element");
  assert.ok(!JSON.stringify(r).includes("4111"));
});

test("fill_payment handles split month/year selects", async () => {
  const p = loadPage(`<form>
    <input autocomplete="cc-number" name="n">
    <select autocomplete="cc-exp-month" name="m"><option value="">MM</option><option value="01">01</option><option value="12">12</option></select>
    <select autocomplete="cc-exp-year" name="y"><option value="">YYYY</option><option value="2029">2029</option></select>
  </form>`);
  const r = await p.call("fill_payment", { card: CARD });
  assert.equal(r.ok, true);
  assert.equal(p.document.querySelector('[name="m"]').value, "12");
  assert.equal(p.document.querySelector('[name="y"]').value, "2029");
});

test("read_page and get_page_text report origin and path only, never the query string or fragment", async () => {
  const p = loadPage(pages.search, { url: BASE + "/search?q=mug&code=SECRET#access_token=TOKEN" });
  for (const m of ["read_page", "get_page_text"]) {
    const r = (await p.call(m, {})).result;
    assert.equal(r.url, BASE + "/search", m);
  }
});
