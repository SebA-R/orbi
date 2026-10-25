import { test } from "node:test";
import assert from "node:assert/strict";

import { createFollower } from "../../../extension/background/follow.js";
import { createRouter } from "../../../extension/background/router.js";
import { normalize } from "../../../extension/lib/settings.js";

// Two windows: the user is on tab 1 (window 10); tab 2 sits in the
// background in window 10, tab 3 in window 20.
function setup({ followTab = true } = {}) {
  const tabState = new Map([
    [1, { id: 1, windowId: 10, active: true }],
    [2, { id: 2, windowId: 10, active: false }],
    [3, { id: 3, windowId: 20, active: true }],
  ]);
  const focused = { id: 10 };
  const switches = [];
  const settings = { followTab };
  const chromeApi = {
    scripting: { executeScript: async () => [{ frameId: 0, documentId: "d" }] },
    tabs: {
      get: async (id) => {
        const t = tabState.get(id);
        if (!t) throw new Error("no tab");
        return { ...t };
      },
      update: async (id, props) => {
        switches.push(["tab", id]);
        const t = tabState.get(id);
        if (props.active) for (const o of tabState.values()) if (o.windowId === t.windowId) o.active = o.id === id;
        // Chrome fires onActivated for Clearcart's own switch too.
        follow.onActivated({ tabId: id, windowId: t.windowId });
        return { ...t };
      },
      sendMessage: async () => ({ ok: true, result: { ok: true } }),
    },
    windows: {
      get: async (id) => ({ id, focused: focused.id === id }),
      update: async (id) => {
        switches.push(["window", id]);
        focused.id = id;
        follow.onWindowFocused(id);
      },
    },
  };
  const follow = createFollower({ chromeApi, getSettings: async () => settings });
  const tabs = {
    resolveAllowedTab: async (id) => id ?? 1,
    resolveTab: async (id) => id ?? 1,
    assertPageAllowed: async () => {},
    navigate: async ({ tabId }) => ({ tabId, url: "https://shop.test/", title: "" }),
    // Chrome shows the neighbour tab while it closes the front one.
    tabsClose: async ({ tabId }) => {
      const gone = tabState.get(tabId);
      tabState.delete(tabId);
      if (gone?.active) {
        tabState.get(1).active = true;
        follow.onActivated({ tabId: 1, windowId: 10 });
      }
      return { ok: true };
    },
    tabsCreate: async ({ onCreated }) => {
      tabState.set(9, { id: 9, windowId: 10, active: false });
      await onCreated?.(9);
      return { tabId: 9 };
    },
  };
  const cdp = { click: async () => {}, type: async () => {}, key: async () => {}, scroll: async () => {}, screenshot: async () => ({ data: "" }) };
  const router = createRouter({ chromeApi, tabs, cdp, follow });
  // The user picks a tab themselves.
  const userSwitch = (id) => {
    const t = tabState.get(id);
    for (const o of tabState.values()) if (o.windowId === t.windowId) o.active = o.id === id;
    follow.onActivated({ tabId: id, windowId: t.windowId });
  };
  return { router, follow, switches, settings, tabState, userSwitch };
}

test("followTab defaults on and keeps a stored false", () => {
  assert.equal(normalize({}).followTab, true);
  assert.equal(normalize({ followTab: false }).followTab, false);
  assert.equal(normalize({ followTab: "no" }).followTab, true);
});

test("acting on a background tab switches to it and focuses its window", async () => {
  const { router, switches } = setup();
  await router.route("click", { tabId: 2, x: 5, y: 5 });
  assert.deepEqual(switches, [["tab", 2]]);
  switches.length = 0;
  await router.route("scroll", { tabId: 3, dy: 100 });
  assert.deepEqual(switches, [["window", 20]], "tab 3 is already active in window 20: only the window is focused");
});

test("type, key, navigate and a new tab all switch", async () => {
  for (const [method, params, want] of [
    ["type", { tabId: 2, text: "wool" }, 2],
    ["key", { tabId: 2, key: "a" }, 2],
    ["navigate", { tabId: 2, url: "https://shop.test/" }, 2],
    ["tabs_create", { url: "https://shop.test/" }, 9],
  ]) {
    const { router, switches } = setup();
    await router.route(method, params);
    assert.deepEqual(switches[0], ["tab", want], method);
  }
});

test("acting on the tab the user is already on does not switch", async () => {
  const { router, switches } = setup();
  await router.route("click", { tabId: 1, x: 5, y: 5 });
  assert.deepEqual(switches, []);
});

test("reading or snapshotting another tab does not switch", async () => {
  const { router, switches } = setup();
  await router.route("read_page", { tabId: 2 });
  await router.route("get_page_text", { tabId: 2 });
  await router.route("find", { tabId: 3, query: "x" });
  await router.route("screenshot", { tabId: 2 });
  await router.route("page_context", {});
  assert.deepEqual(switches, []);
});

test("a manual switch away stops following for the rest of the turn, the next turn resumes", async () => {
  const { router, follow, switches, userSwitch } = setup();
  await router.route("click", { tabId: 2, x: 5, y: 5 });
  assert.deepEqual(switches, [["tab", 2]]);
  // Clearcart's own switch did not count as the user's.
  assert.equal(follow.paused, false);

  userSwitch(1);
  assert.equal(follow.paused, true);
  switches.length = 0;
  await router.route("click", { tabId: 2, x: 5, y: 5 });
  await router.route("tabs_create", { url: "https://shop.test/" });
  assert.deepEqual(switches, [], "no switching after the user moved away");

  // Next user turn: the agent server asks for page_context.
  await router.route("page_context", {});
  assert.equal(follow.paused, false);
  await router.route("click", { tabId: 2, x: 5, y: 5 });
  assert.deepEqual(switches, [["tab", 2]]);
});

test("the user focusing another window also stops following; leaving Chrome does not", async () => {
  const { router, follow } = setup();
  await router.route("click", { tabId: 2, x: 5, y: 5 });
  follow.onWindowFocused(-1);
  assert.equal(follow.paused, false);
  follow.onWindowFocused(20);
  assert.equal(follow.paused, true);
  router.noteTalkStart();
  assert.equal(follow.paused, false, "starting to talk is a new turn");
});

test("switching tabs before Clearcart acts this turn is not a switch away", async () => {
  const { router, follow, switches, userSwitch } = setup();
  userSwitch(2);
  assert.equal(follow.paused, false);
  await router.route("click", { tabId: 1, x: 5, y: 5 });
  assert.deepEqual(switches, [["tab", 1]]);
});

test("Clearcart closing the front tab is not the user switching away", async () => {
  const { router, follow, switches } = setup();
  await router.route("tabs_create", { url: "https://shop.test/" });
  await router.route("tabs_close", { tabId: 9 });
  assert.equal(follow.paused, false);
  switches.length = 0;
  await router.route("click", { tabId: 2, x: 5, y: 5 });
  assert.deepEqual(switches, [["tab", 2]]);
});

test("setting off means no switch", async () => {
  const { router, switches } = setup({ followTab: false });
  await router.route("click", { tabId: 2, x: 5, y: 5 });
  await router.route("navigate", { tabId: 3, url: "https://shop.test/" });
  await router.route("tabs_create", { url: "https://shop.test/" });
  assert.deepEqual(switches, []);
});

test("a failed switch never fails the action", async () => {
  const { router, follow } = setup();
  const r = await router.route("click", { tabId: 99, x: 5, y: 5 });
  assert.deepEqual(r, { ok: true, via: "cdp" });
  assert.equal(await follow.to(99), false);
});
