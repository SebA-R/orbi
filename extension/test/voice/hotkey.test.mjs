import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "..", "content", "hotkey.js"), "utf8");

function load() {
  const hooks = {};
  vm.runInNewContext(SRC, { __clearcartHotkeyTest: hooks, Promise });
  return hooks;
}

function key(code, mods = {}, extra = {}) {
  const e = {
    code, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, repeat: false,
    ...mods, ...extra, prevented: false, stopped: false,
  };
  e.preventDefault = () => { e.prevented = true; };
  e.stopPropagation = () => { e.stopped = true; };
  return e;
}

function detector(hotkey = "Alt+Space") {
  const { createHoldDetector } = load();
  const sent = [];
  const extras = [];
  const timers = [];
  const taps = [];
  const d = createHoldDetector({
    hotkey,
    send: (t, extra) => { sent.push(t); extras.push(extra); },
    onTap: (e) => taps.push(e.code),
    setTimer: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimer: (i) => { timers[i].cleared = true; },
  });
  const fire = () => { for (const t of timers) if (!t.cleared) { t.cleared = true; t.fn(); } };
  return { d, sent, extras, timers, taps, fire };
}

test("Alt+Space hold sends one start and one stop", () => {
  const { d, sent } = detector("Alt+Space");
  const down = key("Space", { altKey: true });
  d.onKeyDown(down);
  assert.equal(down.prevented, true);
  assert.deepEqual(sent, ["ptt.start"]);
  const up = key("Space", { altKey: true });
  d.onKeyUp(up);
  assert.equal(up.prevented, true);
  assert.deepEqual(sent, ["ptt.start", "ptt.stop"]);
  assert.equal(d.held, false);
});

test("key repeat is swallowed but not re-sent", () => {
  const { d, sent } = detector();
  d.onKeyDown(key("Space", { altKey: true }));
  for (let i = 0; i < 5; i++) {
    const rep = key("Space", { altKey: true }, { repeat: true });
    d.onKeyDown(rep);
    assert.equal(rep.prevented, true);
  }
  assert.deepEqual(sent, ["ptt.start"]);
});

test("a second keydown without repeat flag while held does not restart", () => {
  const { d, sent } = detector();
  d.onKeyDown(key("Space", { altKey: true }));
  d.onKeyDown(key("Space", { altKey: true }));
  assert.deepEqual(sent, ["ptt.start"]);
});

test("releasing the modifier first also stops, and the later Space keyup is ignored", () => {
  const { d, sent } = detector();
  d.onKeyDown(key("Space", { altKey: true }));
  const altUp = key("AltLeft");
  d.onKeyUp(altUp);
  assert.equal(altUp.prevented, false, "modifier keyup keeps its default");
  d.onKeyUp(key("Space"));
  assert.deepEqual(sent, ["ptt.start", "ptt.stop"]);
});

test("other keys are never prevented", () => {
  const { d, sent } = detector();
  for (const e of [key("Space"), key("KeyA", { altKey: true }), key("Space", { altKey: true, metaKey: true }), key("Space", { ctrlKey: true, altKey: true })]) {
    d.onKeyDown(e);
    d.onKeyUp(e);
    assert.equal(e.prevented, false, e.code);
  }
  assert.deepEqual(sent, []);
});

test("cancel (blur) stops a held key once", () => {
  const { d, sent } = detector();
  d.cancel();
  d.onKeyDown(key("Space", { altKey: true }));
  d.cancel();
  d.cancel();
  assert.deepEqual(sent, ["ptt.start", "ptt.stop"]);
});

test("configurable hotkeys: Ctrl+Shift+Space and F9", () => {
  const { d, sent } = detector("Ctrl+Shift+Space");
  d.onKeyDown(key("Space", { altKey: true }));
  assert.deepEqual(sent, []);
  d.onKeyDown(key("Space", { ctrlKey: true, shiftKey: true }));
  d.onKeyUp(key("ShiftRight", { ctrlKey: true }));
  assert.deepEqual(sent, ["ptt.start", "ptt.stop"]);
  d.setHotkey("F9");
  d.onKeyDown(key("F9"));
  d.onKeyUp(key("F9"));
  assert.deepEqual(sent, ["ptt.start", "ptt.stop", "ptt.start", "ptt.stop"]);
});

test("switching hotkey mid-hold stops first; unknown names fall back to Space", () => {
  const { d, sent } = detector("Alt+Space");
  d.onKeyDown(key("Space", { altKey: true }));
  d.setHotkey("bogus");
  assert.deepEqual(sent, ["ptt.start", "ptt.stop"]);
  d.onKeyDown(key("Space", { altKey: true }));
  assert.deepEqual(sent, ["ptt.start", "ptt.stop"]);
  d.onKeyDown(key("Space"));
  assert.deepEqual(sent, ["ptt.start", "ptt.stop", "ptt.start"]);
});

test("install wires window listeners, sends runtime messages, follows storage changes", async () => {
  const { install } = load();
  const listeners = {};
  const win = { addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); } };
  const doc = { visibilityState: "visible", addEventListener: (t, fn) => { (listeners[`doc:${t}`] ||= []).push(fn); } };
  const messages = [];
  let onChanged;
  const chromeApi = {
    runtime: { sendMessage: (m) => { messages.push(m); return Promise.resolve(); } },
    storage: {
      local: { get: async () => ({ hotkey: "F9" }) },
      onChanged: { addListener: (fn) => { onChanged = fn; } },
    },
  };
  const d = install({ win, doc, chromeApi });
  assert.equal(install({ win, doc, chromeApi }), d, "idempotent");
  await new Promise((r) => setTimeout(r, 0));
  const fire = (t, e) => listeners[t].forEach((fn) => fn(e));
  fire("keydown", key("F9"));
  fire("keyup", key("F9"));
  onChanged({ hotkey: { newValue: "Alt+Space" } }, "local");
  fire("keydown", key("Space", { altKey: true }));
  doc.visibilityState = "hidden";
  listeners["doc:visibilitychange"].forEach((fn) => fn());
  assert.deepEqual(messages.map((m) => m.type), ["ptt.start", "ptt.stop", "ptt.start", "ptt.stop"]);
});

test("plain Space starts recording silently on touch and confirms once held", () => {
  const { d, sent, extras, timers, taps, fire } = detector("Space");
  const down = key("Space", {}, { target: { tagName: "DIV" } });
  d.onKeyDown(down);
  assert.equal(down.prevented, true);
  assert.deepEqual(sent, ["ptt.start"]);
  assert.equal(JSON.stringify(extras[0]), "{\"silent\":true}");
  assert.equal(timers[0].ms, 200);
  fire();
  assert.deepEqual(sent, ["ptt.start", "ptt.confirm"]);
  d.onKeyUp(key("Space"));
  assert.deepEqual(sent, ["ptt.start", "ptt.confirm", "ptt.stop"]);
  assert.deepEqual(taps, []);
});

test("a quick Space tap cancels the recording and replays the tap", () => {
  const { d, sent, timers, taps, fire } = detector("Space");
  d.onKeyDown(key("Space", {}, { target: { tagName: "BUTTON" } }));
  d.onKeyUp(key("Space"));
  assert.deepEqual(sent, ["ptt.start", "ptt.cancel"]);
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(taps, ["Space"]);
  fire(); // a late timer must not confirm a finished tap
  assert.deepEqual(sent, ["ptt.start", "ptt.cancel"]);
});

test("plain Space types normally in text fields but modifier hotkeys still talk", () => {
  const { d, sent } = detector("Space");
  for (const target of [
    { tagName: "INPUT", type: "text" }, { tagName: "INPUT", type: "search" }, { tagName: "TEXTAREA" },
    { tagName: "DIV", isContentEditable: true }, { tagName: "SELECT" },
  ]) {
    const e = key("Space", {}, { target });
    d.onKeyDown(e);
    assert.equal(e.prevented, false, target.tagName);
  }
  assert.deepEqual(sent, []);
  const checkbox = key("Space", {}, { target: { tagName: "INPUT", type: "checkbox" } });
  d.onKeyDown(checkbox);
  assert.equal(checkbox.prevented, true);
  const alt = detector("Alt+Space");
  alt.d.onKeyDown(key("Space", { altKey: true }, { target: { tagName: "TEXTAREA" } }));
  assert.deepEqual(alt.sent, ["ptt.start"]);
  assert.equal(alt.extras[0], undefined);
});

test("leaving the page mid-hold cancels before confirm and stops after it", () => {
  const a = detector("Space");
  a.d.onKeyDown(key("Space"));
  a.d.cancel();
  assert.deepEqual(a.sent, ["ptt.start", "ptt.cancel"]);
  assert.deepEqual(a.taps, []);
  const b = detector("Space");
  b.d.onKeyDown(key("Space"));
  b.fire();
  b.d.cancel();
  assert.deepEqual(b.sent, ["ptt.start", "ptt.confirm", "ptt.stop"]);
});

test("isPressable and isTextEntry classify focus targets", () => {
  const { isPressable, isTextEntry } = load();
  const role = (r) => ({ tagName: "DIV", getAttribute: (n) => (n === "role" ? r : null) });
  assert.equal(isPressable({ tagName: "BUTTON" }), true);
  assert.equal(isPressable({ tagName: "INPUT", type: "checkbox" }), true);
  assert.equal(isPressable(role("button")), true);
  assert.equal(isPressable(role("region")), false);
  assert.equal(isPressable({ tagName: "A" }), false);
  assert.equal(isTextEntry({ tagName: "INPUT" }), true);
  assert.equal(isTextEntry({ tagName: "INPUT", type: "radio" }), false);
  assert.equal(isTextEntry(null), false);
});
