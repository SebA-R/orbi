// Paying on any site: the card is the one the user picked in Chrome's own
// list; Clearcart presses the order button once, and only after the user's
// spoken yes to the page's own total.
import assert from "node:assert/strict";
import { test } from "node:test";

import { extBridge } from "../extbridge.ts";
import { payNowExt, type PayState } from "../pay.ts";
import { Session, type ServerMessage } from "../session.ts";
import { UnlockGate } from "../unlock.ts";

process.env.CLEARCART_BROWSER = "ext";

const SHOP = "https://shop.example";

// A fake extension: checkout tab 7, the card number filled by the user's
// pick (counts only, as the extension answers), one Place order button.
function fakeExt(o: { total?: string; numberFilled?: boolean } = {}) {
  const total = o.total ?? "$12.96";
  let url = `${SHOP}/checkout`;
  let placed = false;
  const calls: Array<{ method: string; params: any }> = [];
  const call = async (method: string, params: any = {}) => {
    calls.push({ method, params });
    switch (method) {
      case "tab_info":
        return { tabId: 7, url };
      case "get_page_text":
        return placed
          ? { text: "Thank you! Your order is confirmed.\nPaid with the card ending in 1111" }
          : { text: `Checkout\nSubtotal $12.00\nEstimated tax $0.96\nOrder total ${total}\nPlace order · ${total}` };
      case "card_state":
        return { fields: 4, filled: 4, autofilled: 4, number: { filled: o.numberFilled ?? true, autofilled: true }, frames: 0, live: true };
      case "order_buttons":
        return { buttons: [{ ref: "ref_9", label: `Place order · ${total}`, kind: "order" }] };
      case "read_page":
        return { tree: "- main\n" };
      case "lock_arm":
        return { nonce: "n1", expiresInMs: 30_000 };
      case "press_protected":
        placed = true;
        url = `${SHOP}/order/T-1`;
        return { ok: true, via: "cdp" };
    }
    return null;
  };
  return { calls, bridge: { call } as any, presses: () => calls.filter((c) => c.method === "press_protected").length };
}

const fast = { pollMs: 5, orderTimeoutMs: 300, gate: new UnlockGate() };

test("Place order is pressed once, and only after the spoken yes to the page's own total", async () => {
  const f = fakeExt();
  const orig = (extBridge as any).call;
  (extBridge as any).call = f.bridge.call;
  try {
    const sent: ServerMessage[] = [];
    const s = new Session((m) => sent.push(m));
    s.pageContext = null;
    const state = (s as any).state as PayState;
    state.lastTabId = 7;
    const spoken = () => sent.filter((m) => m.type === "agent_text").map((m: any) => m.text);
    const asked = async () => {
      for (let i = 0; i < 100 && !(s as any).awaitingAnswer; i++) await new Promise((r) => setImmediate(r));
    };

    // No yes yet: nothing is armed or pressed.
    assert.equal((await payNowExt(state, { ...fast, bridge: f.bridge })).ok, false);
    // A total that is not the page's is refused before anything is read back.
    const wrong = await s.requestCheckout({ item: "Blue mug", quantity: 1, total: "$9.00" });
    assert.match(wrong.content[0].text, /^declined\. The page's order total is \$12\.96, not \$9\.00/);
    assert.deepEqual(spoken(), []);
    // A hedge is not a yes.
    let done = s.requestCheckout({ item: "Blue mug", quantity: 1, total: "$12.96" });
    await asked();
    assert.match(spoken().at(-1)!, /^You're buying 1 Blue mug for \$12\.96\. Say yes to pay/);
    s.userText("sure, maybe");
    assert.match((await done).content[0].text, /^declined/);
    assert.equal((await payNowExt(state, { ...fast, bridge: f.bridge })).ok, false);
    assert.equal(f.presses(), 0);
    assert.ok(!f.calls.some((c) => c.method === "lock_arm"));

    // An explicit yes: one press of the order button, bound to tab 7.
    done = s.requestCheckout({ item: "Blue mug", quantity: 1, total: "$12.96" });
    await asked();
    s.userText("yes");
    assert.equal((await done).content[0].text, "confirmed");
    const r = await payNowExt(state, { ...fast, bridge: f.bridge });
    assert.deepEqual(r, { ok: true, last4: "1111", receipt: { item: "Blue mug", total: "$12.96", last4: "1111" } });
    assert.equal(f.presses(), 1);
    assert.deepEqual(f.calls.find((c) => c.method === "press_protected")!.params, { tabId: 7, ref: "ref_9", nonce: "n1" });
    // The yes is spent: no second press without a new one.
    assert.equal((await payNowExt(state, { ...fast, bridge: f.bridge })).ok, false);
    assert.equal(f.presses(), 1);
    s.close();
  } finally {
    (extBridge as any).call = orig;
  }
});

test("pay_now presses nothing when the page total changed or the card number is empty", async () => {
  for (const o of [{ total: "$14.00" }, { numberFilled: false }]) {
    const f = fakeExt(o);
    const state: PayState = {
      lastTabId: 7,
      confirmation: { item: "Blue mug", quantity: 1, total: "$12.96", state: "confirmed", confirmedAt: Date.now(), tabId: 7, origin: SHOP, cart: "" },
      payBusy: false,
    };
    const r = await payNowExt(state, { ...fast, bridge: f.bridge });
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.ok(!f.calls.some((c) => c.method === "lock_arm" || c.method === "press_protected"), JSON.stringify(o));
    assert.equal(state.confirmation!.state, "used", "and the yes is spent");
  }
});
