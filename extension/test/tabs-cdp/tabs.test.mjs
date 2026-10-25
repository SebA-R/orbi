import { test } from "node:test";
import assert from "node:assert/strict";

import { installChrome } from "./chrome-mock.mjs";
import {
  GROUP_KEY, GROUP_TITLE, groupId, navigate, navigateAndWait, onGroupRemoved, resolveAllowedTab, resolveTab,
  tabInfo, tabsContext, tabsCreate,
} from "../../background/tabs.js";
import { ERR } from "../../lib/protocol.js";

const STORE = "http://localhost:4000";

test("tabsContext is empty before any agent tab exists", async () => {
  installChrome();
  assert.deepEqual(await tabsContext(), { tabs: [], groupId: null });
});

test("tabsCreate makes a Clearcart group, persists its id and loads the url", async () => {
  const c = installChrome();
  const { tabId } = await tabsCreate({ url: `${STORE}/` });
  const gid = c.storage.session.data[GROUP_KEY];
  assert.equal(c._groups.get(gid).title, GROUP_TITLE);
  assert.equal(c._tabs.get(tabId).groupId, gid);
  assert.equal(c._tabs.get(tabId).status, "complete");
  const ctx = await tabsContext();
  assert.equal(ctx.groupId, gid);
  assert.deepEqual(ctx.tabs, [{ tabId, url: `${STORE}/`, title: `Title of ${STORE}/`, active: true }]);
});

test("a second tab joins the same group", async () => {
  const c = installChrome();
  const a = await tabsCreate({});
  const b = await tabsCreate({ url: `${STORE}/p/1` });
  assert.equal(c._groups.size, 1);
  assert.equal(c._tabs.get(a.tabId).groupId, c._tabs.get(b.tabId).groupId);
  assert.equal((await tabsContext()).tabs.length, 2);
});

test("tabsCreate refuses a non-allowlisted url before opening anything", async () => {
  const c = installChrome();
  await assert.rejects(tabsCreate({ url: "https://evil.example/" }), (e) => e.code === ERR.NOT_ALLOWED);
  assert.equal(c._tabs.size, 0);
});

test("group id is recovered by title when session storage is lost", async () => {
  const c = installChrome();
  await tabsCreate({});
  const gid = c.storage.session.data[GROUP_KEY];
  delete c.storage.session.data[GROUP_KEY];
  assert.equal(await groupId(), gid);
  assert.equal(c.storage.session.data[GROUP_KEY], gid);
});

test("a stale stored group id is dropped and a new group created", async () => {
  const c = installChrome({ session: { [GROUP_KEY]: 999 } });
  assert.equal(await groupId(), null);
  assert.equal(GROUP_KEY in c.storage.session.data, false);
  await tabsCreate({});
  assert.notEqual(c.storage.session.data[GROUP_KEY], 999);
});

test("closing the last agent tab clears the stored group", async () => {
  const c = installChrome();
  c.tabGroups.onRemoved.addListener(onGroupRemoved);
  const { tabId } = await tabsCreate({});
  await c.tabs.remove(tabId);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(GROUP_KEY in c.storage.session.data, false);
});

test("resolveTab defaults to the active agent tab and rejects outsiders", async () => {
  const c = installChrome();
  await assert.rejects(resolveTab(), (e) => e.code === ERR.NO_TAB);
  const outside = await c.tabs.create({ url: "about:blank", active: false });
  const { tabId } = await tabsCreate({});
  assert.equal(await resolveTab(), tabId);
  assert.equal(await resolveTab(tabId), tabId);
  await assert.rejects(resolveTab(outside.id), (e) => e.code === ERR.NO_TAB);
  await assert.rejects(resolveTab(12345), (e) => e.code === ERR.NO_TAB);
  await assert.rejects(resolveTab("1"), (e) => e.code === ERR.BAD_REQUEST);
});

test("navigate checks the allowlist, waits for complete and reports url/title", async () => {
  const c = installChrome();
  const { tabId } = await tabsCreate({ url: `${STORE}/` });
  const r = await navigate({ tabId, url: `${STORE}/cart` });
  assert.deepEqual(r, { tabId, url: `${STORE}/cart`, title: `Title of ${STORE}/cart` });
  await assert.rejects(navigate({ tabId, url: "https://evil.example/" }), (e) => e.code === ERR.NOT_ALLOWED);
  assert.equal(c._tabs.get(tabId).url, `${STORE}/cart`);
  await assert.rejects(navigate({ tabId }), (e) => e.code === ERR.BAD_REQUEST);
});

test("navigate back and forward", async () => {
  installChrome();
  const { tabId } = await tabsCreate({ url: `${STORE}/a` });
  await navigate({ url: `${STORE}/b` });
  assert.equal((await navigate({ url: "back" })).url, `${STORE}/a`);
  assert.equal((await navigate({ url: "forward" })).url, `${STORE}/b`);
  assert.equal((await tabInfo({ tabId })).url, `${STORE}/b`);
  await assert.rejects(navigate({ url: "forward" }), (e) => e.code === ERR.BAD_REQUEST && /forward/.test(e.message));
});

test("navigate back off the allowlist reports NOT_ALLOWED", async () => {
  installChrome();
  await tabsCreate({});
  // first history entry is about:blank, which is not allowlisted
  await navigate({ url: `${STORE}/a` });
  await assert.rejects(navigate({ url: "back" }), (e) => e.code === ERR.NOT_ALLOWED);
  await assert.rejects(resolveAllowedTab(), (e) => e.code === ERR.NOT_ALLOWED);
});

test("navigateAndWait times out", async () => {
  const c = installChrome({ autoComplete: false });
  const { tabId } = await tabsCreate({});
  await assert.rejects(
    navigateAndWait(tabId, () => c.tabs.update(tabId, { url: `${STORE}/slow` }), 50),
    (e) => e.code === ERR.TIMEOUT,
  );
  assert.equal(c.tabs.onUpdated.size, 0);
});

test("navigateAndWait fails with NO_TAB if the tab closes", async () => {
  const c = installChrome({ autoComplete: false });
  const { tabId } = await tabsCreate({});
  const p = navigateAndWait(tabId, () => c.tabs.update(tabId, { url: `${STORE}/x` }), 1000);
  setTimeout(() => c.tabs.remove(tabId), 10);
  await assert.rejects(p, (e) => e.code === ERR.NO_TAB);
});

test("tabInfo returns the resolved tab", async () => {
  installChrome();
  const { tabId } = await tabsCreate({ url: `${STORE}/` });
  assert.deepEqual(await tabInfo({}), { tabId, url: `${STORE}/`, title: `Title of ${STORE}/` });
  assert.equal(await resolveAllowedTab(tabId), tabId);
});
