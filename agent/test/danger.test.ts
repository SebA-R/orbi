// Danger mode on the agent side: the bridge message (only from the
// extension), the spoken notice and the note to Claude, the OCIC lock and
// the checkout page block (both off while on), checkout without a spoken
// yes (announced instead), and the limits that never move with it
// (masking, the blocklist, the CAPTCHA hand-off). Off, all as before.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CardVault, memoryKeys } from "../../vault/index.ts";

import * as proto from "../../extension/lib/protocol.js";
import { extBridge, extOriginAllowed } from "../extbridge.ts";
import { extensionOrigins, upgradeOriginAllowed as sessionOriginAllowed } from "../hostcheck.ts";
import { CARD, hasCardNumber, ocicDangerMode, ocicLockNote, ocicLockReason, pageScript, type Deps } from "../ocic-lock.ts";
import { payWithSavedCardExt } from "../pay.ts";
import { dangerNote, SITES_PROMPT } from "../prompt.ts";
import { browseDenyReason, DANGER_LINE, dangerModeOn, isExplicitYes, navigateLockReason, Session, strayReason, type ServerMessage } from "../session.ts";
import { FakeExt, onceEvent, startBridge } from "./fake-ext.ts";

function withDanger<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CLEARCART_BROWSER;
  process.env.CLEARCART_BROWSER = "ext";
  const was = (extBridge as any).danger;
  (extBridge as any).danger = on;
  return fn().finally(() => {
    (extBridge as any).danger = was;
    if (prev === undefined) delete process.env.CLEARCART_BROWSER;
    else process.env.CLEARCART_BROWSER = prev;
  });
}

function session() {
  const sent: ServerMessage[] = [];
  const s = new Session((m) => sent.push(m));
  s.pageContext = null;
  const spoken = () => sent.filter((m) => m.type === "agent_text").map((m: any) => m.text);
  return { s, sent, spoken };
}

test("bridge: danger_mode from the current extension; anything but true is off", async () => {
  assert.equal(proto.MSG.DANGER_MODE, "danger_mode");
  const b = await startBridge();
  try {
    assert.equal(b.bridge.dangerMode(), false, "off until the extension says");
    const early = new FakeExt(b.url);
    await early.open(false);
    early.ws.send(JSON.stringify({ type: "danger_mode", on: true }));
    await early.ping();
    assert.equal(b.bridge.dangerMode(), false, "before hello");
    early.close();
    const ext = new FakeExt(b.url);
    await ext.open();
    let got = onceEvent(b.bridge, "danger_mode");
    ext.ws.send(JSON.stringify({ type: "danger_mode", on: true }));
    assert.equal(await got, true);
    got = onceEvent(b.bridge, "danger_mode");
    ext.ws.send(JSON.stringify({ type: "danger_mode", on: "true" }));
    assert.equal(await got, false);
    ext.ws.send(JSON.stringify({ type: "danger_mode", on: true }));
    await ext.ping();
    assert.equal(b.bridge.dangerMode(), true);
    const gone = onceEvent(b.bridge, "disconnect");
    ext.close();
    await gone;
    assert.equal(b.bridge.dangerMode(), false, "off once the extension disconnects");
  } finally {
    await b.stop();
  }
});

test("bridge: a web page's socket can never be the extension", async () => {
  // The id the manifest key gives (extension/README.md).
  assert.deepEqual([...extensionOrigins()], ["chrome-extension://dhgknfenfoidnchmjfaicafhieepefoc"]);
  const ours = "chrome-extension://dhgknfenfoidnchmjfaicafhieepefoc";
  assert.equal(extOriginAllowed(undefined), true);
  assert.equal(extOriginAllowed(ours), true);
  for (const o of ["https://evil.example", "http://localhost:5050", "null", "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "", [ours]]) {
    assert.equal(extOriginAllowed(o as any), false, String(o));
  }
  // /session: also this server's own page, on its own port.
  for (const o of [undefined, ours, "http://localhost:5050", "http://127.0.0.1:5050", "http://[::1]:5050"]) {
    assert.equal(sessionOriginAllowed(o, 5050), true, String(o));
  }
  for (const o of ["https://evil.example", "http://localhost:4100", "http://localhost:5050.evil.example", "https://localhost:5050", "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "null"]) {
    assert.equal(sessionOriginAllowed(o, 5050), false, String(o));
  }
  const b = await startBridge();
  try {
    const { WebSocket } = await import("ws");
    const tryOrigin = (origin: string) => new Promise((r) => {
      const ws = new WebSocket(b.url, { headers: { Origin: origin } });
      ws.on("unexpected-response", (_q, res) => r(res.statusCode));
      ws.on("open", () => (r("open"), ws.close()));
      ws.on("error", () => r("error"));
    });
    assert.equal(await tryOrigin("https://evil.example"), 403);
    assert.equal(await tryOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), 403, "another extension");
    assert.equal(await tryOrigin("chrome-extension://dhgknfenfoidnchmjfaicafhieepefoc"), "open");
    assert.equal(b.bridge.dangerMode(), false);
  } finally {
    await b.stop();
  }
});

const tick = () => new Promise((r) => setImmediate(r));

test("Danger mode off: checkout still needs the spoken yes, exactly as before", async () => {
  await withDanger(false, async () => {
    for (const answer of ["sure, maybe", "go ahead and buy whatever", "no", "Danger mode is on", ""]) {
      const f = session();
      const done = f.s.requestCheckout({ item: "Blue mug", quantity: 1, total: "$9.00" });
      await tick();
      f.s.userText(answer || " ");
      if (!answer) f.s.close();
      const r = await done;
      assert.notEqual(r.content[0].text, "confirmed", JSON.stringify(answer));
      f.s.close();
    }
    const f = session();
    const done = f.s.requestCheckout({ item: "Blue mug", quantity: 1, total: "$9.00" });
    await tick();
    assert.ok(f.sent.some((m) => m.type === "confirm"), "the read-back card is shown");
    assert.match(f.spoken().join(" "), /Say yes to pay/);
    f.s.userText("yes");
    assert.equal((await done).content[0].text, "confirmed");
    assert.notEqual((f.s as any).state.confirmation.auto, true);
    f.s.close();
    assert.equal(isExplicitYes("Danger mode is on."), false);
  });
});

test("Danger mode on: checkout announces the order and confirms without waiting for a yes", async () => {
  await withDanger(true, async () => {
    const f = session();
    const r = await f.s.requestCheckout({ item: "Blue mug", quantity: 1, total: "$9.00", changes: "I removed a membership" });
    assert.match(r.content[0].text, /^confirmed/);
    assert.ok(f.spoken().includes("Placing your order for Blue mug, $9.00. I removed a membership."), f.spoken().join("|"));
    assert.ok(!f.spoken().some((t) => /Say yes/.test(t)));
    assert.ok(!f.sent.some((m) => m.type === "confirm"), "no read-back card waiting for an answer");
    const c = (f.s as any).state.confirmation;
    assert.equal(c.state, "confirmed");
    assert.equal(c.auto, true);
    f.s.close();
  });
});

test("Danger mode on: an order completes end to end with no yes, and the line is spoken first", async () => {
  // A fake checkout in tab 7 behind a fake extension, and a saved test card.
  const SHOP = "https://shop.example";
  let url = `${SHOP}/checkout`;
  const calls: string[] = [];
  const handler = async (method: string, params: any): Promise<any> => {
    calls.push(method);
    switch (method) {
      case "tab_info": return { tabId: params.tabId, url, title: "t" };
      case "get_page_text":
        if (url.includes("/order/")) return { url, title: "Order", text: "Thank you! Your order is confirmed.\nTotal charged: $9.00" };
        return { url, title: "Checkout", text: "Order total $9.00\nPlace order · $9.00" };
      case "card_state": return url.includes("/order/") ? { fields: 0, filled: 0, kinds: {}, frames: 0 } : { fields: 3, filled: 0, kinds: { "cc-number": 1, "cc-exp": 1, "cc-csc": 1 }, frames: 1 };
      case "order_buttons": return { buttons: [{ ref: "ref_9", label: "Place order · $9.00", kind: "order" }] };
      case "fill_card": return { ok: true, last4: "4242" };
      case "lock_arm": return { nonce: "n1", expiresInMs: 30_000 };
      case "press_protected": url = `${SHOP}/order/abc`; return { ok: true };
      case "read_page": return { url, title: "t", tree: "- main\n" };
      case "clear_card": return { ok: true, cleared: 0 };
    }
    throw new Error(method);
  };
  const vault = new CardVault({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-danger-")), "cards.json"), keys: memoryKeys() });
  assert.ok((await vault.add({ nickname: "Test card", name: "T", number: "4242424242424242", exp: "12/30", csc: "123" })).ok);
  const realCall = extBridge.call;
  (extBridge as any).call = (m: string, p: any = {}) => handler(m, p);
  try {
    await withDanger(true, async () => {
      const f = session();
      (f.s as any).state.lastTabId = 7;
      const r = await f.s.requestCheckout({ item: "Blue mug", quantity: 1, total: "$9.00" });
      assert.match(r.content[0].text, /^confirmed/);
      assert.match(r.content[0].text, /pay_with_saved_card/);
      assert.deepEqual(f.spoken().filter((t) => /Placing/.test(t)), ["Placing your order for Blue mug, $9.00."]);
      assert.equal((f.s as any).state.confirmation.origin, SHOP, "pinned to the checkout's site");
      const before = calls.length;
      const paid = await payWithSavedCardExt((f.s as any).state, {}, {
        bridge: { call: (m: string, p: any = {}) => handler(m, p) } as any,
        vault,
        pollMs: 5,
        orderTimeoutMs: 300,
      });
      assert.equal(paid.ok, true, JSON.stringify(paid));
      assert.ok(calls.slice(before).includes("fill_card") && calls.slice(before).includes("press_protected"));
      assert.doesNotMatch(JSON.stringify(paid), /4242424242424242|"123"|12\/30/);
      f.s.close();
    });
  } finally {
    (extBridge as any).call = realCall;
  }
});

test("blocklist and the CAPTCHA hand-off do not change with Danger mode", async () => {
  await withDanger(true, async () => {
    assert.ok(browseDenyReason("https://www.chase.com/"));
    assert.ok(browseDenyReason("https://accounts.google.com/"));
  });
  assert.match(SITES_PROMPT, /CAPTCHA, bot check or access-denied page appears, do not try to solve or get around it; tell the user/);
});

// OCIC path: a fake tab whose page answers lock checks.
function ocicDeps(danger: boolean, refs: Record<string, string>, pageLock: unknown = null, locks: unknown[] = []): Deps & { scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    danger: () => danger,
    readRef: async (_t, ref) => refs[ref] ?? "Error: no such ref",
    evalInTab: async <T>(_t: number, code: string) => {
      scripts.push(code);
      if (code.includes("return J(P.lock")) return pageLock as T;
      if (code.includes("return P.listLocks(")) return locks as T;
      return 0 as T;
    },
  };
}

test("OCIC: Danger mode on lifts every lock; off keeps every lock", async () => {
  const refs = {
    ref_1: 'button "Sign in" [ref_1]',
    ref_2: 'button "Place order · $14.27" [ref_2]',
    ref_3: 'button "Apple Pay" [ref_3]',
    ref_4: 'button "Proceed to checkout" [ref_4]',
    ref_5: 'button "Subscribe & Save" [ref_5]',
    ref_6: 'checkbox "Subscribe & Save every 30 days" [ref_6]',
  };
  const placeOrder = { kind: "order", label: "Place order", optin: false, checked: false };
  const on = ocicDeps(true, refs, placeOrder, [{ name: "Place order", kind: "order", optin: false, checked: false }]);
  const off = ocicDeps(false, refs, placeOrder);
  for (const ref of Object.keys(refs)) {
    assert.equal(await ocicLockReason("form_input", { tabId: 1, ref, value: true }, on), null, ref);
    assert.match(String(await ocicLockReason("form_input", { tabId: 1, ref, value: true }, off)), /^Locked:/, ref);
  }
  const click = { tabId: 1, action: "left_click", coordinate: [5, 5] };
  assert.equal(await ocicLockReason("computer", click, on), null);
  assert.match(String(await ocicLockReason("computer", click, off)), /^Locked: 'Place order'/);
  assert.equal(await ocicLockReason("computer", { tabId: 1, action: "left_click", ref: "ref_2" }, on), null, "a ref click goes through");
  assert.match(String(await ocicLockReason("computer", { tabId: 1, action: "left_click", ref: "ref_2" }, off)), /^Locked:/);
  assert.equal(await ocicLockReason("computer", { tabId: 1, action: "key", text: "Enter" }, on), null);
  assert.match(String(await ocicLockReason("computer", { tabId: 1, action: "key", text: "Enter" }, off)), /^Locked:/);
  assert.equal(await ocicLockNote("read_page", { tabId: 1 }, Object.values(refs).join("\n"), on), null);
  assert.match(String(await ocicLockNote("read_page", { tabId: 1 }, Object.values(refs).join("\n"), off)), /ref_2 "Place order/);
});

test("OCIC, both modes: card numbers and card or cross-origin frame focus are never typed into", async () => {
  assert.equal(hasCardNumber("my card is 4242 4242 4242 4242"), true);
  assert.equal(hasCardNumber("1 Main St 94704"), false);
  for (const danger of [true, false]) {
    const d = ocicDeps(danger, { ref_1: 'textbox "Notes" [ref_1]' });
    d.evalInTab = async <T>(_t: number, code: string) => (code.includes("FENCEDFRAME") ? null : false) as T;
    assert.equal(await ocicLockReason("computer", { tabId: 1, action: "type", text: "4242-4242-4242-4242" }, d), CARD);
    assert.equal(await ocicLockReason("form_input", { tabId: 1, ref: "ref_1", value: "4242424242424242" }, d), CARD);
    assert.equal(await ocicLockReason("computer", { tabId: 1, action: "type", text: "hello" }, d), null, String(danger));
    for (const where of ["card", "frame"]) {
      d.evalInTab = async <T>(_t: number, code: string) => (code.includes("FENCEDFRAME") ? where : false) as T;
      assert.equal(await ocicLockReason("computer", { tabId: 1, action: "type", text: "123" }, d), CARD, where);
    }
  }
});

test("OCIC with Danger mode on: password fields are still refused", async () => {
  const d = ocicDeps(true, { ref_9: 'textbox "Password" [ref_9] type="password"' });
  assert.match(String(await ocicLockReason("form_input", { tabId: 1, ref: "ref_9", value: "hunter2" }, d)), /password/i);
});
