// The bridge between Orbi Desktop (Swift, Overlay.swift) and the
// extension's overlay scripts. Swift calls window.orbi; this turns each call
// into the runtime messages the extension's worker and offscreen document
// send its content scripts (lib/protocol.js RT), so the card, the orb face,
// the lips, the karaoke, the frame and the cursor behave exactly as they do
// in Chrome:
//
//   orbi.apply(u)        an overlay update from the server, u = {
//                          state?, latched?          -> VOICE_STATE
//                          line?: {speaker, text, final}
//                                                    -> SUBTITLE (shown now)
//                          speech?: {id, text?, timestamps?, phonemes?, done?}
//                                                    an agent line Sonic is
//                                                    speaking (see below)
//                          frame?: bool              -> FRAME
//                          target?: {x, y, w, h, label?}  what the next press hits
//                          cue?: name, cueAfterCut?  an earcon (lib/voice/chime.js),
//                                                    after the cut cue if asked
//                          link?: bool               the server link is up or down
//                                                    (the closed and back cues)
//                        }
//   orbi.chunk(n, inMs)  the helper scheduled n samples (24 kHz) of speech,
//                        first heard inMs from now
//   orbi.stopSpeech()    playback was cut (barge-in): the caption freezes
//   orbi.cursor(s)       one pointer sample, as background/actor.js sends
//                        them: {phase, x, y, to?, action?, rect?, text?}
//   orbi.reset()         the server went away: back to rest
//   orbi.settings(o)     the helper's menu settings: {showCursor?}
//
// u.frameRect {x, y, w, h} (or null for the whole screen) is the window Orbi
// acts in: the frame ring goes around it, as around the tab's viewport in
// Chrome, clipped to the window with its rounded corners.
//
// Speech captions follow the audio, as in lib/voice/tts.js: speech {id, text}
// queues a line in play order; the audio that follows belongs to the first
// line not yet done; Sonic's word and phoneme timestamps go on the line's
// WordClock (lib/voice/karaoke.js); a 40 ms tick shows the line when its
// first audio is heard and moves the karaoke word, with the word's phonemes
// for the orb's lips. A line with no timestamps after 1 s is shown plainly.

import { WordClock } from "./ext/karaoke.js";
import { createChime, linkCues, cueLength } from "./ext/chime.js";

const RT = { SUBTITLE: "subtitle", SUBTITLE_WORD: "subtitle.word", VOICE_STATE: "voice.state", FRAME: "frame", CURSOR: "cursor" };
const SR = 24000;
const TICK_MS = 40; // lib/voice/tts.js CAPTION_TICK_MS
const NO_TIMESTAMPS_AFTER_S = 1;
const TARGET_MS = 4000; // how long a target box stays hit-testable
const bus = globalThis.__orbiBus;
const send = (m) => bus.send(m);
const now = () => performance.now() / 1000;

// ------------------------------------------------------------ earcons

let ctx = null;
function audio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  } catch { ctx = null; }
  return ctx;
}
let chime = null;
function cue(name, opts) {
  const c = audio();
  if (!c) return;
  chime ??= createChime({ ctx: c });
  try { chime(name, opts); } catch {}
}
const link = linkCues({ play: (n, o) => cue(n, o) });

// ------------------------------------------------------------ speech

let lines = []; // lines in play order whose caption is still to show or advance
let ticker = 0;

function line(id, text) {
  const u = { id, text, clock: new WordClock({ text, sampleRate: SR }), done: false, shown: false, plain: false, index: -1 };
  lines.push(u);
  startTicker();
  return u;
}
const byId = (id) => lines.find((u) => u.id === id);

function timing(u, t) {
  const span = u.index >= 0 ? u.clock.spanOf(u.index) : null;
  if (!span || !Number.isFinite(span.end)) return {};
  const ms = Math.round((span.end - span.start) * 1000);
  return { ms, elapsed: Math.max(0, Math.min(ms, Math.round((t - span.start) * 1000))) };
}

function show(u, karaoke) {
  u.shown = true;
  if (!karaoke) u.plain = true;
  send({ type: RT.SUBTITLE, speaker: "agent", text: u.text, final: true, utteranceId: u.id, karaoke });
}

function word(w) { send({ type: RT.SUBTITLE_WORD, ...w }); }

function tick() {
  const t = now();
  while (lines.length) {
    const u = lines[0];
    const c = u.clock;
    if (!c.chunks.length) {
      if (!u.done) break; // still generating
      show(u, false); // no audio at all (TTS failed): the words anyway
      lines.shift();
      continue;
    }
    if (t < c.firstAt) break;
    if (!u.shown) show(u, true);
    const heardAll = u.done && t >= c.endAt;
    if (!u.plain) {
      if (!c.timed && (heardAll || u.done || t - c.firstAt >= NO_TIMESTAMPS_AFTER_S)) {
        u.plain = true;
        word({ utteranceId: u.id, fallback: true });
      } else if (c.timed) {
        const i = c.indexAt(t);
        if (i > u.index) {
          u.index = i;
          const phonemes = c.phonemesOf(i);
          word({ utteranceId: u.id, index: i, ...timing(u, t), ...(phonemes.length ? { phonemes } : {}) });
        }
      }
    }
    if (!heardAll) break;
    if (!u.plain) word({ utteranceId: u.id, index: c.words.length, done: true });
    lines.shift();
  }
  if (!lines.length) stopTicker();
}

function startTicker() { if (!ticker) ticker = setInterval(tick, TICK_MS); }
function stopTicker() { clearInterval(ticker); ticker = 0; }

// Cut mid-line: the highlight stays on the word that was being heard.
function stopSpeech() {
  if (lines.length) tick(); // a line heard to its end is done, not frozen
  const u = lines[0];
  if (u && u.shown && !u.plain) word({ utteranceId: u.id, index: u.index, ...timing(u, now()), frozen: true });
  lines = [];
  stopTicker();
}

function speech(s) {
  if (!s || typeof s.id !== "string") return;
  let u = byId(s.id);
  if (!u && typeof s.text === "string") u = line(s.id, s.text);
  if (!u) return;
  if (s.timestamps) u.clock.addTimestamps(s.timestamps);
  if (s.phonemes) u.clock.addPhonemes(s.phonemes);
  if (s.done === true) u.done = true;
  tick();
}

// Audio goes to the first line still generating, as the server sends it in
// play order.
function chunk(samples, inMs) {
  const u = lines.find((x) => !x.done);
  if (!u || !(samples > 0)) return;
  u.clock.addChunk(samples, now() + Math.max(0, inMs) / 1000, 1);
  startTicker();
}

// ------------------------------------------------------------ target

// The box the next press lands in, as a hidden labelled button: cursor.js
// names what it is clicking from the element under the point ("Clicking
// Add to cart"), and here the screen is not a page, so this stands in.
let target = null;
let targetTimer = 0;
function setTarget(t) {
  clearTimeout(targetTimer);
  target?.remove();
  target = null;
  if (!t || ![t.x, t.y, t.w, t.h].every(Number.isFinite) || t.w <= 0 || t.h <= 0) return;
  const b = document.createElement("button");
  b.tabIndex = -1;
  b.setAttribute("aria-label", typeof t.label === "string" ? t.label : "");
  Object.assign(b.style, {
    position: "fixed", left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px`, height: `${t.h}px`,
    margin: "0", padding: "0", border: "0", opacity: "0", background: "none",
  });
  document.body.append(b);
  target = b;
  targetTimer = setTimeout(() => setTarget(null), TARGET_MS);
}

// ------------------------------------------------------------ card blur

// The card's backdrop-filter only blurs this page, which is empty; the
// native blur goes behind the card instead. Its box and opacity go to Swift
// whenever they change, read once per frame only while the card is on screen
// or fading.
let cardWatch = null;
function watchCard() {
  const post = globalThis.webkit?.messageHandlers?.orbiCard;
  if (!post || cardWatch) return;
  const root = bus.root("clearcart-subtitles");
  const wrap = root?.querySelector(".wrap");
  const card = root?.querySelector(".card");
  if (!wrap || !card) return;
  let last = "";
  let raf = 0;
  const read = () => {
    raf = 0;
    if (!wrap.isConnected) { cardWatch?.disconnect(); cardWatch = null; return; }
    const r = card.getBoundingClientRect();
    const o = Number(getComputedStyle(wrap).opacity) || 0;
    const s = [r.x, r.y, r.width, r.height, o].map((v) => v.toFixed(1)).join(",");
    if (s !== last) {
      last = s;
      post.postMessage({ x: r.x, y: r.y, w: r.width, h: r.height, opacity: o });
    }
    if (wrap.classList.contains("on") || o > 0) raf = requestAnimationFrame(read);
  };
  const wake = () => { if (!raf) raf = requestAnimationFrame(read); };
  cardWatch = new MutationObserver(wake);
  cardWatch.observe(wrap, { attributes: true, attributeFilter: ["class"] });
  cardWatch.observe(card, { childList: true, subtree: true, characterData: true });
  wake();
}

// ------------------------------------------------------------ frame

// frame.js puts the ring 24px past the viewport's edges; here the viewport
// is the screen, so a sheet added to its shadow root moves the ring to the
// window's box instead and clips it there (the 24px outside the window
// would show on the desktop, where Chrome clips them at the viewport).
const RING_OUT = 24;
const WINDOW_RADIUS = 12;
let frameRect = null;
let frameSheet = null;
function placeFrame() {
  const root = bus.root("clearcart-frame");
  if (!root) return;
  if (!frameSheet) {
    try {
      frameSheet = new CSSStyleSheet();
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, frameSheet];
    } catch { frameSheet = null; return; }
  }
  const r = frameRect;
  frameSheet.replaceSync(r ? `.ring {
  inset: auto; left: ${r.x - RING_OUT}px; top: ${r.y - RING_OUT}px;
  width: ${r.w + 2 * RING_OUT}px; height: ${r.h + 2 * RING_OUT}px;
  clip-path: inset(${RING_OUT}px round ${WINDOW_RADIUS}px);
}` : "");
}
function setFrameRect(r) {
  const ok = r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0;
  frameRect = ok ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
  placeFrame();
}

// ------------------------------------------------------------ API

let state = "idle";

function apply(u) {
  if (!u || typeof u !== "object") return;
  if (typeof u.state === "string" && (u.state !== state || "latched" in u)) {
    state = u.state;
    send({ type: RT.VOICE_STATE, state, ...(u.latched === true ? { latched: true } : {}) });
  }
  if ("target" in u) setTarget(u.target);
  if (u.line && typeof u.line.text === "string") {
    const { speaker, text, final } = u.line;
    send({ type: RT.SUBTITLE, speaker: speaker === "user" ? "user" : "agent", text, final: final === true });
  }
  if (u.speech) speech(u.speech);
  if ("frameRect" in u) setFrameRect(u.frameRect);
  if (typeof u.frame === "boolean") {
    send({ type: RT.FRAME, on: u.frame });
    placeFrame(); // the ring is made on the first "on"
  }
  if (typeof u.cue === "string") cue(u.cue, u.cueAfterCut ? { when: cueLength("cut") } : undefined);
  if (typeof u.link === "boolean") link(u.link ? "open" : "closed");
  watchCard();
}

function cursor(s) {
  if (s && typeof s.phase === "string") send({ type: RT.CURSOR, ...s });
}

function reset() {
  stopSpeech();
  setTarget(null);
  cursor({ phase: "hide" });
  apply({ state: "idle", frame: false });
}

function settings(o) {
  if (o && typeof o.showCursor === "boolean") bus.setting("showCursor", o.showCursor);
}

globalThis.orbi = Object.freeze({ apply, chunk, stopSpeech, cursor, reset, settings });
globalThis.webkit?.messageHandlers?.orbiReady?.postMessage(true);
