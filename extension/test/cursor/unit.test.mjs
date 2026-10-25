// Unit tests for content/cursor.js in jsdom with a fake chrome API and a
// manual clock. Run: npm test (from this folder; jsdom from ../subtitles works too).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, "..", "..", "content", f), "utf8");
const SRC = read("cursor.js");
const FACE_SRC = read("orb-face.js");
const SUBS_SRC = read("subtitles.js");
const FRAME_SRC = read("frame.js");

function setup({ stored = {}, reduce = false, subtitles = false, frame = false, session = null } = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body><button id=add style='position:absolute'>Add to cart</button><input id=q placeholder='Search'></body></html>", {
    runScripts: "outside-only",
    url: "http://localhost:4000/",
  });
  const { window } = dom;
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  window.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + (ms || 0) }); return id; };
  window.clearTimeout = (id) => { timers.delete(id); };
  window.requestAnimationFrame = (fn) => window.setTimeout(fn, 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  window.Date.now = () => now;
  const tick = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  };
  const shadows = new Map();
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (init) {
    const r = attach.call(this, init);
    r.mode0 = init.mode;
    shadows.set(this.localName, r);
    return r;
  };
  const animations = [];
  window.Element.prototype.animate = function (frames, opts) {
    animations.push({ el: this, frames, opts });
    return { cancel() {} };
  };
  // jsdom has no layout: say what is under a point.
  let under = null;
  window.document.elementFromPoint = () => under;
  const listeners = [];
  const changeListeners = [];
  window.chrome = {
    runtime: { onMessage: { addListener: (f) => listeners.push(f) } },
    storage: {
      local: { get: async (k) => (k in stored ? { [k]: stored[k] } : {}) },
      onChanged: { addListener: (f) => changeListeners.push(f) },
    },
  };
  window.matchMedia = (q) => ({ matches: reduce && q.includes("prefers-reduced-motion: reduce"), media: q });
  if (session) window.sessionStorage.setItem("__clearcartCursor", JSON.stringify(session));
  window.eval(FACE_SRC);
  if (subtitles) window.eval(SUBS_SRC);
  if (frame) window.eval(FRAME_SRC);
  window.eval(SRC);
  const send = (msg) => listeners.map((f) => f(msg, {}, () => {}));
  const cursor = (m) => send({ type: "cursor", voice: "thinking", ...m });
  const host = () => window.document.querySelector("clearcart-cursor");
  const $ = (sel) => shadows.get("clearcart-cursor")?.querySelector(sel);
  const subs$ = (sel) => shadows.get("clearcart-subtitles")?.querySelector(sel);
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    window, send, cursor, host, $, subs$, tick, flush, animations, changeListeners, listeners, shadows,
    pointAt: (el) => { under = el; },
  };
}

const gesture = (t, action, pts, to = pts.at(-1)) => {
  for (const [x, y] of pts) { t.cursor({ phase: "move", action, x, y, to: { x: to[0], y: to[1] } }); t.tick(16); }
};

test("nothing is added to the page before the first sample", () => {
  const t = setup();
  assert.equal(t.host(), null);
  assert.equal(t.listeners.length, 1);
});

test("follows the hook's samples with transform-only moves, batched per frame", () => {
  const t = setup();
  t.cursor({ phase: "move", action: "click", x: 10, y: 20, to: { x: 100, y: 80 } });
  const h = t.host();
  assert.ok(h);
  assert.equal(h.getAttribute("aria-hidden"), "true");
  assert.ok(h.hasAttribute("inert"));
  assert.equal(h.getAttribute("data-clearcart-overlay"), "1.5");
  assert.equal(h.style.getPropertyValue("pointer-events"), "none");
  assert.equal(h.style.getPropertyPriority("pointer-events"), "important");
  assert.equal(h.style.getPropertyValue("z-index"), "2147483647");
  assert.match(SRC, /host\.setAttribute\("popover", "manual"\)/);
  assert.equal(t.shadows.get("clearcart-cursor").mode0, "closed");
  const cur = t.$(".cur");
  assert.equal(cur.style.transform, "translate3d(10px, 20px, 0)");
  assert.equal(cur.classList.contains("idle"), false);
  // Several samples inside one frame: one write, the latest point.
  t.cursor({ phase: "move", action: "click", x: 40, y: 40, to: { x: 100, y: 80 } });
  t.cursor({ phase: "move", action: "click", x: 60, y: 50, to: { x: 100, y: 80 } });
  assert.equal(cur.style.transform, "translate3d(10px, 20px, 0)");
  t.tick(16);
  assert.equal(cur.style.transform, "translate3d(60px, 50px, 0)");
  // Only transform changes on the cursor while it moves.
  assert.deepEqual(Array.from({ length: cur.style.length }, (_, i) => cur.style[i]), ["transform"]);
  // Only the pointer: no orb face on the tail.
  assert.equal(t.$(".otag"), null);
  assert.equal(t.$(".ccf"), null);
  assert.doesNotMatch(SRC, /OrbFace|otag|ccf/);
});

test("the cursor's shape follows the action: arrow, I-beam, wheel", () => {
  const t = setup();
  gesture(t, "click", [[5, 5], [50, 50]]);
  const cur = t.$(".cur");
  assert.ok(cur.classList.contains("m-click"));
  t.cursor({ phase: "type", action: "type", x: 50, y: 50, text: "linen pants" });
  assert.ok(cur.classList.contains("m-type"));
  assert.ok(!cur.classList.contains("m-click"));
  t.cursor({ phase: "wheel", action: "scroll", x: 300, y: 300 });
  assert.ok(cur.classList.contains("m-scroll"));
  assert.ok(t.$(".whl .chev"), "the scroll wheel from design 8");
  assert.ok(t.$(".ib") && t.$(".arw"));
});

test("a press plays the ripple, the ring pulse and the target highlight", () => {
  const t = setup();
  gesture(t, "click", [[5, 5], [120, 90]]);
  const rect = { x: 100, y: 80, width: 40, height: 20 };
  t.cursor({ phase: "press", action: "click", x: 120, y: 90, rect });
  const cur = t.$(".cur");
  assert.ok(cur.classList.contains("prs"));
  const els = t.animations.map((a) => a.el.className);
  assert.deepEqual(els.sort(), ["hl", "pulse", "rip"]);
  const rip = t.animations.find((a) => a.el.className === "rip");
  assert.equal(rip.opts.duration, 520);
  assert.match(rip.frames[0].transform, /translate3d\(120px, 90px, 0\) scale\(\.25\)/);
  // Every animation is transform and opacity only.
  for (const a of t.animations) for (const f of a.frames) for (const k of Object.keys(f)) assert.ok(["transform", "opacity", "offset"].includes(k), k);
  const hl = t.$(".hl");
  assert.equal(hl.style.width, "50px");
  assert.equal(hl.style.height, "30px");
  t.cursor({ phase: "release", action: "click", x: 120, y: 90 });
  assert.ok(!cur.classList.contains("prs"));
});

test("no text near the cursor: no name tag, no caption chip", () => {
  const t = setup();
  t.pointAt(t.window.document.getElementById("add"));
  gesture(t, "click", [[5, 5], [120, 90]]);
  t.cursor({ phase: "press", action: "click", x: 120, y: 90, rect: { x: 100, y: 80, width: 40, height: 20 } });
  t.cursor({ phase: "type", action: "type", x: 120, y: 90, text: "linen pants" });
  const root = t.shadows.get("clearcart-cursor");
  const text = [...root.querySelectorAll("*")].filter((n) => n.localName !== "style").map((n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.data).join("")).join("");
  assert.equal(text.trim(), "");
  assert.equal(root.querySelector(".chip, .tag"), null);
  assert.doesNotMatch(SRC, /\.chip|\.tag\b/);
});

test("action captions go to the subtitle card's action line, under the spoken words", () => {
  const t = setup({ subtitles: true });
  t.send({ type: "subtitle", speaker: "agent", text: "Let me find those for you", final: false });
  t.pointAt(t.window.document.getElementById("add"));
  gesture(t, "click", [[5, 5], [120, 90]]);
  assert.equal(t.subs$(".act").textContent, "Clicking Add to cart");
  assert.equal(t.subs$(".agent").textContent.trim(), "Let me find those for you", "spoken words stay");
  const lines = [...t.subs$(".lines").children].map((n) => n.className);
  assert.deepEqual(lines.slice(-2), ["agent", "act"], "a secondary line below the words");
  t.pointAt(t.window.document.getElementById("q"));
  t.cursor({ phase: "type", action: "type", x: 120, y: 90, text: "linen  pants" });
  assert.equal(t.subs$(".act").textContent, "Typing linen pants");
  // A later spoken line does not clear it, and it does not replace the words.
  t.send({ type: "subtitle", speaker: "agent", text: "Let me find those for you now", final: false });
  assert.equal(t.subs$(".act").textContent, "Typing linen pants");
  assert.match(t.subs$(".agent").textContent, /now/);
  // The agent's own click does not dismiss the card (the user's does).
  t.window.document.dispatchEvent(new t.window.Event("pointerdown"));
  assert.ok(t.subs$(".wrap").classList.contains("on"));
});

test("stays at its last position: no idle fade, the caption clears after 1.5 s", () => {
  const t = setup({ subtitles: true });
  t.pointAt(t.window.document.getElementById("add"));
  gesture(t, "click", [[5, 5], [120, 90]]);
  const cur = t.$(".cur");
  t.tick(1600);
  assert.equal(t.subs$(".act").textContent, "");
  t.tick(60000);
  assert.ok(t.host());
  assert.equal(cur.classList.contains("idle"), false);
  assert.equal(cur.style.transform, "translate3d(120px, 90px, 0)");
});

test("hide (turn end, interrupt) and tab switches leave it in place; pagehide saves it for a reload", async () => {
  const t = setup();
  gesture(t, "click", [[5, 5], [50, 50]]);
  t.cursor({ phase: "type", action: "type", x: 50, y: 50, text: "a long query" });
  t.cursor({ phase: "hide" });
  assert.ok(t.host());
  assert.equal(t.$(".cur").classList.contains("idle"), false);
  assert.equal(t.$(".cur").style.transform, "translate3d(50px, 50px, 0)");
  t.window.document.dispatchEvent(new t.window.Event("visibilitychange"));
  assert.ok(t.host());
  t.window.dispatchEvent(new t.window.Event("pagehide"));
  assert.equal(t.host(), null);
  const saved = JSON.parse(t.window.sessionStorage.getItem("__clearcartCursor"));
  assert.deepEqual(saved, { x: 50, y: 50 });

  const r = setup({ session: saved });
  await r.flush();
  assert.ok(r.host(), "redrawn after a reload");
  assert.equal(r.$(".cur").style.transform, "translate3d(50px, 50px, 0)");
  assert.equal(r.$(".cur").classList.contains("idle"), false);
  const off = setup({ session: saved, stored: { showCursor: false } });
  await off.flush();
  assert.equal(off.host(), null, "not with the setting off");
});

test("the setting off: nothing is drawn, and turning it off removes the cursor", async () => {
  const off = setup({ stored: { showCursor: false } });
  await off.flush();
  gesture(off, "click", [[5, 5], [50, 50]]);
  assert.equal(off.host(), null);

  const t = setup();
  gesture(t, "click", [[5, 5]]);
  assert.ok(t.host());
  for (const f of t.changeListeners) f({ showCursor: { newValue: false } }, "local");
  assert.equal(t.host(), null);
  gesture(t, "click", [[6, 6]]);
  assert.equal(t.host(), null);
  for (const f of t.changeListeners) f({ showCursor: { newValue: true } }, "local");
  gesture(t, "click", [[7, 7]]);
  assert.ok(t.host());
});

test("reduced motion: jumps to where the pointer settles, no ripple or pulse, a static highlight", () => {
  const t = setup({ reduce: true });
  t.cursor({ phase: "move", action: "click", x: 10, y: 10, to: { x: 200, y: 100 } });
  const cur = t.$(".cur");
  assert.equal(cur.style.transform, "translate3d(10px, 10px, 0)");
  for (const [x, y] of [[60, 30], [120, 60], [180, 90], [200, 100]]) {
    t.cursor({ phase: "move", action: "click", x, y, to: { x: 200, y: 100 } });
    t.tick(16);
    assert.equal(cur.style.transform, "translate3d(10px, 10px, 0)", "no path in between");
  }
  t.tick(130);
  assert.equal(cur.style.transform, "translate3d(200px, 100px, 0)");
  t.cursor({ phase: "press", action: "click", x: 200, y: 100, rect: { x: 180, y: 90, width: 40, height: 20 } });
  assert.deepEqual(t.animations, []);
  const hl = t.$(".hl");
  assert.ok(hl.classList.contains("still"));
  t.tick(1500);
  assert.ok(!hl.classList.contains("still"));
  assert.match(SRC, /prefers-reduced-motion: reduce[\s\S]*transition: none !important/);
});

test("no re-append loop with the cursor, the subtitles and the frame all mounted", async () => {
  const t = setup({ subtitles: true, frame: true });
  const root = t.window.document.documentElement;
  let moves = 0;
  new t.window.MutationObserver((recs) => { for (const r of recs) moves += r.addedNodes.length; }).observe(root, { childList: true });
  const order = () => [...root.children].map((el) => el.localName).filter((n) => n.startsWith("clearcart-"));
  t.send({ type: "frame", on: true });
  t.send({ type: "subtitle", speaker: "agent", text: "Adding it", final: false });
  gesture(t, "click", [[5, 5], [50, 50]]);
  for (let i = 0; i < 5; i++) await t.flush();
  assert.deepEqual(order(), ["clearcart-frame", "clearcart-cursor", "clearcart-subtitles"]);
  moves = 0;
  // Samples, presses and captions add no DOM moves.
  for (let i = 0; i < 40; i++) { t.cursor({ phase: "move", action: "click", x: i, y: i, to: { x: 40, y: 40 } }); t.tick(16); }
  t.cursor({ phase: "press", action: "click", x: 40, y: 40, rect: { x: 30, y: 30, width: 20, height: 20 } });
  for (let i = 0; i < 10; i++) await t.flush();
  assert.equal(moves, 0, "no re-appends once all three are shown");
  // A page overlay appended later goes under all three, once.
  t.window.document.body.after(t.window.document.createElement("div"));
  root.append(t.window.document.createElement("div"));
  for (let i = 0; i < 10; i++) await t.flush();
  assert.deepEqual([...root.children].slice(-3).map((e) => e.localName), ["clearcart-frame", "clearcart-cursor", "clearcart-subtitles"]);
  moves = 0;
  for (let i = 0; i < 10; i++) await t.flush();
  assert.equal(moves, 0);
  // Remounting the cursor after the setting went off and on settles too.
  for (const f of t.changeListeners) f({ showCursor: { newValue: false } }, "local");
  assert.equal(t.host(), null);
  for (const f of t.changeListeners) f({ showCursor: { newValue: true } }, "local");
  gesture(t, "click", [[9, 9]]);
  for (let i = 0; i < 5; i++) await t.flush();
  moves = 0;
  for (let i = 0; i < 10; i++) await t.flush();
  assert.equal(moves, 0);
  assert.deepEqual(order(), ["clearcart-frame", "clearcart-cursor", "clearcart-subtitles"]);
});

test("a hostile page that keeps itself last trips the cursor's valve", async () => {
  const t = setup();
  gesture(t, "click", [[5, 5]]);
  const root = t.window.document.documentElement;
  const bad = t.window.document.createElement("div");
  let fights = 0;
  new t.window.MutationObserver(() => {
    if (root.lastElementChild !== bad && fights < 1000) { fights++; root.append(bad); }
  }).observe(root, { childList: true });
  root.append(bad);
  for (let i = 0; i < 200; i++) await t.flush();
  assert.ok(fights < 40, `page fought ${fights} times`);
});
