// pay_with_saved_card on Stripe's hosted test checkout (pay.ts, origins.ts)
// over a fake extension: test-mode pages only, Stripe's own total and Pay
// button, the test ZIP and email, the exact page pinned, and the paid page
// told apart from the form. The card comes from a vault keyed in memory:
// Stripe's published test card only, never a live Stripe page.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CardVault, memoryKeys } from "../../vault/index.ts";
import { ExtError, extBridge } from "../extbridge.ts";
import { isCheckoutUrl, isStripeCheckoutUrl, usableSite } from "../origins.ts";
import { NO_FIELDS, payWithSavedCardExt, STRIPE_TEST_EMAIL, STRIPE_TEST_ZIP, stripePaid, stripeTotal, type PayState } from "../pay.ts";

// The user took stripe.com off their blocked sites (docs/demo/STRIPE.md).
process.env.CLEARCART_BROWSER = "ext";
(extBridge as any).entries = [];

const STRIPE_SITE = "https://checkout.stripe.com";
const CARD = { nickname: "Stripe test", name: "Test Person", number: "4242424242424242", exp: "12/30", csc: "123" };
const URL_ = `${STRIPE_SITE}/c/pay/cs_test_a1B2c3`;

// What get_page_text gives on tests/fixtures/stripe-checkout.html.
const CHECKOUT_TEXT = "TEST MODE\nPay Orbi Demo Store\n$14.00\nBlue mug\nView details\nPay with Link\nOR\nEmail\nPayment method\nCard\nCard information\nCardholder name\nCountry or region\nSave my information for faster checkout\nPay";
const PAID_TEXT = "TEST MODE\nThanks for your payment\nA payment to Orbi Demo Store will appear on your statement.\n$14.00\nBlue mug";

async function vaultWith(card: object = CARD) {
  const vault = new CardVault({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-stripe-")), "cards.json"), keys: memoryKeys() });
  assert.ok((await vault.add(card)).ok);
  return vault;
}

// A yes on tab 7, pinned to Stripe's origin and the saved card.
function confirmed(vault: CardVault, total = "$14.00"): PayState {
  return {
    lastTabId: 7,
    confirmation: { item: "Blue mug", quantity: 1, total, state: "confirmed", confirmedAt: Date.now(), tabId: 7, origin: STRIPE_SITE, card: vault.list().cards[0] },
    cardFieldsLive: false,
  };
}

type Opts = {
  url?: string;
  text?: string;
  kinds?: Record<string, number>;
  // The card number field still there after the press.
  formStays?: boolean;
  buttons?: Array<{ ref: string; label: string; kind: string }>;
  // The tab's address from the nth tab_info call on (a page swap).
  swapTo?: { at: number; url: string };
};

function fakeStripe(o: Opts = {}) {
  let url = o.url ?? URL_;
  let infos = 0;
  let paid = false;
  let cardIn = false;
  const calls: Array<{ method: string; params: any }> = [];
  const kinds = o.kinds ?? { "cc-number": 1, "cc-exp": 1, "cc-csc": 1, "cc-name": 1, "postal-code": 1 };
  const form = () => !paid || o.formStays === true;
  const handler = async (method: string, params: any) => {
    calls.push({ method, params });
    switch (method) {
      case "tab_info":
        if (o.swapTo && ++infos >= o.swapTo.at) url = o.swapTo.url;
        return { tabId: 7, url, title: "Stripe Checkout" };
      case "get_page_text":
        return { url, text: paid ? PAID_TEXT : (o.text ?? CHECKOUT_TEXT) };
      case "card_state": {
        if (!form()) return { fields: 0, filled: 0, kinds: {}, frames: 0 };
        const n = Object.values(kinds).reduce((a, b) => a + b, 0);
        return { fields: n, filled: cardIn ? n : 0, kinds, frames: 1 };
      }
      case "order_buttons":
        return {
          buttons: form() ? (o.buttons ?? [
            { ref: "ref_1", label: "Pay with Link", kind: "express" },
            { ref: "ref_2", label: "Pay with card", kind: "payment-form" },
            { ref: "ref_9", label: "Pay Processing", kind: "order" },
          ]) : [],
        };
      case "fill_card":
        cardIn = true;
        return { ok: true, last4: params.card.number.slice(-4), frames: 1 };
      case "lock_arm":
        return { nonce: "n1", expiresInMs: 30_000 };
      case "press_protected":
        paid = true;
        return { ok: true };
      case "read_page":
        return { tree: "- main\n" };
      case "clear_card":
        cardIn = false;
        return { ok: true, cleared: 5 };
    }
    throw new ExtError("unknown_method", method);
  };
  return { calls, bridge: { call: (m: string, p: any = {}) => handler(m, p) } as any };
}

const fast = { pollMs: 5, orderTimeoutMs: 300, settleMs: 0 };
const called = (s: { calls: Array<{ method: string }> }, ...m: string[]) => s.calls.some((c) => m.includes(c.method));

test("Stripe test checkout URLs are checkout pages; live mode and other hosts are not, and Orbi pays on test pages only", () => {
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
  assert.equal(usableSite(URL_), true);
  assert.equal(usableSite(`${STRIPE_SITE}/c/pay/cs_live_a1B2c3`), false);
  assert.equal(usableSite("https://buy.stripe.com/4gw5kE0Ab1cd"), false);
});

test("stripeTotal: Total due, else the one amount shown; several amounts are unknown", () => {
  assert.equal(stripeTotal(CHECKOUT_TEXT), "$14.00");
  assert.equal(stripeTotal("Blue mug\n$14.00\nTax\n$1.12\nTotal due\n$15.12"), "$15.12");
  assert.equal(stripeTotal("Blue mug\n$14.00\nTea\n$3.00"), "");
  // A product named "Total due $1.00" next to the real one; another currency; whole dollars.
  assert.equal(stripeTotal("Total due $1.00\n$14.00\nTotal due\n$14.00"), "");
  assert.equal(stripeTotal("Blue mug\nCA$14.00"), "");
  assert.equal(stripeTotal("Blue mug\n€14.00"), "");
  assert.equal(stripeTotal("Blue mug\n$14\n$14.00"), "");
  assert.equal(stripeTotal("Blue mug\nUS$14.00"), "$14.00");
  assert.equal(stripePaid(PAID_TEXT), true);
  assert.equal(stripePaid(CHECKOUT_TEXT), false);
});

test("Stripe: fills the saved card plus the test ZIP and email, presses the one Pay button once, confirms on the thank-you page", async () => {
  const vault = await vaultWith();
  const s = fakeStripe();
  const state = confirmed(vault);
  const r = await payWithSavedCardExt(state, {}, { ...fast, vault, bridge: s.bridge });
  assert.deepEqual(r, { ok: true, last4: "4242", nickname: "Stripe test", receipt: { item: "Blue mug", total: "$14.00", last4: "4242" } });
  assert.equal(state.cardFieldsLive, false);
  assert.equal(state.confirmation?.state, "used");
  const fill = s.calls.filter((c) => c.method === "fill_card");
  assert.deepEqual(fill.map((c) => c.params), [{ tabId: 7, origin: STRIPE_SITE, card: { name: CARD.name, number: CARD.number, exp: CARD.exp, csc: CARD.csc, zip: STRIPE_TEST_ZIP }, email: STRIPE_TEST_EMAIL }]);
  assert.deepEqual(s.calls.filter((c) => c.method === "press_protected").map((c) => c.params), [{ tabId: 7, ref: "ref_9", nonce: "n1" }]);
  assert.deepEqual(s.calls.filter((c) => JSON.stringify(c.params).includes(CARD.number)).map((c) => c.method), ["fill_card"], "only fill_card carries the card");
});

test("Stripe: the saved card's own ZIP wins over the test one", async () => {
  const vault = await vaultWith({ ...CARD, zip: "94107" });
  const s = fakeStripe();
  assert.equal((await payWithSavedCardExt(confirmed(vault), {}, { ...fast, vault, bridge: s.bridge })).ok, true);
  assert.equal(s.calls.find((c) => c.method === "fill_card")!.params.card.zip, "94107");
});

test("Stripe: a total that does not match, or that cannot be read, stops before any card value moves", async () => {
  const vault = await vaultWith();
  for (const [text, total] of [[CHECKOUT_TEXT, "$15.00"], ["Blue mug\n$14.00\nTea\n$3.00", "$14.00"]] as const) {
    const s = fakeStripe({ text });
    const r = await payWithSavedCardExt(confirmed(vault, total), {}, { ...fast, vault, bridge: s.bridge });
    assert.match((r as any).error, /The page total is now/);
    assert.ok(!called(s, "fill_card", "lock_arm"));
  }
});

test("Stripe: a live-mode session is not a page Orbi pays on", async () => {
  const vault = await vaultWith();
  const s = fakeStripe({ url: `${STRIPE_SITE}/c/pay/cs_live_a1B2c3` });
  const r = await payWithSavedCardExt(confirmed(vault), {}, { ...fast, vault, bridge: s.bridge });
  assert.match((r as any).error, /on a site Orbi does not use/);
  assert.ok(!called(s, "fill_card"));
});

test("Stripe: no single Pay button means nothing is filled or pressed", async () => {
  const vault = await vaultWith();
  for (const buttons of [
    [{ ref: "ref_2", label: "Pay with card", kind: "payment-form" }],
    [{ ref: "ref_8", label: "Pay", kind: "order" }, { ref: "ref_9", label: "Pay $14.00", kind: "order" }],
  ]) {
    const s = fakeStripe({ buttons });
    const state = confirmed(vault);
    const r = await payWithSavedCardExt(state, {}, { ...fast, vault, bridge: s.bridge });
    assert.equal(r.ok, false, JSON.stringify(buttons));
    assert.ok(!called(s, "fill_card", "lock_arm", "press_protected"));
    assert.equal(state.cardFieldsLive, false);
  }
});

test("Stripe: thank-you text with the card form still there is not a success, and the card is emptied", async () => {
  const vault = await vaultWith();
  const s = fakeStripe({ formStays: true });
  const state = confirmed(vault);
  const r = await payWithSavedCardExt(state, {}, { ...fast, vault, bridge: s.bridge });
  assert.match((r as any).error, /does not show the order as placed/);
  assert.equal(s.calls.filter((c) => c.method === "press_protected").length, 1);
  assert.ok(called(s, "clear_card"));
  assert.equal(state.cardFieldsLive, false);
});

test("Stripe: no card number field stops before any card value moves", async () => {
  const vault = await vaultWith();
  const s = fakeStripe({ kinds: { "cc-exp": 1, "cc-csc": 1 } });
  assert.deepEqual(await payWithSavedCardExt(confirmed(vault), {}, { ...fast, vault, bridge: s.bridge }), { ok: false, error: NO_FIELDS });
  assert.ok(!called(s, "fill_card"));
});

test("Stripe: a page that already says thanks is refused before any card value moves", async () => {
  const vault = await vaultWith();
  const s = fakeStripe({ text: CHECKOUT_TEXT + "\nThank you for your order" });
  const r = await payWithSavedCardExt(confirmed(vault), {}, { ...fast, vault, bridge: s.bridge });
  assert.match((r as any).error, /already shows a payment confirmation/);
  assert.ok(!called(s, "fill_card"));
});

test("Stripe: a tab moved to another session on the same host is never pressed, nor filled once moved before the fill", async () => {
  const vault = await vaultWith();
  // At the start (1), right before the fill (2), at the press (3).
  for (const at of [1, 2, 3]) {
    const s = fakeStripe({ swapTo: { at, url: `${STRIPE_SITE}/c/pay/cs_live_zzz` } });
    const state = confirmed(vault);
    const r = await payWithSavedCardExt(state, {}, { ...fast, vault, bridge: s.bridge });
    assert.equal(r.ok, false, `swap at ${at}`);
    assert.ok(!called(s, "lock_arm", "press_protected"), `swap at ${at}`);
    if (at < 3) assert.ok(!called(s, "fill_card"), `swap at ${at}`);
    assert.equal(state.cardFieldsLive, false, `swap at ${at}`);
  }
});
