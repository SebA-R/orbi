import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { installChrome } from "./chrome-mock.mjs";
import {
  _barTiming, _resetForTests, assertInViewport, attach, click, detach, fitScale, isAttached, jpegSize, key, onDetach, onTabRemoved, parseKey, screenshot, scroll, type, viewport,
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
  // The clipped capture came back without a readable size: the plain one is used.
  assert.deepEqual(sent(), [
    ["Page.getLayoutMetrics", {}],
    ["Page.captureScreenshot", { format: "jpeg", quality: 70, clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 } }],
    ["Page.captureScreenshot", { format: "jpeg", quality: 70 }],
  ]);
});

test("a clip whose size cannot be read, or that fails, is not retried on every screenshot", async () => {
  await screenshot({ tabId });
  await screenshot({ tabId });
  const shots = () => sent().filter(([m]) => m === "Page.captureScreenshot");
  assert.equal(shots().length, 3, "one capture the second time");
  assert.equal(shots().filter(([, p]) => p.clip).length, 1);
  _resetForTests();
  c._capture = (p) => {
    if (p.clip) throw new Error("clip failed");
    return "BASE64JPEG";
  };
  await screenshot({ tabId });
  await screenshot({ tabId });
  assert.equal(shots().filter(([, p]) => p.clip).length, 2, "one more clip try, then none");
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

// Chrome's clip: a CSS-px rectangle rendered at clip.scale times the
// device pixel ratio.
const chromeClip = (dpr) => (p) => (p.clip ? fakeJpeg(Math.round(p.clip.width * p.clip.scale * dpr), Math.round(p.clip.height * p.clip.scale * dpr)) : fakeJpeg(1440 * dpr, 900 * dpr));

test("a 2x screen is captured straight at CSS size, so image pixels are click coordinates", async () => {
  // The offsite_aritzia recording: 1440x900 CSS px at device scale 2.
  c._viewport = { width: 1440, height: 900, dpr: 2, pageY: 1200 };
  c._capture = chromeClip(2);
  const r = await screenshot({ tabId });
  assert.deepEqual(jpegSize(r.data), { width: 1440, height: 900 });
  assert.deepEqual([r.width, r.height, r.scale], [1440, 900, 1]);
  // The visible part of the scrolled page, rendered at half the device scale.
  const shots = sent().filter(([m]) => m === "Page.captureScreenshot");
  assert.deepEqual(shots, [["Page.captureScreenshot", { format: "jpeg", quality: 70, clip: { x: 0, y: 1200, width: 1440, height: 900, scale: 0.5 } }]]);
  // A point read off the image is inside the viewport the click checks.
  const vp = await viewport(tabId);
  assert.doesNotThrow(() => assertInViewport(vp, 1086, 543));
});

test("a tab whose clip came back the wrong size skips it for a minute, then tries again", async () => {
  c._viewport = { width: 1440, height: 900, dpr: 2 };
  c._capture = (p) => (p.clip ? fakeJpeg(960, 600) : fakeJpeg(2880, 1800)); // zoom: the clip is off
  const clips = () => sent().filter(([m, p]) => m === "Page.captureScreenshot" && p.clip).length;
  await screenshot({ tabId });
  await screenshot({ tabId });
  assert.equal(clips(), 1, "skipped the second time");
  const realNow = Date.now;
  const t0 = realNow();
  Date.now = () => t0 + 61_000;
  try {
    await screenshot({ tabId });
  } finally {
    Date.now = realNow;
  }
  assert.equal(clips(), 2, "tried again after a minute");
});

test("a viewport too big for the model is shrunk to fit, with its scale", async () => {
  assert.equal(fitScale(1440, 900), 1);
  assert.equal(fitScale(2560, 1440), 1);
  c._viewport = { width: 3440, height: 1440, dpr: 1 };
  c._capture = chromeClip(1);
  const r = await screenshot({ tabId });
  const size = jpegSize(r.data);
  assert.ok(size.width <= 2576 && size.width * size.height <= 3_750_000, JSON.stringify(size));
  assert.deepEqual([r.width, r.height], [3440, 1440]);
  assert.ok(Math.abs(r.scale - size.width / 3440) < 0.001, `scale ${r.scale}`);
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

test("a concurrent first attach waits for the same debugging-bar settle", async () => {
  _resetForTests({ settle: true });
  Object.assign(_barTiming, { wait: 60, settle: 30, poll: 5 });
  let polls = 0;
  const send = c.debugger.sendCommand;
  c.debugger.sendCommand = async (t, m, p) => {
    if (m === "Page.getLayoutMetrics") c._viewport = { height: [900, 900, 880, 860, 844][Math.min(polls++, 4)] };
    return send(t, m, p);
  };
  let pollsAtB = -1;
  const a = attach(tabId);
  const b = attach(tabId).then((v) => ((pollsAtB = polls), v));
  assert.deepEqual(await Promise.all([a, b]), [true, true], "both hear the viewport moved");
  assert.equal(c._calls.filter((x) => x[0] === "attach").length, 1);
  assert.ok(pollsAtB >= 5, "the second caller did not return before the bar settled");
  assert.equal(await attach(tabId), false, "attached and settled: nothing to wait for");
});

test("a detach during an attach in flight waits for it, so the tab is not left attached", async () => {
  _resetForTests({ settle: true });
  Object.assign(_barTiming, { wait: 30, settle: 30, poll: 5 });
  const a = attach(tabId);
  await detach(tabId);
  await a;
  assert.equal(isAttached(tabId), false);
  assert.equal(c._attached.has(tabId), false);
});

test("a detach during a send's attach wins: the send fails and does not attach again", async () => {
  _resetForTests({ settle: true });
  Object.assign(_barTiming, { wait: 30, settle: 30, poll: 5 });
  const s = type({ tabId, text: "x" });
  await detach(tabId);
  await assert.rejects(s, /detached/);
  assert.equal(isAttached(tabId), false);
  assert.equal(c._attached.has(tabId), false);
  assert.equal(c._calls.filter((x) => x[0] === "attach").length, 1, "no re-attach after the detach");
});

test("a fresh attach with no bar (--silent-debugger-extension-api) answers false", async () => {
  _resetForTests({ settle: true });
  Object.assign(_barTiming, { wait: 30, settle: 30, poll: 5 });
  assert.equal(await attach(tabId), false);
});
