// Danger mode on the agent side: the bridge message, the once-per-session
// spoken notice, the OCIC lock with the mode on, and the limits that never
// move with it (the spoken yes before paying, the unlock gates, the
// blocklist, the CAPTCHA hand-off).
import assert from "node:assert/strict";
import { test } from "node:test";

import * as proto from "../../extension/lib/protocol.js";
import { extBridge } from "../extbridge.ts";
import { ocicDangerMode, ocicLockNote, ocicLockReason, pageScript, type Deps } from "../ocic-lock.ts";
import { claimConfirmation, payNowExt } from "../pay.ts";
import { SITES_PROMPT } from "../prompt.ts";
import { browseDenyReason, DANGER_LINE, dangerModeOn, isExplicitYes, Session, type ServerMessage } from "../session.ts";
import { UnlockGate } from "../unlock.ts";
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
    ext.close();
  } finally {
    await b.stop();
  }
});

test("spoken notice: 'Danger mode is on.' once per session, only while it is on", async () => {
  assert.equal(DANGER_LINE, "Danger mode is on.");
  await withDanger(true, async () => {
    assert.equal(dangerModeOn(), true);
    const f = session();
    f.s.userText("find socks");
    f.s.userText("the blue ones");
    assert.deepEqual(f.spoken(), ["Danger mode is on."]);
    f.s.close();
  });
  await withDanger(false, async () => {
    const f = session();
    f.s.userText("find socks");
    assert.deepEqual(f.spoken(), []);
    f.s.close();
  });
});

test("checkout still needs the spoken yes with Danger mode on", async () => {
  await withDanger(true, async () => {
    for (const answer of ["sure, maybe", "go ahead and buy whatever", "no", "Danger mode is on", ""]) {
      const f = session();
      const done = f.s.requestCheckout({ item: "Advil", quantity: 1, total: "$9.00" });
      await new Promise((r) => setImmediate(r));
      f.s.userText(answer || " ");
      if (!answer) f.s.close();
      const r = await done;
      assert.notEqual(r.content[0].text, "confirmed", JSON.stringify(answer));
      f.s.close();
    }
    const f = session();
    const done = f.s.requestCheckout({ item: "Advil", quantity: 1, total: "$9.00" });
    await new Promise((r) => setImmediate(r));
    f.s.userText("yes");
    assert.equal((await done).content[0].text, "confirmed");
    f.s.close();
    assert.equal(isExplicitYes("Danger mode is on."), false);
  });
});

test("pay_now and the order unlock refuse without a confirmed yes, Danger mode or not", async () => {
  await withDanger(true, async () => {
    assert.equal(claimConfirmation({ lastTabId: 3, confirmation: null, cardFieldsLive: false } as any).ok, false);
    const calls: string[] = [];
    const bridge = { call: async (m: string) => (calls.push(m), {}) } as any;
    const r = await payNowExt({ lastTabId: 3, confirmation: null, cardFieldsLive: false } as any, { bridge });
    assert.equal(r.ok, false);
    assert.ok(!calls.includes("lock_arm") && !calls.includes("press_protected") && !calls.includes("fill_payment"), calls.join(","));
    const gate = new UnlockGate({ isAllowed: () => true });
    for (const confirmation of [null, { total: "$9.00", state: "pending" }, { total: "$9.00", state: "used" }]) {
      assert.equal(gate.issue({ confirmation, tabId: 3, href: "http://localhost:4000/checkout", pageTotal: "$9.00" }).ok, false);
    }
  });
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

test("OCIC: the page scripts carry the mode; off unless CLEARCART_DANGER_MODE is set", () => {
  const prev = process.env.CLEARCART_DANGER_MODE;
  try {
    delete process.env.CLEARCART_DANGER_MODE;
    assert.equal(ocicDangerMode(), false);
    assert.match(pageScript("return 1;"), /P\.setDangerMode\(false\);/);
    process.env.CLEARCART_DANGER_MODE = "1";
    assert.equal(ocicDangerMode(), true);
    assert.match(pageScript("return 1;"), /P\.setDangerMode\(true\);/);
    assert.match(pageScript("return 1;", false), /P\.setDangerMode\(false\);/);
  } finally {
    if (prev === undefined) delete process.env.CLEARCART_DANGER_MODE;
    else process.env.CLEARCART_DANGER_MODE = prev;
  }
});

test("OCIC with Danger mode on: sign in goes through; Place order, wallets and checkout stay locked", async () => {
  const refs = {
    ref_1: 'button "Sign in" [ref_1]',
    ref_2: 'button "Place order · $14.27" [ref_2]',
    ref_3: 'button "Apple Pay" [ref_3]',
    ref_4: 'button "Proceed to checkout" [ref_4]',
    ref_5: 'button "Subscribe & Save" [ref_5]',
  };
  const on = ocicDeps(true, refs);
  assert.equal(await ocicLockReason("form_input", { tabId: 1, ref: "ref_1", value: "x" }, on), null);
  for (const ref of ["ref_2", "ref_3", "ref_4", "ref_5"]) {
    assert.match(String(await ocicLockReason("form_input", { tabId: 1, ref, value: "x" }, on)), /^Locked:/, ref);
  }
  const off = ocicDeps(false, refs);
  assert.match(String(await ocicLockReason("form_input", { tabId: 1, ref: "ref_1", value: "x" }, off)), /^Locked:/);
  // A coordinate click is judged by the page, whose classifier got the mode.
  const placeOrder = { kind: "order", label: "Place order", optin: false, checked: false };
  const d = ocicDeps(true, refs, placeOrder);
  assert.match(String(await ocicLockReason("computer", { tabId: 1, action: "left_click", coordinate: [5, 5] }, d)), /^Locked: 'Place order'/);
  assert.ok(d.scripts.every((s) => s.includes("P.setDangerMode(true);")));
  // The note after read_page: sign in is not listed, Place order is.
  const note = await ocicLockNote("read_page", { tabId: 1 }, Object.values(refs).join("\n"), ocicDeps(true, refs));
  assert.doesNotMatch(String(note), /Sign in/);
  assert.match(String(note), /ref_2 "Place order/);
});

test("OCIC with Danger mode on: password fields are still refused", async () => {
  const d = ocicDeps(true, { ref_9: 'textbox "Password" [ref_9] type="password"' });
  assert.match(String(await ocicLockReason("form_input", { tabId: 1, ref: "ref_9", value: "hunter2" }, d)), /password/i);
});
