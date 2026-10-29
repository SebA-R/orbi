import { test } from "node:test";
import assert from "node:assert/strict";

// cdp.click: a failure after the press went down carries noFallback, so the
// router never DOM-clicks a control the page may already have taken.
let failOn = null;
const sent = [];
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
cdp._resetForTests();

test("a failed release (the press already went down) is noFallback", async () => {
  failOn = "mouseReleased";
  const e = await cdp.click({ tabId: 3, x: 5, y: 5 }).catch((x) => x);
  assert.equal(e.noFallback, true);
  assert.equal(e.code, "internal");
});

test("a failed move or press may fall back", async () => {
  for (const step of ["mouseMoved", "mousePressed"]) {
    failOn = step;
    const e = await cdp.click({ tabId: 3, x: 5, y: 5 }).catch((x) => x);
    assert.ok(e instanceof Error, step);
    assert.notEqual(e.noFallback, true, step);
  }
});
