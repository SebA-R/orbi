import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { installChrome } from "./chrome-mock.mjs";
import {
  _barTiming, _resetForTests, assertInViewport, attach, click, isAttached, jpegSize, key, onDetach, onTabRemoved, parseKey, screenshot, scroll, type, viewport,
} from "../../background/cdp.js";
import { ERR } from "../../lib/protocol.js";

let c;
let tabId;
beforeEach(async () => {
  _resetForTests();
  c = installChrome();
  tabId = (await c.tabs.create({})).id;
});

const sent = () => c._calls.filter((x) => x[0] === "send").map(([, , m, p]) => [m, p]);

test("attaches lazily once with protocol 1.3", async () => {
  assert.equal(isAttached(tabId), false);
  await type({ tabId, text: "hi" });
  await type({ tabId, text: "there" });
  assert.deepEqual(c._calls.filter((x) => x[0] === "attach"), [["attach", tabId, "1.3"]]);
  assert.equal(isAttached(tabId), true);
});

test("click sends moved, pressed, released with the left button", async () => {
  await click({ tabId, x: 10.5, y: 20 });
  const ev = sent();
  assert.deepEqual(ev.map(([m, p]) => [m, p.type]), [
    ["Input.dispatchMouseEvent", "mouseMoved"],
    ["Input.dispatchMouseEvent", "mousePressed"],
    ["Input.dispatchMouseEvent", "mouseReleased"],
  ]);
  assert.equal(ev[1][1].button, "left");
  assert.equal(ev[1][1].clickCount, 1);
  assert.equal(ev[1][1].x, 10.5);
  assert.equal(ev[2][1].y, 20);
});

test("click validates coordinates and tab id", async () => {
  await assert.rejects(click({ tabId, x: "a", y: 1 }), (e) => e.code === ERR.BAD_REQUEST);
  await assert.rejects(click({ tabId, x: 1 }), (e) => e.code === ERR.BAD_REQUEST);
  await assert.rejects(click({ x: 1, y: 1 }), (e) => e.code === ERR.BAD_REQUEST);
  assert.equal(sent().length, 0);
});

test("type uses Input.insertText", async () => {
  await type({ tabId, text: "red shoes" });
  assert.deepEqual(sent(), [["Input.insertText", { text: "red shoes" }]]);
  await assert.rejects(type({ tabId, text: 5 }), (e) => e.code === ERR.BAD_REQUEST);
});

test("key Enter sends keyDown with text then keyUp", async () => {
  await key({ tabId, key: "Enter" });
  const ev = sent();
  assert.equal(ev[0][1].type, "keyDown");
  assert.equal(ev[0][1].key, "Enter");
  assert.equal(ev[0][1].windowsVirtualKeyCode, 13);
  assert.equal(ev[0][1].text, "\r");
  assert.equal(ev[1][1].type, "keyUp");
  assert.equal("text" in ev[1][1], false);
});

test("non-text keys use rawKeyDown", async () => {
  for (const k of ["Tab", "Escape", "ArrowDown"]) await key({ tabId, key: k });
  assert.deepEqual(sent().map(([, p]) => `${p.type}:${p.key}`), [
    "rawKeyDown:Tab", "keyUp:Tab", "rawKeyDown:Escape", "keyUp:Escape", "rawKeyDown:ArrowDown", "keyUp:ArrowDown",
  ]);
});

test("parseKey handles modifiers and characters", () => {
  assert.deepEqual(parseKey("Shift+Tab"), { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: undefined, modifiers: 8 });
  const ctrlA = parseKey("Ctrl+a");
  assert.equal(ctrlA.modifiers, 2);
  assert.equal(ctrlA.code, "KeyA");
  assert.equal(ctrlA.text, undefined);
  assert.equal(parseKey("a").text, "a");
  assert.equal(parseKey("Shift+a").text, "A");
  assert.equal(parseKey("5").code, "Digit5");
  assert.equal(parseKey("+").key, "+");
  assert.throws(() => parseKey("Hyper+x"), (e) => e.code === ERR.BAD_REQUEST);
  assert.throws(() => parseKey("NotAKey"), (e) => e.code === ERR.BAD_REQUEST);
  assert.throws(() => parseKey(""), (e) => e.code === ERR.BAD_REQUEST);
});

test("scroll sends a mouseWheel event", async () => {
  await scroll({ tabId, x: 100, y: 200, dy: 300 });
  assert.deepEqual(sent(), [["Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 200, deltaX: 0, deltaY: 300 }]]);
});

test("screenshot captures jpeg quality 70 and reports its CSS size", async () => {
  const r = await screenshot({ tabId });
  assert.deepEqual(r, { data: "BASE64JPEG", mimeType: "image/jpeg", width: 1440, height: 900, scale: 1 });
  assert.deepEqual(sent(), [["Page.getLayoutMetrics", {}], ["Page.captureScreenshot", { format: "jpeg", quality: 70 }]]);
});

// SOI, then a SOF0 frame header for w x h.
const fakeJpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64");

test("jpegSize reads the frame header", () => {
  assert.deepEqual(jpegSize(fakeJpeg(2880, 1800)), { width: 2880, height: 1800 });
});

test("a 2x capture is reported in CSS px with its scale when it cannot be resized", async () => {
  c._viewport = { width: 1440, height: 900, dpr: 2 };
  c._shot = fakeJpeg(2880, 1800);
  assert.deepEqual(await viewport(tabId), { width: 1440, height: 900, dpr: 2 });
  // No OffscreenCanvas in node: the image stays 2880 wide, scale 2.
  const r = await screenshot({ tabId });
  assert.deepEqual([r.width, r.height, r.scale], [1440, 900, 2]);
  // Chrome already captured at CSS size: nothing to scale.
  c._shot = fakeJpeg(1440, 900);
  const r1 = await screenshot({ tabId });
  assert.deepEqual([r1.width, r1.height, r1.scale, r1.data], [1440, 900, 1, c._shot]);
});

test("assertInViewport refuses points past the edge with a clear message", () => {
  const vp = { width: 1440, height: 900, dpr: 2 };
  assert.doesNotThrow(() => assertInViewport(vp, 0, 0));
  assert.doesNotThrow(() => assertInViewport(vp, 1440, 900));
  for (const [x, y] of [[1878, 574], [1538, 1193], [-1, 10], [10, 901]]) {
    assert.throws(() => assertInViewport(vp, x, y), (e) => e.code === ERR.BAD_REQUEST && /outside the 1440x900 viewport/.test(e.message) && /CSS pixels/.test(e.message));
  }
});

test("re-attaches after an external detach", async () => {
  await type({ tabId, text: "a" });
  c._attached.delete(tabId); // Chrome detached without telling us
  await type({ tabId, text: "b" });
  assert.equal(c._calls.filter((x) => x[0] === "attach").length, 2);
  assert.deepEqual(sent().map(([, p]) => p.text), ["a", "b"]);
});

test("onDetach and onTabRemoved forget the session", async () => {
  await attach(tabId);
  onDetach({ tabId });
  assert.equal(isAttached(tabId), false);
  await attach(tabId).catch(() => {}); // mock still thinks attached -> "already attached" is reused
  assert.equal(isAttached(tabId), true);
  onTabRemoved(tabId);
  assert.equal(isAttached(tabId), false);
});

test("attach to a missing tab is NO_TAB", async () => {
  await assert.rejects(attach(9999), (e) => e.code === ERR.NO_TAB);
});

test("parseKey refuses control characters (\\r would press Enter)", () => {
  for (const k of ["\r", "\n", "\t", "Shift+\r", "a\u0000", "\u007f", " "]) {
    assert.throws(() => parseKey(k), { code: "bad_request" }, JSON.stringify(k));
  }
  assert.equal(parseKey("Shift+ ").key, " ");
  assert.equal(parseKey("Enter").key, "Enter");
});

test("a fresh attach waits for the debugging bar and says the viewport moved", async () => {
  _resetForTests({ settle: true });
  Object.assign(_barTiming, { wait: 60, settle: 30, poll: 5 });
  // The bar slides in a few polls after the attach: 900 down to 844.
  let polls = 0;
  const send = c.debugger.sendCommand;
  c.debugger.sendCommand = async (t, m, p) => {
    if (m === "Page.getLayoutMetrics") c._viewport = { height: [900, 900, 880, 860, 844][Math.min(polls++, 4)] };
    return send(t, m, p);
  };
  assert.equal(await attach(tabId), true);
  assert.equal((await viewport(tabId)).height, 844, "settled at the new height");
  assert.equal(await attach(tabId), false, "already attached");
});

test("a fresh attach with no bar (--silent-debugger-extension-api) answers false", async () => {
  _resetForTests({ settle: true });
  Object.assign(_barTiming, { wait: 30, settle: 30, poll: 5 });
  assert.equal(await attach(tabId), false);
});
