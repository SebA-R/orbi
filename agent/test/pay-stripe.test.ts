import { STRIPE_SITE } from "./pay-stripe-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import { ExtError } from "../extbridge.ts";
import { isCheckoutUrl, isStripeCheckoutUrl } from "../origins.ts";
import { onPayCheckout, payNowExt, STRIPE_TEST_EMAIL, STRIPE_TEST_ZIP, stripePaid, stripeTotal, type PayState } from "../pay.ts";

// Stripe's published test card. Tests drive a fake extension only.
const CARD = { name: "Test Person", number: "4242424242424242", exp: "12/30", csc: "123" };
const URL_ = `${STRIPE_SITE}/c/pay/cs_test_a1B2c3`;

// What get_page_text gives on tests/fixtures/stripe-checkout.html.
const CHECKOUT_TEXT = "TEST MODE\nPay Orbi Demo Store\n$14.00\nBlue mug\nView details\nPay with Link\nOR\nEmail\nPayment method\nCard\nCard information\nCardholder name\nCountry or region\nSave my information for faster checkout\nPay";
const PAID_TEXT = "TEST MODE\nThanks for your payment\nA payment to Orbi Demo Store will appear on your statement.\n$14.00\nBlue mug";

function confirmed(total = "$14.00"): PayState {
  return {
    lastTabId: 7,
    confirmation: { item: "Blue mug", quantity: 1, total, state: "confirmed", confirmedAt: Date.now(), tabId: 7 },
    cardFieldsLive: false,
  };
}

type Opts = {
  url?: string;
  text?: string;
  paidText?: string;
  // The card fields: Stripe has no name field when billing is the shipping address.
  fields?: Array<{ kind: string; filled: boolean }>;
  // Card number field still there after the press.
  formStays?: boolean;
  buttons?: Array<{ ref: string; role: string; name: string }>;
};

function fakeStripe(o: Opts = {}) {
  const url = o.url ?? URL_;
  const calls: Array<{ method: string; params: any }> = [];
  let paid = false;
  const before = o.fields ?? [
    { kind: "other", filled: false },
    { kind: "cc-number", filled: false },
    { kind: "cc-exp", filled: false },
    { kind: "cc-csc", filled: false },
    { kind: "address", filled: false },
  ];
  const handler = async (method: string, params: any) => {
    calls.push({ method, params });
    switch (method) {
      case "tab_info":
        return { tabId: 7, url, title: "Stripe Checkout" };
      case "tabs_context":
        return { tabs: [{ tabId: 7, url, title: "Stripe Checkout", active: true }] };
      case "get_page_text":
        return { url, text: paid ? (o.paidText ?? PAID_TEXT) : (o.text ?? CHECKOUT_TEXT) };
      case "read_fields":
        return { fields: paid && !o.formStays ? [] : before };
      case "fill_payment":
        return { ok: true, last4: params.card.number.slice(-4) };
      case "find":
        return {
          matches: o.buttons ?? [
            { ref: "ref_1", role: "button", name: "Pay with Link" },
            { ref: "ref_2", role: "button", name: "Pay with card" },
            { ref: "ref_9", role: "button", name: "Pay" },
          ],
        };
      case "lock_arm":
        return { nonce: "n1" };
      case "press_protected":
        paid = true;
        return { ok: true };
      case "read_page":
        return { tree: "- main\n" };
      case "clear_payment":
        return { ok: true };
    }
    throw new ExtError("unknown_method", method);
  };
  return { calls, bridge: { call: (m: string, p: any = {}) => handler(m, p) } };
}

const fast = { getCard: async () => ({ ...CARD }), pollMs: 5, orderTimeoutMs: 300 };

test("Stripe test checkout URLs are checkout pages; live mode and other hosts are not", () => {
  for (const u of [
    `${STRIPE_SITE}/c/pay/cs_test_a1B2c3`,
    `${STRIPE_SITE}/c/pay/cs_test_a1B2c3#fidkdWxOYHwnPyd1blpxYHZxWjA0`,
    "https://buy.stripe.com/test_4gw5kE0Ab1cd",
    "https://js.stripe.com/v3/embedded-checkout-inner.html?publishableKey=pk_test_x&checkoutSessionId=cs_test_a1B2&ui_mode=embedded",
  ]) assert.equal(isStripeCheckoutUrl(u), true, u);
  for (const u of [
    `${STRIPE_SITE}/c/pay/cs_live_a1B2c3`,
    "https://buy.stripe.com/4gw5kE0Ab1cd",
    "https://js.stripe.com/v3/embedded-checkout-inner.html?checkoutSessionId=cs_live_a1B2",
    "http://checkout.stripe.com/c/pay/cs_test_a1B2c3",
    "https://checkout.stripe.com.evil.example/c/pay/cs_test_a1B2c3",
    "https://checkout.stripe.dev/checkout",
  ]) assert.equal(isStripeCheckoutUrl(u), false, u);
  assert.equal(isCheckoutUrl("https://buy.stripe.com/test_4gw5kE0Ab1cd"), true);
  // A pay site only when listed.
  assert.equal(onPayCheckout(URL_), true);
  assert.equal(onPayCheckout("https://buy.stripe.com/test_4gw5kE0Ab1cd"), false);
});

test("stripeTotal: Total due, else the one amount shown; several amounts are unknown", () => {
  assert.equal(stripeTotal(CHECKOUT_TEXT), "$14.00");
  assert.equal(stripeTotal("Blue mug\n$14.00\nTax\n$1.12\nTotal due\n$15.12"), "$15.12");
  assert.equal(stripeTotal("Blue mug\n$14.00\nTea\n$3.00"), "");
  assert.equal(stripePaid(PAID_TEXT), true);
  assert.equal(stripePaid(CHECKOUT_TEXT), false);
});

test("Stripe: fills card plus test ZIP and email, presses the one Pay button once, confirms on the thank-you page", async () => {
  const s = fakeStripe();
  const state = confirmed();
  const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
  assert.deepEqual(r, { ok: true, last4: "4242", receipt: { item: "Blue mug", total: "$14.00", last4: "4242" } });
  assert.ok(!JSON.stringify(r).includes(CARD.number));
  assert.equal(state.cardFieldsLive, false);
  assert.equal(state.confirmation?.state, "used");
  const fill = s.calls.filter((c) => c.method === "fill_payment");
  assert.equal(fill.length, 1);
  assert.deepEqual(fill[0].params.card, CARD);
  assert.deepEqual(fill[0].params.billing, { postal: STRIPE_TEST_ZIP, email: STRIPE_TEST_EMAIL });
  const presses = s.calls.filter((c) => c.method === "press_protected");
  assert.deepEqual(presses.map((c) => c.params), [{ tabId: 7, ref: "ref_9", nonce: "n1" }]);
  // Only fill_payment carries the card.
  assert.deepEqual(s.calls.filter((c) => JSON.stringify(c.params).includes(CARD.number)).map((c) => c.method), ["fill_payment"]);
});

test("Stripe: the vault card's own ZIP and email win over the test values", async () => {
  const s = fakeStripe();
  await payNowExt(confirmed(), { ...fast, getCard: async () => ({ ...CARD, zip: "94107", email: "me@example.com" }), bridge: s.bridge as any });
  assert.deepEqual(s.calls.find((c) => c.method === "fill_payment")!.params.billing, { postal: "94107", email: "me@example.com" });
});

test("Stripe: a total that does not match, or that cannot be read, stops before the card is read", async () => {
  for (const [text, total] of [[CHECKOUT_TEXT, "$15.00"], ["Blue mug\n$14.00\nTea\n$3.00", "$14.00"]] as const) {
    const s = fakeStripe({ text });
    let read = false;
    const r = await payNowExt(confirmed(total), { ...fast, getCard: async () => ((read = true), { ...CARD }), bridge: s.bridge as any });
    assert.equal(r.ok, false);
    assert.match((r as any).error, /checkout total/);
    assert.equal(read, false);
    assert.ok(!s.calls.some((c) => c.method === "fill_payment" || c.method === "lock_arm"));
  }
});

test("Stripe: a live-mode session is not a checkout page", async () => {
  const s = fakeStripe({ url: `${STRIPE_SITE}/c/pay/cs_live_a1B2c3` });
  const r = await payNowExt(confirmed(), { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /not the checkout page/);
  assert.ok(!s.calls.some((c) => c.method === "fill_payment"));
});

test("Stripe: no single Pay button means no press, and the form is cleared", async () => {
  for (const buttons of [
    [{ ref: "ref_2", role: "button", name: "Pay with card" }],
    [{ ref: "ref_8", role: "button", name: "Pay" }, { ref: "ref_9", role: "button", name: "Pay" }],
  ]) {
    const s = fakeStripe({ buttons });
    const state = confirmed();
    const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
    assert.deepEqual(r, { ok: false, error: "Could not press Pay on the checkout page." });
    assert.ok(!s.calls.some((c) => c.method === "lock_arm" || c.method === "press_protected"));
    assert.ok(s.calls.some((c) => c.method === "clear_payment"));
    assert.equal(state.cardFieldsLive, false);
  }
});

test("Stripe: thank-you text with the card form still there is not a success", async () => {
  const s = fakeStripe({ formStays: true });
  const state = confirmed();
  const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /did not load in time/);
  assert.equal(s.calls.filter((c) => c.method === "press_protected").length, 1);
  assert.ok(s.calls.some((c) => c.method === "clear_payment"));
});

test("Stripe: missing card number field stops before the card is read", async () => {
  const s = fakeStripe({ fields: [{ kind: "cc-exp", filled: false }, { kind: "cc-csc", filled: false }] });
  const r = await payNowExt(confirmed(), { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /checkout fields/);
  assert.ok(!s.calls.some((c) => c.method === "fill_payment"));
});
