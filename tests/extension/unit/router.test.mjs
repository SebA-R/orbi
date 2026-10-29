import { test } from "node:test";
import assert from "node:assert/strict";

import { containsCardNumber, createRouter } from "../../../extension/background/router.js";

function fakes({ focus = { kind: "other", payment: false }, failFirstSend = false, cdpClickFails = false, cdpClickPressed = false, tabsExtra = {} } = {}) {
  const calls = [];
  let sends = 0;
  const chromeApi = {
    scripting: {
      executeScript: async (o) => calls.push(["inject", o.target.tabId, o.files]),
    },
    tabs: {
      sendMessage: async (tabId, msg) => {
        sends++;
        if (failFirstSend && sends === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
        calls.push(["page", tabId, msg.method, msg.params]);
        if (msg.method === "focused_field") return { ok: true, result: focus };
        if (msg.method === "rect" || msg.method === "guard_ref") return { ok: true, result: { x: 10, y: 20, width: 100, height: 40 } };
        if (msg.method === "form_input") return { ok: false, error: { code: "payment_field", message: "no" } };
        return { ok: true, result: { ok: true } };
      },
    },
  };
  const tabs = {
    resolveAllowedTab: async (id) => (calls.push(["resolve", id]), id ?? 7),
    tabsContext: async () => ({ tabs: [], groupId: 1 }),
    assertPageAllowed: async () => {},
    ...tabsExtra,
  };
  const cdp = {
    click: async (o) => {
      if (cdpClickFails) throw Object.assign(new Error("attach failed"), { code: "internal" });
      if (cdpClickPressed) throw Object.assign(new Error("Input.dispatchMouseEvent failed"), { code: "internal", noFallback: true });
      calls.push(["cdp.click", o]);
    },
    type: async (o) => calls.push(["cdp.type", o]),
    send: async (_t, method, p) => calls.push(["cdp.send", method, p]),
    key: async (o) => calls.push(["cdp.key", o]),
  };
  return { calls, router: createRouter({ chromeApi, tabs, cdp }) };
}

test("containsCardNumber finds Luhn-valid 13-19 digit runs only", () => {
  assert.ok(containsCardNumber("4111 1111 1111 1111"));
  assert.ok(containsCardNumber("pay 4111-1111-1111-1111 now"));
  assert.ok(containsCardNumber("x94111111111111111"));
  assert.ok(containsCardNumber("8171 9999 2766 0000"), "RuPay");
  assert.ok(containsCardNumber("9792123456789018"), "Troy");
  assert.ok(!containsCardNumber("4111 1111 1111 2"));
  assert.ok(!containsCardNumber("order 12345 qty 2"));
  assert.ok(!containsCardNumber("blue wool sweater"));
});

test("page methods inject mask.js, protect.js, then page.js and pass params without tabId", async () => {
  const { calls, router } = fakes();
  await router.route("find", { tabId: 3, query: "sweater" });
  assert.deepEqual(calls[0], ["resolve", 3]);
  assert.deepEqual(calls[1], ["inject", 3, ["content/mask.js", "content/protect.js", "content/page.js"]]);
  assert.deepEqual(calls[2], ["page", 3, "find", { query: "sweater" }]);
});

test("retries once after Receiving end does not exist", async () => {
  const { calls, router } = fakes({ failFirstSend: true });
  await router.route("read_page", {});
  assert.equal(calls.filter((c) => c[0] === "inject").length, 2);
  assert.equal(calls.filter((c) => c[0] === "page").length, 1);
});

test("page errors keep their code", async () => {
  const { router } = fakes();
  await assert.rejects(router.route("form_input", { ref: "ref_1", value: "x" }), { code: "payment_field" });
});

test("click by ref clicks the rect centre over CDP, and falls back to click_ref", async () => {
  const a = fakes();
  await a.router.route("click", { ref: "ref_4" });
  assert.deepEqual(a.calls.find((c) => c[0] === "cdp.click")[1], { tabId: 7, x: 60, y: 40 });
  const b = fakes({ cdpClickFails: true });
  assert.deepEqual(await b.router.route("click", { ref: "ref_4" }), { ok: true, via: "dom" });
  assert.ok(b.calls.some((c) => c[0] === "page" && c[2] === "click_ref"));
});

test("click and key answer through tabs.actAndSettle: the press's result plus where the tab settled", async () => {
  const seen = [];
  const actAndSettle = async (tabId, act) => {
    seen.push(tabId);
    const r = await act();
    return { ...r, navigated: true, url: "https://shop.example/next", title: "Next" };
  };
  const { calls, router } = fakes({ tabsExtra: { actAndSettle } });
  assert.deepEqual(await router.route("click", { ref: "ref_4" }), { ok: true, via: "cdp", navigated: true, url: "https://shop.example/next", title: "Next" });
  assert.deepEqual(await router.route("key", { tabId: 3, key: "Enter" }), { ok: true, navigated: true, url: "https://shop.example/next", title: "Next" });
  assert.deepEqual(seen, [7, 3]);
  assert.ok(calls.some((c) => c[0] === "cdp.click") && calls.some((c) => c[0] === "cdp.key"));
  // Refused before the press: nothing settles.
  await assert.rejects(router.route("key", { key: "\r" }));
  assert.deepEqual(seen, [7, 3]);
});

test("a CDP click that failed after the press went down never falls back to a DOM click", async () => {
  const f = fakes({ cdpClickPressed: true });
  await assert.rejects(f.router.route("click", { ref: "ref_4" }), { code: "internal" });
  assert.ok(!f.calls.some((c) => c[0] === "page" && c[2] === "click_ref"), "no second click");
});

// Typing goes key by key through the actor (background/actor.js).
const typed = (calls) => calls.filter((c) => c[0] === "cdp.send" && (c[1] === "Input.insertText" || c[2]?.type === "char")).map((c) => c[2].text).join("");

test("type refuses card numbers and payment fields, and allows normal text", async () => {
  const ok = fakes();
  await ok.router.route("type", { text: "wool sweater" });
  assert.equal(typed(ok.calls), "wool sweater");

  const num = fakes();
  await assert.rejects(num.router.route("type", { text: "4111111111111111" }), { code: "payment_field" });
  await assert.rejects(num.router.route("type", { text: "8123456789012340" }), { code: "payment_field" });
  await assert.rejects(num.router.route("type", { text: "9792 1234 5678 9018" }), { code: "payment_field" });
  assert.ok(!num.calls.some((c) => c[0] === "cdp.type" || c[0] === "cdp.send"));

  const field = fakes({ focus: { kind: "cc-csc", payment: true } });
  await assert.rejects(field.router.route("type", { text: "123" }), { code: "payment_field" });
  await assert.rejects(field.router.route("key", { key: "1" }), { code: "payment_field" });
  await field.router.route("key", { key: "Tab" });
  assert.ok(field.calls.some((c) => c[0] === "cdp.key"));
});

test("unknown methods are refused", async () => {
  const { router } = fakes();
  await assert.rejects(router.route("javascript_tool", {}), { code: "unknown_method" });
});

// Tabs and context (no tab group).

function contextFakes({ blocked = false, page = { selection: "Blue mug", pointing: { via: "hover", ref: "ref_9", role: "link", name: "Blue mug" } } } = {}) {
  const calls = [];
  const active = { id: 21, title: "Mugs", url: "https://www.etsy.com/c/mugs?ref=nav#top" };
  const chromeApi = {
    scripting: { executeScript: async (o) => calls.push(["inject", o.target.tabId, o.files]) },
    tabs: {
      sendMessage: async (tabId, msg) => {
        calls.push(["page", tabId, msg.method]);
        return { ok: true, result: page };
      },
    },
  };
  const tabs = {
    activeTab: async () => active,
    originPath: (u) => u.split(/[?#]/)[0],
    resolveAllowedTab: async (id, opts) => {
      calls.push(["resolve", id, opts]);
      if (blocked) throw Object.assign(new Error("tab 21 is on a blocked site"), { code: "not_allowed" });
      return id ?? 7;
    },
    markDriven: async (id) => calls.push(["driven", id]),
    tabsClose: async ({ tabId }) => (calls.push(["close", tabId]), { ok: true }),
    assertPageAllowed: async () => {},
  };
  const cdp = { click: async () => {}, scroll: async () => {}, type: async () => {}, key: async () => {}, send: async () => {} };
  return { calls, router: createRouter({ chromeApi, tabs, cdp }) };
}

test("tab-bound calls inject no tab pill; clicking or typing never marks a user tab sweepable", async () => {
  const { calls, router } = fakes();
  await router.route("click", { tabId: 4, x: 1, y: 2 });
  assert.ok(!calls.some((c) => c[0] === "inject" && c[2].some((f) => f.includes("indicator"))));
  const b = contextFakes();
  await b.router.route("click", { tabId: 5, x: 1, y: 2 });
  await b.router.route("type", { tabId: 5, text: "mug" });
  await b.router.route("key", { tabId: 5, key: "Tab" });
  await b.router.route("scroll", { tabId: 6, x: 1, y: 2 });
  assert.deepEqual(b.calls.filter((c) => c[0] === "driven"), []);
  await b.router.route("tabs_close", { tabId: 5 });
  assert.ok(b.calls.some((c) => c[0] === "close" && c[1] === 5));
});

test("page_context: active tab as origin+path, selection and pointing, read with the tracker loaded", async () => {
  const { calls, router } = contextFakes();
  const ctx = await router.route("page_context", {});
  assert.deepEqual(ctx, {
    active: { tabId: 21, title: "Mugs", url: "https://www.etsy.com/c/mugs" },
    selection: "Blue mug",
    pointing: { via: "hover", ref: "ref_9", role: "link", name: "Blue mug" },
  });
  assert.deepEqual(calls.find((c) => c[0] === "resolve"), ["resolve", 21, { peek: true }]);
  assert.deepEqual(calls.find((c) => c[0] === "inject")[2][0], "content/context.js");
});

test("page_context: a blocked active tab gives only { blocked: true } and nothing is read from it", async () => {
  const { calls, router } = contextFakes({ blocked: true });
  assert.deepEqual(await router.route("page_context", {}), { active: { blocked: true } });
  assert.ok(!calls.some((c) => c[0] === "inject" || c[0] === "page"));
});

test("page_context: a new tab page is an empty new tab, not a blocked site, and nothing is read from it", async () => {
  const calls = [];
  const r = createRouter({
    chromeApi: { scripting: { executeScript: async () => calls.push(["inject"]) }, tabs: { sendMessage: async () => calls.push(["page"]) } },
    tabs: { activeTab: async () => ({ id: 30, title: "Orbi", url: "chrome://newtab/" }), onNewTab: (t) => t.url === "chrome://newtab/", resolveAllowedTab: async () => { throw new Error("no"); } },
    cdp: {},
  });
  assert.deepEqual(await r.route("page_context", {}), { active: { tabId: 30, title: "New Tab", url: "chrome://newtab/", newTab: true } });
  assert.deepEqual(calls, []);
});

test("page_context: Orbi's error page names the failed address only when tabs allows it, and reads nothing", async () => {
  const calls = [];
  let failed = "https://shop.example/cart";
  let hidden = false;
  const r = createRouter({
    chromeApi: { scripting: { executeScript: async () => calls.push(["inject"]) }, tabs: { sendMessage: async () => calls.push(["page"]) } },
    tabs: {
      activeTab: async () => ({ id: 31, title: "Can't reach this site", url: "chrome-extension://x/newtab/error.html#k=1" }),
      onNewTab: () => false,
      onErrorPage: () => true,
      failedAddress: async () => failed,
      resolveTab: async (id) => { if (hidden) throw new Error("blocked"); return id; },
      resolveAllowedTab: async () => { throw new Error("no"); },
    },
    cdp: {},
  });
  const base = { tabId: 31, title: "Can't reach this site", url: "chrome-error://chromewebdata/", newTab: true, errorPage: true };
  assert.deepEqual(await r.route("page_context", {}), { active: { ...base, failedUrl: "https://shop.example/cart" } });
  failed = null;
  assert.deepEqual(await r.route("page_context", {}), { active: base });
  // A user's error page for a blocked site is a blocked tab.
  hidden = true;
  assert.deepEqual(await r.route("page_context", {}), { active: { blocked: true } });
  assert.deepEqual(calls, []);
});

test("page_context uses the snapshot taken when the user started talking, once", async () => {
  const page = { selection: "at talk start", pointing: null };
  const { calls, router } = contextFakes({ page });
  await router.noteTalkStart();
  page.selection = "later";
  assert.equal((await router.route("page_context", {})).selection, "at talk start");
  assert.equal((await router.route("page_context", {})).selection, "later");
  assert.equal(calls.filter((c) => c[0] === "page").length, 2);
});

// Time of check: a read reaches only the document that was checked, and is
// dropped when the page moved to a blocked site.

function tocFakes({ failFirstSend = false, replyHref = "https://www.etsy.com/c/mugs", blockedAfter = false, blockedOnRetry = false } = {}) {
  const calls = [];
  let docs = 0;
  let sends = 0;
  let resolves = 0;
  const chromeApi = {
    scripting: {
      executeScript: async (o) => {
        calls.push(["inject", o.target]);
        return [{ frameId: 0, documentId: `doc-${++docs}`, result: null }];
      },
    },
    tabs: {
      sendMessage: async (tabId, msg, opts) => {
        sends++;
        calls.push(["send", msg.method, opts]);
        if (failFirstSend && sends === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
        return { ok: true, result: { url: "https://www.etsy.com/c/mugs", tree: "secret page text" }, href: replyHref };
      },
    },
  };
  const tabs = {
    resolveAllowedTab: async (id, opts) => {
      resolves++;
      calls.push(["resolve", id, opts]);
      if (blockedOnRetry && resolves > 1) throw Object.assign(new Error("tab 3 is on a blocked site"), { code: "not_allowed" });
      return id ?? 3;
    },
    assertPageAllowed: async (id, url) => {
      calls.push(["recheck", id, url]);
      if (blockedAfter || /mail\.google/.test(String(url))) throw Object.assign(new Error(`tab ${id} moved to a blocked site; the result was dropped`), { code: "not_allowed" });
    },
  };
  const cdp = { screenshot: async () => ({ data: "JPEG", mimeType: "image/jpeg" }) };
  return { calls, router: createRouter({ chromeApi, tabs, cdp }) };
}

test("page calls are pinned to the documentId that was injected and checked", async () => {
  const { calls, router } = tocFakes();
  await router.route("read_page", { tabId: 3 });
  assert.deepEqual(calls.find((c) => c[0] === "send")[2], { documentId: "doc-1" });
  assert.deepEqual(calls.find((c) => c[0] === "recheck"), ["recheck", 3, "https://www.etsy.com/c/mugs"]);
});

test("a reply from a document on a blocked site is dropped", async () => {
  const { router } = tocFakes({ replyHref: "https://mail.google.com/mail/u/0/" });
  await assert.rejects(router.route("get_page_text", { tabId: 3 }), (e) => e.code === "not_allowed" && !/secret|google/.test(e.message));
});

test("the NO_RECEIVER retry checks the tab again before injecting into the new document", async () => {
  const ok = tocFakes({ failFirstSend: true });
  await ok.router.route("read_page", { tabId: 3 });
  const sends = ok.calls.filter((c) => c[0] === "send").map((c) => c[2]);
  assert.deepEqual(sends, [{ documentId: "doc-1" }, { documentId: "doc-2" }]);
  const injects = ok.calls.map((c, i) => [c[0], i]).filter((c) => c[0] === "inject").map((c) => c[1]);
  const recheckAt = ok.calls.findIndex((c, i) => c[0] === "resolve" && i > injects[0] && c[2]?.peek);
  assert.ok(recheckAt > injects[0] && recheckAt < injects[1], "tab rechecked between the two injects");

  const moved = tocFakes({ failFirstSend: true, blockedOnRetry: true });
  await assert.rejects(moved.router.route("read_page", { tabId: 3 }), { code: "not_allowed" });
  assert.equal(moved.calls.filter((c) => c[0] === "inject").length, 1, "nothing injected into the blocked page");
});

test("a screenshot is dropped when the tab moved to a blocked site while it was taken", async () => {
  const ok = tocFakes();
  assert.equal((await ok.router.route("screenshot", { tabId: 3 })).data, "JPEG");
  assert.deepEqual(ok.calls.find((c) => c[0] === "recheck"), ["recheck", 3, undefined]);
  const moved = tocFakes({ blockedAfter: true });
  await assert.rejects(moved.router.route("screenshot", { tabId: 3 }), { code: "not_allowed" });
});

test("a tabs module without the page recheck fails closed", async () => {
  const chromeApi = {
    scripting: { executeScript: async () => [{ frameId: 0, documentId: "d" }] },
    tabs: { sendMessage: async () => ({ ok: true, result: { text: "x" }, href: "https://www.etsy.com/" }) },
  };
  const router = createRouter({ chromeApi, tabs: { resolveAllowedTab: async () => 3 }, cdp: {} });
  await assert.rejects(router.route("get_page_text", { tabId: 3 }), { code: "internal" });
});

test("a coordinate click or scroll outside the viewport is refused before any input; scroll defaults to the centre", async () => {
  const f = { calls: [] };
  const vp = { width: 1440, height: 900, dpr: 2 };
  const r = createRouter({
    chromeApi: { scripting: { executeScript: async () => {} }, tabs: { sendMessage: async () => ({ ok: true, result: { ok: true } }) } },
    tabs: { resolveAllowedTab: async (id) => id ?? 7, assertPageAllowed: async () => {} },
    cdp: {
      viewport: async () => vp,
      click: async (o) => f.calls.push(["cdp.click", o]),
      scroll: async (o) => f.calls.push(["cdp.scroll", o]),
      send: async () => {},
    },
  });
  for (const [x, y] of [[1878, 574], [1538, 1193]]) {
    await assert.rejects(r.route("click", { x, y }), (e) => e.code === "bad_request" && /outside the 1440x900 viewport/.test(e.message));
    await assert.rejects(r.route("scroll", { x, y, dy: 100 }), (e) => e.code === "bad_request");
  }
  assert.equal(f.calls.length, 0, "nothing was pressed or scrolled");
  await r.route("click", { x: 700, y: 400 });
  await r.route("scroll", { dy: 300 });
  assert.deepEqual(f.calls.map((c) => c[0]), ["cdp.click", "cdp.scroll"]);
  assert.deepEqual([f.calls[1][1].x, f.calls[1][1].y], [720, 450]);
});

test("the debugging bar opening on the first attach: a point is refused, a ref is measured after it", async () => {
  const calls = [];
  let rectY = 20;
  const r = createRouter({
    chromeApi: {
      scripting: { executeScript: async () => {} },
      tabs: {
        sendMessage: async (_t, msg) => (msg.method === "guard_ref" ? { ok: true, result: { x: 10, y: rectY, width: 100, height: 40 } } : { ok: true, result: { ok: true } }),
      },
    },
    tabs: { resolveAllowedTab: async (id) => id ?? 7, assertPageAllowed: async () => {} },
    cdp: {
      // The bar opens on attach and moves the page up 28px.
      attach: async () => (calls.push(["attach"]), (rectY = -8), true),
      viewport: async () => ({ width: 1440, height: 844, dpr: 1 }),
      click: async (o) => calls.push(["cdp.click", o]),
      send: async () => {},
    },
  });
  await assert.rejects(r.route("click", { x: 700, y: 400 }), (e) => e.code === "bad_request" && /debugging bar/.test(e.message));
  assert.ok(!calls.some((c) => c[0] === "cdp.click"), "nothing was pressed");
  rectY = 20;
  await r.route("click", { ref: "ref_4" });
  assert.deepEqual(calls.find((c) => c[0] === "cdp.click")[1], { tabId: 7, x: 60, y: 12 }, "the rect read after the bar opened");
});

function overlayRouter(script) {
  const calls = [];
  let finds = 0;
  const router = createRouter({
    chromeApi: {
      scripting: { executeScript: async () => {} },
      tabs: {
        sendMessage: async (_t, msg) => {
          calls.push(["page", msg.method, msg.params]);
          if (msg.method === "overlay_find") return { ok: true, result: script.find(finds++) };
          if (msg.method === "guard_ref") return { ok: true, result: { x: 10, y: 20, width: 20, height: 20 } };
          return { ok: true, result: { ok: true, hidden: true } };
        },
      },
    },
    tabs: { resolveAllowedTab: async (id) => id ?? 7, assertPageAllowed: async () => {} },
    cdp: {
      viewport: async () => ({ width: 1280, height: 800, dpr: 1 }),
      click: async (o) => calls.push(["cdp.click", o.x, o.y]),
      key: async (o) => calls.push(["cdp.key", o.key]),
      send: async () => {},
    },
    settle: async () => {},
  });
  return { calls, router };
}

const POP = { found: true, ref: "ref_1", name: "Get 10% off", closeRef: "ref_2", backdrop: { x: 640, y: 12 } };

test("dismiss_overlay: the close button first, and it stops once the pop-up is gone", async () => {
  const { calls, router } = overlayRouter({ find: (i) => (i === 0 ? POP : { found: false }) });
  assert.deepEqual(await router.route("dismiss_overlay", {}), { dismissed: true, via: "close button", name: "Get 10% off" });
  assert.deepEqual(calls.filter((c) => c[0].startsWith("cdp")), [["cdp.click", 20, 30]]);
  assert.ok(!calls.some((c) => c[1] === "overlay_hide"));
});

test("dismiss_overlay: Escape, then the backdrop, then hiding it", async () => {
  const stubborn = overlayRouter({ find: () => POP });
  assert.deepEqual(await stubborn.router.route("dismiss_overlay", {}), { dismissed: true, via: "hidden", name: "Get 10% off" });
  assert.deepEqual(stubborn.calls.filter((c) => c[0].startsWith("cdp")), [["cdp.click", 20, 30], ["cdp.key", "Escape"], ["cdp.click", 640, 12]]);
  assert.deepEqual(stubborn.calls.at(-1), ["page", "overlay_hide", { ref: "ref_1" }]);
  const esc = overlayRouter({ find: (i) => (i === 0 ? { ...POP, closeRef: null } : { found: false }) });
  assert.equal((await esc.router.route("dismiss_overlay", {})).via, "Escape");
});

test("dismiss_overlay: a sign-in or payment dialog is refused with nothing pressed; no pop-up is a plain answer", async () => {
  const s = overlayRouter({ find: () => ({ found: true, ref: "ref_1", name: "Sign in", sensitive: "it has a password field" }) });
  await assert.rejects(s.router.route("dismiss_overlay", {}), (e) => e.code === "locked" && /password field/.test(e.message));
  assert.ok(!s.calls.some((c) => c[0].startsWith("cdp") || c[1] === "overlay_hide"));
  const none = overlayRouter({ find: () => ({ found: false }) });
  assert.equal((await none.router.route("dismiss_overlay", {})).dismissed, false);
});

// Google Docs, Sheets and Slides (background/gdocs.js).
function docsFakes({ url = "https://docs.google.com/document/d/1jfHEhSnJs75Jd188KNDu0UE-SKfh7QSgtpYzw1LElUc/edit", tabUrl = url + "?tab=t.0", focus, exported = "Doc body text", type = "text/plain", landed = "https://doc-0s-docstext.googleusercontent.com/x", blockAfterFetch = false } = {}) {
  const calls = [];
  const chromeApi = {
    scripting: { executeScript: async () => {} },
    tabs: {
      get: async () => ({ id: 7, url: tabUrl }),
      sendMessage: async (_t, msg) => {
        calls.push(["page", msg.method]);
        if (msg.method === "focused_field") return { ok: true, result: focus };
        return { ok: true, href: tabUrl, result: { url, title: "Doc - Google Docs", text: "File\n\nEdit", truncated: false } };
      },
    },
  };
  const tabs = {
    resolveAllowedTab: async (id) => id ?? 7,
    assertPageAllowed: async (id, u) => {
      calls.push(["allowed", u ?? null]);
      if (blockAfterFetch && calls.some((c) => c[0] === "fetch")) throw Object.assign(new Error("tab 7 is on a blocked site"), { code: "not_allowed" });
    },
  };
  const cdp = { send: async (_t, m, p) => calls.push(["cdp.send", m, p]), click: async () => {}, key: async () => {} };
  const fetchImpl = async (u) => {
    calls.push(["fetch", u]);
    if (exported == null) return { ok: false, status: 403, url: u, headers: { get: () => "text/html" }, text: async () => "" };
    return { ok: true, status: 200, url: landed, headers: { get: (h) => (h === "content-type" ? type : null) }, text: async () => exported };
  };
  return { calls, router: createRouter({ chromeApi, tabs, cdp, fetchImpl }) };
}

test("get_page_text on a Google Doc reads the file's text, then checks the tab again", async () => {
  const { calls, router } = docsFakes();
  const r = await router.route("get_page_text", { tabId: 7 });
  assert.equal(r.text, "Doc body text\n\n---\n\nFile\n\nEdit");
  assert.equal(r.source, "Google Docs file text");
  assert.match(r.note, /click in the document/);
  const fetchAt = calls.findIndex((c) => c[0] === "fetch");
  assert.equal(calls[fetchAt][1], "https://docs.google.com/document/d/1jfHEhSnJs75Jd188KNDu0UE-SKfh7QSgtpYzw1LElUc/export?format=txt");
  assert.ok(calls.slice(fetchAt).some((c) => c[0] === "allowed"), "allowlist checked after the download");
  // A sheet exports the tab shown.
  const s = docsFakes({ url: "https://docs.google.com/spreadsheets/d/1uuLbAjXtZuXK-N8nNT4FQzzi4bvgXtxI6BAdiIEDUHo/edit", tabUrl: "https://docs.google.com/spreadsheets/d/1uuLbAjXtZuXK-N8nNT4FQzzi4bvgXtxI6BAdiIEDUHo/edit#gid=9" });
  await s.router.route("get_page_text", {});
  assert.match(s.calls.find((c) => c[0] === "fetch")[1], /format=csv&gid=9$/);
});

test("get_page_text keeps the page text, with a note, when the file can't be downloaded; other sites never fetch", async () => {
  const d = docsFakes({ exported: null });
  const r = await d.router.route("get_page_text", {});
  assert.equal(r.text, "File\n\nEdit");
  assert.match(r.note, /could not be downloaded/);
  const other = docsFakes({ url: "https://www.example.com/a", tabUrl: "https://www.example.com/a" });
  const o = await other.router.route("get_page_text", {});
  assert.equal(o.note, undefined);
  assert.ok(!other.calls.some((c) => c[0] === "fetch"));
});

test("type with nothing focused is refused before any key; read_page on Docs says how to edit", async () => {
  const { calls, router } = docsFakes({ focus: { kind: "none", payment: false, nothing: true } });
  await assert.rejects(router.route("type", { text: "hello" }), { code: "no_element", message: /Click the field or editor first/ });
  assert.ok(!calls.some((c) => c[0] === "cdp.send"));
  // A focused element that is not a text field still types (insertText), as before.
  const b = docsFakes({ focus: { kind: "none", payment: false } });
  await b.router.route("type", { text: "a" });
  assert.ok(b.calls.some((c) => c[0] === "cdp.send" && c[1] === "Input.insertText"));
  const rp = await router.route("read_page", {});
  assert.match(rp.note, /Google Docs draws the document on a canvas/);
});

test("get_page_text drops the file's text when the tab moved to a blocked site during the download", async () => {
  const { router } = docsFakes({ blockAfterFetch: true, exported: "secret plans" });
  await assert.rejects(router.route("get_page_text", {}), { code: "not_allowed" });
});

test("get_page_text: a sheet's gid only from the page that answered; CSV; maxChars; a redirect to sign-in", async () => {
  const sheet = "https://docs.google.com/spreadsheets/d/1uuLbAjXtZuXK-N8nNT4FQzzi4bvgXtxI6BAdiIEDUHo/edit";
  // The tab has moved on to another file: its gid is not used.
  const moved = docsFakes({ url: sheet, tabUrl: "https://docs.google.com/spreadsheets/d/1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/edit#gid=5", type: "text/csv; charset=utf-8", exported: "a,b\n1,2" });
  const r = await moved.router.route("get_page_text", {});
  assert.equal(moved.calls.find((c) => c[0] === "fetch")[1], "https://docs.google.com/spreadsheets/d/1uuLbAjXtZuXK-N8nNT4FQzzi4bvgXtxI6BAdiIEDUHo/export?format=csv");
  assert.match(r.text, /^a,b\n1,2/);
  const long = docsFakes({ exported: "x".repeat(500) });
  const t = await long.router.route("get_page_text", { maxChars: 100 });
  assert.equal(t.truncated, true);
  assert.equal(t.text, "x".repeat(100) + "\n… (truncated)");
  const signin = docsFakes({ landed: "https://accounts.google.com/v3/signin/identifier" });
  assert.match((await signin.router.route("get_page_text", {})).note, /could not be downloaded/);
  // The account and a link-shared file's key go along.
  const keyed = docsFakes({ tabUrl: "https://docs.google.com/document/d/1jfHEhSnJs75Jd188KNDu0UE-SKfh7QSgtpYzw1LElUc/edit?authuser=2&resourcekey=0-abc_D" });
  await keyed.router.route("get_page_text", {});
  assert.match(keyed.calls.find((c) => c[0] === "fetch")[1], /format=txt&authuser=2&resourcekey=0-abc_D$/);
});

test("in a hidden field (Google Docs) a typed space goes in without a Space key; letters are keys", async () => {
  const { calls, router } = docsFakes({ focus: { kind: "other", payment: false, text: true, hidden: true } });
  await router.route("type", { text: "a b" });
  const sent = calls.filter((c) => c[0] === "cdp.send");
  assert.ok(!sent.some((c) => c[1] === "Input.dispatchKeyEvent" && c[2].code === "Space"), "no Space key event");
  assert.ok(sent.some((c) => c[1] === "Input.insertText" && c[2].text === " "));
  assert.ok(sent.some((c) => c[1] === "Input.dispatchKeyEvent" && c[2].type === "char" && c[2].text === "a"));
});
