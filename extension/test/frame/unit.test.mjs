// Unit tests for content/frame.js in jsdom with a fake chrome API and a
// manual clock. Run: npm test (from this folder; jsdom from ../subtitles works too).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "..", "content", "frame.js"), "utf8");

function setup() {
  const dom = new JSDOM("<!doctype html><html><head></head><body><input id=f></body></html>", {
    runScripts: "outside-only",
    url: "http://localhost:4000/",
  });
  const { window } = dom;
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  window.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; };
  window.clearTimeout = (id) => { timers.delete(id); };
  window.requestAnimationFrame = (fn) => window.setTimeout(fn, 16);
  const tick = (ms) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  };
  let shadow = null;
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (init) {
    shadow = attach.call(this, init);
    shadow.mode0 = init.mode;
    return shadow;
  };
  const listeners = [];
  window.chrome = { runtime: { onMessage: { addListener: (f) => listeners.push(f) } } };
  window.eval(SRC);
  const send = (msg) => listeners.map((f) => f(msg, {}, () => {}));
  const host = () => window.document.querySelector("clearcart-frame");
  const ring = () => shadow && shadow.querySelector(".ring");
  return { window, send, host, ring, tick, listeners, getShadow: () => shadow };
}

test("nothing is added to the page before the first show", () => {
  const { host, listeners } = setup();
  assert.equal(host(), null);
  assert.equal(listeners.length, 1);
});

test("show mounts an aria-hidden, inert, click-through host in a closed shadow root and fades in", () => {
  const { send, host, ring, tick, getShadow, window } = setup();
  const answers = send({ type: "frame", on: true });
  assert.deepEqual(answers, [undefined]); // never holds the channel open
  const h = host();
  assert.ok(h);
  assert.equal(h.getAttribute("aria-hidden"), "true");
  assert.ok(h.hasAttribute("inert"));
  // jsdom has no popover; Chromium gets popover="manual" (top layer).
  if ("popover" in h) assert.equal(h.getAttribute("popover"), "manual");
  assert.match(SRC, /host\.setAttribute\("popover", "manual"\)/);
  assert.equal(h.style.getPropertyValue("pointer-events"), "none");
  assert.equal(h.style.getPropertyPriority("pointer-events"), "important");
  assert.equal(h.style.getPropertyValue("position"), "fixed");
  assert.equal(h.style.getPropertyValue("z-index"), "2147483647");
  assert.equal(getShadow().mode0, "closed");
  assert.equal(window.document.activeElement, window.document.body); // no focus taken
  assert.equal(ring().classList.contains("on"), false);
  tick(16);
  assert.equal(ring().classList.contains("on"), true);
});

test("the ring is the B1 recipe at half speed, still under reduced motion", () => {
  const css = SRC;
  assert.match(css, /@property --clearcart-frame-a \{ syntax: "<angle>"; inherits: false; initial-value: 0deg; \}/);
  assert.match(css, /conic-gradient\(from var\(--clearcart-frame-a\), #ff9f6b, #ff5f8f, #b56cff, #5e8bff, #4fd1ff, #ff9f6b\)/);
  assert.match(css, /padding: 2px;/);
  assert.match(css, /mask-composite: exclude;/);
  assert.match(css, /opacity: \.45;/);
  assert.match(css, /animation: turn 6s linear infinite;/);
  assert.match(css, /@keyframes turn \{ from \{ --clearcart-frame-a: 0deg; \} to \{ --clearcart-frame-a: 360deg; \} \}/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.ring, \.ring\.on \{ animation: none; \}/);
  assert.match(css, /transition: opacity \.3s ease/);
});

test("hide fades out, then removes the host; a show during the fade keeps it", () => {
  const { send, host, ring, tick } = setup();
  send({ type: "frame", on: true });
  tick(16);
  send({ type: "frame", on: false });
  assert.equal(ring().classList.contains("on"), false);
  assert.ok(host(), "still there while it fades");
  tick(200);
  send({ type: "frame", on: true });
  tick(400);
  assert.ok(host());
  assert.equal(ring().classList.contains("on"), true);
  send({ type: "frame", on: false });
  tick(400);
  assert.equal(host(), null);
});

test("other messages and a hide before any show do nothing", () => {
  const { send, host } = setup();
  send({ type: "voice.state", state: "thinking" });
  send({ type: "frame", on: false });
  send(null);
  assert.equal(host(), null);
});

test("stays the last child of <html> when the page appends an overlay", async () => {
  const { send, host, window } = setup();
  send({ type: "frame", on: true });
  const overlay = window.document.createElement("div");
  window.document.documentElement.append(overlay);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(window.document.documentElement.lastElementChild, host());
});

test("runs in the top frame only, and only once", () => {
  const { window } = setup();
  const iframe = window.document.createElement("iframe");
  window.document.body.append(iframe);
  const sub = iframe.contentWindow;
  const subListeners = [];
  sub.chrome = { runtime: { onMessage: { addListener: (f) => subListeners.push(f) } } };
  sub.eval(SRC);
  assert.equal(subListeners.length, 0);
  assert.equal(sub.__clearcartFrame, undefined);
  const top = setup();
  top.window.eval(SRC);
  assert.equal(top.listeners.length, 1);
});
