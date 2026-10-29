import { test } from "node:test";
import assert from "node:assert/strict";

// cdp.click: a failure from the press on carries noFallback, so the router
// never DOM-clicks a control the page may already have taken.
let failOn = null;
const sent = [];
const pages = [];
globalThis.chrome = {
  debugger: {
    attach: async () => {},
    sendCommand: async (_t, method, p) => {
      if (method !== "Input.dispatchMouseEvent") return {};
      sent.push(p.type);
      if (p.type === failOn) throw new Error("Target closed");
    },
  },
};
const cdp = await import("../../../extension/background/cdp.js");
const { createRouter } = await import("../../../extension/background/router.js");
cdp._resetForTests();

test("a failed press or release is noFallback and says to check the page first", async () => {
  for (const step of ["mousePressed", "mouseReleased"]) {
    failOn = step;
    const e = await cdp.click({ tabId: 3, x: 5, y: 5 }).catch((x) => x);
    assert.equal(e.noFallback, true, step);
    assert.equal(e.code, "internal");
    assert.match(e.message, /may have reached the page.*check the page before clicking again/);
  }
});

test("a failed move pressed nothing and may fall back", async () => {
  failOn = "mouseMoved";
  const e = await cdp.click({ tabId: 3, x: 5, y: 5 }).catch((x) => x);
  assert.ok(e instanceof Error);
  assert.notEqual(e.noFallback, true);
});

// The real cdp.click under the router's unpaced ref click.
function router() {
  const chromeApi = {
    scripting: { executeScript: async () => [] },
    tabs: {
      get: async (id) => ({ id, windowId: 1 }),
      sendMessage: async (_tabId, msg) => {
        pages.push(msg.method);
        if (msg.method === "guard_ref") return { ok: true, result: { x: 10, y: 20, width: 100, height: 40 } };
        return { ok: true, result: { ok: true } };
      },
    },
  };
  const tabs = { resolveAllowedTab: async (id) => id ?? 7, assertPageAllowed: async () => {} };
  return createRouter({ chromeApi, tabs, cdp, follow: { to: async () => {}, own: (f) => f(), forget: () => {}, claim: () => {}, newTurn: () => {} } });
}

test("router: a release failure after the press never DOM-clicks; a move failure falls back to click_ref", async () => {
  pages.length = 0;
  failOn = "mouseReleased";
  await assert.rejects(router().route("click", { ref: "ref_4" }), (e) => e.code === "internal" && /may have reached the page/.test(e.message));
  assert.ok(!pages.includes("click_ref"), "no second click");

  pages.length = 0;
  failOn = "mouseMoved";
  assert.deepEqual(await router().route("click", { ref: "ref_4" }), { ok: true, via: "dom" });
  assert.ok(pages.includes("click_ref"));
});
