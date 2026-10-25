// pay_with_saved_card over a fake extension (pay.ts): only right after a
// confirmed yes pinned to tab, origin, total and cart; the page total and
// card fields checked before any card value moves; one fill, one press;
// and nothing Claude gets back (or any log) holds a card field. The card
// comes from a vault keyed in memory, never the Keychain. Test numbers only.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CardVault, memoryKeys, NO_CARD } from "../../vault/index.ts";
import { ExtBridge, ExtError, extBridge } from "../extbridge.ts";
import { orderTotal } from "../money.ts";
import { cartLines, claimConfirmation, CONFIRM_TTL_MS, NO_FIELDS, payWithSavedCardExt, safeAlert, type Confirmation, type PayState } from "../pay.ts";
import { Session } from "../session.ts";
import { FakeExt } from "./fake-ext.ts";

const SHOP = "https://shop.example";
const VISA = { nickname: "Work Visa", name: "Ada Lovelace", number: "4111111111111111", exp: "12/30", csc: "123", zip: "94704" };
const STRIPE = { nickname: "Personal", name: "Ada Lovelace", number: "4242424242424242", exp: "11/29", csc: "456" };
const SECRETS = ["4111111111111111", "4111 1111", "4242424242424242", "Ada Lovelace", "12/30", "11/29", '"123"', '"456"', "94704"];

async function vaultWith(...cards: object[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pay-"));
  const vault = new CardVault({ file: path.join(dir, "cards.json"), keys: memoryKeys() });
  for (const c of cards) assert.ok((await vault.add(c)).ok);
  return vault;
}

function confirmed(total = "$14.27", extra: Partial<Confirmation> = {}): PayState {
  return {
    lastTabId: 7,
    confirmation: { item: "Blue mug", quantity: 1, total, state: "confirmed", confirmedAt: Date.now(), tabId: 7, origin: SHOP, ...extra },
    cardFieldsLive: false,
  };
}

type CheckoutOpts = {
  total?: string;
  url?: string;
  kinds?: Record<string, number>;
  buttons?: Array<{ ref: string; label: string; kind: string; disabled?: boolean }>;
  onFill?: (params: any) => any;
  outcome?: "order" | "reject" | "stuck";
  press?: "ok" | "locked";
};

// A fake extension driving a checkout in tab 7: card fields in a frame or
// the page (card_state), one Place order button, and an order page after
// the press.
function fakeCheckout(o: CheckoutOpts = {}) {
  let url = o.url ?? `${SHOP}/checkout`;
  const calls: Array<{ method: string; params: any }> = [];
  let cardIn = false;
  let ordered = false;
  let rejected = false;
  const handler = async (method: string, params: any) => {
    calls.push({ method, params });
    switch (method) {
      case "tab_info":
        if (params.tabId !== 7) throw new ExtError("no_tab", "no such tab");
        return { tabId: 7, url, title: "t" };
      case "get_page_text":
        if (ordered) return { url, text: "Thank you! Your order is confirmed.\nTotal charged: $14.27" };
        return { url, text: `Shipping\n1 x Blue mug: $12.00\nOrder total ${o.total ?? "$14.27"}\nPlace order · ${o.total ?? "$14.27"}` };
      case "card_state":
        if (ordered) return { fields: 0, filled: 0, kinds: {}, frames: 0 };
        return { fields: 4, filled: cardIn ? 4 : 0, kinds: o.kinds ?? { "cc-name": 1, "cc-number": 1, "cc-exp": 1, "cc-csc": 1 }, frames: 2 };
      case "order_buttons":
        return { buttons: o.buttons ?? [{ ref: "ref_9", label: "Place order · $14.27", kind: "order" }] };
      case "fill_card":
        // Some of the card may be in before a failure.
        cardIn = true;
        return o.onFill ? o.onFill(params) : { ok: true, last4: params.card.number.slice(-4), frames: 2 };
      case "lock_arm":
        return { nonce: `nonce-${calls.filter((c) => c.method === "lock_arm").length}`, expiresInMs: 30_000 };
      case "press_protected":
        if (o.press === "locked") throw new ExtError("locked", "Locked: no valid unlock for this press");
        if ((o.outcome ?? "order") === "order") {
          ordered = true;
          url = `${SHOP}/order/T-1`;
        } else if (o.outcome === "reject") rejected = true;
        return { ok: true, via: "cdp" };
      case "read_page":
        return { url, tree: rejected ? '- main [ref_1]\n  - alert [ref_3]\n    - text "Card ending 1111 declined, code 05"\n' : "- main\n" };
      case "clear_card":
        cardIn = false;
        return { ok: true, cleared: 4 };
    }
    throw new ExtError("unknown_method", method);
  };
  return { calls, handler, bridge: { call: (m: string, p: any = {}) => handler(m, p) }, setUrl: (u: string) => (url = u) };
}

const fast = { pollMs: 5, orderTimeoutMs: 300, settleMs: 0 };

// The read-back binds the yes to one saved card (session.ts
// requestCheckout): here the vault's default, unless the test names one.
function pay(state: PayState, args: { cardNickname?: string | null }, deps: Parameters<typeof payWithSavedCardExt>[2] & { vault: CardVault }) {
  const c = state.confirmation;
  if (c && c.card === undefined) {
    const p = deps.vault.pick(null);
    c.card = p.ok ? p.card : null;
  }
  return payWithSavedCardExt(state, args, deps);
}
const noCard = (value: unknown, what = "result") => {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  for (const x of SECRETS) assert.ok(!s.includes(x), `${what} holds ${x}`);
};

test("happy path: checks, one fill with the saved card, one press, and only last4 and nickname come back", async () => {
  const vault = await vaultWith(VISA);
  const s = fakeCheckout();
  const state = confirmed();
  const r = await pay(state, {}, { ...fast, vault, bridge: s.bridge as any });
  assert.deepEqual(r, { ok: true, last4: "1111", nickname: "Work Visa", receipt: { item: "Blue mug", total: "$14.27", last4: "1111" } });
  noCard(r);
  assert.equal(state.confirmation?.state, "used");
  assert.equal(state.cardFieldsLive, false);
  const fill = s.calls.find((c) => c.method === "fill_card")!;
  assert.deepEqual(fill.params, { tabId: 7, origin: SHOP, card: { name: "Ada Lovelace", number: "4111111111111111", exp: "12/30", csc: "123", zip: "94704" } });
  assert.deepEqual(s.calls.filter((c) => JSON.stringify(c.params).includes("4111")).map((c) => c.method), ["fill_card"], "only fill_card carries the card");
  const order = s.calls.map((c) => c.method);
  assert.ok(order.indexOf("card_state") < order.indexOf("fill_card") && order.indexOf("order_buttons") < order.indexOf("fill_card"), "fields and button checked first");
  assert.equal(order.indexOf("lock_arm") + 1, order.indexOf("press_protected"));
  assert.ok(order.indexOf("fill_card") < order.indexOf("lock_arm"));
  assert.equal(s.calls.filter((c) => c.method === "press_protected").length, 1);
  assert.deepEqual(s.calls.find((c) => c.method === "press_protected")!.params, { tabId: 7, ref: "ref_9", nonce: "nonce-1" });
});

test("refused without a confirmed yes: nothing is read, filled or pressed", async () => {
  const vault = await vaultWith(VISA);
  for (const st of ["pending", "declined", "used", null] as const) {
    const s = fakeCheckout();
    const state = confirmed();
    if (st) state.confirmation!.state = st;
    else state.confirmation = null;
    const r = await pay(state, {}, { ...fast, vault, bridge: s.bridge as any });
    assert.equal(r.ok, false, String(st));
    assert.match((r as any).error, /No confirmed checkout/);
    assert.equal(s.calls.length, 0, String(st));
  }
});

test("refused on a total mismatch: the yes is spent and no card value moves", async () => {
  const vault = await vaultWith(VISA);
  const s = fakeCheckout({ total: "$19.99" });
  const state = confirmed("$14.27");
  const r = await pay(state, {}, { ...fast, vault, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /The page total is now \$19\.99, but the user said yes to \$14\.27/);
  assert.equal(state.confirmation?.state, "used");
  assert.ok(!s.calls.some((c) => c.method === "fill_card" || c.method === "lock_arm"));
  // A different currency is a mismatch too.
  const eur = fakeCheckout({ total: "€14.27" });
  assert.equal((await pay(confirmed("$14.27"), {}, { ...fast, vault, bridge: eur.bridge as any })).ok, false);
  assert.ok(!eur.calls.some((c) => c.method === "fill_card"));
});

test("the card is the one the read-back named: none saved asks for one; another or a removed card needs a new read-back", async () => {
  const none = await vaultWith();
  const s = fakeCheckout();
  const state = confirmed();
  assert.deepEqual(await pay(state, {}, { ...fast, vault: none, bridge: s.bridge as any }), { ok: false, error: NO_CARD });
  assert.match(NO_CARD, /add one in \w+ settings, under Payment cards/);
  assert.equal(state.confirmation?.state, "confirmed");
  const two = await vaultWith(VISA, STRIPE);
  const [visa, personal] = two.list().cards;
  for (const cardNickname of ["Amex", "personal"]) {
    const st = confirmed("$14.27", { card: visa });
    const miss = await pay(st, { cardNickname }, { ...fast, vault: two, bridge: s.bridge as any });
    assert.match((miss as any).error, /said yes to paying with Work Visa ending 1111\. To pay with another card, call request_checkout again/, cardNickname);
    assert.equal(st.confirmation?.state, "confirmed");
  }
  const unnamed = confirmed("$14.27", { card: null });
  assert.match(((await pay(unnamed, {}, { ...fast, vault: two, bridge: s.bridge as any })) as any).error, /read-back did not name a saved card/);
  assert.equal(s.calls.length, 0, "nothing on the page was touched");
  const r = await pay(confirmed("$14.27", { card: personal }), { cardNickname: "personal" }, { ...fast, vault: two, bridge: s.bridge as any });
  assert.ok(r.ok && r.last4 === "4242" && r.nickname === "Personal", JSON.stringify(r));
  assert.equal(s.calls.find((c) => c.method === "fill_card")!.params.card.number, "4242424242424242");
  assert.ok(await two.remove(personal.id));
  const gone = await pay(confirmed("$14.27", { card: personal }), {}, { ...fast, vault: two, bridge: fakeCheckout().bridge as any });
  assert.match((gone as any).error, /not saved any more/);
});

test("the total is read again once the card is in: a change presses nothing and empties the fields", async () => {
  const vault = await vaultWith(VISA);
  let filled = false;
  const s = fakeCheckout({ onFill: (p) => ((filled = true), { ok: true, last4: p.card.number.slice(-4) }) });
  const handler = s.handler;
  const surcharge = async (m: string, p: any) => (m === "get_page_text" && filled ? { text: "1 x Blue mug: $12.00\nOrder total $15.27" } : handler(m, p));
  const state = confirmed();
  const r = await pay(state, {}, { ...fast, vault, bridge: { call: (m: string, p: any = {}) => surcharge(m, p) } as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /total changed to \$15\.27 once the card went in, so nothing was pressed/);
  assert.ok(!s.calls.some((c) => c.method === "press_protected"));
  assert.ok(s.calls.some((c) => c.method === "clear_card"));
  assert.equal(state.cardFieldsLive, false);
});

test("the user speaking stops a payment on a spoken yes before the next step", async () => {
  const vault = await vaultWith(VISA);
  const stop = new AbortController();
  const s = fakeCheckout({ onFill: (p) => (stop.abort(), { ok: true, last4: p.card.number.slice(-4) }) });
  const state = confirmed();
  const r = await pay(state, {}, { ...fast, vault, signal: stop.signal, bridge: s.bridge as any });
  assert.match((r as any).error, /^The user spoke before the order was placed, so nothing was pressed/);
  assert.ok(!s.calls.some((c) => c.method === "press_protected"));
  assert.ok(s.calls.some((c) => c.method === "clear_card"));
});

test("refused when the tab moved to another site, or the page is on a blocked site", async () => {
  const vault = await vaultWith(VISA);
  const s = fakeCheckout({ url: "https://other.example/checkout" });
  const r = await pay(confirmed(), {}, { ...fast, vault, bridge: s.bridge as any });
  assert.match((r as any).error, /not on the page the user said yes on/);
  const bank = fakeCheckout({ url: "https://www.chase.com/checkout" });
  const b = await pay(confirmed("$14.27", { origin: "https://www.chase.com" }), {}, { ...fast, vault, bridge: bank.bridge as any });
  assert.match((b as any).error, /on a site \w+ does not use/);
  for (const x of [s, bank]) assert.ok(!x.calls.some((c) => c.method === "fill_card"));
  const none = confirmed("$14.27", { origin: null });
  assert.match(((await pay(none, {}, { ...fast, vault, bridge: s.bridge as any })) as any).error, /No checkout tab/);
});

test("card fields that are missing or not one of each: nothing is filled or pressed", async () => {
  const vault = await vaultWith(VISA);
  for (const kinds of [{ "cc-number": 1, "cc-exp": 1 }, { "cc-number": 2, "cc-exp": 1, "cc-csc": 1 }, { "cc-name": 1 }, {}]) {
    const s = fakeCheckout({ kinds });
    const r = await pay(confirmed(), {}, { ...fast, vault, bridge: s.bridge as any });
    assert.deepEqual(r, { ok: false, error: NO_FIELDS }, JSON.stringify(kinds));
    assert.match(NO_FIELDS, /^Couldn't find the card fields on this page/);
    assert.ok(!s.calls.some((c) => c.method === "fill_card" || c.method === "lock_arm"));
  }
  // Split month and year count as the expiry.
  const split = fakeCheckout({ kinds: { "cc-number": 1, "cc-exp-month": 1, "cc-exp-year": 1, "cc-csc": 1 } });
  assert.equal((await pay(confirmed(), {}, { ...fast, vault, bridge: split.bridge as any })).ok, true);
});

test("errors never carry what the extension or the page said about the card, and the fields are cleared", async () => {
  const vault = await vaultWith(VISA);
  const s = fakeCheckout({
    onFill: (p) => {
      throw new ExtError("internal", `could not set ${p.card.number} ${p.card.csc}`);
    },
  });
  const state = confirmed();
  const r = await pay(state, {}, { ...fast, vault, bridge: s.bridge as any });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /^Couldn't fill the card fields on this page/);
  noCard(r);
  assert.ok(s.calls.some((c) => c.method === "clear_card"));
  assert.equal(state.cardFieldsLive, false);
  assert.ok(!s.calls.some((c) => c.method === "press_protected"));
  // A declined card: the alert comes back with every digit masked.
  const d = fakeCheckout({ outcome: "reject" });
  const declined = await pay(confirmed(), {}, { ...fast, vault, bridge: d.bridge as any });
  assert.deepEqual(declined, { ok: false, error: "The site did not take the payment: Card ending # declined, code #" });
  assert.ok(d.calls.some((c) => c.method === "clear_card"));
  assert.equal(safeAlert("4111 1111 1111 1111 expired 12/30, cvc 123"), "# expired #, cvc #");
});

test("a press the extension refuses, or no order page, clears the fields; nothing is pressed twice", async () => {
  const vault = await vaultWith(VISA);
  for (const o of [{ press: "locked" as const }, { outcome: "stuck" as const }]) {
    const s = fakeCheckout(o);
    const state = confirmed();
    const r = await pay(state, {}, { ...fast, vault, bridge: s.bridge as any });
    assert.equal(r.ok, false);
    assert.match((r as any).error, o.press ? /Could not press 'Place order/ : /does not show the order as placed\. Do not press it again/);
    assert.ok(s.calls.some((c) => c.method === "clear_card"));
    assert.equal(state.cardFieldsLive, false);
    assert.ok(s.calls.filter((c) => c.method === "press_protected").length <= 1);
  }
});

test("a yes that is stale, on another tab, or for a changed cart is refused; two calls at once fill once", async () => {
  const vault = await vaultWith(VISA);
  const stale = confirmed("$14.27", { confirmedAt: Date.now() - CONFIRM_TTL_MS - 1_000 });
  const s = fakeCheckout();
  assert.match(((await pay(stale, {}, { ...fast, vault, bridge: s.bridge as any })) as any).error, /more than a minute old/);
  assert.match(((await pay(confirmed("$14.27", { tabId: 3 }), {}, { ...fast, vault, bridge: s.bridge as any })) as any).error, /not on the page/);
  const cart = cartLines("1 x Blue mug: $9.99\nOrder total $14.27");
  assert.match(((await pay(confirmed("$14.27", { cart }), {}, { ...fast, vault, bridge: s.bridge as any })) as any).error, /cart changed/);
  assert.ok(!s.calls.some((c) => c.method === "fill_card"));
  const both = fakeCheckout();
  const state = confirmed();
  const [a, b] = await Promise.all([1, 2].map(() => pay(state, {}, { ...fast, vault, bridge: both.bridge as any })));
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal(both.calls.filter((c) => c.method === "fill_card").length, 1);
  assert.equal(claimConfirmation(state).ok, false);
});

test("more than one order button, or a disabled one, is never guessed", async () => {
  const vault = await vaultWith(VISA);
  const two = fakeCheckout({ buttons: [{ ref: "ref_1", label: "Continue", kind: "payment-form" }, { ref: "ref_2", label: "Submit", kind: "order" }] });
  assert.match(((await pay(confirmed(), {}, { ...fast, vault, bridge: two.bridge as any })) as any).error, /more than one button/);
  const off = fakeCheckout({ buttons: [{ ref: "ref_9", label: "Place order", kind: "order", disabled: true }] });
  assert.match(((await pay(confirmed(), {}, { ...fast, vault, bridge: off.bridge as any })) as any).error, /not active yet/);
  for (const x of [two, off]) assert.ok(!x.calls.some((c) => c.method === "fill_card"));
  // One that says it places the order wins over a plain Continue.
  const pick = fakeCheckout({ buttons: [{ ref: "ref_1", label: "Continue", kind: "payment-form" }, { ref: "ref_9", label: "Place order", kind: "order" }] });
  assert.equal((await pay(confirmed(), {}, { ...fast, vault, bridge: pick.bridge as any })).ok, true);
  assert.equal(pick.calls.find((c) => c.method === "press_protected")!.params.ref, "ref_9");
});

test("Danger mode: its announced confirmation pays while Danger mode is on, and not once it is off", async () => {
  const vault = await vaultWith(VISA);
  const on = fakeCheckout();
  const st = { ...confirmed("$14.27", { auto: true }), autoOk: () => true };
  assert.equal((await pay(st, {}, { ...fast, vault, bridge: on.bridge as any })).ok, true);
  const off = fakeCheckout();
  const r = await pay({ ...confirmed("$14.27", { auto: true }), autoOk: () => false }, {}, { ...fast, vault, bridge: off.bridge as any });
  assert.match((r as any).error, /Danger mode was turned off/);
  assert.ok(!off.calls.some((c) => c.method === "fill_card"));
});

test("over a real socket: the card travels only in fill_card, and the bridge logs stay clean", async () => {
  const vault = await vaultWith(VISA);
  const logs: string[] = [];
  const bridge = new ExtBridge((l) => logs.push(l));
  const server = http.createServer();
  bridge.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const s = fakeCheckout();
  const ext = new FakeExt(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ext`, s.handler);
  try {
    await ext.open();
    const r = await pay(confirmed(), {}, { ...fast, vault, bridge });
    assert.equal(r.ok, true, JSON.stringify(r));
    noCard(r);
    noCard(logs.join("\n"), "bridge log");
    assert.deepEqual(ext.requests.filter((q) => JSON.stringify(q.params).includes(VISA.number)).map((q) => q.method), ["fill_card"]);
  } finally {
    ext.close();
    bridge.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("the order total is read from the page's own total line", () => {
  assert.equal(orderTotal("Subtotal $12.00\nTax $0.96\nOrder total $14.27")?.text, "$14.27");
  assert.equal(orderTotal("Items total $12.00\nTotal\nUSD 18.36")?.cents, 1836);
  assert.equal(orderTotal("Total $5.00\nTotal $6.00"), null, "two different totals: unclear");
});

// The tool body, as Claude calls it.
async function inExt<T>(handler: (m: string, p: any) => any, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CLEARCART_BROWSER;
  const realCall = extBridge.call;
  process.env.CLEARCART_BROWSER = "ext";
  (extBridge as any).call = (m: string, p: any = {}) => handler(m, p);
  try {
    return await fn();
  } finally {
    (extBridge as any).call = realCall;
    if (prev === undefined) delete process.env.CLEARCART_BROWSER;
    else process.env.CLEARCART_BROWSER = prev;
  }
}

const B = "mcp__browser__";
const pre = (s: Session, tool: string, tool_input: Record<string, unknown> = {}) =>
  (s as any).guard({ hook_event_name: "PreToolUse", tool_name: B + tool, tool_input }, undefined, { signal: new AbortController().signal });

test("the tool: refused without a confirmed yes, and on success Claude gets ok, last4 and nickname only", async () => {
  const vault = await vaultWith(VISA);
  const s = fakeCheckout();
  await inExt(s.handler, async () => {
    const sent: any[] = [];
    const session = new Session((m) => sent.push(m), { vault });
    session.pageContext = null;
    const no = JSON.parse((await session.payNowCall({})).content[0].text);
    assert.deepEqual(Object.keys(no).sort(), ["error", "ok"]);
    assert.equal(no.ok, false);
    assert.ok(!sent.some((m) => m.type === "receipt"));
    assert.ok(!s.calls.some((c) => c.method === "fill_card"));
    (session as any).state.confirmation = confirmed("$14.27", { card: vault.list().cards[0] }).confirmation;
    const yes = JSON.parse((await session.payNowCall({})).content[0].text);
    assert.deepEqual(yes, { ok: true, last4: "1111", nickname: "Work Visa" });
    noCard(sent, "messages to the window");
    session.close();
  });
});

test("a spoken yes stops counting when the user speaks again or another browser action comes first; Danger mode's does not", async () => {
  await inExt(async () => ({ url: `${SHOP}/checkout` }), async () => {
    const session = new Session(() => {});
    session.pageContext = null;
    const st = (session as any).state as PayState;
    st.confirmation = confirmed().confirmation;
    session.userText("actually wait");
    assert.equal(st.confirmation?.state, "declined");
    st.confirmation = confirmed().confirmation;
    await pre(session, "get_page_text", { tabId: 7 });
    assert.equal(st.confirmation?.state, "confirmed", "reading the page is fine");
    await pre(session, "click", { tabId: 7, ref: "ref_3" });
    assert.equal(st.confirmation?.state, "declined");
    st.confirmation = { ...confirmed().confirmation!, auto: true };
    await pre(session, "click", { tabId: 7, ref: "ref_3" });
    session.userText("go on");
    assert.equal(st.confirmation?.state, "confirmed", "Danger mode's announcement is left as it was");
    session.close();
  });
});

test("the guard keeps page reads off while the card is in the page, and lets them back once it is gone", async () => {
  let filled = 4;
  let clears = 0;
  const handler = async (m: string) => {
    if (m === "card_state") return { fields: 4, filled, kinds: {}, frames: 1 };
    if (m === "clear_card") {
      clears++;
      throw new ExtError("internal", "frame gone");
    }
    return { url: `${SHOP}/checkout` };
  };
  await inExt(handler, async () => {
    const session = new Session(() => {});
    session.pageContext = null;
    const st = (session as any).state as PayState;
    st.cardFieldsLive = true;
    st.cardTabId = 7;
    const denied = (r: any) => r?.hookSpecificOutput?.permissionDecision === "deny";
    process.env.CLEARCART_ALLOW_ANY_SITE = "1";
    try {
      for (const tool of ["read_page", "get_page_text", "find", "screenshot", "form_input", "type"]) assert.ok(denied(await pre(session, tool, { tabId: 7 })), tool);
      assert.ok(clears > 0, "it tried to empty the fields");
      filled = 0;
      assert.ok(!denied(await pre(session, "read_page", { tabId: 7 })));
      assert.equal(st.cardFieldsLive, false);
    } finally {
      delete process.env.CLEARCART_ALLOW_ANY_SITE;
    }
    session.close();
  });
});
