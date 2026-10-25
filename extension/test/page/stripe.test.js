// read_fields, fill_payment, find and get_page_text on a saved copy of
// Stripe's hosted test checkout (tests/fixtures/stripe-checkout.html).
// Never a live Stripe page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPage } from "./harness.js";

const HTML = readFileSync(fileURLToPath(new URL("../../../tests/fixtures/stripe-checkout.html", import.meta.url)), "utf8");
const URL_ = "https://checkout.stripe.com/c/pay/cs_test_a1B2c3";
const CARD = { name: "Ada Lovelace", number: "4242 4242 4242 4242", exp: "12/30", csc: "123" };
const SECRETS = ["4242424242424242", "4242 4242", "12/30", "Ada Lovelace"];

const load = () => loadPage(HTML, { url: URL_ });
const val = (p, id) => p.document.getElementById(id).value;

test("stripe: the card fields are in the page and read by kind", async () => {
  const p = load();
  const kinds = Object.fromEntries((await p.call("read_fields", {})).result.fields.map((f) => [f.name, f.kind]));
  assert.equal(kinds.cardNumber, "cc-number");
  assert.equal(kinds.cardExpiry, "cc-exp");
  assert.equal(kinds.cardCvc, "cc-csc");
  assert.equal(kinds.billingName, "cc-name");
  assert.equal(kinds.billingPostalCode, "address");
});

test("stripe: fill_payment fills card, name, billing ZIP and email; only last4 comes back", async () => {
  const p = load();
  let inputs = 0;
  p.document.getElementById("cardNumber").addEventListener("input", () => inputs++);
  const r = await p.call("fill_payment", { card: CARD, billing: { postal: "42424", email: "demo@example.com" } });
  assert.deepEqual([r.ok, r.result], [true, { ok: true, last4: "4242" }]);
  assert.equal(inputs, 1);
  assert.equal(val(p, "cardNumber"), "4242424242424242");
  assert.equal(val(p, "cardExpiry"), "12/30");
  assert.equal(val(p, "cardCvc"), "123");
  assert.equal(val(p, "billingName"), "Ada Lovelace");
  assert.equal(val(p, "billingPostalCode"), "42424");
  assert.equal(val(p, "email"), "demo@example.com");
  assert.equal(val(p, "billingCountry"), "US", "the country select is left alone");
  const outputs = JSON.stringify([
    (await p.call("read_page", { filter: "all" })).result,
    (await p.call("get_page_text", {})).result,
    (await p.call("find", { query: "card" })).result,
    (await p.call("read_fields", {})).result,
  ]);
  for (const s of SECRETS) assert.ok(!outputs.includes(s), "leaked " + s);
  await p.call("clear_payment", {});
  for (const id of ["cardNumber", "cardExpiry", "cardCvc", "billingName"]) assert.equal(val(p, id), "", id);
});

test("stripe: billing values never overwrite what is there, and no billing means no ZIP or email", async () => {
  const p = load();
  p.document.getElementById("email").value = "typed@example.com";
  await p.call("fill_payment", { card: CARD, billing: { postal: "42424", email: "demo@example.com" } });
  assert.equal(val(p, "email"), "typed@example.com");
  const q = load();
  await q.call("fill_payment", { card: CARD });
  assert.equal(val(q, "billingPostalCode"), "");
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
