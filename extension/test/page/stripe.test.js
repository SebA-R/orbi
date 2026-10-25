// The saved-card fill (content/cardfill.js), find and get_page_text on a
// saved copy of Stripe's hosted test checkout
// (tests/fixtures/stripe-checkout.html). Never a live Stripe page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPage } from "./harness.js";

const HTML = readFileSync(fileURLToPath(new URL("../../../tests/fixtures/stripe-checkout.html", import.meta.url)), "utf8");
const CARDFILL_SRC = readFileSync(new URL("../../content/cardfill.js", import.meta.url), "utf8");
const URL_ = "https://checkout.stripe.com/c/pay/cs_test_a1B2c3";
// What the worker hands the page for Stripe's test card (router.js fillCard).
const VALUES = { "cc-number": "4242424242424242", "cc-exp": { mm: "12", yy: "30", yyyy: "2030" }, "cc-csc": "123", "cc-name": "Ada Lovelace", "postal-code": "42424", email: "demo@example.com" };
const SECRETS = ["4242424242424242", "4242 4242", "12 / 30", "Ada Lovelace"];

const load = () => loadPage(HTML, { url: URL_ });
const val = (p, id) => p.document.getElementById(id).value;
// cardfill.js in the page's window, after mask.js, as the worker injects it.
function cardFill(p) {
  p.window.eval(CARDFILL_SRC);
  const api = p.window.__clearcartCardFill;
  return (fn, ...a) => JSON.parse(JSON.stringify(api[fn](...a)));
}

test("stripe: the card fields and the billing ZIP are in the page, by kind; the email and country are not card fields", () => {
  const cf = cardFill(load());
  assert.deepEqual(cf("scan").fields.map((f) => [f.kind, f.usable]), [["cc-number", true], ["cc-exp", true], ["cc-csc", true], ["cc-name", true], ["postal-code", true]]);
});

test("stripe: fill puts in card, name, billing ZIP and email; nothing reaches the page-reading tools; clear empties the card", async () => {
  const p = load();
  const cf = cardFill(p);
  let inputs = 0;
  p.document.getElementById("cardNumber").addEventListener("input", () => inputs++);
  const r = cf("fill", VALUES);
  assert.deepEqual(r, { ok: true, filled: { email: true, "cc-number": true, "cc-exp": true, "cc-csc": true, "cc-name": true, "postal-code": true } });
  assert.equal(inputs, 1);
  assert.equal(val(p, "cardNumber"), "4242424242424242");
  assert.equal(val(p, "cardExpiry"), "12 / 30", "the field's MM / YY");
  assert.equal(val(p, "cardCvc"), "123");
  assert.equal(val(p, "billingName"), "Ada Lovelace");
  assert.equal(val(p, "billingPostalCode"), "42424");
  assert.equal(val(p, "email"), "demo@example.com");
  assert.equal(val(p, "billingCountry"), "US", "the country select is left alone");
  const outputs = JSON.stringify([
    r,
    cf("scan"),
    (await p.call("read_page", { filter: "all" })).result,
    (await p.call("get_page_text", {})).result,
    (await p.call("find", { query: "card" })).result,
  ]);
  for (const s of SECRETS) assert.ok(!outputs.includes(s), "leaked " + s);
  assert.deepEqual(cf("clear"), { ok: true, cleared: 5 });
  for (const id of ["cardNumber", "cardExpiry", "cardCvc", "billingName", "billingPostalCode"]) assert.equal(val(p, id), "", id);
});

test("stripe: an email or ZIP already there is never overwritten, and no email means none is typed", () => {
  const p = load();
  p.document.getElementById("email").value = "typed@example.com";
  p.document.getElementById("billingPostalCode").value = "10001";
  const r = cardFill(p)("fill", VALUES);
  assert.equal(r.ok, true);
  assert.equal(r.filled.email, false);
  assert.equal(val(p, "email"), "typed@example.com");
  assert.equal(val(p, "billingPostalCode"), "10001");
  const q = load();
  const { email: _, ...noEmail } = VALUES;
  assert.equal(cardFill(q)("fill", noEmail).ok, true);
  assert.equal(val(q, "email"), "");
});

test("stripe: find Pay gives one button named Pay next to Pay with card and Pay with Link; the text shows one amount", async () => {
  const p = load();
  const m = (await p.call("find", { query: "pay" })).result.matches.filter((x) => x.role === "button");
  const names = m.map((x) => x.name);
  assert.ok(names.includes("Pay with card") && names.includes("Pay with Link"), JSON.stringify(names));
  const pay = m.filter((x) => /^\s*pay(\s+processing)?\s*$/i.test(x.name));
  assert.equal(pay.length, 1, JSON.stringify(names));
  assert.equal(pay[0].locked, true, "the Pay button is locked for agent tools");
  const text = (await p.call("get_page_text", {})).result.text;
  assert.deepEqual([...new Set(text.match(/\$\d+\.\d{2}/g))], ["$14.00"]);
});
