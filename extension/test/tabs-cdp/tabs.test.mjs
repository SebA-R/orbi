import { test } from "node:test";
import assert from "node:assert/strict";

import { installChrome } from "./chrome-mock.mjs";
import {
  BLANK_PAGE, LEGACY_GROUP_TITLE, STATE_KEY, agentTabs, assertPageAllowed, navigate, navigateAndWait, onTabRemoved, originPath, resolveAllowedTab, resolveTab,
  frameAllowed, isAllowed, onMainFrameError, tabInfo, tabsActivate, tabsClose, tabsContext, tabsCreate, ungroupLegacy,
} from "../../background/tabs.js";
import * as netguard from "../../background/netguard.js";
import { ERR } from "../../lib/protocol.js";
import { SUGGESTED_BLOCKLIST } from "../../lib/blocklist.js";

// A made-up shop on the open web (nothing is fetched).
const SHOP = "https://shop.example";

// A user's own tab, already loaded, not opened by Orbi.
async function userTab(c, url, { active = false, title = "User tab" } = {}) {
  const t = await c.tabs.create({ url: "about:blank", active });
  Object.assign(c._tabs.get(t.id), { url, title, status: "complete" });
  return t.id;
}

function fresh(opts) {
  netguard._reset();
  return installChrome(opts);
}

test("no tab group is ever created", async () => {
  const c = fresh();
  const { tabId } = await tabsCreate({ url: `${SHOP}/` });
  await navigate({ tabId, url: `${SHOP}/cart` });
  assert.equal(c._groups.size, 0);
  assert.equal(c._tabs.get(tabId).groupId, -1);
});

test("new tabs open in the background next to the user's tab", async () => {
  const c = fresh();
  const mine = await userTab(c, "https://www.etsy.com/", { active: true });
  const { tabId } = await tabsCreate({ url: "https://www.etsy.com/search?q=mug" });
  const create = c._calls.find((x) => x[0] === "tabs.create" && x[1].active === false);
  assert.deepEqual(create[1], { url: "about:blank", active: false, windowId: 1, index: c._tabs.get(mine).index + 1 });
  assert.equal(c._tabs.get(mine).active, true, "the user stays on their tab");
  assert.equal(c._tabs.get(tabId).active, false);
});

test("tabsContext lists the user's tabs and Orbi's, with origin+path only, and hides blocked tabs", async () => {
  const c = fresh();
  const etsy = await userTab(c, "https://www.etsy.com/listing/1/mug?ref=search#reviews", { active: true, title: "Mug" });
  const mail = await userTab(c, "https://mail.google.com/mail/u/0/#inbox");
  const local = await userTab(c, "http://localhost:5050/");
  const settings = await userTab(c, "chrome://settings/");
  const login = await userTab(c, "https://user:pw@shop.example/");
  const { tabId: mineBlank } = await tabsCreate({});
  const { tabId: mine } = await tabsCreate({ url: `${SHOP}/` });
  const { tabs } = await tabsContext();
  assert.deepEqual(tabs.map((t) => t.tabId).sort(), [etsy, mineBlank, mine].sort());
  assert.deepEqual(tabs.find((t) => t.tabId === etsy), { tabId: etsy, title: "Mug", url: "https://www.etsy.com/listing/1/mug", active: true, openedByClearcart: false });
  assert.equal(tabs.find((t) => t.tabId === mine).openedByClearcart, true);
  for (const id of [mail, local, settings, login]) {
    await assert.rejects(resolveAllowedTab(id), (e) => e.code === ERR.NOT_ALLOWED && !/google|localhost/.test(e.message), String(id));
    await assert.rejects(navigate({ tabId: id, url: "https://www.etsy.com/" }), (e) => e.code === ERR.NOT_ALLOWED);
  }
  assert.equal(originPath("https://a.example/p?q=1#f"), "https://a.example/p");
});

test("a tab served from a local address is hidden and refused (netguard)", async () => {
  const c = fresh();
  const id = await userTab(c, "https://rebind.example/");
  netguard.noteResponse({ tabId: id, type: "main_frame", url: "https://rebind.example/", ip: "127.0.0.1" });
  assert.equal((await tabsContext()).tabs.length, 0);
  await assert.rejects(resolveAllowedTab(id), (e) => e.code === ERR.NOT_ALLOWED);
});

test("every call checks the tab again: a user tab that moves to a blocked site is refused", async () => {
  const c = fresh();
  const id = await userTab(c, "https://www.etsy.com/");
  assert.equal(await resolveAllowedTab(id), id);
  c._tabs.get(id).url = "https://www.paypal.com/signin";
  await assert.rejects(resolveAllowedTab(id), (e) => e.code === ERR.NOT_ALLOWED);
});

test("Orbi closes only tabs it opened", async () => {
  const c = fresh();
  const user = await userTab(c, "https://www.etsy.com/");
  const { tabId } = await tabsCreate({ url: "https://www.etsy.com/" });
  await assert.rejects(tabsClose({ tabId: user }), (e) => e.code === ERR.NOT_ALLOWED && /only closes tabs it opened/.test(e.message));
  assert.ok(c._tabs.has(user));
  assert.deepEqual(await tabsClose({ tabId }), { ok: true });
  assert.ok(!c._tabs.has(tabId));
});

test("tabsActivate brings an allowed tab to the front, never a blocked one", async () => {
  const c = fresh();
  await userTab(c, "https://www.etsy.com/", { active: true });
  const mail = await userTab(c, "https://mail.google.com/");
  const { tabId } = await tabsCreate({ url: "https://www.etsy.com/c/mugs" });
  await tabsActivate({ tabId });
  assert.equal(c._tabs.get(tabId).active, true);
  await assert.rejects(tabsActivate({ tabId: mail }), (e) => e.code === ERR.NOT_ALLOWED);
});

test("resolveTab defaults to the tab Orbi used last, else the user's active tab", async () => {
  const c = fresh();
  const active = await userTab(c, "https://www.etsy.com/", { active: true });
  assert.equal(await resolveTab(), active);
  const { tabId } = await tabsCreate({ url: "https://www.etsy.com/x" });
  assert.equal(await resolveTab(), tabId);
  await c.tabs.remove(tabId);
  await onTabRemoved(tabId);
  assert.equal(await resolveTab(), active);
  await assert.rejects(resolveTab(12345), (e) => e.code === ERR.NO_TAB);
  await assert.rejects(resolveTab("1"), (e) => e.code === ERR.BAD_REQUEST);
});

test("agentTabs (the sweep) holds only tabs Orbi opened, blocked ones included", async () => {
  const c = fresh();
  const untouched = await userTab(c, "https://mail.google.com/");
  const used = await userTab(c, "https://www.etsy.com/");
  await navigate({ tabId: used, url: "https://www.etsy.com/cart" });
  const { tabId } = await tabsCreate({ url: "https://www.etsy.com/" });
  // A clicked link lands the agent's own tab on a blocked site.
  await navigateAndWait(tabId, () => c.tabs.update(tabId, { url: "https://www.paypal.com/signin" }));
  const { tabs } = await agentTabs();
  assert.deepEqual(tabs.map((t) => t.tabId), [tabId]);
  assert.ok(!tabs.some((t) => t.tabId === untouched || t.tabId === used));
  // The sweep may still send it back.
  assert.equal((await navigate({ tabId, url: "back" })).url, "https://www.etsy.com/");
  assert.deepEqual(c.storage.session.data[STATE_KEY].created, [tabId]);
});

test("the sweep may send a tab Orbi opened to a blank page, never one of the user's tabs", async () => {
  const c = fresh();
  const { tabId } = await tabsCreate({ url: "https://www.etsy.com/" });
  await navigateAndWait(tabId, () => c.tabs.update(tabId, { url: "https://www.paypal.com/signin" }));
  assert.equal(BLANK_PAGE, "about:blank");
  const r = await navigate({ tabId, url: BLANK_PAGE });
  assert.equal(r.tabId, tabId);
  assert.equal(c._tabs.get(tabId).url, "about:blank");
  const user = await userTab(c, "https://www.etsy.com/");
  await assert.rejects(navigate({ tabId: user, url: BLANK_PAGE }), (e) => e.code === ERR.NOT_ALLOWED && /only blanks tabs it opened/.test(e.message));
  assert.equal(c._tabs.get(user).url, "https://www.etsy.com/");
});

test("a user tab Orbi navigated is never swept or navigated once the user opens a blocked site in it", async () => {
  const c = fresh();
  const id = await userTab(c, "https://www.etsy.com/");
  await navigate({ tabId: id, url: "https://www.etsy.com/cart" });
  assert.equal(await resolveAllowedTab(id), id);
  // The user opens Gmail in their own tab.
  c._tabs.get(id).url = "https://mail.google.com/mail/u/0/#inbox";
  assert.deepEqual((await agentTabs()).tabs, []);
  await assert.rejects(navigate({ tabId: id, url: "back" }), (e) => e.code === ERR.NOT_ALLOWED && !/google/.test(e.message));
  await assert.rejects(navigate({ tabId: id, url: "https://www.etsy.com/" }), (e) => e.code === ERR.NOT_ALLOWED);
  await assert.rejects(tabInfo({ tabId: id }), (e) => e.code === ERR.NOT_ALLOWED);
  assert.equal(c._tabs.get(id).url, "https://mail.google.com/mail/u/0/#inbox");
});

test("a driven list left by an older version gives no tab a pass", async () => {
  const c = fresh();
  const id = await userTab(c, "https://mail.google.com/");
  c.storage.session.data[STATE_KEY] = { created: [], driven: [id], last: null };
  assert.deepEqual((await agentTabs()).tabs, []);
  await assert.rejects(navigate({ tabId: id, url: "https://www.etsy.com/" }), (e) => e.code === ERR.NOT_ALLOWED);
});

test("navigate reports origin and path only, never the query string or fragment", async () => {
  fresh();
  const { tabId } = await tabsCreate({ url: "https://www.etsy.com/" });
  const r = await navigate({ tabId, url: "https://www.etsy.com/oauth/callback?code=SECRET&state=x#access_token=TOKEN" });
  assert.equal(r.url, "https://www.etsy.com/oauth/callback");
  assert.ok(!r.url.includes("SECRET") && !r.url.includes("TOKEN"));
  // The agent server's internal pay flow still gets the full URL.
  assert.match((await tabInfo({ tabId })).url, /code=SECRET/);
});

test("tabsCreate on an address that does not load reports Orbi's error page, like navigate", async () => {
  const c = fresh();
  c.runtime = { getURL: (p) => `chrome-extension://x/${p}` };
  // Chrome's load failure, shown as Orbi's own error page.
  const update = c.tabs.update;
  c.tabs.update = (id, props) => update(id, props.url === "https://down.example/" ? { ...props, url: "chrome-extension://x/newtab/error.html#k=00000000-0000-0000-0000-000000000000" } : props);
  const r = await tabsCreate({ url: "https://down.example/" });
  assert.deepEqual(r, { tabId: r.tabId, url: "chrome-error://chromewebdata/", title: "Can't reach this site" });
  delete c.runtime;
});

test("assertPageAllowed drops a result from a page that moved to a blocked site", async () => {
  const c = fresh();
  const id = await userTab(c, "https://www.etsy.com/");
  await assertPageAllowed(id);
  await assertPageAllowed(id, "https://www.etsy.com/c/mugs");
  await assert.rejects(assertPageAllowed(id, "https://mail.google.com/"), (e) => e.code === ERR.NOT_ALLOWED && !/google/.test(e.message));
  c._tabs.get(id).pendingUrl = "https://www.paypal.com/signin";
  await assert.rejects(assertPageAllowed(id), (e) => e.code === ERR.NOT_ALLOWED);
  delete c._tabs.get(id).pendingUrl;
  c._tabs.get(id).url = "https://www.paypal.com/signin";
  await assert.rejects(assertPageAllowed(id), (e) => e.code === ERR.NOT_ALLOWED);
});

test("ungroupLegacy takes tabs out of the old Clearcart group without closing them", async () => {
  const c = fresh();
  const a = await userTab(c, "https://www.etsy.com/");
  const b = await userTab(c, "https://www.etsy.com/x");
  const other = await userTab(c, "https://www.etsy.com/y");
  const gid = await c.tabs.group({ tabIds: [a, b] });
  await c.tabGroups.update(gid, { title: LEGACY_GROUP_TITLE });
  const mine = await c.tabs.group({ tabIds: [other] });
  await c.tabGroups.update(mine, { title: "Work" });
  assert.equal(await ungroupLegacy(), 2);
  assert.equal(c._tabs.get(a).groupId, -1);
  assert.equal(c._tabs.get(b).groupId, -1);
  assert.equal(c._tabs.get(other).groupId, mine, "the user's own groups are left alone");
  assert.equal(c._tabs.size, 3);
});

test("allowlist mode: navigate checks the allowlist, waits for complete and reports url/title", async () => {
  const c = fresh({ local: { browseMode: "allowlist", allowlist: [SHOP] } });
  await assert.rejects(tabsCreate({ url: "https://evil.example/" }), (e) => e.code === ERR.NOT_ALLOWED);
  const { tabId } = await tabsCreate({ url: `${SHOP}/` });
  const r = await navigate({ tabId, url: `${SHOP}/cart` });
  assert.deepEqual(r, { tabId, url: `${SHOP}/cart`, title: `Title of ${SHOP}/cart` });
  await assert.rejects(navigate({ tabId, url: "https://evil.example/" }), (e) => e.code === ERR.NOT_ALLOWED);
  assert.equal(c._tabs.get(tabId).url, `${SHOP}/cart`);
  await assert.rejects(navigate({ tabId }), (e) => e.code === ERR.BAD_REQUEST);
});

test("allowlist mode with no allowed sites opens nothing", async () => {
  fresh({ local: { browseMode: "allowlist" } });
  await assert.rejects(tabsCreate({ url: `${SHOP}/` }), (e) => e.code === ERR.NOT_ALLOWED);
});

// Makes c.tabs.update send `from` on to `to` (a server redirect) and/or
// fail the main frame with `error` (webRequest.onErrorOccurred, which comes
// before Chrome's error page completes with the failed address).
function patchLoads(c, { from, to, fail } = {}) {
  const update = c.tabs.update.bind(c.tabs);
  c.tabs.update = async (id, props) => {
    let url = props.url;
    if (url && from && url === from) url = to;
    if (url && fail && fail[url]) onMainFrameError({ type: "main_frame", frameId: 0, tabId: id, url, error: fail[url] });
    return update(id, url ? { ...props, url } : props);
  };
}

test("tabsCreate: a redirect to a blocked site is refused, like navigate", async () => {
  const c = fresh({ local: { browseMode: "allowlist", allowlist: [SHOP] } });
  patchLoads(c, { from: `${SHOP}/go`, to: "https://evil.example/landing" });
  await assert.rejects(tabsCreate({ url: `${SHOP}/go` }), (e) => e.code === ERR.NOT_ALLOWED && /evil\.example/.test(e.message));
  const { tabId } = await tabsCreate({ url: `${SHOP}/` });
  assert.equal(c._tabs.get(tabId).url, `${SHOP}/`);
});

test("navigate and tabsCreate fail with NET_ERROR when the page did not load", async () => {
  const c = fresh();
  const down = "https://down.example/";
  patchLoads(c, { fail: { [down]: "net::ERR_NAME_NOT_RESOLVED", [`${down}?code=secret`]: "net::ERR_CONNECTION_REFUSED" } });
  await assert.rejects(tabsCreate({ url: down }), (e) => e.code === ERR.NET_ERROR && /down\.example/.test(e.message) && /ERR_NAME_NOT_RESOLVED/.test(e.message) && /in tab \d+, which is still open/.test(e.message));
  const { tabId } = await tabsCreate({ url: `${SHOP}/` });
  await assert.rejects(navigate({ tabId, url: `${down}?code=secret` }), (e) => e.code === ERR.NET_ERROR && !/secret/.test(e.message));
  // A later load that works is not blamed for the earlier failure.
  const r = await navigate({ tabId, url: `${SHOP}/b` });
  assert.equal(r.url, `${SHOP}/b`);
  // A stop or download (ERR_ABORTED) is not a failed page.
  onMainFrameError({ type: "main_frame", frameId: 0, tabId, url: `${SHOP}/c`, error: "net::ERR_ABORTED" });
  patchLoads(c, { fail: { [`${SHOP}/d`]: "net::ERR_ABORTED" } });
  assert.equal((await navigate({ tabId, url: `${SHOP}/d` })).url, `${SHOP}/d`);
  // A subframe's failure is not the page's.
  patchLoads(c);
  onMainFrameError({ type: "sub_frame", frameId: 3, tabId, url: `${SHOP}/e`, error: "net::ERR_CONNECTION_REFUSED" });
  assert.equal((await navigate({ tabId, url: `${SHOP}/e` })).url, `${SHOP}/e`);
});

test("navigate back and forward", async () => {
  fresh();
  const { tabId } = await tabsCreate({ url: `${SHOP}/a` });
  await navigate({ url: `${SHOP}/b` });
  assert.equal((await navigate({ url: "back" })).url, `${SHOP}/a`);
  assert.equal((await navigate({ url: "forward" })).url, `${SHOP}/b`);
  assert.equal((await tabInfo({ tabId })).url, `${SHOP}/b`);
  await assert.rejects(navigate({ url: "forward" }), (e) => e.code === ERR.BAD_REQUEST && /forward/.test(e.message));
});

test("navigateAndWait times out, and fails with NO_TAB if the tab closes", async () => {
  const c = fresh({ autoComplete: false });
  const { tabId } = await tabsCreate({});
  await assert.rejects(navigateAndWait(tabId, () => c.tabs.update(tabId, { url: `${SHOP}/slow` }), 50), (e) => e.code === ERR.TIMEOUT);
  assert.equal(c.tabs.onUpdated.size, 0);
  const p = navigateAndWait(tabId, () => c.tabs.update(tabId, { url: `${SHOP}/x` }), 1000);
  setTimeout(() => c.tabs.remove(tabId), 10);
  await assert.rejects(p, (e) => e.code === ERR.NO_TAB);
});

test("navigateAndWait: Back within a single page app sends loading and no complete, and still finishes", async () => {
  const c = fresh({ autoComplete: false });
  const { tabId } = await tabsCreate({});
  const tab = c._tabs.get(tabId);
  const t0 = Date.now();
  // What Chrome does for a same-document Back: "loading", then the status
  // turns complete with no event for it.
  const done = await navigateAndWait(tabId, () => {
    c.tabs.onUpdated.fire(tabId, { status: "loading" }, { ...tab, status: "loading" });
    tab.status = "complete";
  }, 5000);
  assert.equal(done.status, "complete");
  assert.ok(Date.now() - t0 < 1000, "not the timeout");
  assert.equal(c.tabs.onUpdated.size, 0);
});

test("open mode: blocked sites are refused before the tab moves", async () => {
  const c = fresh({ local: { blocklist: [...SUGGESTED_BLOCKLIST, "nordstrom.com"] } });
  const { tabId } = await tabsCreate({ url: "https://www.etsy.com/" });
  for (const url of [
    "https://mail.google.com/", "https://vault.bitwarden.com/", "https://secure.chase.com/", "https://www.irs.gov/",
    "https://accounts.google.com/", "http://localhost:5050/", "http://localhost:4001/", "chrome://settings",
    "file:///etc/passwd", "javascript:alert(1)", "https://www.nordstrom.com/s/1",
  ]) {
    await assert.rejects(navigate({ tabId, url }), (e) => e.code === ERR.NOT_ALLOWED && /blocked/.test(e.message), url);
  }
  assert.equal(c._tabs.get(tabId).url, "https://www.etsy.com/");
  await assert.rejects(tabsCreate({ url: "https://mail.google.com/" }), (e) => e.code === ERR.NOT_ALLOWED);
});

test("the pay unlock follows the browse policy; a payment frame needs only the fixed rules", async () => {
  fresh();
  assert.equal(await isAllowed(`${SHOP}/checkout`), true, "open mode: any site that is not blocked");
  assert.equal(await isAllowed("https://mail.google.com/"), false);
  assert.equal(await frameAllowed("https://js.stripe.com/v3/elements-inner-card.html"), true);
  assert.equal(await frameAllowed("http://127.0.0.1:4101/card-frame"), false);
  fresh({ local: { browseMode: "allowlist", allowlist: ["https://www.etsy.com"] } });
  assert.equal(await isAllowed(`${SHOP}/checkout`), false, "allowlist mode: only the allowed sites");
  assert.equal(await isAllowed("https://www.etsy.com/checkout"), true);
});

test("incognito: the manifest keeps Orbi out, and an incognito tab is hidden and refused", async () => {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.incognito, "not_allowed");
  const c = fresh();
  const id = await userTab(c, "https://www.etsy.com/", { active: true });
  c._tabs.get(id).incognito = true;
  assert.deepEqual((await tabsContext()).tabs, []);
  await assert.rejects(resolveAllowedTab(id), (e) => e.code === ERR.NOT_ALLOWED);
  await assert.rejects(resolveAllowedTab(), (e) => e.code === ERR.NOT_ALLOWED);
  await assert.rejects(navigate({ tabId: id, url: "https://www.etsy.com/x" }), (e) => e.code === ERR.NOT_ALLOWED);
});
