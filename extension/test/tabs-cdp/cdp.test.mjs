import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { installChrome } from "./chrome-mock.mjs";
import {
  _resetForTests, attach, click, isAttached, key, onDetach, onTabRemoved, parseKey, screenshot, scroll, type,
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

test("screenshot captures jpeg quality 70", async () => {
  const r = await screenshot({ tabId });
  assert.deepEqual(r, { data: "BASE64JPEG", mimeType: "image/jpeg" });
  assert.deepEqual(sent(), [["Page.captureScreenshot", { format: "jpeg", quality: 70 }]]);
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
