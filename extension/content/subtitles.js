// Orbi subtitles: a quiet caption card at the bottom of every tab that
// shows what the user said and what the agent is saying.
//
// Declared in the manifest as a classic content script (no ES imports), so
// the runtime message types it needs are inlined from lib/protocol.js RT.
//
// The card is purely visual. Screen reader users already hear the agent, so
// the host is aria-hidden and inert, takes no pointer events and never
// receives focus. It lives in a closed shadow root with its own reset so page
// CSS cannot reach it, and it is only added to the page on the first message.
//
// It must sit above everything, cookie banners and modal dialogs included.
// The host is a manual popover, so it renders in the browser's top layer
// (above any z-index), and it is re-raised to the top of that layer every
// time it shows, so a dialog or banner opened later can't cover it. Every
// host style is set inline with !important, and it stays the last child of
// <html> in case a page appends its own max z-index overlay after it.

(() => {
  "use strict";

  const FLAG = "__clearcartSubtitles";
  if (globalThis[FLAG]) return; // idempotent if injected twice
  globalThis[FLAG] = true;

  // VOICE_LEVEL ({ level: 0..1 }) is optional: nothing sends it yet, and the
  // orb loops its listening and speaking motion until something does.
  const RT = { SUBTITLE: "subtitle", SUBTITLE_WORD: "subtitle.word", VOICE_STATE: "voice.state", VOICE_LEVEL: "voice.level", SETTINGS_CHANGED: "settings.changed" };
  // The status orb face comes from content/orb-face.js, loaded just before this
  // script. Without it the card simply has no orb.
  const FACE = globalThis.__clearcartOrbFace || null;
  const HIDE_MIN_MS = 10000;  // shortest wait after the last words, once nothing is being said
  const HIDE_MAX_MS = 60000;  // longest wait, however much text is on the card
  const MS_PER_EXTRA_WORD = 300; // about 200 words per minute of extra reading time
  const FREE_WORDS = 15;      // lines up to this many words get the minimum wait
  const STALE_MIN_MS = 30000; // hard cap after the last update, even if a state never returns to idle
  const STALE_LATCHED_MS = 70000; // a latched session stops itself after 60 s without speech
  const LATCH_HINT = "Listening. Press Space to send.";
  const FADE_MS = 700;        // matches the .wrap fade-out transition
  const MAX_CHARS = 600;
  const STATES = new Set(["idle", "listening", "thinking", "speaking"]);

  const CSS = `
:host {
  all: initial !important;
  position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;
  display: block !important; pointer-events: none !important;
}
* { box-sizing: border-box; }
.wrap {
  --ink: #1d1d1f; --muted: #6e6e73;
  --card: rgb(255 255 255 / .74); --edge: rgb(0 0 0 / .08);
  --shadow: 0 10px 40px rgb(30 34 60 / .14), 0 1px 3px rgb(30 34 60 / .08);
  --ease: cubic-bezier(.25, .8, .25, 1);
  position: fixed !important; left: 50% !important; bottom: 28px !important; z-index: 2147483647 !important;
  width: max-content; max-width: min(720px, calc(100vw - 32px));
  transform: translate(-50%, 10px) scale(.97);
  opacity: 0; visibility: hidden;
  --fade: cubic-bezier(.4, 0, .2, 1);
  transition: opacity .6s var(--fade), transform .7s var(--fade), visibility 0s linear .7s;
  pointer-events: none; user-select: none; -webkit-user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased; color: var(--ink); text-align: left;
}
.wrap.on {
  opacity: 1; visibility: visible; transform: translate(-50%, 0) scale(1);
  transition: opacity .32s var(--ease), transform .42s var(--ease), visibility 0s;
}
.card {
  position: relative; display: flex; align-items: flex-start; gap: 12px;
  padding: 14px 20px 15px 16px; border-radius: 22px;
  background: var(--card); border: 1px solid var(--edge); box-shadow: var(--shadow);
  -webkit-backdrop-filter: blur(28px) saturate(180%); backdrop-filter: blur(28px) saturate(180%);
}
.card > .ccf { margin: 1px 0 0 !important; }
.wrap:not(.on) .ccf, .wrap:not(.on) .ccf * { animation: none !important; } /* no work while hidden */
.lines { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.user {
  font-size: 13.5px; line-height: 1.4; font-weight: 400; letter-spacing: -.005em; color: var(--muted);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.agent {
  font-size: 21px; line-height: 1.36; font-weight: 500; letter-spacing: -.018em; color: var(--ink);
  max-height: calc(21px * 1.36 * 3); overflow: hidden; overflow-wrap: anywhere;
}
.act { font-size: 12px; line-height: 1.3; font-weight: 500; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.act:empty { display: none; }
.lines:has(> .user:empty):has(> .agent:empty) { align-self: center; } /* the action line alone */
.hint { font-size: 12px; line-height: 1.3; font-weight: 500; letter-spacing: .01em; color: var(--muted); }
.user:empty, .agent:empty, .hint:empty { display: none; }
.w { display: inline; animation: word-in .46s var(--ease) both; animation-delay: calc(var(--i, 0) * 55ms); }
@keyframes word-in {
  from { opacity: 0; filter: blur(7px); transform: translateY(3px); }
  to { opacity: 1; filter: blur(0); transform: none; }
}
/* Karaoke: the agent line as it is heard. Words already said (ks) are a
   slightly lighter ink, words still to come (kp) slightly darker, and the
   word being heard (kc) is the boundary: a color sweep across it, from the
   said ink to the coming ink, timed to the word's own start and end (--k-dur,
   with --k-delay negative for the part already heard), with a thin orb
   gradient line growing under it. Both inks keep 4.5:1 on the card over any
   page, light or dark. */
.wrap { --k-said: #48484e; --k-next: #1d1d1f; }
.agent.karaoke .w { animation: k-in .28s var(--ease) both; color: var(--k-next); }
.agent.karaoke .w.ks { color: var(--k-said); }
.agent.karaoke .w.kc {
  position: relative; color: var(--k-next);
  background: linear-gradient(90deg, var(--k-said) 0 45%, var(--k-next) 55% 100%) no-repeat;
  background-size: 220% 100%; background-position: 100% 0;
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  animation: k-sweep var(--k-dur, 250ms) linear var(--k-delay, 0ms) both;
}
.agent.karaoke .w.kc::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: 1px; height: 2px; border-radius: 2px;
  background: linear-gradient(90deg, #ff9f6b, #ff5f8f, #b56cff, #5e8bff, #4fd1ff);
  transform-origin: left center; animation: k-line var(--k-dur, 250ms) linear var(--k-delay, 0ms) both;
}
.agent.karaoke.frozen .w:not(.kc) { animation: none; }
.agent.karaoke.frozen .w.kc, .agent.karaoke.frozen .w.kc::after { animation-play-state: paused; }
@keyframes k-in { from { opacity: 0; } }
@keyframes k-sweep { from { background-position: 100% 0; } to { background-position: 0 0; } }
@keyframes k-line { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@media (prefers-color-scheme: dark) {
  .wrap {
    --ink: #f5f5f7; --muted: #a1a1a6;
    --card: rgb(28 28 30 / .72); --edge: rgb(255 255 255 / .1);
    --shadow: 0 12px 44px rgb(0 0 0 / .55), 0 1px 3px rgb(0 0 0 / .4);
    --k-said: #ffffff; --k-next: #d4d4d9;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wrap, .wrap.on { transform: translate(-50%, 0); }
  .w { animation-name: fade-in; animation-duration: .2s; animation-delay: 0s; }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
  /* The color steps word by word: no sweep, no fades. The word being heard
     takes the said ink at once and keeps a still line under it. */
  .agent.karaoke .w, .agent.karaoke .w.kc, .agent.karaoke .w.kc::after { animation: none; }
  .agent.karaoke .w.kc { background: none; -webkit-text-fill-color: currentColor; color: var(--k-said); }
}
@media (prefers-contrast: more) {
  .agent.karaoke .w.kc { text-decoration: underline 3px; text-underline-offset: 4px; }
  .agent.karaoke .w.kc::after { display: none; }
}
@media (forced-colors: active) {
  .card { background: Canvas; border-color: CanvasText; }
  .agent { color: CanvasText; } .user { color: GrayText; }
  /* Not color alone: the word being heard is underlined. */
  .agent.karaoke .w, .agent.karaoke .w.ks, .agent.karaoke .w.kc { color: CanvasText; }
  .agent.karaoke .w.kc { background: none; -webkit-text-fill-color: CanvasText; text-decoration: underline 3px; text-underline-offset: 4px; }
  .agent.karaoke .w.kc::after { display: none; }
}
`;

  const ui = {
    host: null, wrap: null, user: null, agent: null, face: null,
    enabled: true, state: "idle", latched: false, hint: null,
    agentWords: [], agentFinal: false,
    // Karaoke (SUBTITLE with utteranceId and karaoke, then SUBTITLE_WORD):
    // the line's id, words cut from its start to fit MAX_CHARS, the word
    // being heard, and a word that came before its line did.
    agentId: null, agentCut: 0, kIndex: -1, kDone: false, pendingWord: null, userFinal: false, lastSpeaker: null,
    hideTimer: 0,
    staleTimer: 0,
    clearTimer: 0,
  };

  function mount() {
    if (ui.host && ui.host.isConnected) return true;
    const root = document.documentElement;
    if (!root) return false;
    const host = document.createElement("clearcart-subtitles");
    host.setAttribute(OVERLAY_ATTR, String(RANK));
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("inert", "");
    host.setAttribute("translate", "no");
    if ("popover" in host) host.setAttribute("popover", "manual");
    pinHostStyle(host);

    const shadow = host.attachShadow({ mode: "closed" });
    let adopted = false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(FACE ? FACE.CSS + CSS : CSS);
      shadow.adoptedStyleSheets = [sheet]; // not subject to page style-src CSP
      adopted = true;
    } catch {}
    if (!adopted) {
      const style = document.createElement("style");
      style.textContent = FACE ? FACE.CSS + CSS : CSS;
      shadow.append(style);
    }

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.dataset.state = ui.state;
    const card = document.createElement("div");
    card.className = "card";
    const face = FACE ? FACE.create(document, { canPlay: () => wrap.classList.contains("on") }) : null;
    if (face) face.setState(ui.state);
    const lines = document.createElement("div");
    lines.className = "lines";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = ui.latched ? LATCH_HINT : "";
    const user = document.createElement("div");
    user.className = "user";
    const agent = document.createElement("div");
    agent.className = "agent";
    // The agent's current action (content/cursor.js), under the words.
    const act = document.createElement("div");
    act.className = "act";
    lines.append(hint, user, agent, act);
    if (face) card.append(face.el);
    card.append(lines);
    wrap.append(card);
    shadow.append(wrap);
    place(root, host);
    if (ui.face) ui.face.destroy();
    Object.assign(ui, { host, wrap, hint, user, agent, face, act });
    keepLast(root);
    return true;
  }

  // Inline !important beats any page rule, and also the UA popover styles
  // (margin auto, border, padding, Canvas background).
  const HOST_STYLE = [
    ["all", "initial"], ["position", "fixed"], ["inset", "0"], ["display", "block"],
    ["width", "100vw"], ["height", "100vh"], ["max-width", "none"], ["max-height", "none"],
    ["margin", "0"], ["padding", "0"], ["border", "0"], ["background", "transparent"],
    ["overflow", "visible"], ["color", "inherit"], ["opacity", "1"], ["visibility", "visible"],
    ["transform", "none"], ["filter", "none"], ["clip-path", "none"],
    ["pointer-events", "none"], ["z-index", "2147483647"], ["contain", "layout style"],
  ];
  function pinHostStyle(host) {
    const hs = host.style;
    for (const [k, v] of HOST_STYLE) hs.setProperty(k, v, "important");
  }

  // Move to the very top of the top layer (a later showPopover/showModal on
  // the page would otherwise stack above us).
  function raise() {
    const host = ui.host;
    if (!host || typeof host.showPopover !== "function") return;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {}
  }

  // Pages that append their own overlay after us, or rewrite our inline style.
  // Every Orbi overlay host carries OVERLAY_ATTR, whose value is its rank
  // (higher sits later, so the subtitles stay above the frame). A host only
  // moves when a non-Orbi element follows it, so two Orbi overlays
  // never chase each other. A valve stops re-appending for a while if a page
  // keeps itself last too, so the two can't spin forever.
  const OVERLAY_ATTR = "data-clearcart-overlay";
  const VALVE_MAX = 20;       // re-appends allowed per window
  const VALVE_WINDOW_MS = 1000;
  const VALVE_PAUSE_MS = 3000;
  const RANK = 2;
  const valve = { times: [], until: 0, timer: 0 };
  function rankOf(el) {
    const r = Number(el.getAttribute(OVERLAY_ATTR));
    return Number.isFinite(r) ? r : 0;
  }
  function followedByPage(host) {
    for (let el = host.nextElementSibling; el; el = el.nextElementSibling) {
      if (!el.hasAttribute(OVERLAY_ATTR)) return true;
    }
    return false;
  }
  // Last, but before any trailing Orbi overlay that ranks above us.
  function place(root, host) {
    let before = null;
    for (let el = root.lastElementChild; el && el !== host; el = el.previousElementSibling) {
      if (!el.hasAttribute(OVERLAY_ATTR) || rankOf(el) <= RANK) break;
      before = el;
    }
    if (before) root.insertBefore(host, before);
    else root.append(host);
  }
  function valveOpen() {
    const now = Date.now();
    if (now < valve.until) return false;
    valve.times = valve.times.filter((t) => now - t < VALVE_WINDOW_MS);
    if (valve.times.length >= VALVE_MAX) {
      valve.until = now + VALVE_PAUSE_MS;
      valve.times = [];
      clearTimeout(valve.timer);
      valve.timer = setTimeout(() => { valve.timer = 0; check(); }, VALVE_PAUSE_MS);
      return false;
    }
    valve.times.push(now);
    return true;
  }

  function check() {
    const host = ui.host;
    const root = document.documentElement;
    if (!host || !root) return;
    if ((host.parentNode !== root || followedByPage(host)) && valveOpen()) {
      place(root, host);
      if (ui.wrap && ui.wrap.classList.contains("on")) raise();
    }
    if (host.style.getPropertyPriority("z-index") !== "important") pinHostStyle(host);
  }
  let watcher = null;
  function keepLast(root) {
    if (watcher || typeof MutationObserver !== "function") return;
    watcher = new MutationObserver(check);
    watcher.observe(root, { childList: true });
  }

  // A fade-out was about to empty the card: empty it now, so the old words
  // don't come back with the new ones.
  function flushPendingClear() {
    if (!ui.clearTimer) return;
    clearTimeout(ui.clearTimer);
    ui.clearTimer = 0;
    clearText();
  }

  // Reading time for what is on the card (user line plus agent line):
  // 10 s for up to 15 words, plus 300 ms per extra word, capped at 60 s.
  function hideDelayMs() {
    const n = words(ui.user ? ui.user.textContent : "").length
      + words(ui.agent ? ui.agent.textContent : "").length;
    return Math.min(HIDE_MAX_MS, HIDE_MIN_MS + Math.max(0, n - FREE_WORDS) * MS_PER_EXTRA_WORD);
  }

  // The stale cap never cuts a long caption short.
  function armStale() {
    clearTimeout(ui.staleTimer);
    ui.staleTimer = setTimeout(hide, Math.max(ui.latched ? STALE_LATCHED_MS : STALE_MIN_MS, hideDelayMs() + 10000));
  }

  function show() {
    if (!ui.enabled || !mount()) return;
    flushPendingClear();
    armStale();
    ui.wrap.classList.add("on");
    raise();
  }

  function resetKaraoke() {
    ui.agentId = null;
    ui.agentCut = 0;
    ui.kIndex = -1;
    ui.kDone = false;
    if (ui.agent) ui.agent.classList.remove("karaoke", "frozen");
  }

  function clearText() {
    resetKaraoke();
    ui.agentWords = [];
    ui.lastSpeaker = null;
    if (ui.agent) ui.agent.textContent = "";
    if (ui.user) ui.user.textContent = "";
    if (ui.act) ui.act.textContent = "";
  }

  // Fade out first, then empty the card, so the words don't vanish mid-fade.
  function hide() {
    clearTimeout(ui.hideTimer);
    clearTimeout(ui.staleTimer);
    ui.hideTimer = 0;
    if (ui.wrap) ui.wrap.classList.remove("on");
    clearTimeout(ui.clearTimer);
    ui.clearTimer = setTimeout(() => {
      ui.clearTimer = 0;
      if (ui.wrap && ui.wrap.classList.contains("on")) return;
      clearText();
    }, FADE_MS);
  }

  function scheduleHide() {
    clearTimeout(ui.hideTimer);
    ui.hideTimer = setTimeout(hide, hideDelayMs());
  }

  function cancelHide() {
    clearTimeout(ui.hideTimer);
    ui.hideTimer = 0;
  }

  function words(text) {
    return text.split(/\s+/).filter(Boolean);
  }

  // Streams the agent line: words already on screen stay put, only new ones
  // blur in, staggered. A line that does not extend the current one replaces it.
  function renderAgent(text) {
    const next = words(text);
    const prev = ui.agentWords;
    let keep = 0;
    while (keep < prev.length && keep < next.length && prev[keep] === next[keep]) keep++;
    // Each word is a span plus a space. A partial may change its last word,
    // so everything after the common prefix is redrawn.
    while (ui.agent.childNodes.length > keep * 2) ui.agent.lastChild.remove();
    const frag = document.createDocumentFragment();
    for (let i = keep; i < next.length; i++) {
      const span = document.createElement("span");
      span.className = "w";
      span.style.setProperty("--i", String(i - keep));
      span.textContent = next[i];
      frag.append(span, document.createTextNode(" "));
    }
    ui.agent.append(frag);
    ui.agentWords = next;
    ui.agent.scrollTop = ui.agent.scrollHeight; // keep the newest line in view
  }

  // Whole words from the end of the line, up to MAX_CHARS, and how many
  // words were cut from its start (word indexes count from the full line).
  function fitWords(text) {
    const all = words(text);
    let cut = 0;
    let len = all.join(" ").length;
    while (len > MAX_CHARS && cut < all.length - 1) len -= all[cut++].length + 1;
    return { text: all.slice(cut).join(" ").slice(-MAX_CHARS), cut };
  }

  // A karaoke line: every word drawn at once, in the coming ink until heard.
  function renderKaraoke(text, id, cut) {
    resetKaraoke();
    ui.agentWords = [];
    ui.agent.textContent = "";
    ui.agentId = id;
    ui.agentCut = cut;
    ui.agent.classList.add("karaoke");
    const frag = document.createDocumentFragment();
    for (const w of words(text)) {
      const span = document.createElement("span");
      span.className = "w kp";
      span.textContent = w;
      frag.append(span, document.createTextNode(" "));
    }
    ui.agent.append(frag);
    ui.agentWords = words(text);
    ui.agent.scrollTop = 0;
  }

  // Said (ks) before the word being heard, the sweep (kc) on it, still to
  // come (kp) after. The sweep lasts as long as the word is heard, already
  // `elapsed` ms in.
  function paintKaraoke(timing) {
    const spans = ui.agent.querySelectorAll(".w");
    const at = ui.kDone ? Infinity : ui.kIndex - ui.agentCut;
    let current = null;
    spans.forEach((span, i) => {
      const cls = i < at ? "ks" : i === at ? "kc" : "kp";
      if (cls === "kc") current = span;
      for (const c of ["ks", "kc", "kp"]) if (c !== cls) span.classList.remove(c);
      span.classList.add(cls);
    });
    if (current && timing && Number.isFinite(timing.ms)) {
      current.style.setProperty("--k-dur", `${Math.max(1, timing.ms)}ms`);
      current.style.setProperty("--k-delay", `${-Math.max(0, Math.min(timing.ms, timing.elapsed || 0))}ms`);
    }
    // Keep the word being heard in view on a long line.
    if (current && ui.agent.scrollHeight > ui.agent.clientHeight) {
      ui.agent.scrollTop = Math.max(0, current.offsetTop - ui.agent.offsetTop - ui.agent.clientHeight / 3);
    }
  }

  function onWord(msg) {
    if (!ui.enabled || typeof msg.utteranceId !== "string") return;
    if (!ui.agent || msg.utteranceId !== ui.agentId) {
      ui.pendingWord = msg; // its line is on the way (a tab switch replay)
      return;
    }
    ui.pendingWord = null;
    if (!ui.agent.classList.contains("karaoke")) return; // already shown plainly
    if (msg.fallback) {
      // No timestamps: the line is shown plainly, as before karaoke.
      ui.agent.classList.remove("karaoke", "frozen");
      ui.agent.querySelectorAll(".w").forEach((s) => s.classList.remove("ks", "kc", "kp"));
      return;
    }
    const fresh = msg.done || msg.frozen || (Number.isInteger(msg.index) && msg.index > ui.kIndex);
    if (!fresh) return; // late or replayed: never goes back
    if (msg.done) ui.kDone = true;
    else if (Number.isInteger(msg.index)) ui.kIndex = msg.index;
    ui.agent.classList.toggle("frozen", msg.frozen === true);
    paintKaraoke(msg);
    if (ui.face) ui.face.poke();
    // The card stays up while the line is being heard; its reading time
    // starts once the voice goes idle (onState) or the line is done.
    if (msg.done && ui.state === "idle") scheduleHide();
    else if (!msg.done) cancelHide();
    if (ui.wrap && ui.wrap.classList.contains("on")) armStale(); // a word heard is activity
  }

  function onSubtitle({ speaker, text, final, utteranceId, karaoke }) {
    if (speaker !== "user" && speaker !== "agent") return;
    if (typeof text !== "string") return;
    const fit = fitWords(text);
    text = fit.text;
    if (!ui.enabled || !mount()) return;
    flushPendingClear(); // before the new text goes in
    final = final === true;
    const id = typeof utteranceId === "string" ? utteranceId : null;

    if (speaker === "user") {
      // A new user turn clears the previous agent answer.
      if (ui.lastSpeaker === "agent" || ui.userFinal) {
        resetKaraoke();
        ui.agentWords = [];
        ui.agent.textContent = "";
      }
      ui.user.textContent = text;
      ui.userFinal = final;
    } else if (id && id === ui.agentId && ui.agent.textContent) {
      // The same line again (a replay to a tab that has it): keep its place.
    } else if (id && karaoke === true) {
      renderKaraoke(text, id, fit.cut);
      ui.agentFinal = final;
      const early = ui.pendingWord;
      ui.pendingWord = null;
      if (early && early.utteranceId === id) onWord(early);
    } else {
      if (ui.agentFinal || ui.agentId) {
        // Previous agent line is done; this is a new one.
        resetKaraoke();
        ui.agentWords = [];
        ui.agent.textContent = "";
      }
      renderAgent(text);
      ui.agentId = id;
      ui.agentFinal = final;
    }
    ui.lastSpeaker = speaker;
    if (ui.face) ui.face.poke(); // a caption is activity: restart the idle clock
    if (!text && !ui.user.textContent && !ui.agent.textContent) return scheduleHide();
    show();
    // An agent line captioned from the audio (it has an utteranceId) arrives
    // while the voice is speaking: its reading time starts at idle instead.
    if (final && !(speaker === "agent" && id && ui.state === "speaking")) scheduleHide();
    else cancelHide();
  }

  function onState(state, latched) {
    if (!STATES.has(state)) return;
    ui.state = state;
    ui.latched = state === "listening" && latched === true;
    if (ui.hint) ui.hint.textContent = ui.latched ? LATCH_HINT : "";
    if (ui.wrap) ui.wrap.dataset.state = state;
    if (ui.face) ui.face.setState(state);
    if (!ui.enabled) return;
    if (state === "idle") {
      if (ui.wrap && ui.wrap.classList.contains("on") && !ui.hideTimer) scheduleHide();
      return;
    }
    show();
    if (ui.wrap) ui.wrap.dataset.state = state;
    cancelHide();
  }

  // The action line: a small secondary line that never replaces what was
  // said. It shows the card when it is hidden and lets the usual timers
  // hide it again.
  function setAction(text) {
    text = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    if (!text) { if (ui.act) ui.act.textContent = ""; return; }
    if (!ui.enabled || !mount()) return;
    flushPendingClear();
    ui.act.textContent = text;
    show();
    if (!ui.hideTimer && (ui.state === "idle" || ui.state === "thinking")) scheduleHide();
  }
  globalThis.__clearcartCaption = Object.freeze({ set: setAction });

  function setEnabled(on) {
    ui.enabled = on !== false;
    if (!ui.enabled) {
      hide();
      if (watcher) watcher.disconnect();
      watcher = null;
      if (ui.face) ui.face.destroy();
      if (ui.host) ui.host.remove();
      ui.host = ui.wrap = ui.hint = ui.user = ui.agent = ui.face = ui.act = null;
    }
  }

  // A click on the page outside the card fades it out early, like dismissing
  // a toast. The card takes no clicks, so a press on it reaches the page too;
  // those are told apart by position and leave the card up.
  // The agent's own clicks (content/cursor.js saw its pointer just now) don't.
  const onCard = (e) => {
    const card = ui.wrap && ui.wrap.querySelector(".card");
    if (!card || typeof e.clientX !== "number" || typeof e.clientY !== "number") return false;
    const r = card.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  document.addEventListener("pointerdown", (e) => {
    const agent = globalThis.__clearcartAgentPointer;
    if (agent && typeof agent.busy === "function" && agent.busy()) return;
    if (!ui.wrap || !ui.wrap.classList.contains("on")) return;
    if (onCard(e)) return;
    hide();
  }, { capture: true, passive: true });

  const chromeApi = globalThis.chrome;
  if (chromeApi && chromeApi.runtime && chromeApi.runtime.onMessage) {
    chromeApi.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === RT.SUBTITLE || msg.type === RT.SUBTITLE_WORD) {
        if (msg.type === RT.SUBTITLE) onSubtitle(msg);
        else onWord(msg);
        if (ui.face) ui.face.caption(msg); // lip-sync on the heard words
      }
      else if (msg.type === RT.VOICE_STATE) onState(msg.state, msg.latched);
      else if (msg.type === RT.VOICE_LEVEL) { if (ui.face) ui.face.setLevel(msg.level); }
      else if (msg.type === RT.SETTINGS_CHANGED && msg.settings && "subtitles" in msg.settings) {
        setEnabled(msg.settings.subtitles);
      }
      // No response: never hold the message channel open.
    });
  }

  const storage = chromeApi && chromeApi.storage;
  if (storage && storage.local) {
    try {
      Promise.resolve(storage.local.get("subtitles"))
        .then((v) => { if (v && v.subtitles === false) setEnabled(false); })
        .catch(() => {});
    } catch {}
  }
  if (storage && storage.onChanged) {
    storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.subtitles) setEnabled(changes.subtitles.newValue);
    });
  }
})();
