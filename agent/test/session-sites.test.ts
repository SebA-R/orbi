// Open web browsing in the session: the navigation guard and the tab sweep
// (session.ts), and the sites prompt (prompt.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBlockLines } from "../blocklist.ts";
import { extBridge } from "../extbridge.ts";
import { STORE_ORIGIN, type SitePolicy } from "../origins.ts";
import { sitesPrompt } from "../prompt.ts";
import { browseDenyReason, returnStrays, Session, sweepNote } from "../session.ts";

process.env.CLEARCART_BROWSER = "ext";
const B = "mcp__browser__";
const ALLOWLIST: SitePolicy = { mode: "allowlist", allowed: new Set([STORE_ORIGIN]), blocked: new Set(), entries: [] };

const pre = (s: Session, tool: string, tool_input: Record<string, unknown>) =>
  (s as any).guard({ hook_event_name: "PreToolUse", tool_name: B + tool, tool_input }, undefined, { signal: new AbortController().signal });
const denied = (r: any) => r?.hookSpecificOutput?.permissionDecision === "deny" ? String(r.hookSpecificOutput.permissionDecisionReason) : null;

test("open mode (default): navigate may open any store, not blocked sites", async () => {
  const s = new Session(() => {});
  for (const url of ["https://www.etsy.com/search?q=mug", "https://www.aritzia.com/us/en", `${STORE_ORIGIN}/cart`, "back"]) {
    assert.equal(denied(await pre(s, "navigate", { url, tabId: 5 })), null, url);
  }
  for (const url of ["https://mail.google.com/", "https://www.chase.com/", "https://vault.bitwarden.com/", "http://localhost:5050/", "chrome://settings", "file:///etc/passwd"]) {
    assert.match(denied(await pre(s, "navigate", { url })) || "", /^Blocked: Clearcart does not open/, url);
  }
  assert.match(denied(await pre(s, "tabs_create", { url: "https://accounts.google.com/" })) || "", /Blocked/);
  assert.equal(denied(await pre(s, "tabs_create", {})), null);
});

test("ext mode: the guard and sweep use the list the extension sent", async () => {
  const s = new Session(() => {});
  (extBridge as any).entries = parseBlockLines(["# mine", "etsy.com", "*shoe*"]).entries;
  try {
    assert.match(denied(await pre(s, "navigate", { url: "https://www.etsy.com/" })) || "", /etsy\.com/);
    assert.match(denied(await pre(s, "navigate", { url: "https://bestshoes.example/" })) || "", /\*shoe\*/);
    assert.equal(denied(await pre(s, "navigate", { url: "https://mail.google.com/" })), null, "the user took it off the list");
    assert.match(denied(await pre(s, "navigate", { url: "http://localhost:5050/" })) || "", /local address/, "fixed rules stay");
    const f = fakeNav({});
    assert.equal(await returnStrays([{ tabId: 1, url: "https://www.etsy.com/" }, { tabId: 2, url: "https://mail.google.com/" }], f.nav), 1);
    (extBridge as any).entries = [];
    assert.equal(denied(await pre(s, "navigate", { url: "https://www.etsy.com/" })), null, "an empty list blocks nothing extra");
    assert.match(denied(await pre(s, "navigate", { url: "file:///etc/passwd" })) || "", /not a web page/);
  } finally {
    (extBridge as any).entries = null;
  }
});

test("open mode keeps the checkout page block on every site but the store", async () => {
  const s = new Session(() => {});
  assert.match(denied(await pre(s, "navigate", { url: "https://www.etsy.com/cart/checkout" })) || "", /^Locked:/);
  assert.match(denied(await pre(s, "navigate", { url: "https://www.nordstrom.com/payment" })) || "", /^Locked:/);
  assert.equal(denied(await pre(s, "navigate", { url: `${STORE_ORIGIN}/checkout` })), null);
});

test("allowlist mode message and check", () => {
  assert.match(browseDenyReason("https://www.etsy.com/", ALLOWLIST) || "", /only browses http:\/\/localhost:\d+/);
  assert.equal(browseDenyReason(`${STORE_ORIGIN}/x`, ALLOWLIST), null);
  assert.equal(browseDenyReason("forward", ALLOWLIST), null);
});

function fakeNav(results: Record<string, string | Error>) {
  const calls: Array<[number, string]> = [];
  const nav = async (tabId: number, url: string) => {
    calls.push([tabId, url]);
    const r = results[`${tabId} ${url}`];
    if (r instanceof Error) throw r;
    return r ?? url;
  };
  return { calls, nav };
}

test("open mode sweep: only tabs on blocked sites move, back first", async () => {
  const f = fakeNav({ "2 back": "https://www.etsy.com/listing/1" });
  const n = await returnStrays(
    [{ tabId: 1, url: "https://www.etsy.com/" }, { tabId: 2, url: "https://www.paypal.com/signin" }, { tabId: 3, url: "about:blank" }, { tabId: 4, url: `${STORE_ORIGIN}/` }],
    f.nav
  );
  assert.equal(n, 1);
  assert.deepEqual(f.calls, [[2, "back"]]);
});

test("open mode sweep: falls back to the store when back fails or is blocked too", async () => {
  const f = fakeNav({ "2 back": new Error("no page to go back to"), "3 back": "https://accounts.google.com/" });
  const n = await returnStrays([{ tabId: 2, url: "https://mail.google.com/" }, { tabId: 3, url: "https://myaccount.google.com/" }], f.nav);
  assert.equal(n, 2);
  assert.deepEqual(f.calls, [[2, "back"], [2, `${STORE_ORIGIN}/`], [3, "back"], [3, `${STORE_ORIGIN}/`]]);
});

test("open mode sweep: back to a blank page is fine", async () => {
  const f = fakeNav({ "2 back": "about:blank" });
  await returnStrays([{ tabId: 2, url: "http://localhost:5050/" }], f.nav);
  assert.deepEqual(f.calls, [[2, "back"]]);
});

test("allowlist mode sweep sends strays straight to the store", async () => {
  const f = fakeNav({});
  const n = await returnStrays([{ tabId: 1, url: "https://www.etsy.com/" }, { tabId: 2, url: `${STORE_ORIGIN}/cart` }], f.nav, ALLOWLIST);
  assert.equal(n, 1);
  assert.deepEqual(f.calls, [[1, `${STORE_ORIGIN}/`]]);
  assert.match(sweepNote(1, ALLOWLIST), /Only browse/);
  assert.match(sweepNote(1), /blocked site/);
});

test("the session sweep over the extension bridge uses the group's tabs only", async () => {
  const calls: Array<[string, any]> = [];
  const orig = extBridge.call;
  (extBridge as any).call = async (method: string, params: any) => {
    calls.push([method, params]);
    if (method === "tabs_context") return { tabs: [{ tabId: 9, url: "https://www.etsy.com/" }, { tabId: 10, url: "https://mail.google.com/" }] };
    if (method === "navigate") return { url: "https://www.etsy.com/" };
    return {};
  };
  try {
    const statuses: string[] = [];
    const s = new Session((m) => m.type === "status" && statuses.push(m.text));
    const r = await (s as any).sweep({ hook_event_name: "PostToolUse", tool_name: B + "click", tool_input: {} }, undefined, {});
    assert.match(r.hookSpecificOutput.additionalContext, /blocked site/);
    assert.deepEqual(calls.filter((c) => c[0] === "navigate").map((c) => c[1]), [{ url: "back", tabId: 10 }]);
    assert.ok(statuses.some((t) => /returned 1 tab/.test(t)));
  } finally {
    (extBridge as any).call = orig;
  }
});

test("sites prompt: open mode allows any store with the real-site rules", () => {
  const p = sitesPrompt("open", []);
  assert.match(p, /any online store/);
  assert.match(p, /never log in or create an account/);
  assert.match(p, /never enter an address, card/);
  assert.match(p, /Never start checkout/);
  assert.match(p, /reject, decline or necessary only/);
  assert.match(p, /CAPTCHA/);
  assert.match(sitesPrompt("allowlist", []), /Only browse the demo store/);
  assert.match(sitesPrompt("allowlist", ["https://www.aritzia.com"]), /also browse https:\/\/www\.aritzia\.com/);
  for (const t of [p, sitesPrompt("allowlist", ["https://x.example"])]) assert.ok(!/\u2014/.test(t), "no em dashes");
});
