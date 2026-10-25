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

function detector(hotkey = "Alt+Space", opts = {}) {
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
    ...opts,
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
  const { d, sent } = detector("Ctrl+Shift+Space");
  d.onKeyDown(key("Space", { ctrlKey: true, shiftKey: true }));
  d.setHotkey("bogus");
  assert.deepEqual(sent, ["ptt.start", "ptt.stop"]);
  d.onKeyDown(key("Space", { ctrlKey: true, shiftKey: true }));
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

const field = { tagName: "INPUT", type: "search" };

test("hold Space then release stops: nothing keeps listening", () => {
  const { d, sent, fire } = detector("Space");
  d.onKeyDown(key("Space", {}, { target: { tagName: "DIV" } }));
  fire();
  d.onKeyUp(key("Space"));
  assert.deepEqual(sent, ["ptt.start", "ptt.confirm", "ptt.stop"]);
  assert.equal(d.held, false);
  assert.equal(d.latched, false);
  // A later stray keyup or blur sends nothing more.
  d.onKeyUp(key("Space"));
  d.cancel();
  assert.deepEqual(sent, ["ptt.start", "ptt.confirm", "ptt.stop"]);
});

test("Option+Space latches; the next Space sends without typing a space", () => {
  const { d, sent, extras, taps } = detector("Space");
  const down = key("Space", { altKey: true }, { target: field });
  d.onKeyDown(down);
  assert.equal(down.prevented, true);
  assert.deepEqual(sent, ["ptt.start"]);
  assert.deepEqual({ ...extras[0] }, { latch: true });
  const up = key("Space", { altKey: true });
  d.onKeyUp(up);
  d.onKeyUp(key("AltLeft"));
  assert.equal(up.prevented, true);
  assert.deepEqual(sent, ["ptt.start"], "letting go keeps listening");
  assert.equal(d.latched, true);
  const space = key("Space", {}, { target: { tagName: "DIV" } });
  d.onKeyDown(space);
  assert.equal(space.prevented, true, "no space typed, no scroll");
  const spaceUp = key("Space");
  d.onKeyUp(spaceUp);
  assert.equal(spaceUp.prevented, true);
  assert.deepEqual(sent, ["ptt.start", "ptt.stop"], "no new hold started");
  assert.deepEqual(taps, []);
  assert.equal(d.latched, false);
});

test("Space during a latch inside a text field ends the latch", () => {
  const { d, sent } = detector("Space");
  d.onKeyDown(key("Space", { altKey: true }, { target: field }));
  d.onKeyUp(key("Space", { altKey: true }));
  const space = key("Space", {}, { target: field });
  d.onKeyDown(space);
  assert.equal(space.prevented, true);
  d.onKeyUp(key("Space"));
  assert.deepEqual(sent, ["ptt.start", "ptt.stop"]);
  // Afterwards plain Space types in the field again.
  const after = key("Space", {}, { target: field });
  d.onKeyDown(after);
  assert.equal(after.prevented, false);
});

test("Option+Space a second time also ends the latch; blur does not", () => {
  const { d, sent } = detector("Space");
  d.onKeyDown(key("Space", { altKey: true }));
  d.onKeyUp(key("Space", { altKey: true }));
  d.cancel(); // window blur: hands-free keeps listening
  assert.deepEqual(sent, ["ptt.start"]);
  d.onKeyDown(key("Space", { altKey: true }));
  d.onKeyDown(key("Space", { altKey: true }, { repeat: true }));
  d.onKeyUp(key("Space", { altKey: true }));
  assert.deepEqual(sent, ["ptt.start", "ptt.stop"]);
});

test("a latch reported by VOICE_STATE (another frame, the toggle command) ends on Space", () => {
  const { d, sent } = detector("Space");
  d.setVoiceState("listening", true);
  d.onKeyDown(key("Space", {}, { target: field }));
  assert.deepEqual(sent, ["ptt.stop"]);
  d.setVoiceState("listening", true);
  d.setVoiceState("thinking"); // ended elsewhere (timeout): Space is Space again
  const e = key("Space", {}, { target: field });
  d.onKeyDown(e);
  assert.equal(e.prevented, false);
});

test("other talk keys stay hold-to-talk and Option+Space does nothing with F9", () => {
  const alt = detector("Alt+Space");
  alt.d.onKeyDown(key("Space", { altKey: true }, { target: field }));
  alt.d.onKeyUp(key("AltLeft"));
  assert.deepEqual(alt.sent, ["ptt.start", "ptt.stop"]);
  const f9 = detector("F9");
  f9.d.onKeyDown(key("Space", { altKey: true }));
  assert.deepEqual(f9.sent, []);
});

function tap(d, target = { tagName: "DIV" }) {
  const down = key("Space", {}, { target });
  const up = key("Space");
  d.onKeyDown(down);
  d.onKeyUp(up);
  return { down, up };
}

test("double-tap Space while speaking hushes, and both taps are consumed", () => {
  const { d, sent, taps, timers } = detector("Space");
  d.setVoiceState("speaking");
  const one = tap(d);
  assert.equal(one.down.prevented, true);
  assert.deepEqual(sent, ["ptt.start"], "first tap keeps the speech ducked, no cancel yet");
  assert.equal(timers.at(-1).ms, 350);
  const two = tap(d);
  assert.equal(two.down.prevented, true);
  assert.deepEqual(sent, ["ptt.start", "ptt.hush"], "one silent start, then hush: no restore and fade again");
  assert.deepEqual(taps, [], "no scroll or button press");
  assert.equal(timers.filter((t) => !t.cleared && t.ms === 350).length, 0);
});

test("a single tap while speaking brings the speech back after the window", () => {
  const { d, sent, taps, fire } = detector("Space");
  d.setVoiceState("speaking");
  tap(d);
  fire();
  assert.deepEqual(sent, ["ptt.start", "ptt.cancel"]);
  assert.deepEqual(taps, []);
});

test("double-tap Space while idle passes through untouched", () => {
  const { d, sent, taps } = detector("Space");
  tap(d);
  tap(d);
  assert.deepEqual(sent, ["ptt.start", "ptt.cancel", "ptt.start", "ptt.cancel"]);
  assert.deepEqual(taps, ["Space", "Space"], "each tap does what Space does");
  // And in a text field nothing is touched at all.
  const t = detector("Space");
  t.d.setVoiceState("idle");
  const a = tap(t.d, field);
  const b = tap(t.d, field);
  assert.equal(a.down.prevented || b.down.prevented, false);
  assert.deepEqual(t.sent, []);
});

test("a tap then a hold while speaking still barges in", () => {
  const { d, sent, timers } = detector("Space");
  d.setVoiceState("speaking");
  tap(d);
  d.onKeyDown(key("Space", {}, { target: { tagName: "DIV" } }));
  timers.at(-1).fn(); // held past the confirm time
  d.onKeyUp(key("Space"));
  assert.deepEqual(sent, ["ptt.start", "ptt.confirm", "ptt.stop"]);
});

test("hiding the tab forgets the voice state and the latch", () => {
  const { d, sent } = detector("Space");
  d.setVoiceState("listening", true);
  d.forgetVoiceState();
  tap(d);
  assert.deepEqual(sent, ["ptt.start", "ptt.cancel"]);
});

test("install learns the voice state from runtime messages and a hidden tab forgets it", () => {
  const { install } = load();
  const listeners = {};
  let onMsg;
  const win = { addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); } };
  const doc = { visibilityState: "visible", activeElement: null, addEventListener: (t, fn) => { (listeners[`doc:${t}`] ||= []).push(fn); } };
  const messages = [];
  const chromeApi = { runtime: { sendMessage: (m) => { messages.push(m.type); }, onMessage: { addListener: (fn) => { onMsg = fn; } } } };
  const d = install({ win, doc, chromeApi });
  onMsg({ type: "voice.state", state: "listening", latched: true });
  assert.equal(d.latched, true);
  onMsg({ type: "voice.error", message: "stt hiccup" });
  assert.equal(d.latched, true, "an STT error alone doesn't end the latch");
  doc.visibilityState = "hidden";
  listeners["doc:visibilitychange"].forEach((fn) => fn());
  assert.equal(d.latched, false);
  assert.deepEqual(messages, []);
  doc.visibilityState = "visible";
  listeners["doc:visibilitychange"].forEach((fn) => fn());
  assert.deepEqual(messages, ["voice.state.query"], "visible again: ask for the state");
});

test("an input inside an open or closed shadow root counts as typing", () => {
  const { createHoldDetector, isTextEntry } = load();
  const input = { tagName: "INPUT", type: "text" };
  const openHost = { tagName: "SL-INPUT", shadowRoot: { activeElement: input } };
  const closedHost = { tagName: "MY-FIELD", shadowRoot: null };
  const dom = { openOrClosedShadowRoot: (el) => (el === closedHost ? { activeElement: input } : null) };
  const sent = [];
  const d = createHoldDetector({ hotkey: "Space", send: (t) => sent.push(t), dom, setTimer: () => 0, clearTimer: () => {} });
  // Open root: composedPath()[0] is the inner input; the host alone also resolves.
  for (const e of [
    key("Space", {}, { target: openHost, composedPath: () => [input, openHost] }),
    key("Space", {}, { target: openHost }),
    key("Space", {}, { target: closedHost, composedPath: () => [closedHost] }),
  ]) {
    d.onKeyDown(e);
    assert.equal(e.prevented, false);
  }
  assert.deepEqual(sent, []);
  // An opaque custom element: typing only if it looks like a field.
  assert.equal(isTextEntry({ tagName: "VAADIN-TEXT-FIELD" }), true);
  assert.equal(isTextEntry({ tagName: "DIV", getAttribute: (n) => (n === "role" ? "textbox" : null) }), true);
  assert.equal(isTextEntry({ tagName: "X-CARD", getAttribute: (n) => (n === "contenteditable" ? "" : null) }), true);
  assert.equal(isTextEntry({ tagName: "YT-ICON-BUTTON" }), false);
  assert.equal(isTextEntry({ tagName: "APP-SEARCH-RESULTS" }), false);
  assert.equal(isTextEntry({ tagName: "MY-FILE-INPUT" }), false);
  const btn = key("Space", {}, { target: { tagName: "X-CARD", shadowRoot: { activeElement: { tagName: "BUTTON" } } } });
  d.onKeyDown(btn);
  assert.equal(btn.prevented, true);
  assert.deepEqual(sent, ["ptt.start"]);
});

test("a hold in an iframe ends on a release in the top frame, never a latch", () => {
  const sent = [];
  const make = () => {
    const timers = [];
    const d = load().createHoldDetector({
      hotkey: "Space", send: (t) => sent.push(t),
      setTimer: (fn) => { timers.push(fn); return timers.length - 1; }, clearTimer: () => {},
    });
    return { d, fire: () => timers.splice(0).forEach((fn) => fn()) };
  };
  const frame = make();
  const top = make();
  frame.d.onKeyDown(key("Space", {}, { target: { tagName: "DIV" } }));
  frame.fire();
  // The worker broadcasts the state to every frame of the tab.
  frame.d.setVoiceState("listening", false);
  top.d.setVoiceState("listening", false);
  const up = key("Space");
  top.d.onKeyUp(up);
  assert.equal(up.prevented, true);
  assert.deepEqual(sent, ["ptt.start", "ptt.confirm", "ptt.stop"]);
  top.d.onKeyUp(key("Space")); // only once
  assert.equal(sent.length, 3);
  // Not for a keyup in a text field, nor after this frame lost focus.
  top.d.setVoiceState("listening", false);
  top.d.onKeyUp(key("Space", {}, { target: { tagName: "TEXTAREA" } }));
  top.d.cancel();
  top.d.onKeyUp(key("Space"));
  assert.equal(sent.length, 3);
  // The frame's blur (focus left it) also ends its side; a second stop is a no-op in the controller.
  frame.d.cancel();
  assert.equal(frame.d.held, false);
  // A latch is hands-free: a stray keyup elsewhere leaves it on.
  sent.length = 0;
  top.d.setVoiceState("listening", true);
  top.d.onKeyUp(key("Space"));
  assert.deepEqual(sent, []);
});

test("IME composition never triggers talk or ends a latch", () => {
  const { d, sent } = detector("Space");
  const composing = key("Space", {}, { target: { tagName: "DIV" }, isComposing: true });
  d.onKeyDown(composing);
  const ime = key("Space", {}, { target: { tagName: "DIV" }, keyCode: 229 });
  d.onKeyDown(ime);
  assert.equal(composing.prevented, false);
  assert.equal(ime.prevented, false);
  assert.deepEqual(sent, []);
  d.onKeyDown(key("Space", { altKey: true }));
  assert.equal(d.latched, true);
  d.onKeyDown(key("Space", {}, { isComposing: true }));
  assert.equal(d.latched, true);
  assert.deepEqual(sent, ["ptt.start"]);
});

test("synthetic key events from the page never talk", () => {
  const { install } = load();
  const listeners = {};
  const win = { addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); } };
  const doc = { visibilityState: "visible", addEventListener: () => {} };
  const messages = [];
  install({ win, doc, chromeApi: { runtime: { sendMessage: (m) => { messages.push(m); } } } });
  const fire = (t, e) => listeners[t].forEach((fn) => fn(e));
  fire("keydown", key("Space", { altKey: true }, { isTrusted: false }));
  fire("keyup", key("Space", { altKey: true }, { isTrusted: false }));
  assert.deepEqual(messages, []);
});

test("a frame rewritten with document.open() gets its listeners back", () => {
  const { install } = load();
  // Like the DOM: adding the same listener twice keeps one.
  let listeners = {};
  const add = (k, fn) => { (listeners[k] ||= new Set()).add(fn); };
  let rewritten;
  const win = {
    addEventListener: (t, fn) => add(t, fn),
    MutationObserver: class { constructor(fn) { rewritten = fn; } observe() {} disconnect() {} },
  };
  const doc = { visibilityState: "visible", addEventListener: (t, fn) => add(`doc:${t}`, fn) };
  const messages = [];
  install({ win, doc, chromeApi: { runtime: { sendMessage: (m) => { messages.push(m); } } } });
  const fire = (t, e) => (listeners[t] || []).forEach((fn) => fn(e));
  // document.open() erases every listener and replaces the document's children.
  listeners = {};
  fire("keydown", key("Space", { altKey: true }));
  assert.deepEqual(messages, []);
  rewritten();
  rewritten();
  assert.equal(listeners.keydown.size, 1);
  fire("keydown", key("Space", { altKey: true }));
  assert.deepEqual(messages.map((m) => m.type), ["ptt.start"]);
});

// Google Docs' caret lives in a hidden contenteditable in a frame 1px tall
// at top -10000 (.docs-texteventtarget-iframe).
const DOCS_BOX = { tagName: "DIV", isContentEditable: true, getAttribute: () => null };

test("Space in a hidden text field types, and a hold talks with nothing recorded before", () => {
  const { d, sent, extras, timers, fire } = detector("Space", { isHidden: () => true });
  const down = key("Space", {}, { target: DOCS_BOX });
  d.onKeyDown(down);
  assert.equal(down.prevented, false, "the space is typed");
  assert.deepEqual(sent, [], "no silent start while typing");
  assert.equal(timers[0].ms, load().HIDDEN_CONFIRM_MS, "longer than a resting thumb");
  // The key's first auto-repeat: a finger is holding it.
  const first = key("Space", {}, { target: DOCS_BOX, repeat: true });
  d.onKeyDown(first);
  assert.equal(first.prevented, true);
  fire();
  assert.deepEqual(sent, ["ptt.start"]);
  assert.equal(extras[0], undefined, "a confirmed start, with the listen sound");
  const rep = key("Space", {}, { target: DOCS_BOX, repeat: true });
  d.onKeyDown(rep);
  assert.equal(rep.prevented, true, "no run of spaces while talking");
  const up = key("Space", {}, { target: DOCS_BOX });
  d.onKeyUp(up);
  assert.equal(up.prevented, true);
  assert.deepEqual(sent, ["ptt.start", "ptt.stop"]);
  // Key repeat turned off: the hold talks after HIDDEN_CONFIRM_MS.
  const b = detector("Space", { isHidden: () => true });
  b.d.onKeyDown(key("Space", {}, { target: DOCS_BOX }));
  b.fire();
  b.d.onKeyUp(key("Space", {}, { target: DOCS_BOX }));
  assert.deepEqual(b.sent, ["ptt.start", "ptt.stop"]);
});

test("a tap, or Space then another key, in a hidden text field is just typing", () => {
  const { d, sent, taps, timers, fire } = detector("Space", { isHidden: () => true });
  d.onKeyDown(key("Space", {}, { target: DOCS_BOX }));
  const up = key("Space", {}, { target: DOCS_BOX });
  d.onKeyUp(up);
  assert.equal(up.prevented, false);
  fire();
  // Space down, the next letter before Space comes up: a fast typist.
  d.onKeyDown(key("Space", {}, { target: DOCS_BOX }));
  const b = key("KeyB", {}, { target: DOCS_BOX });
  d.onKeyDown(b);
  assert.equal(b.prevented, false);
  fire();
  d.onKeyUp(key("Space", {}, { target: DOCS_BOX }));
  assert.deepEqual(sent, []);
  assert.deepEqual(taps, [], "no replayed tap: the space was typed");
  assert.ok(timers.length >= 2);
});

test("a visible text field still never talks on Space", () => {
  const { d, sent, fire } = detector("Space", { isHidden: () => false });
  const down = key("Space", {}, { target: DOCS_BOX });
  d.onKeyDown(down);
  fire();
  assert.equal(down.prevented, false);
  assert.deepEqual(sent, []);
});

test("isHiddenEntry: the Docs text frame off the top is hidden, a field on screen is not", () => {
  const { isHiddenEntry } = load();
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const top = { innerWidth: 1280, innerHeight: 900 };
  const frameEl = { getBoundingClientRect: () => rect(0, -10000, 625, 1), ownerDocument: { defaultView: top } };
  const inner = { innerWidth: 625, innerHeight: 1, frameElement: frameEl };
  const box = { ownerDocument: { defaultView: inner }, getBoundingClientRect: () => rect(0, 0, 625, 18) };
  assert.equal(isHiddenEntry(box), true);
  const field = { ownerDocument: { defaultView: { ...top, frameElement: null } }, getBoundingClientRect: () => rect(10, 10, 200, 30) };
  assert.equal(isHiddenEntry(field), false);
  const offTextarea = { ownerDocument: { defaultView: { ...top, frameElement: null } }, getBoundingClientRect: () => rect(-9999, 10, 1, 1) };
  assert.equal(isHiddenEntry(offTextarea), true);
  assert.equal(isHiddenEntry({}), false);
});
