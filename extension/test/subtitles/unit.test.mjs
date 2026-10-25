// Unit tests for content/subtitles.js in jsdom with a fake chrome API and a
// manual clock. Run: npm test (from this folder).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "..", "content", "subtitles.js"), "utf8");

function setup({ stored = {} } = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body><input id=f></body></html>", {
    runScripts: "outside-only",
    url: "http://localhost:4000/",
  });
  const { window } = dom;

  // Manual clock.
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  window.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; };
  window.clearTimeout = (id) => { timers.delete(id); };
  const tick = (ms) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  };

  // Capture the closed shadow root for inspection.
  let shadow = null;
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (init) {
    const r = attach.call(this, init);
    shadow = r;
    shadow.mode0 = init.mode;
    return r;
  };

  const msgListeners = [];
  const changeListeners = [];
  window.chrome = {
    runtime: { onMessage: { addListener: (f) => msgListeners.push(f) } },
    storage: {
      local: { get: async (k) => (k in stored ? { [k]: stored[k] } : {}) },
      onChanged: { addListener: (f) => changeListeners.push(f) },
    },
  };

  window.eval(SRC);
  const send = (msg) => msgListeners.forEach((f) => f(msg, {}, () => {}));
  const host = () => window.document.querySelector("clearcart-subtitles");
  const $ = (sel) => shadow && shadow.querySelector(sel);
  const visible = () => !!$(".wrap")?.classList.contains("on");
  const flush = () => new Promise((r) => setImmediate(r));
  return { window, send, host, $, visible, tick, flush, changeListeners, msgListeners, getShadow: () => shadow };
}

test("adds nothing to the page until the first message", () => {
  const t = setup();
  assert.equal(t.host(), null);
  assert.equal(t.msgListeners.length, 1);
});

test("mounts a closed, aria-hidden, inert, click-through host at max z-index", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Hello there", final: false });
  const h = t.host();
  assert.ok(h);
  assert.equal(t.getShadow().mode0, "closed");
  assert.equal(h.shadowRoot, null, "closed root is not reachable from the page");
  assert.equal(h.getAttribute("aria-hidden"), "true");
  assert.ok(h.hasAttribute("inert"));
  assert.equal(h.style.getPropertyValue("pointer-events"), "none");
  assert.equal(h.style.getPropertyValue("z-index"), "2147483647");
  assert.equal(h.style.getPropertyPriority("z-index"), "important");
  assert.ok(t.visible());
});

test("never takes focus from the page", () => {
  const t = setup();
  const input = t.window.document.getElementById("f");
  input.focus();
  t.send({ type: "voice.state", state: "listening" });
  t.send({ type: "subtitle", speaker: "user", text: "find oat milk", final: true });
  t.send({ type: "subtitle", speaker: "agent", text: "I found three.", final: true });
  assert.equal(t.window.document.activeElement, input);
  assert.equal(t.getShadow().querySelectorAll("[tabindex],button,a,input").length, 0);
});

test("user line is plain text and agent line is split into word spans", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "user", text: "find  <b>oat</b> milk", final: true });
  assert.equal(t.$(".user").textContent, "find <b>oat</b> milk");
  assert.equal(t.$(".user").children.length, 0, "no HTML injection");
  t.send({ type: "subtitle", speaker: "agent", text: "Oatly is four dollars", final: false });
  const spans = [...t.$(".agent").querySelectorAll(".w")];
  assert.deepEqual(spans.map((s) => s.textContent), ["Oatly", "is", "four", "dollars"]);
  assert.deepEqual(spans.map((s) => s.style.getPropertyValue("--i")), ["0", "1", "2", "3"]);
});

test("streaming partials keep existing word nodes and only animate new ones", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Oatly is", final: false });
  const first = t.$(".agent .w");
  t.send({ type: "subtitle", speaker: "agent", text: "Oatly is four dollars", final: false });
  const spans = [...t.$(".agent").querySelectorAll(".w")];
  assert.equal(spans[0], first, "existing word node reused");
  assert.equal(spans.length, 4);
  assert.equal(spans[2].style.getPropertyValue("--i"), "0", "new words stagger from zero");
  // A changed last word is redrawn.
  t.send({ type: "subtitle", speaker: "agent", text: "Oatly is four dollars fifty.", final: false });
  t.send({ type: "subtitle", speaker: "agent", text: "Oatly is four dollars, fifty.", final: true });
  assert.equal(t.$(".agent").textContent.trim(), "Oatly is four dollars, fifty.");
});

test("a new agent line after a final one replaces it", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "First line.", final: true });
  t.send({ type: "subtitle", speaker: "agent", text: "Second", final: false });
  assert.equal(t.$(".agent").textContent.trim(), "Second");
});

test("a new user turn clears the previous agent answer", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "user", text: "find milk", final: true });
  t.send({ type: "subtitle", speaker: "agent", text: "Found it.", final: true });
  t.send({ type: "subtitle", speaker: "user", text: "add", final: false });
  assert.equal(t.$(".user").textContent, "add");
  assert.equal(t.$(".agent").textContent, "");
});

test("fades out 5 s after the last final line, a newer line resets the timer, text clears after the fade", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Done.", final: true });
  t.tick(4000);
  assert.ok(t.visible());
  t.send({ type: "subtitle", speaker: "agent", text: "Anything else?", final: true });
  t.tick(4000);
  assert.ok(t.visible(), "timer restarted by the newer final line");
  t.tick(1000);
  assert.equal(t.visible(), false);
  assert.equal(t.$(".agent").textContent.trim(), "Anything else?", "words stay while fading");
  t.tick(700);
  assert.equal(t.$(".agent").textContent, "", "card is cleared once the fade ends");
});

test("hides 30 s after the last update even if the voice state never returns to idle", () => {
  const t = setup();
  t.send({ type: "voice.state", state: "thinking" });
  t.tick(29_999);
  assert.ok(t.visible());
  t.tick(1);
  assert.equal(t.visible(), false);
});

test("a partial line cancels a pending hide", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "user", text: "buy eggs", final: true });
  t.tick(4000);
  t.send({ type: "subtitle", speaker: "agent", text: "Adding", final: false });
  t.tick(10_000);
  assert.ok(t.visible());
});

test("state dot follows voice.state; active states keep the card up, idle lets it go", () => {
  const t = setup();
  t.send({ type: "voice.state", state: "listening" });
  assert.ok(t.visible());
  assert.equal(t.$(".wrap").dataset.state, "listening");
  t.send({ type: "voice.state", state: "thinking" });
  assert.equal(t.$(".wrap").dataset.state, "thinking");
  t.send({ type: "subtitle", speaker: "agent", text: "Here you go.", final: true });
  t.send({ type: "voice.state", state: "speaking" });
  t.tick(20_000);
  assert.ok(t.visible(), "still speaking, no hide");
  t.send({ type: "voice.state", state: "idle" });
  assert.equal(t.$(".wrap").dataset.state, "idle");
  t.tick(4999);
  assert.ok(t.visible());
  t.tick(1);
  assert.equal(t.visible(), false);
});

test("ignores malformed and unrelated messages", () => {
  const t = setup();
  t.send(null);
  t.send("subtitle");
  t.send({ type: "subtitle", speaker: "system", text: "x" });
  t.send({ type: "subtitle", speaker: "agent", text: 42 });
  t.send({ type: "voice.state", state: "dancing" });
  t.send({ type: "page.call", method: "read_page" });
  assert.equal(t.host(), null);
});

test("stays off when settings.subtitles is false", async () => {
  const t = setup({ stored: { subtitles: false } });
  await t.flush();
  t.send({ type: "voice.state", state: "listening" });
  t.send({ type: "subtitle", speaker: "agent", text: "Hello", final: true });
  assert.equal(t.host(), null);
});

test("turning subtitles off removes the overlay; turning them on brings it back", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Hello", final: false });
  assert.ok(t.host());
  t.changeListeners.forEach((f) => f({ subtitles: { oldValue: true, newValue: false } }, "local"));
  assert.equal(t.host(), null);
  t.send({ type: "subtitle", speaker: "agent", text: "Hidden", final: false });
  assert.equal(t.host(), null);
  t.send({ type: "settings.changed", settings: { subtitles: true } });
  t.send({ type: "subtitle", speaker: "agent", text: "Back", final: false });
  assert.ok(t.host());
  assert.equal(t.$(".agent").textContent.trim(), "Back");
});

test("is idempotent when injected twice", () => {
  const t = setup();
  t.window.eval(SRC);
  assert.equal(t.msgListeners.length, 1);
});

test("stylesheet honors reduced motion, dark mode and stays inside the shadow root", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Hi", final: false });
  const root = t.getShadow();
  const css = [...root.adoptedStyleSheets || []].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join("\n")
    || root.querySelector("style")?.textContent || "";
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /max-width: min\(720px/);
  assert.equal(t.window.document.head.querySelectorAll("style,link").length, 0, "no page-level styles added");
});
