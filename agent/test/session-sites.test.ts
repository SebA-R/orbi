// Open web browsing in the session: the navigation guard and the tab sweep
// (session.ts), and the sites prompt (prompt.ts).
import assert from "node:assert/strict";
import dns from "node:dns";
import { test } from "node:test";

import { parseBlockLines } from "../blocklist.ts";
import { extBridge } from "../extbridge.ts";
import { STORE_ORIGIN, type SitePolicy } from "../origins.ts";
import { sitesPrompt } from "../prompt.ts";
import { browseDenyReason, localDnsReason, returnStrays, Session, sweepNote } from "../session.ts";

process.env.CLEARCART_BROWSER = "ext";
// No real DNS in tests: names with "rebind" point at this computer.
(dns.promises as any).lookup = async (host: string) => [{ address: /rebind/.test(host) ? "127.0.0.1" : "93.184.215.14", family: 4 }];
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

test("open mode sweep: a tab that lands on a checkout page off the store goes back too", async () => {
  const f = fakeNav({ "5 back": "https://www.etsy.com/cart", "6 back": "https://www.etsy.com/%63heckout" });
  const n = await returnStrays(
    [{ tabId: 5, url: "https://www.etsy.com/checkout.html" }, { tabId: 6, url: "https://www.etsy.com/gp/buy/spc" }, { tabId: 7, url: `${STORE_ORIGIN}/checkout` }],
    f.nav
  );
  assert.equal(n, 2);
  assert.deepEqual(f.calls, [[5, "back"], [6, "back"], [6, `${STORE_ORIGIN}/`]], "back onto another checkout page is not good enough");
});

test("allowlist mode sweep sends strays straight to the store", async () => {
  const f = fakeNav({});
  const n = await returnStrays([{ tabId: 1, url: "https://www.etsy.com/" }, { tabId: 2, url: `${STORE_ORIGIN}/cart` }], f.nav, ALLOWLIST);
  assert.equal(n, 1);
  assert.deepEqual(f.calls, [[1, `${STORE_ORIGIN}/`]]);
  assert.match(sweepNote(1, ALLOWLIST), /Only browse/);
  assert.match(sweepNote(1), /blocked site/);
});

test("the session sweep over the extension bridge only looks at tabs Clearcart opened", async () => {
  const calls: Array<[string, any]> = [];
  let tab10 = "https://mail.google.com/";
  const orig = extBridge.call;
  (extBridge as any).call = async (method: string, params: any) => {
    calls.push([method, params]);
    if (method === "agent_tabs") return { tabs: [{ tabId: 9, url: "https://www.etsy.com/" }, { tabId: 10, url: tab10 }] };
    if (method === "navigate") return { url: (tab10 = "https://www.etsy.com/") };
    return {};
  };
  try {
    const statuses: string[] = [];
    const s = new Session((m) => m.type === "status" && statuses.push(m.text));
    const r = await (s as any).sweep({ hook_event_name: "PostToolUse", tool_name: B + "click", tool_input: {} }, undefined, {});
    assert.match(r.hookSpecificOutput.additionalContext, /blocked site/);
    assert.deepEqual(calls.filter((c) => c[0] === "navigate").map((c) => c[1]), [{ url: "back", tabId: 10 }]);
    assert.ok(!calls.some((c) => c[0] === "tabs_context"), "the user's tabs are not swept");
    assert.ok(statuses.some((t) => /returned 1 tab/.test(t)));
  } finally {
    (extBridge as any).call = orig;
  }
});

test("sites prompt: open mode allows any store with the real-site rules", () => {
  const p = sitesPrompt("open", []);
  assert.match(p, /any online store/);
  assert.match(p, /sign in or create an account only when the user asks, through request_unlock/);
  assert.match(p, /never enter an address, card/);
  assert.match(p, /Never start checkout on your own/);
  assert.match(p, /never press Place order/);
  assert.match(p, /reject, decline or necessary only/);
  assert.match(p, /CAPTCHA/);
  assert.match(sitesPrompt("allowlist", []), /Only browse the demo store/);
  assert.match(sitesPrompt("allowlist", ["https://www.aritzia.com"]), /also browse https:\/\/www\.aritzia\.com/);
  for (const t of [p, sitesPrompt("allowlist", ["https://x.example"])]) assert.ok(!/\u2014/.test(t), "no em dashes");
});

const post = (s: Session, tool: string) => (s as any).sweep({ hook_event_name: "PostToolUse", tool_name: B + tool, tool_input: {} }, undefined, {});

// An OCIC-path session whose tab list and navigation are fakes.
function ocicSession(tabs: Array<{ tabId: number; url?: string }> | (() => never)) {
  const s = new Session(() => {});
  const navs: Array<[number, string]> = [];
  (s as any).listTabs = async () => (typeof tabs === "function" ? tabs() : tabs.map((t) => ({ ...t })));
  (s as any).navTab = async (tabId: number, url: string) => {
    navs.push([tabId, url]);
    const to = url === "back" ? "https://www.etsy.com/" : url;
    if (typeof tabs !== "function") for (const t of tabs) if (t.tabId === tabId) t.url = to;
    return to;
  };
  return { s, navs };
}

async function ocic<T>(fn: () => Promise<T>): Promise<T> {
  process.env.CLEARCART_BROWSER = "";
  try {
    return await fn();
  } finally {
    process.env.CLEARCART_BROWSER = "ext";
  }
}

test("checkout page block covers tabs_create and tabs_create_mcp too", async () => {
  const s = new Session(() => {});
  for (const tool of ["tabs_create", "tabs_create_mcp", "navigate"]) {
    assert.match(denied(await pre(s, tool, { url: "https://www.etsy.com/cart/checkout" })) || "", /^Locked:/, tool);
    assert.match(denied(await pre(s, tool, { url: "https://www.nordstrom.com/payment" })) || "", /^Locked:/, tool);
  }
  assert.equal(denied(await pre(s, "tabs_create_mcp", { url: `${STORE_ORIGIN}/checkout` })), null);
  assert.equal(denied(await pre(s, "tabs_create_mcp", {})), null);
});

test("OCIC path: a page tool on a tab a redirect moved to a blocked site is denied and the tab swept", async () => {
  await ocic(async () => {
    const tabs = [{ tabId: 5, url: "https://www.etsy.com/" }, { tabId: 6, url: "https://mail.google.com/mail/u/0" }];
    const { s, navs } = ocicSession(tabs);
    for (const tool of ["get_page_text", "read_page", "find", "computer", "form_input", "read_console_messages"]) {
      tabs[1].url = "https://mail.google.com/mail/u/0";
      assert.match(denied(await pre(s, tool, { tabId: 6, action: "screenshot" })) || "", /^Blocked: that tab is on a site/, tool);
    }
    assert.deepEqual(navs.at(-1), [6, "back"]);
    assert.equal(denied(await pre(s, "get_page_text", { tabId: 5 })), null);
    assert.equal(denied(await pre(s, "get_page_text", { tabId: 6 })), null, "swept back to an allowed page");
  });
});

test("OCIC path: the current-tab check fails closed", async () => {
  await ocic(async () => {
    const broken = ocicSession(() => {
      throw new Error("bridge down");
    });
    assert.match(denied(await pre(broken.s, "get_page_text", { tabId: 5 })) || "", /could not check/);
    const { s } = ocicSession([{ tabId: 5, url: "https://www.etsy.com/" }, { tabId: 7 }]);
    assert.match(denied(await pre(s, "get_page_text", { tabId: 9 })) || "", /not one of Clearcart's tabs/);
    assert.match(denied(await pre(s, "get_page_text", { tabId: 7 })) || "", /could not check/);
    assert.match(denied(await pre(s, "get_page_text", {})) || "", /could not check/, "no tabId: every tab must be known");
  });
});

test("names that resolve to this computer are refused on open and on the current tab", async () => {
  const s = new Session(() => {});
  assert.match(denied(await pre(s, "navigate", { url: "http://rebind.example:5050/cartesia-token" })) || "", /points to this computer/);
  assert.match(denied(await pre(s, "tabs_create_mcp", { url: "http://shop.rebind.example/" })) || "", /points to this computer/);
  assert.equal(denied(await pre(s, "navigate", { url: "https://www.etsy.com/" })), null);
  const policy: SitePolicy = { mode: "open", allowed: new Set([STORE_ORIGIN]), blocked: new Set() };
  assert.equal(await localDnsReason(`${STORE_ORIGIN}/`, policy, async () => [{ address: "127.0.0.1" }]), null, "the store is allowed");
  assert.equal(await localDnsReason("https://gone.example/", policy, async () => { throw new Error("ENOTFOUND"); }), null);
  assert.match((await localDnsReason("https://lan.example/", policy, async () => [{ address: "93.1.1.1" }, { address: "::ffff:192.168.1.1" }])) || "", /local network/);
  await ocic(async () => {
    const { s: o } = ocicSession([{ tabId: 5, url: "http://later.rebind.example/" }]);
    assert.match(denied(await pre(o, "get_page_text", { tabId: 5 })) || "", /^Blocked/);
  });
});

test("the sweep fails closed: an error pauses browser tools until a sweep succeeds", async () => {
  let down = true;
  const tabs = [{ tabId: 5, url: "https://www.etsy.com/" }];
  const { s } = ocicSession(tabs);
  (s as any).listTabs = async () => {
    if (down) throw new Error("bridge down");
    return tabs;
  };
  const r = await post(s, "click");
  assert.match(r.hookSpecificOutput.additionalContext, /paused/);
  assert.match(denied(await pre(s, "navigate", { url: "https://www.etsy.com/" })) || "", /browser tools are paused/);
  assert.match(denied(await pre(s, "tabs_context", {})) || "", /paused/);
  down = false;
  assert.equal(denied(await pre(s, "navigate", { url: "https://www.etsy.com/" })), null);
  assert.equal(denied(await pre(s, "click", {})), null);
});

test("the sweep fails closed when a stray tab will not move", async () => {
  const s = new Session(() => {});
  (s as any).listTabs = async () => [{ tabId: 6, url: "https://mail.google.com/" }];
  (s as any).navTab = async () => null;
  const r = await post(s, "click");
  assert.match(r.hookSpecificOutput.additionalContext, /paused/);
  assert.match(denied(await pre(s, "screenshot", {})) || "", /paused/);
});
