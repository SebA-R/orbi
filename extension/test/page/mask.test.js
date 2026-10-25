import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage } from "./harness.js";

const HTML = `<form>
  <label>Name on card <input id="a" name="holder"></label>
  <label>Card number <input id="b" autocomplete="cc-number"></label>
  <input id="c" name="cvv">
  <input id="d" placeholder="MM/YY" name="exp">
  <label for="e">Security code</label><input id="e" name="sc">
  <input id="f" name="q" aria-label="Search products">
  <input id="g" name="shipping" aria-label="Express shipping">
  <input id="h" type="checkbox" name="addon_subscription">
  <textarea id="i" name="address" autocomplete="street-address"></textarea>
</form>`;

test("isPaymentField flags cc-* autocomplete and payment words only", () => {
  const { window } = loadPage(HTML);
  const M = window.ClearcartMask;
  const $ = (id) => window.document.getElementById(id);
  for (const id of ["a", "b", "c", "d", "e"]) assert.equal(M.isPaymentField($(id)), true, id);
  for (const id of ["f", "g", "h", "i"]) assert.equal(M.isPaymentField($(id)), false, id);
});

test("luhn accepts valid 13-19 digit numbers with separators", () => {
  const { window } = loadPage("");
  const { luhn } = window.ClearcartMask;
  assert.equal(luhn("4111 1111 1111 1111"), true);
  assert.equal(luhn("4111-1111-1111-1111"), true);
  assert.equal(luhn("4111111111111112"), false);
  assert.equal(luhn("1800555014"), false); // too short
  assert.equal(luhn("abc"), false);
});

test("maskValue masks payment elements and card runs in free text", () => {
  const { window } = loadPage(HTML);
  const M = window.ClearcartMask;
  const b = window.document.getElementById("b");
  assert.equal(M.maskValue("4111111111111111", b), "[masked]");
  assert.equal(M.maskValue("", b), "");
  const out = M.maskValue("card 4111 1111 1111 1111 call 1-800-555-0142");
  assert.ok(!out.includes("4111"), out);
  assert.ok(out.includes("1-800-555-0142"), out);
});
