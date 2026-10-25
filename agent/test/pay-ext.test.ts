import { PAY_SITE } from "./pay-site-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import { ExtBridge, ExtError } from "../extbridge.ts";
import { alertText, cartLines, claimConfirmation, CONFIRM_TTL_MS, payNowExt, type Confirmation, type PayState } from "../pay.ts";
import { UnlockGate } from "../unlock.ts";
import { FakeExt } from "./fake-ext.ts";
import http from "node:http";
import type { AddressInfo } from "node:net";

const CARD = { name: "Test Person", number: "4242424242424242", exp: "12/30", csc: "123" };
const getCard = async () => ({ ...CARD });

function confirmed(total = "$14.27", tab: number | null = 7, extra: Partial<Confirmation> = {}): PayState {
  return {
    lastTabId: tab,
    confirmation: { item: "Blue mug", quantity: 1, total, state: "confirmed", confirmedAt: Date.now(), tabId: tab, ...extra },
    cardFieldsLive: false,
  };
}

type CheckoutOpts = {
  total?: string;
  url?: string;
  fields?: Array<{ kind: string; filled: boolean }>;
  onFill?: (params: any) => any;
  outcome?: "order" | "reject" | "stuck";
  // What the extension does with press_protected.
  press?: "ok" | "locked";
};

// A fake extension driving a checkout tab 7 on a pay site.
function fakeCheckout(o: CheckoutOpts = {}) {
  let url = o.url ?? `${PAY_SITE}/checkout`;
  const calls: Array<{ method: string; params: any }> = [];
  const fields = o.fields ?? [
    { kind: "address", filled: false },
    { kind: "cc-name", filled: false },
    { kind: "cc-number", filled: false },
    { kind: "cc-exp", filled: false },
    { kind: "cc-csc", filled: false },
  ];
  let rejected = false;
  let ordered = false;
  const handler = async (method: string, params: any) => {
    calls.push({ method, params });
    switch (method) {
      case "tab_info":
        if (params.tabId !== 7) throw new ExtError("no_tab", "no such tab");
        return { tabId: params.tabId, url, title: "t" };
      case "tabs_context":
        return { tabs: [{ tabId: 7, url, title: "t", active: true }], groupId: 1 };
      case "get_page_text":
        if (ordered) return { url, title: "Order", text: "Thanks!\nTotal charged: $14.27\nPaid with: Visa ending in 4242" };
        return { url, title: "Checkout", text: `Shipping\nOrder total ${o.total ?? "$14.27"}\nPlace order · ${o.total ?? "$14.27"}` };
      case "read_fields":
        return { fields };
      case "fill_payment":
        return o.onFill ? o.onFill(params) : { ok: true, last4: params.card.number.slice(-4) };
      case "find":
        return { matches: [{ ref: "ref_2", role: "link", name: "Back to cart" }, { ref: "ref_9", role: "button", name: "Place order · $14.27" }] };
      case "rect":
        return { x: 10, y: 20, width: 100, height: 40 };
      case "click":
        // The extension refuses agent clicks on the locked Place order.
        throw new ExtError("locked", "Locked: 'Place order' can only be pressed by Clearcart after the user says yes.");
      case "lock_arm":
        return { nonce: `nonce-${calls.filter((c) => c.method === "lock_arm").length}`, expiresInMs: 30_000 };
      case "press_protected":
        if (o.press === "locked") throw new ExtError("locked", "Locked: no valid unlock for this press");
        if ((o.outcome ?? "order") === "order") {
          ordered = true;
          url = `${PAY_SITE}/order/abc`;
        }
        else if (o.outcome === "reject") rejected = true;
        return { ok: true, via: "cdp" };
      case "read_page":
        return { url, title: "Checkout", tree: rejected ? '- main [ref_1]\n  - alert [ref_3]\n    - text "Card declined"\n  - textbox "Name on card" [ref_4]\n' : "- main\n" };
      case "clear_payment":
        return { ok: true };
    }
    throw new ExtError("unknown_method", method);
  };
  return { calls, handler, bridge: { call: (m: string, p: any = {}) => handler(m, p) } };
}

const fast = { getCard, pollMs: 5, orderTimeoutMs: 300 };

function noCard(value: unknown) {
  const s = JSON.stringify(value);
  assert.ok(!s.includes(CARD.number), "card number leaked");
  assert.ok(!s.includes(CARD.csc + '"') && !s.includes(CARD.exp), "card details leaked");
}

test("happy path: fill_payment, press place order through the unlock, receipt", async () => {
  const s = fakeCheckout();
  const state = confirmed();
  const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
  assert.deepEqual(r, { ok: true, last4: "4242", receipt: { item: "Blue mug", total: "$14.27", last4: "4242" } });
  noCard(r);
  assert.equal(state.cardFieldsLive, false);
  assert.equal(state.confirmation?.state, "used");
  const fill = s.calls.find((c) => c.method === "fill_payment")!;
  assert.deepEqual(fill.params.card, CARD);
  assert.equal(fill.params.tabId, 7);
  assert.equal("address" in fill.params, false, "never fills an address");
  assert.ok(!s.calls.some((c) => c.method === "click"), "no plain click on the locked button");
  const arm = s.calls.findIndex((c) => c.method === "lock_arm");
  const press = s.calls.findIndex((c) => c.method === "press_protected");
  assert.ok(arm > s.calls.findIndex((c) => c.method === "fill_payment") && press === arm + 1, "fill, arm, press");
  assert.deepEqual(s.calls[press].params, { tabId: 7, ref: "ref_9", nonce: "nonce-1" });
  assert.ok(!s.calls.some((c) => c.method === "clear_payment"));
});

test("refuses without a confirmation", async () => {
  const s = fakeCheckout();
  const state = confirmed();
  state.confirmation!.state = "pending";
  const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.equal(s.calls.length, 0);
});

test("refuses off the checkout page", async () => {
  const s = fakeCheckout({ url: `${PAY_SITE}/cart` });
  const r = await payNowExt(confirmed(), { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /not the checkout page/);
  assert.ok(!s.calls.some((c) => c.method === "fill_payment"));
});

test("refuses on a total mismatch and burns the confirmation", async () => {
  const s = fakeCheckout({ total: "$19.99" });
  const state = confirmed("$14.27");
  const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /\$19\.99/);
  assert.equal(state.confirmation?.state, "used");
  assert.ok(!s.calls.some((c) => c.method === "fill_payment"));
});

test("refuses when the card fields are missing", async () => {
  const s = fakeCheckout({ fields: [{ kind: "address", filled: false }] });
  const r = await payNowExt(confirmed(), { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.ok(!s.calls.some((c) => c.method === "fill_payment"));
});

test("fill_payment errors never carry the extension's message", async () => {
  const s = fakeCheckout({
    onFill: (p) => {
      throw new ExtError("payment_field", `bad number ${p.card.number}`);
    },
  });
  const state = confirmed();
  const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
  assert.deepEqual(r, { ok: false, error: "Could not fill the checkout fields (payment_field)." });
  noCard(r);
  assert.ok(s.calls.some((c) => c.method === "clear_payment"), "clears the form");
  assert.equal(state.cardFieldsLive, false);
});

test("a rejected payment is reported and the form is cleared", async () => {
  const s = fakeCheckout({ outcome: "reject" });
  const r = await payNowExt(confirmed(), { ...fast, bridge: s.bridge as any });
  assert.deepEqual(r, { ok: false, error: "The site rejected the payment: Card declined" });
  assert.ok(s.calls.some((c) => c.method === "clear_payment"));
});

test("order page timeout clears the form", async () => {
  const s = fakeCheckout({ outcome: "stuck" });
  const state = confirmed();
  const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /did not load in time/);
  assert.ok(s.calls.some((c) => c.method === "clear_payment"));
  assert.equal(state.cardFieldsLive, false);
});

test("over a real socket: card travels only in fill_payment, bridge logs stay clean", async () => {
  const logs: string[] = [];
  const bridge = new ExtBridge((l) => logs.push(l));
  const server = http.createServer();
  bridge.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const s = fakeCheckout();
  const ext = new FakeExt(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ext`, s.handler);
  try {
    await ext.open();
    const r = await payNowExt(confirmed(), { ...fast, bridge });
    assert.equal(r.ok, true);
    noCard(r);
    noCard(logs);
    const withCard = ext.requests.filter((q) => JSON.stringify(q.params).includes(CARD.number));
    assert.deepEqual(withCard.map((q) => q.method), ["fill_payment"]);
  } finally {
    ext.close();
    bridge.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("alertText reads named alerts and alerts with text children", () => {
  assert.equal(alertText("- main\n  - alert \"Card declined\" [ref_2]\n"), "Card declined");
  assert.equal(alertText("- alert [ref_3]\n  - text \"That card number is not valid.\"\n- textbox \"Name\" [ref_4]"), "That card number is not valid.");
  assert.equal(alertText("- main\n  - text \"fine\"\n"), "");
});

test("the extension refusing the press stops payment and clears the form", async () => {
  const s = fakeCheckout({ press: "locked" });
  const state = confirmed();
  const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
  assert.deepEqual(r, { ok: false, error: "Could not press Place order on the checkout page." });
  assert.ok(s.calls.some((c) => c.method === "clear_payment"));
  assert.equal(state.cardFieldsLive, false);
});

test("the gate refuses an origin that is not a pay site before any card is read", async () => {
  const s = fakeCheckout();
  let read = false;
  const gate = new UnlockGate({ isAllowed: () => false });
  const r = await payNowExt(confirmed(), { ...fast, gate, getCard: async () => ((read = true), { ...CARD }), bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /not a Clearcart pay site/);
  assert.equal(read, false);
  assert.ok(!s.calls.some((c) => c.method === "fill_payment" || c.method === "lock_arm"));
});

test("a grant spent elsewhere cannot press", async () => {
  const s = fakeCheckout();
  // A gate whose grants are expired by the time the press comes.
  let t = 0;
  const gate = new UnlockGate({ now: () => (t += 70_000) });
  const r = await payNowExt(confirmed(), { ...fast, gate, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.ok(!s.calls.some((c) => c.method === "press_protected" || c.method === "lock_arm"));
  assert.ok(s.calls.some((c) => c.method === "clear_payment"));
});

// Security review: a yes expires, is tied to its tab and cart, and is spent
// before pay_now awaits anything.
test("a yes older than a minute is refused and spent", async () => {
  const s = fakeCheckout();
  const state = confirmed("$14.27", 7, { confirmedAt: Date.now() - CONFIRM_TTL_MS - 1_000 });
  const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /more than a minute old/);
  assert.equal(state.confirmation?.state, "used");
  assert.equal(s.calls.length, 0);
});

test("a yes given on another tab is refused", async () => {
  const s = fakeCheckout();
  const state = confirmed("$14.27", 7, { tabId: 3 });
  const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /not the one the user said yes on/);
  assert.ok(!s.calls.some((c) => c.method === "fill_payment"));
  // No tab pinned at all is refused too.
  const none = confirmed("$14.27", 7, { tabId: null });
  assert.match(((await payNowExt(none, { ...fast, bridge: s.bridge as any })) as any).error, /No checkout tab/);
});

test("a cart that changed since the yes is refused, an unchanged one pays", async () => {
  const page = "Shipping\nOrder total $14.27\nPlace order · $14.27";
  const s = fakeCheckout();
  const changed = confirmed("$14.27", 7, { cart: cartLines("1 × Blue mug: $9.99\n" + page) });
  const r = await payNowExt(changed, { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /cart changed/);
  assert.ok(!s.calls.some((c) => c.method === "fill_payment"));
  const same = confirmed("$14.27", 7, { cart: cartLines(page) });
  assert.equal((await payNowExt(same, { ...fast, bridge: fakeCheckout().bridge as any })).ok, true);
});

test("an early return spends the yes: a retry after missing card fields is refused", async () => {
  const s = fakeCheckout({ fields: [{ kind: "address", filled: false }] });
  const state = confirmed();
  assert.equal((await payNowExt(state, { ...fast, bridge: s.bridge as any })).ok, false);
  assert.equal(state.confirmation?.state, "used");
  const again = await payNowExt(state, { ...fast, bridge: fakeCheckout().bridge as any });
  assert.equal(again.ok, false);
  assert.match((again as any).error, /No confirmed checkout/);
});

test("two pay_now calls at once: the yes is spent synchronously, so only one fills", async () => {
  const s = fakeCheckout();
  const state = confirmed();
  const [a, b] = await Promise.all([payNowExt(state, { ...fast, bridge: s.bridge as any }), payNowExt(state, { ...fast, bridge: s.bridge as any })]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal(s.calls.filter((c) => c.method === "fill_payment").length, 1);
  assert.equal(s.calls.filter((c) => c.method === "press_protected").length, 1);
  assert.equal(claimConfirmation(state).ok, false);
});

test("a checkout page with an order path is not the order page: no receipt, and the form is cleared", async () => {
  for (const url of [`${PAY_SITE}/order/checkout`, `${PAY_SITE}/orders/123/payment`]) {
    const s = fakeCheckout({ url, outcome: "stuck" });
    const state = confirmed();
    const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
    assert.equal(r.ok, false, url);
    assert.match((r as any).error, /did not load in time/);
    assert.ok(s.calls.some((c) => c.method === "clear_payment"), `clears the form on ${url}`);
    assert.equal(state.cardFieldsLive, false);
  }
});

test("on the order page, a form that still holds card values is cleared", async () => {
  const s = fakeCheckout({ fields: [{ kind: "cc-name", filled: false }, { kind: "cc-number", filled: true }, { kind: "cc-exp", filled: false }, { kind: "cc-csc", filled: false }] });
  const state = confirmed();
  const r = await payNowExt(state, { ...fast, bridge: s.bridge as any });
  assert.equal(r.ok, true);
  assert.ok(s.calls.some((c) => c.method === "clear_payment"));
  assert.equal(state.cardFieldsLive, false);
});
