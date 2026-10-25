// Agent tabs. Every tab the agent drives lives in one tab group titled
// "Clearcart"; its id is kept in chrome.storage.session so it survives a
// service-worker restart (but not a browser restart, where the group is
// recovered by title).

import { BridgeError, ERR } from "../lib/protocol.js";
import { assertAllowed, isAllowed } from "./allowlist.js";

export const GROUP_TITLE = "Clearcart";
export const GROUP_COLOR = "blue";
export const GROUP_KEY = "clearcartGroupId";
export const NAV_TIMEOUT_MS = 20_000;
const NO_GROUP = -1;

const api = () => globalThis.chrome;

function info(tab) {
  return { tabId: tab.id, url: tab.url || tab.pendingUrl || "", title: tab.title || "" };
}

async function groupExists(id) {
  if (typeof id !== "number" || id === NO_GROUP) return false;
  try {
    await api().tabGroups.get(id);
    return true;
  } catch {
    return false;
  }
}

// Returns the live group id, recovering it by title if the stored one is gone.
// Returns null when there is no agent group yet.
export async function groupId() {
  const { [GROUP_KEY]: stored } = await api().storage.session.get(GROUP_KEY);
  if (await groupExists(stored)) return stored;
  const [found] = await api().tabGroups.query({ title: GROUP_TITLE });
  if (found) {
    await api().storage.session.set({ [GROUP_KEY]: found.id });
    return found.id;
  }
  if (stored != null) await api().storage.session.remove(GROUP_KEY);
  return null;
}

// Puts a tab into the agent group, creating the group if needed.
async function addToGroup(tab) {
  const existing = await groupId();
  if (existing != null) {
    await api().tabs.group({ groupId: existing, tabIds: [tab.id] });
    return existing;
  }
  const id = await api().tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  await api().tabGroups.update(id, { title: GROUP_TITLE, color: GROUP_COLOR });
  await api().storage.session.set({ [GROUP_KEY]: id });
  return id;
}

// Forget the stored id when Chrome removes the group (last tab closed).
export async function onGroupRemoved(group) {
  const { [GROUP_KEY]: stored } = await api().storage.session.get(GROUP_KEY);
  if (group && stored === group.id) await api().storage.session.remove(GROUP_KEY);
}

export async function tabsContext() {
  const gid = await groupId();
  const tabs = gid == null ? [] : await api().tabs.query({ groupId: gid });
  return { tabs: tabs.map((t) => ({ ...info(t), active: !!t.active })), groupId: gid };
}

// Given id must be in the agent group; default is the group's active tab
// (or its first tab if none of them is active).
export async function resolveTab(tabId) {
  const gid = await groupId();
  if (gid == null) throw new BridgeError(ERR.NO_TAB, "no agent tabs; call tabs_create first");
  if (tabId != null) {
    if (!Number.isInteger(tabId)) throw new BridgeError(ERR.BAD_REQUEST, "tabId must be an integer");
    let tab;
    try {
      tab = await api().tabs.get(tabId);
    } catch {
      throw new BridgeError(ERR.NO_TAB, `no tab ${tabId}`);
    }
    if (tab.groupId !== gid) throw new BridgeError(ERR.NO_TAB, `tab ${tabId} is not an agent tab`);
    return tab.id;
  }
  const tabs = await api().tabs.query({ groupId: gid });
  const pick = tabs.find((t) => t.active) || tabs[0];
  if (!pick) throw new BridgeError(ERR.NO_TAB, "no agent tabs; call tabs_create first");
  return pick.id;
}

// Resolves once the tab reaches status "complete" after `start()` runs.
// The listener is installed before start() so no event is missed. If no
// "loading" event shows up (same-document navigation), a short grace check
// of the tab's own status settles it.
export function navigateAndWait(tabId, start, timeoutMs = NAV_TIMEOUT_MS) {
  const c = api();
  return new Promise((resolve, reject) => {
    let seenLoading = false;
    let done = false;
    const finish = (err, tab) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      c.tabs.onUpdated.removeListener(onUpdated);
      c.tabs.onRemoved.removeListener(onRemoved);
      if (err) reject(err);
      else resolve(tab);
    };
    const onUpdated = (id, change, tab) => {
      if (id !== tabId) return;
      if (change.status === "loading") seenLoading = true;
      if (change.status === "complete" && seenLoading) finish(null, tab);
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(new BridgeError(ERR.NO_TAB, `tab ${tabId} closed while loading`));
    };
    const timer = setTimeout(
      () => finish(new BridgeError(ERR.TIMEOUT, `page did not finish loading in ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
    let grace;
    c.tabs.onUpdated.addListener(onUpdated);
    c.tabs.onRemoved.addListener(onRemoved);
    Promise.resolve()
      .then(start)
      .then(() => {
        grace = setTimeout(async () => {
          if (seenLoading || done) return;
          try {
            const tab = await c.tabs.get(tabId);
            if (tab.status === "complete") finish(null, tab);
          } catch {
            finish(new BridgeError(ERR.NO_TAB, `no tab ${tabId}`));
          }
        }, 250);
      })
      .catch((e) => finish(e instanceof BridgeError ? e : new BridgeError(ERR.INTERNAL, e?.message || String(e))));
  });
}

export async function tabsCreate({ url } = {}) {
  if (url != null) await assertAllowed(url);
  const tab = await api().tabs.create({ url: "about:blank", active: true });
  await addToGroup(tab);
  if (url != null) await navigateAndWait(tab.id, () => api().tabs.update(tab.id, { url }));
  return { tabId: tab.id };
}

export async function navigate({ tabId, url } = {}) {
  if (typeof url !== "string" || !url) throw new BridgeError(ERR.BAD_REQUEST, "url is required");
  const id = await resolveTab(tabId);
  let start;
  const history = (fn, dir) => async () => {
    try {
      await fn(id);
    } catch {
      // Includes entries Chrome skips because they were added without a user gesture.
      throw new BridgeError(ERR.BAD_REQUEST, `no page to go ${dir} to`);
    }
  };
  if (url === "back") start = history((i) => api().tabs.goBack(i), "back");
  else if (url === "forward") start = history((i) => api().tabs.goForward(i), "forward");
  else {
    await assertAllowed(url);
    start = () => api().tabs.update(id, { url });
  }
  await navigateAndWait(id, start);
  const tab = await api().tabs.get(id);
  // History can lead off the allowlist; report it so callers stop driving.
  if (!(await isAllowed(tab.url))) {
    let origin = "unknown";
    try {
      origin = new URL(tab.url).origin;
    } catch {}
    throw new BridgeError(ERR.NOT_ALLOWED, `navigated to a non-allowlisted origin: ${origin}`);
  }
  return info(tab);
}

export async function tabInfo({ tabId } = {}) {
  const id = await resolveTab(tabId);
  return info(await api().tabs.get(id));
}

// For the worker: resolve an agent tab and check its current page is
// allowlisted before any CDP input or page call touches it.
export async function resolveAllowedTab(tabId) {
  const id = await resolveTab(tabId);
  const tab = await api().tabs.get(id);
  await assertAllowed(tab.url);
  return id;
}
