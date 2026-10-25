// Clearcart's cursor: shows where the agent's pointer is and what it is
// doing, design "7. Orb tag arrow" from the Agent-Cursor board. A white
// arrow with a spectrum outline and the small orb face (content/orb-face.js)
// on its tail; an I-beam while typing; the mouse wheel from design 8 while
// scrolling. A press plays a ripple at the point, a ring pulse around the
// target and a spectrum highlight on it.
//
// There is no text near the cursor. What it is doing ("Clicking Add to
// cart") goes to the subtitle card as its small action line
// (globalThis.__clearcartCaption from content/subtitles.js).
//
// The worker (background/cursor.js) sends RT.CURSOR for every pointer sample
// background/actor.js dispatched, in CSS pixels of this frame's viewport
// (CDP input coordinates), so nothing is mapped. Phases: move (with to, the
// point the gesture heads for), press (with rect, the target's box),
// release, wheel, type (with text), key, hide.
//
// Classic content script, top frame only, purely visual like the frame and
// the subtitles: an aria-hidden, inert, click-through host in a closed
// shadow root, a manual popover in the top layer, inline !important host
// styles. Only transforms and opacity animate; position updates are batched
// to one style write per animation frame and nothing reads layout per
// sample. Once shown on a tab it stays at its last position: no idle fade,
// and the worker's "hide" (turn end, interrupt, tab switch) only puts it at
// rest. The position is kept in sessionStorage, so a reload or a return from
// the back/forward cache redraws it there. Only the setting off removes it.
// Under reduced motion it jumps to where the pointer settles, plays no
// ripple or pulse, and the highlight is static.

(() => {
  "use strict";

  const FLAG = "__clearcartCursor";
  if (globalThis[FLAG]) return; // idempotent if injected twice
  if (globalThis.top !== globalThis) return; // top frame only
  globalThis[FLAG] = true;

  const RT = { CURSOR: "cursor" };
  const FACE = globalThis.__clearcartOrbFace || null;
  const IDLE_MS = 1500;    // no sample for this long: clear the caption, save the spot
  const SAVE_KEY = "__clearcartCursor";
  const SETTLE_MS = 120;   // reduced motion: jump once moves stop for this long
  const HL_MS = 1400;      // highlight on the target
  const REDUCE = "(prefers-reduced-motion: reduce)";
  const STATES = new Set(["idle", "listening", "thinking", "speaking"]);
  const SPECTRUM = "#ff9f6b, #ff5f8f, #b56cff, #5e8bff, #4fd1ff";

  const CSS = `
:host { all: initial !important; pointer-events: none !important; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; overflow: hidden; pointer-events: none; }
.cur {
  position: absolute; left: 0; top: 0; width: 0; height: 0;
  opacity: 1; transition: opacity .35s ease; will-change: transform;
}
.cur.idle { opacity: 0; }
.arw { position: absolute; left: -2px; top: -2px; filter: drop-shadow(0 2px 4px rgba(20,22,40,.28));
  transition: opacity .12s, transform .1s; transform-origin: 2px 2px; }
.cur.prs .arw { transform: scale(.86); }
.ib { position: absolute; left: -6px; top: -11px; opacity: 0; transition: opacity .12s; }
.whl { position: absolute; left: -8px; top: -11px; opacity: 0; transition: opacity .12s;
  filter: drop-shadow(0 2px 4px rgba(20,22,40,.22)); }
.whl .chev { animation: chev .5s ease-in-out infinite; animation-play-state: paused; }
.cur.m-type .ib, .cur.m-scroll .whl { opacity: 1; }
.cur.m-type .arw, .cur.m-scroll .arw { opacity: 0; }
.cur.m-scroll .whl .chev { animation-play-state: running; }
@keyframes chev { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(2px); } }
.otag {
  position: absolute; left: 0; top: 0; width: 14px; height: 14px; line-height: 0;
  --ccf-size: 14px; --ccf-glow: 0 0 6px rgba(94,139,255,.45);
  transform: translate(13px, 17px); transition: transform .12s;
}
.cur.m-type .otag { transform: translate(9px, 8px); }
.cur.m-scroll .otag { transform: translate(12px, 4px); }
.cur.prs .otag { transform: translate(13px, 17px) scale(.85); }
.cur.prs .ccf-dots { transform: scaleY(.35); }
.ccf-dots { transform-box: fill-box; transform-origin: center; transition: transform .1s; }
.rip {
  position: absolute; left: 0; top: 0; width: 46px; height: 46px; margin: -23px 0 0 -23px;
  border-radius: 50%; border: 2px solid rgba(181,108,255,.9);
  background: radial-gradient(circle, rgba(255,95,143,.22), rgba(255,95,143,0) 70%);
  opacity: 0;
}
.pulse {
  position: absolute; left: 0; top: 0; border-radius: 10px; opacity: 0;
  box-shadow: 0 0 0 3px rgba(94,139,255,.55);
}
.hl {
  position: absolute; left: 0; top: 0; border-radius: 14px; padding: 2px; opacity: 0;
  background: linear-gradient(90deg, ${SPECTRUM});
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
}
.hl.still { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .cur, .cur *, .hl { transition: none !important; }
  .whl .chev { animation: none !important; }
}
@media (forced-colors: active) {
  .arw path { fill: Canvas; stroke: CanvasText; } .layer { forced-color-adjust: none; }
}
`;

  // Built with createElementNS, not innerHTML, so no Trusted Types sink.
  const SVGNS = "http://www.w3.org/2000/svg";
  const IBEAM_D = "M2 1.5c2 0 3 .6 4 1.6 1-1 2-1.6 4-1.6M2 20.5c2 0 3-.6 4-1.6 1 1 2 1.6 4 1.6M6 3.1v15.8";
  // [tag, attrs, children]
  const ARROW = ["svg", { class: "arw", width: 18, height: 24, viewBox: "0 0 18 24" }, [
    ["defs", {}, [["linearGradient", { id: "ccc-ag", x1: 0, y1: 0, x2: 1, y2: 1 },
      ["#ff9f6b", "#ff5f8f", "#b56cff", "#5e8bff", "#4fd1ff"].map((c, i) => ["stop", { offset: i / 4, "stop-color": c }])]]],
    ["path", { d: "M2 2 L2 19.5 L6.6 15.4 L9.6 22 L12.6 20.7 L9.7 14.3 L15.8 14.3 Z", fill: "#ffffff", stroke: "url(#ccc-ag)", "stroke-width": 1.7, "stroke-linejoin": "round" }],
  ]];
  const IBEAM = ["svg", { class: "ib", width: 12, height: 22, viewBox: "0 0 12 22" }, [
    ["path", { d: IBEAM_D, fill: "none", stroke: "#ffffff", "stroke-width": 3.4, "stroke-linecap": "round" }],
    ["path", { d: IBEAM_D, fill: "none", stroke: "#1d1d1f", "stroke-width": 1.6, "stroke-linecap": "round" }],
  ]];
  const WHEEL = ["svg", { width: 16, height: 30, viewBox: "0 0 16 30" }, [
    ["rect", { x: 1.5, y: 1.5, width: 13, height: 19, rx: 6.5, fill: "#ffffff", stroke: "#1d1d1f", "stroke-width": 1.5 }],
    ["path", { d: "M8 5.5v4", stroke: "#b56cff", "stroke-width": 2, "stroke-linecap": "round" }],
    ["path", { class: "chev", d: "M4.5 24l3.5 3 3.5-3", fill: "none", stroke: "#5e8bff", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }],
  ]];
  function build([tag, attrs, kids = []]) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (tag === "svg") { node.setAttribute("aria-hidden", "true"); node.setAttribute("focusable", "false"); }
    for (const k of kids) node.append(build(k));
    return node;
  }

  // Inline !important beats any page rule and the UA popover styles.
  const HOST_STYLE = [
    ["all", "initial"], ["position", "fixed"], ["inset", "0"], ["display", "block"],
    ["width", "auto"], ["height", "auto"], ["max-width", "none"], ["max-height", "none"],
    ["margin", "0"], ["padding", "0"], ["border", "0"], ["background", "transparent"],
    ["overflow", "visible"], ["opacity", "1"], ["visibility", "visible"],
    ["transform", "none"], ["filter", "none"], ["clip-path", "none"],
    ["pointer-events", "none"], ["z-index", "2147483647"], ["contain", "strict"],
  ];

  const ui = {
    host: null, cur: null, rip: null, pulse: null, hl: null, face: null, watcher: null,
    enabled: true, x: null, y: null, drawn: "", raf: 0, mode: "", voice: "thinking",
    idleTimer: 0, settleTimer: 0, pressTimer: 0, hlTimer: 0, goal: null, pending: null,
  };

  let mql = null;
  function reduced() {
    try {
      if (!mql && globalThis.matchMedia) mql = globalThis.matchMedia(REDUCE);
      return !!(mql && mql.matches);
    } catch { return false; }
  }

  function pinHostStyle(host) {
    for (const [k, v] of HOST_STYLE) host.style.setProperty(k, v, "important");
  }

  function mount() {
    if (ui.host && ui.host.isConnected) return true;
    const root = document.documentElement;
    if (!root) return false;
    const host = document.createElement("clearcart-cursor");
    host.setAttribute(OVERLAY_ATTR, String(RANK));
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("inert", "");
    host.setAttribute("tabindex", "-1");
    if ("popover" in host) host.setAttribute("popover", "manual");
    pinHostStyle(host);

    const shadow = host.attachShadow({ mode: "closed" });
    const css = (FACE ? FACE.CSS : "") + CSS;
    let adopted = false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet]; // not subject to page style-src CSP
      adopted = true;
    } catch {}
    if (!adopted) {
      const style = document.createElement("style");
      style.textContent = css;
      shadow.append(style);
    }
    const layer = document.createElement("div");
    layer.className = "layer";
    const hl = document.createElement("div");
    hl.className = "hl";
    const pulse = document.createElement("div");
    pulse.className = "pulse";
    const rip = document.createElement("div");
    rip.className = "rip";
    const cur = document.createElement("div");
    cur.className = "cur idle";
    const whl = document.createElement("span");
    whl.className = "whl";
    whl.append(build(WHEEL));
    cur.append(build(ARROW), build(IBEAM), whl);
    const otag = document.createElement("span");
    otag.className = "otag";
    const face = FACE ? FACE.create(document, { canPlay: () => !!ui.cur && !ui.cur.classList.contains("idle") }) : null;
    if (face) {
      face.setState(ui.voice);
      otag.append(face.el);
    }
    cur.append(otag);
    layer.append(hl, pulse, rip, cur);
    shadow.append(layer);
    place(root, host);
    if (ui.face) ui.face.destroy();
    Object.assign(ui, { host, cur, rip, pulse, hl, face, drawn: "", mode: "" });
    keepLast(root);
    raise();
    return true;
  }

  // Top of the top layer, once per mount (and after a re-place): never per
  // sample, so it does not fight the subtitles, which raise when they show.
  function raise() {
    const host = ui.host;
    if (!host || typeof host.showPopover !== "function") return;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {}
  }

  // The shared re-append rule (content/frame.js, content/subtitles.js): every
  // Clearcart overlay host carries OVERLAY_ATTR with its rank; a host only
  // moves when a non-Clearcart element follows it, and a valve stops
  // re-appending for a while against a page that also keeps itself last.
  // Rank 1.5: above the frame (1), under the subtitles (2).
  const OVERLAY_ATTR = "data-clearcart-overlay";
  const VALVE_MAX = 20;       // re-appends allowed per window
  const VALVE_WINDOW_MS = 1000;
  const VALVE_PAUSE_MS = 3000;
  const RANK = 1.5;
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
      raise();
    }
    if (host.style.getPropertyPriority("z-index") !== "important") pinHostStyle(host);
  }
  function keepLast(root) {
    if (ui.watcher || typeof MutationObserver !== "function") return;
    ui.watcher = new MutationObserver(check);
    ui.watcher.observe(root, { childList: true });
  }

  // ------------------------------------------------------------ drawing

  // One transform write per frame, whatever the sample rate.
  function draw() {
    ui.raf = 0;
    if (!ui.cur || ui.x == null) return;
    const t = `translate3d(${ui.x}px, ${ui.y}px, 0)`;
    if (t !== ui.drawn) {
      ui.cur.style.transform = t;
      ui.drawn = t;
    }
  }
  function schedule() {
    if (ui.raf) return;
    if (typeof requestAnimationFrame === "function") ui.raf = requestAnimationFrame(draw);
    else draw();
  }
  function moveTo(x, y, now) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    ui.x = Math.round(x);
    ui.y = Math.round(y);
    if (now || !ui.drawn) {
      if (ui.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(ui.raf);
      ui.raf = 0;
      draw();
    } else {
      schedule();
    }
  }

  function setMode(mode) {
    if (!ui.cur || mode === ui.mode) return;
    if (ui.mode) ui.cur.classList.remove(`m-${ui.mode}`);
    ui.cur.classList.add(`m-${mode}`);
    ui.mode = mode;
  }

  function wake() {
    if (ui.cur && ui.cur.classList.contains("idle") && ui.x != null) ui.cur.classList.remove("idle");
    clearTimeout(ui.idleTimer);
    ui.idleTimer = setTimeout(rest, IDLE_MS);
  }

  // Idle, turn end, interrupt: the caption goes, the cursor stays put.
  function rest() {
    clearTimeout(ui.idleTimer);
    ui.idleTimer = 0;
    caption("");
    settle();
    release();
    ui.goal = null;
    if (ui.pending) moveTo(ui.pending.x, ui.pending.y, true);
    ui.pending = null;
    setMode("move");
    save();
  }

  // The last position, per tab (sessionStorage is per tab and survives reloads).
  function save() {
    if (ui.x == null) return;
    try { globalThis.sessionStorage.setItem(SAVE_KEY, JSON.stringify({ x: ui.x, y: ui.y })); } catch {}
  }
  function saved() {
    try {
      const v = JSON.parse(globalThis.sessionStorage.getItem(SAVE_KEY) || "null");
      return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : null;
    } catch { return null; }
  }

  // Redraw at the saved spot (load, back/forward cache, setting back on).
  function restore() {
    if (!ui.enabled || ui.host) return;
    const at = saved();
    if (!at || !mount()) return;
    setMode("move");
    moveTo(at.x, at.y, true);
    if (ui.cur) ui.cur.classList.remove("idle");
  }

  // Off the page: no host, no observer, no timers.
  function teardown() {
    for (const k of ["idleTimer", "settleTimer", "pressTimer", "hlTimer"]) {
      clearTimeout(ui[k]);
      ui[k] = 0;
    }
    if (ui.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(ui.raf);
    ui.raf = 0;
    if (ui.watcher) ui.watcher.disconnect();
    ui.watcher = null;
    try { if (ui.host && ui.host.matches(":popover-open")) ui.host.hidePopover(); } catch {}
    if (ui.face) ui.face.destroy();
    if (ui.host) ui.host.remove();
    ui.host = ui.cur = ui.rip = ui.pulse = ui.hl = ui.face = null;
    ui.x = ui.y = null;
    ui.goal = ui.pending = null;
    ui.drawn = ui.mode = "";
  }

  function hideNow() {
    caption("");
    teardown();
  }

  // ------------------------------------------------------------ feedback

  // Web Animations: no class toggling, so no forced reflow to restart them.
  function play(el, frames, opts) {
    if (!el || typeof el.animate !== "function") return null;
    try { return el.animate(frames, opts); } catch { return null; }
  }

  function boxAround(el, r, pad) {
    el.style.width = `${Math.round(r.width + pad * 2)}px`;
    el.style.height = `${Math.round(r.height + pad * 2)}px`;
    el.style.transform = `translate3d(${Math.round(r.x - pad)}px, ${Math.round(r.y - pad)}px, 0)`;
  }

  function validRect(r) {
    return r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
  }

  function feedback(x, y, rect) {
    const still = reduced();
    if (!still && ui.rip) {
      ui.rip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      play(ui.rip, [
        { transform: `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) scale(.25)`, opacity: 0.75 },
        { transform: `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) scale(1)`, opacity: 0 },
      ], { duration: 520, easing: "cubic-bezier(.2,.7,.3,1)" });
    }
    if (!validRect(rect)) return;
    if (!still && ui.pulse) {
      boxAround(ui.pulse, rect, 0);
      const sx = (rect.width + 20) / rect.width;
      const sy = (rect.height + 20) / rect.height;
      const at = `translate3d(${Math.round(rect.x)}px, ${Math.round(rect.y)}px, 0)`;
      play(ui.pulse, [
        { transform: `${at} scale(1, 1)`, opacity: 0.9 },
        { transform: `${at} scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`, opacity: 0 },
      ], { duration: 700, easing: "ease-out" });
    }
    if (ui.hl) {
      boxAround(ui.hl, rect, 5);
      clearTimeout(ui.hlTimer);
      if (still) {
        ui.hl.classList.add("still");
        ui.hlTimer = setTimeout(() => { ui.hlTimer = 0; if (ui.hl) ui.hl.classList.remove("still"); }, HL_MS);
      } else {
        ui.hl.classList.remove("still");
        play(ui.hl, [{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.7 }, { opacity: 0, offset: 1 }], { duration: HL_MS, easing: "ease-out" });
      }
    }
  }

  // ------------------------------------------------------------ captions

  function caption(text) {
    const c = globalThis.__clearcartCaption;
    if (!c || typeof c.set !== "function") return;
    try { c.set(text); } catch {}
  }

  const CONTROL = "a[href], button, input, select, textarea, summary, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=searchbox], [role=textbox]";
  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}...` : s);

  // A short name for the control at (x, y) in this frame, or "". One hit
  // test per gesture, never per sample. Never reads a field's value, except
  // a button input's, which is its label.
  function labelAt(x, y) {
    let el = null;
    try { el = document.elementFromPoint(x, y); } catch {}
    if (!el || el.localName === "iframe" || el.localName === "frame") return "";
    const c = el.closest ? el.closest(CONTROL) : null;
    if (!c) return "";
    const aria = c.getAttribute("aria-label");
    if (aria) return clip(squash(aria));
    if (c.localName === "input") {
      const kind = (c.getAttribute("type") || "text").toLowerCase();
      if (kind === "submit" || kind === "button" || kind === "reset") return clip(squash(c.value));
      return clip(squash(c.getAttribute("placeholder") || c.getAttribute("title") || ""));
    }
    if (c.localName === "textarea" || c.localName === "select") return clip(squash(c.getAttribute("placeholder") || c.getAttribute("title") || ""));
    return clip(squash(c.textContent || c.getAttribute("title") || ""));
  }

  function gestureCaption(action, to) {
    if (action === "scroll") return "Scrolling";
    const name = to ? labelAt(to.x, to.y) : "";
    if (action === "click") return name ? `Clicking ${name}` : "Clicking";
    if (action === "hover") return name ? `Pointing at ${name}` : "";
    return "";
  }

  // ------------------------------------------------------------ samples

  // The subtitles' click-away ignores a pointerdown while the agent's
  // pointer is moving or pressing: that click is the agent's.
  const BUSY_MS = 600;
  let lastSample = -Infinity;
  globalThis.__clearcartAgentPointer = Object.freeze({ busy: () => Date.now() - lastSample < BUSY_MS });

  function onSample(msg) {
    if (msg.phase === "hide") { lastSample = -Infinity; return ui.host ? rest() : caption(""); }
    if (msg.phase === "move" || msg.phase === "press" || msg.phase === "release") lastSample = Date.now();
    if (!ui.enabled) return;
    if (STATES.has(msg.voice) && msg.voice !== ui.voice) {
      ui.voice = msg.voice;
      if (ui.face) ui.face.setState(ui.voice);
    }
    const hasPoint = Number.isFinite(msg.x) && Number.isFinite(msg.y);
    // Typing with no pointer yet in this tab: just the caption.
    if (!hasPoint && !ui.host) {
      if (msg.phase === "type") caption(msg.text ? `Typing ${msg.text}` : "Typing");
      return;
    }
    if (!mount()) return;
    const still = reduced();
    switch (msg.phase) {
      case "move": {
        setMode(msg.action === "scroll" ? "move" : msg.action || "move");
        const to = msg.to && Number.isFinite(msg.to.x) && Number.isFinite(msg.to.y) ? msg.to : null;
        if (to && (!ui.goal || ui.goal.x !== to.x || ui.goal.y !== to.y || ui.goal.action !== msg.action)) {
          ui.goal = { x: to.x, y: to.y, action: msg.action };
          const text = gestureCaption(msg.action, to);
          if (text) caption(text);
        }
        if (still) {
          // Jump to where the pointer comes to rest, no path.
          ui.pending = { x: msg.x, y: msg.y };
          if (ui.x == null) moveTo(msg.x, msg.y, true);
          clearTimeout(ui.settleTimer);
          ui.settleTimer = setTimeout(() => {
            ui.settleTimer = 0;
            if (ui.pending) moveTo(ui.pending.x, ui.pending.y, true);
            ui.pending = null;
          }, SETTLE_MS);
        } else {
          moveTo(msg.x, msg.y, false);
        }
        break;
      }
      case "press":
        setMode("click");
        settle();
        moveTo(msg.x, msg.y, true);
        if (ui.cur) ui.cur.classList.add("prs");
        clearTimeout(ui.pressTimer);
        ui.pressTimer = setTimeout(release, 300);
        feedback(msg.x, msg.y, msg.rect);
        break;
      case "release":
        release();
        moveTo(msg.x, msg.y, true);
        break;
      case "wheel":
        settle();
        setMode("scroll");
        moveTo(msg.x, msg.y, true);
        if (!ui.goal || ui.goal.action !== "scroll") {
          ui.goal = { x: msg.x, y: msg.y, action: "scroll" };
          caption("Scrolling");
        }
        break;
      case "type":
        settle();
        setMode("type");
        ui.goal = null;
        if (hasPoint) moveTo(msg.x, msg.y, true);
        caption(msg.text ? `Typing ${msg.text}` : "Typing");
        break;
      case "key":
        if (ui.mode !== "type") setMode("type");
        break;
      default:
        return;
    }
    wake();
  }

  function settle() {
    clearTimeout(ui.settleTimer);
    ui.settleTimer = 0;
    ui.pending = null;
  }

  function release() {
    clearTimeout(ui.pressTimer);
    ui.pressTimer = 0;
    if (ui.cur) ui.cur.classList.remove("prs");
  }

  function setEnabled(on) {
    ui.enabled = on !== false;
    if (!ui.enabled) hideNow();
    else restore();
  }

  const chromeApi = globalThis.chrome;
  if (chromeApi && chromeApi.runtime && chromeApi.runtime.onMessage) {
    chromeApi.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object" || msg.type !== RT.CURSOR) return;
      onSample(msg);
      // No response: never hold the message channel open.
    });
  }

  const storage = chromeApi && chromeApi.storage;
  if (storage && storage.local) {
    try {
      Promise.resolve(storage.local.get("showCursor"))
        .then((v) => { if (v && v.showCursor === false) setEnabled(false); else restore(); })
        .catch(restore);
    } catch { restore(); }
  } else {
    restore();
  }
  if (storage && storage.onChanged) {
    storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.showCursor) setEnabled(changes.showCursor.newValue);
    });
  }

  // The page is going away: keep the spot for a reload or the back/forward
  // cache. A tab switch leaves the cursor where it is, drawn on return.
  globalThis.addEventListener?.("pagehide", () => { save(); hideNow(); });
  globalThis.addEventListener?.("pageshow", (e) => { if (e && e.persisted) restore(); });
})();
