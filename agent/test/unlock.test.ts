// The button lock's unlock gate (unlock.ts): grants only after a confirmed
// yes, on a page Orbi may use, with a matching total; single use,
// bound to tab and origin, short-lived.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ExtError } from "../extbridge.ts";
import { extToolDefinitions } from "../exttools.ts";
import { parseMoney } from "../money.ts";
import { BROWSE_MODE } from "../origins.ts";
import { LockedError, pressProtectedExt, UnlockGate, unlockGate } from "../unlock.ts";

// Sites these gates may arm on: a local test page and a real store's origin.
const LOCAL = "http://localhost:4100";
const ALLOW = new Set([LOCAL, "https://www.aritzia.com"]);
const gateAt = (clock = { t: 0 }) =>
  new UnlockGate({ isAllowed: (h) => { try { return ALLOW.has(new URL(h!).origin); } catch { return false; } }, now: () => clock.t, ttlMs: 1_000 });
const yes = (total = "$14.27") => ({ total, state: "confirmed" });
const req = (o: Partial<Parameters<UnlockGate["issue"]>[0]> = {}) => ({
  confirmation: yes(),
  tabId: 7,
  href: `${LOCAL}/checkout`,
  pageTotal: "$14.27",
  ...o,
});

test("no grant without a confirmed yes", () => {
  const g = gateAt();
  for (const state of ["pending", "declined", "used"]) assert.equal(g.issue(req({ confirmation: { total: "$14.27", state } })).ok, false, state);
  assert.equal(g.issue(req({ confirmation: null })).ok, false);
});

test("no grant off the allowed sites; any of them can get one", () => {
  const g = gateAt();
  assert.equal(g.issue(req({ href: "https://evil.example/checkout" })).ok, false);
  assert.equal(g.issue(req({ href: "http://localhost:4100@evil.example/checkout" })).ok, false);
  assert.equal(g.issue(req({ href: null })).ok, false);
  // Not tied to one site: every allowed site uses the same gate.
  assert.equal(g.issue(req({ href: "https://www.aritzia.com/us/en/checkout" })).ok, true);
});

test("no grant when the page total differs from the confirmed total", () => {
  const g = gateAt();
  const r = g.issue(req({ pageTotal: "$19.26" }));
  assert.equal(r.ok, false);
  assert.match((r as any).error, /\$19\.26.*\$14\.27/);
  assert.equal(g.issue(req({ pageTotal: "" })).ok, false);
  assert.equal(g.issue(req({ pageTotal: "14.27" })).ok, true);
  assert.equal(g.issue(req({ pageTotal: "€14.27" })).ok, false, "another currency");
  assert.equal(g.issue(req({ pageTotal: "$14.270" })).ok, false, "not the same cents");
});

test("a grant is single use, for its tab and origin, until it expires", () => {
  const clock = { t: 0 };
  const g = gateAt(clock);
  const at = { tabId: 7, href: `${LOCAL}/checkout` };
  const a = (g.issue(req()) as any).grant;
  assert.equal(g.consume(a, at), true);
  assert.equal(g.consume(a, at), false, "single use");
  const b = (g.issue(req()) as any).grant;
  assert.equal(g.consume(b, { ...at, tabId: 8 }), false, "other tab");
  assert.equal(g.consume(b, at), false, "spent by the failed try");
  const c = (g.issue(req()) as any).grant;
  assert.equal(g.consume(c, { ...at, href: "https://www.aritzia.com/checkout" }), false, "other origin");
  const d = (g.issue(req()) as any).grant;
  clock.t += 1_001;
  assert.equal(g.consume(d, at), false, "expired");
  assert.equal(g.consume({ token: "guess" }, at), false);
  assert.equal(g.consume(null, at), false);
});

test("pressProtectedExt spends the grant, then arms and presses once", async () => {
  const calls: Array<[string, any]> = [];
  const bridge = {
    call: async (m: string, p: any) => {
      calls.push([m, p]);
      if (m === "tab_info") return { url: `${LOCAL}/checkout` };
      if (m === "lock_arm") return { nonce: "n1" };
      return { ok: true, via: "cdp" };
    },
  };
  const g = gateAt();
  const grant = (g.issue(req()) as any).grant;
  assert.deepEqual(await pressProtectedExt(bridge as any, grant, { tabId: 7, ref: "ref_9" }, g), { ok: true, via: "cdp" });
  assert.deepEqual(calls.map((c) => c[0]), ["tab_info", "lock_arm", "press_protected"]);
  assert.deepEqual(calls[2][1], { tabId: 7, ref: "ref_9", nonce: "n1" });
  await assert.rejects(pressProtectedExt(bridge as any, grant, { tabId: 7, ref: "ref_9" }, g), LockedError);
  assert.equal(calls.length, 4, "a spent grant never reaches lock_arm");
});

test("money parses prices to cents and rejects empty text", () => {
  assert.deepEqual(parseMoney("$1,014.27"), { text: "$1,014.27", cents: 101427, cur: "$" });
  assert.equal(parseMoney(""), null);
  assert.equal(parseMoney("unknown"), null);
});

test("Claude's tools cannot reach the unlock: no tool arms or presses, and click passes nothing extra", async () => {
  const calls: Array<[string, any]> = [];
  const bridge = {
    call: async (m: string, p: any) => {
      calls.push([m, p]);
      if (m === "rect") return { x: 0, y: 0, width: 10, height: 10 };
      if (m === "click") throw new ExtError("locked", "Locked: 'Place order' can only be pressed by Orbi after the user says yes.");
      return null;
    },
  };
  const defs = Object.fromEntries(extToolDefinitions(bridge as any).map((d) => [d.name, d]));
  for (const m of ["lock_arm", "press_protected", "click_ref", "rect", "fill_card", "clear_card", "card_state", "order_buttons"]) assert.equal(defs[m], undefined, m);
  const r: any = await defs.click.handler({ ref: "ref_9", nonce: "x", unlock: true } as any, {});
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "Locked: 'Place order' can only be pressed by Orbi after the user says yes.");
  assert.ok(!calls.some(([m]) => m === "lock_arm" || m === "press_protected"));
  assert.ok(calls.every(([, p]) => !("nonce" in p) && !("unlock" in p)));
});

test("the default gate arms on any page Orbi may use, never on a blocked site or a local address", () => {
  assert.equal(BROWSE_MODE, "open");
  for (const href of ["https://www.etsy.com/cart/checkout", "https://www.aritzia.com/us/en/checkout", "https://www.nordstrom.com/checkout"]) {
    for (const gate of [unlockGate, new UnlockGate()]) assert.equal(gate.issue(req({ href })).ok, true, href);
  }
  for (const href of ["https://www.chase.com/checkout", "https://www.paypal.com/checkout", `${LOCAL}/checkout`, "http://192.168.1.4/checkout", "file:///checkout"]) {
    for (const gate of [unlockGate, new UnlockGate()]) {
      const r = gate.issue(req({ href }));
      assert.equal(r.ok, false, href);
      assert.match((r as any).error, /does not use, so its order button stays locked/);
    }
  }
  // Still only with a confirmed yes and the matching total.
  assert.equal(new UnlockGate().issue(req({ href: "https://www.etsy.com/checkout", confirmation: { total: "$14.27", state: "pending" } })).ok, false);
  assert.equal(new UnlockGate().issue(req({ href: "https://www.etsy.com/checkout", pageTotal: "$15.00" })).ok, false);
});
