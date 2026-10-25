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
const FACE_SRC = fs.readFileSync(path.join(HERE, "..", "..", "content", "orb-face.js"), "utf8");

function setup({ stored = {}, reduce = false } = {}) {
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

  window.matchMedia = (q) => ({ matches: reduce && q.includes("prefers-reduced-motion: reduce"), media: q });
  window.eval(FACE_SRC); // loaded just before subtitles.js, as in the manifest
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

const wordsOf = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ") + ".";

test("a short line hides at 10 s, not before, and text clears after the fade", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Done.", final: true });
  t.tick(9999);
  assert.ok(t.visible());
  t.tick(1);
  assert.equal(t.visible(), false);
  assert.equal(t.$(".agent").textContent.trim(), "Done.", "words stay while fading");
  t.tick(700);
  assert.equal(t.$(".agent").textContent, "", "card is cleared once the fade ends");
});

test("a newer final line restarts the timer", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Done.", final: true });
  t.tick(8000);
  t.send({ type: "subtitle", speaker: "agent", text: "Anything else?", final: true });
  t.tick(8000);
  assert.ok(t.visible(), "timer restarted by the newer final line");
  t.tick(2000);
  assert.equal(t.visible(), false);
});

test("a 75 word answer waits about 28 s", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: wordsOf(75), final: true });
  t.tick(27_999);
  assert.ok(t.visible());
  t.tick(1);
  assert.equal(t.visible(), false);
});

test("the user line counts toward the wait too", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "user", text: wordsOf(10), final: true });
  t.send({ type: "subtitle", speaker: "agent", text: wordsOf(15), final: true });
  t.tick(12_999); // 25 words: 10 s + 10 x 300 ms
  assert.ok(t.visible());
  t.tick(1);
  assert.equal(t.visible(), false);
});

test("the wait is capped at 60 s", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "user", text: wordsOf(100), final: true });
  t.send({ type: "subtitle", speaker: "agent", text: wordsOf(150), final: true });
  t.tick(59_999);
  assert.ok(t.visible());
  t.tick(1);
  assert.equal(t.visible(), false);
});

test("the stale cap is extended for long text", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: wordsOf(100), final: false });
  t.send({ type: "voice.state", state: "speaking" }); // never returns to idle
  t.tick(44_999); // 100 words: 35.5 s wait, so the cap is 45.5 s
  assert.ok(t.visible(), "not cut at 30 s");
  t.tick(501);
  assert.equal(t.visible(), false);
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

test("state orb follows voice.state; active states keep the card up, idle lets it go", () => {
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
  t.tick(9999);
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

test("a line arriving mid-fade clears the old words at once instead of bringing them back", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "user", text: "old question", final: true });
  t.send({ type: "subtitle", speaker: "agent", text: "Old answer.", final: true });
  t.tick(10_000);
  assert.equal(t.visible(), false, "fading");
  t.send({ type: "voice.state", state: "listening" });
  assert.ok(t.visible());
  assert.equal(t.$(".agent").textContent, "");
  assert.equal(t.$(".user").textContent, "");
  t.tick(5000);
  t.send({ type: "subtitle", speaker: "agent", text: "New.", final: true });
  t.tick(5000);
  t.send({ type: "subtitle", speaker: "agent", text: "Newer.", final: false });
  assert.equal(t.$(".agent").textContent.trim(), "Newer.");
});

test("a latched listening state says how to send, and the hint goes when it ends", () => {
  const t = setup();
  t.send({ type: "voice.state", state: "listening", latched: true });
  assert.ok(t.visible());
  assert.equal(t.$(".hint").textContent, "Listening. Press Space to send.");
  assert.doesNotMatch(t.$(".hint").textContent, /—/);
  t.tick(45_000);
  assert.ok(t.visible(), "a latch can sit quietly for up to a minute");
  t.send({ type: "voice.state", state: "thinking" });
  assert.equal(t.$(".hint").textContent, "");
  t.send({ type: "voice.state", state: "listening" });
  assert.equal(t.$(".hint").textContent, "", "a hold shows no hint");
});

// Mini orb face (content/orb-face.js) in the card.
const MIN = 60_000;
const face = (t) => t.$(".card > .ccf");
const happy = (t) => face(t).classList.contains("ccf-happy");

test("the orb face replaces the dot: decorative, inside the card, eyes and a smile", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Hi", final: false });
  const f = face(t);
  assert.ok(f, "face mounted in the card");
  assert.equal(t.$(".dot"), null, "old dot gone");
  assert.equal(f.getAttribute("aria-hidden"), "true");
  assert.equal(f.querySelectorAll("circle.ccf-eye").length, 2);
  assert.equal(f.querySelectorAll("path.ccf-m").length, 1);
  assert.equal(f.querySelectorAll(".ccf-b, [class*=brow]").length, 0, "no eyebrows");
  assert.equal(f.textContent, "", "no text: the state is said elsewhere");
});

test("the face shows only at rest: listening, thinking and speaking are faceless", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Hi", final: false });
  assert.equal(face(t).classList.contains("ccf-noface"), false, "idle smiles");
  for (const state of ["listening", "thinking", "speaking"]) {
    t.send({ type: "voice.state", state });
    assert.equal(face(t).classList.contains("ccf-noface"), true, state);
  }
  t.send({ type: "voice.state", state: "idle" });
  assert.equal(face(t).classList.contains("ccf-noface"), false, "face back at rest");
  const css = t.window.__clearcartOrbFace.CSS;
  assert.match(css, /\.ccf\.ccf-noface \.ccf-f \{ opacity: 0; \}/);
  assert.match(css, /\.ccf-f \{[^}]*transition: opacity \.15s/, "fades over 150 ms");
});

test("the orb face gets one state class per voice state", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Hi", final: false });
  for (const state of ["listening", "thinking", "speaking", "idle"]) {
    t.send({ type: "voice.state", state });
    const states = [...face(t).classList].filter((c) => c.startsWith("ccf--"));
    assert.deepEqual(states, [`ccf--${state}`], state);
    assert.equal(face(t).dataset.state, state);
  }
  t.send({ type: "voice.state", state: "dancing" });
  assert.ok(face(t).classList.contains("ccf--idle"), "unknown states ignored");
});

// The face on its own (as in the popup, which stays visible), on the same clock.
const bare = (opts) => {
  const t = setup(opts);
  const f = t.window.__clearcartOrbFace.create(t.window.document);
  return { t, f, happy: () => f.el.classList.contains("ccf-happy") };
};

test("happy moment fires once, only after 20 minutes of continuous idle, and lasts under 600 ms", () => {
  const { t, f, happy } = bare();
  f.setState("speaking");
  f.setState("idle");
  t.tick(20 * MIN - 1);
  assert.equal(happy(), false, "not before 20 minutes");
  t.tick(1);
  assert.equal(happy(), true, "plays at 20 minutes");
  t.tick(499);
  assert.equal(happy(), true);
  t.tick(1);
  assert.equal(happy(), false, "over after 500 ms");
  t.tick(60 * MIN);
  assert.equal(happy(), false, "plays once, not again");
});

test("activity resets the idle clock for the happy moment", () => {
  const a = bare();
  a.t.tick(15 * MIN);
  a.f.poke(); // a caption or other activity
  a.t.tick(15 * MIN);
  assert.equal(a.happy(), false, "15 + 15 minutes is not 20 of continuous idle");
  a.t.tick(5 * MIN);
  assert.equal(a.happy(), true, "20 minutes after the last activity");

  const b = bare();
  b.t.tick(19 * MIN);
  b.f.setState("listening");
  b.f.setState("idle");
  b.t.tick(19 * MIN);
  assert.equal(b.happy(), false, "a state change restarts the clock");
  b.t.tick(MIN);
  assert.equal(b.happy(), true);

  const c = bare();
  c.t.tick(19 * MIN);
  c.f.setState("thinking");
  c.t.tick(MIN);
  assert.equal(c.happy(), false, "cancelled when work starts");
});

test("never plays the happy moment while listening, thinking or speaking", () => {
  for (const state of ["listening", "thinking", "speaking"]) {
    const t = setup();
    t.send({ type: "voice.state", state });
    t.tick(60 * MIN);
    assert.equal(happy(t), false, state);
  }
});

test("no happy moment and no live motion under reduced motion", () => {
  const t = setup({ reduce: true });
  t.send({ type: "subtitle", speaker: "agent", text: "Hi", final: true });
  t.send({ type: "voice.state", state: "speaking" });
  t.send({ type: "voice.level", level: 0.9 });
  assert.equal(face(t).style.getPropertyValue("--ccf-swell"), "", "levels ignored");
  t.send({ type: "voice.state", state: "idle" });
  t.tick(60 * MIN);
  assert.equal(happy(t), false);
  const lone = bare({ reduce: true });
  lone.t.tick(60 * MIN);
  assert.equal(lone.happy(), false, "never, even when visible");
  const root = t.getShadow();
  const css = [...root.adoptedStyleSheets || []].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join("\n")
    || root.querySelector("style")?.textContent || "";
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{[^}]*\.ccf[^{]*\{\s*animation: none !important/);
});

test("a live level drives the swell and the cadence pulse, then falls back to the loop", () => {
  const t = setup();
  t.send({ type: "voice.state", state: "listening" });
  t.send({ type: "voice.level", level: 1 });
  assert.ok(face(t).classList.contains("ccf-live"));
  assert.ok(Number(face(t).style.getPropertyValue("--ccf-swell")) > 1);
  t.tick(300);
  assert.equal(face(t).classList.contains("ccf-live"), false, "loop again once levels stop");
  t.send({ type: "voice.state", state: "speaking" });
  t.send({ type: "voice.level", level: 0.5 });
  const pulse = Number(face(t).style.getPropertyValue("--ccf-swell"));
  assert.ok(pulse > 1 && pulse <= 1.09, "speaking pulses the orb, up to 1.09");
  t.send({ type: "voice.state", state: "thinking" });
  assert.equal(face(t).style.getPropertyValue("--ccf-swell"), "", "reset on state change");
  t.send({ type: "voice.level", level: 1 });
  assert.equal(face(t).classList.contains("ccf-live"), false, "no level motion while thinking");
});

test("the happy moment does not play while the card is hidden", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Done.", final: true });
  t.send({ type: "voice.state", state: "speaking" });
  t.send({ type: "voice.state", state: "idle" });
  t.tick(11_000); // the card hides after the reading time
  assert.equal(t.visible(), false);
  t.tick(20 * MIN);
  assert.equal(happy(t), false, "nobody can see it");
});

test("clicking the page fades the card out early, then clears it", () => {
  const t = setup();
  t.send({ type: "subtitle", speaker: "agent", text: "Done.", final: true });
  assert.ok(t.visible());
  t.window.document.body.dispatchEvent(new t.window.Event("pointerdown", { bubbles: true }));
  assert.equal(t.visible(), false);
  t.tick(700);
  assert.equal(t.$(".agent").textContent, "", "card is cleared once the fade ends");
  t.send({ type: "subtitle", speaker: "agent", text: "Next.", final: true });
  assert.ok(t.visible(), "the next line shows again");
});

// Karaoke: SUBTITLE {utteranceId, karaoke} then SUBTITLE_WORD as words are heard.
const LINE = "Found it, nine dollars.";
const kline = (t, id = "u1", text = LINE) => t.send({ type: "subtitle", speaker: "agent", text, final: true, utteranceId: id, karaoke: true });
const kword = (t, m) => t.send({ type: "subtitle.word", utteranceId: "u1", ...m });
// Each word as "" (heard), "kc" (being heard) or "kp" (still to come).
const marks = (t) => [...t.$(".agent").querySelectorAll(".w")].map((s) => (s.classList.contains("kc") ? "kc" : s.classList.contains("kp") ? "kp" : ""));
const sheet = (t) => {
  const root = t.getShadow();
  return [...(root.adoptedStyleSheets || [])].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join("\n")
    || root.querySelector("style")?.textContent || "";
};

test("karaoke: the exact line is drawn dim, then the heard word is highlighted and earlier words stay bright", () => {
  const t = setup();
  kline(t);
  assert.equal(t.$(".agent").textContent.trim(), LINE, "the text sent to TTS, word for word");
  assert.ok(t.$(".agent").classList.contains("karaoke"));
  assert.deepEqual(marks(t), ["kp", "kp", "kp", "kp"]);
  kword(t, { index: 0 });
  assert.deepEqual(marks(t), ["kc", "kp", "kp", "kp"]);
  kword(t, { index: 2 });
  assert.deepEqual(marks(t), ["", "", "kc", "kp"]);
  kword(t, { index: 1 }); // late or duplicate: never goes back
  assert.deepEqual(marks(t), ["", "", "kc", "kp"]);
  kword(t, { index: 4, done: true });
  assert.deepEqual(marks(t), ["", "", "", ""]);
});

test("karaoke: an interrupt freezes the highlight; nothing advances it after", () => {
  const t = setup();
  kline(t);
  kword(t, { index: 1 });
  kword(t, { index: 1, frozen: true });
  assert.ok(t.$(".agent").classList.contains("frozen"), "the sweep stops");
  assert.deepEqual(marks(t), ["", "kc", "kp", "kp"]);
  t.send({ type: "voice.state", state: "listening" });
  assert.deepEqual(marks(t), ["", "kc", "kp", "kp"], "a barge-in keeps the frozen line until the user speaks");
  t.send({ type: "subtitle", speaker: "user", text: "wait", final: false });
  assert.equal(t.$(".agent").textContent, "", "a new turn clears it");
  assert.equal(t.$(".agent").classList.contains("karaoke"), false);
  kword(t, { index: 3 });
  assert.equal(t.$(".agent").textContent, "", "a stray word for the old line draws nothing");
});

test("karaoke: a tab switch replay shows the line at the word being heard, even when the word comes first", () => {
  const t = setup();
  // The relay's replay: line, then word.
  kline(t);
  kword(t, { index: 2 });
  assert.deepEqual(marks(t), ["", "", "kc", "kp"]);
  // Switching back to a tab that already has the line keeps its place.
  kline(t);
  assert.deepEqual(marks(t), ["", "", "kc", "kp"]);

  // A live word can reach the new tab just before the replayed line.
  const u = setup();
  u.send({ type: "subtitle.word", utteranceId: "u7", index: 1 });
  kline(u, "u7");
  assert.deepEqual(marks(u), ["", "kc", "kp", "kp"]);
});

test("karaoke: a new line resets the highlight", () => {
  const t = setup();
  kline(t);
  kword(t, { index: 3 });
  kline(t, "u2", "Want the store brand?");
  assert.deepEqual(marks(t), ["kp", "kp", "kp", "kp"]);
  assert.equal(t.$(".agent").textContent.trim(), "Want the store brand?");
  t.send({ type: "subtitle.word", utteranceId: "u2", index: 0 });
  assert.deepEqual(marks(t), ["kc", "kp", "kp", "kp"]);
});

test("karaoke: without timestamps the line falls back to the plain caption", () => {
  const t = setup();
  kline(t);
  kword(t, { fallback: true });
  assert.equal(t.$(".agent").classList.contains("karaoke"), false);
  assert.deepEqual(marks(t), ["", "", "", ""], "every word at full ink");
  assert.equal(t.$(".agent").textContent.trim(), LINE);

  // A line sent without karaoke (TTS failed, or an older offscreen) streams in as before.
  const u = setup();
  u.send({ type: "subtitle", speaker: "agent", text: LINE, final: true, utteranceId: "u3", karaoke: false });
  assert.equal(u.$(".agent").classList.contains("karaoke"), false);
  assert.equal(u.$(".agent").querySelector(".w").style.getPropertyValue("--i"), "0", "the staggered word-in");
  u.send({ type: "subtitle.word", utteranceId: "u3", index: 2 });
  assert.deepEqual(marks(u), ["", "", "", ""]);
});

test("karaoke: word indexes count from the full line when a long line is cut to fit", () => {
  const t = setup();
  const long = Array.from({ length: 150 }, (_, i) => `w${i}`).join(" ");
  kline(t, "u1", long);
  const shown = [...t.$(".agent").querySelectorAll(".w")].map((s) => s.textContent);
  assert.ok(shown.length < 150 && shown.at(-1) === "w149");
  const first = Number(shown[0].slice(1));
  kword(t, { index: first + 2 });
  assert.equal(marks(t).indexOf("kc"), 2);
  assert.equal(t.$(".agent .kc").textContent, `w${first + 2}`);
});

test("karaoke: reduced motion keeps a static highlight; high contrast underlines the word", () => {
  const t = setup({ reduce: true });
  kline(t);
  kword(t, { index: 1 });
  assert.deepEqual(marks(t), ["", "kc", "kp", "kp"], "the highlight is still there");
  const css = sheet(t).replace(/\s+/g, " ");
  // Every @media (q) block, joined (the orb face has its own).
  const block = (q) => css.split("@media").filter((part) => part.trimStart().startsWith(`(${q})`)).join("\n");
  assert.match(block("prefers-reduced-motion: reduce"), /\.agent\.karaoke \.w\.kc[^{]*\{[^}]*animation: (?:auto ease 0s 1 normal none running )?none/);
  assert.match(block("forced-colors: active"), /\.w\.kc \{[^}]*text-decoration: underline/);
  assert.match(block("prefers-contrast: more"), /\.w\.kc \{[^}]*text-decoration: underline/);
});
