// Clearcart active-tab frame: a faint rotating spectrum ring around the page
// of the tab Clearcart is working in, like Claude in Chrome's frame.
//
// The worker (background/frame.js) decides which tab gets it and sends
// RT.FRAME { on } to that tab's top frame. One ring, no per-state variants:
// a conic gradient in the orb colours, masked to a 2px border, at opacity
// .45, turning once every 6s. It fades in and out over 300 ms. With reduced
// motion it holds still.
//
// Classic content script (no imports), top frame only. Purely visual, like
// content/subtitles.js: the host is aria-hidden and inert, takes no pointer
// events, never takes focus, and lives in a closed shadow root. It is a manual
// popover so it renders in the top layer above dialogs and banners, and every
// host style is inline with !important. Nothing is added to the page until
// the first "on".

(() => {
  "use strict";

  const FLAG = "__clearcartFrame";
  if (globalThis[FLAG]) return; // idempotent if injected twice
  if (globalThis.top !== globalThis) return; // top frame only
  globalThis[FLAG] = true;

  const RT = { FRAME: "frame" };
  const FADE_MS = 300;

  // The ring angle. An @property inside a shadow root is not registered by
  // Chrome, so it is also registered for the document (a name no page uses);
  // without that the angle would not animate.
  const ANGLE = "--clearcart-frame-a";
  function registerAngle() {
    try {
      globalThis.CSS?.registerProperty?.({ name: ANGLE, syntax: "<angle>", inherits: false, initialValue: "0deg" });
    } catch {} // already registered (an earlier injection or the page)
  }

  const CSS = `
@property --clearcart-frame-a { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
:host { all: initial !important; pointer-events: none !important; }
.ring {
  position: fixed; inset: 0; box-sizing: border-box;
  padding: 2px;
  background: conic-gradient(from var(--clearcart-frame-a), #ff9f6b, #ff5f8f, #b56cff, #5e8bff, #4fd1ff, #ff9f6b);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  opacity: 0; visibility: hidden;
  transition: opacity .3s ease, visibility 0s linear .3s;
  animation: turn 6s linear infinite;
  animation-play-state: paused;
  pointer-events: none;
}
.ring.on {
  opacity: .45; visibility: visible;
  transition: opacity .3s ease, visibility 0s;
  animation-play-state: running;
}
@keyframes turn { from { --clearcart-frame-a: 0deg; } to { --clearcart-frame-a: 360deg; } }
@media (prefers-reduced-motion: reduce) {
  .ring, .ring.on { animation: none; }
}
@media (forced-colors: active) {
  .ring { forced-color-adjust: none; }
}
`;

  // Inline !important beats any page rule and the UA popover styles.
  const HOST_STYLE = [
    ["all", "initial"], ["position", "fixed"], ["inset", "0"], ["display", "block"],
    ["width", "auto"], ["height", "auto"], ["max-width", "none"], ["max-height", "none"],
    ["margin", "0"], ["padding", "0"], ["border", "0"], ["background", "transparent"],
    ["overflow", "visible"], ["opacity", "1"], ["visibility", "visible"],
    ["transform", "none"], ["filter", "none"], ["clip-path", "none"],
    ["pointer-events", "none"], ["z-index", "2147483647"], ["contain", "strict"],
  ];

  const ui = { host: null, ring: null, on: false, removeTimer: 0, watcher: null };

  function pinHostStyle(host) {
    for (const [k, v] of HOST_STYLE) host.style.setProperty(k, v, "important");
  }

  function mount() {
    if (ui.host && ui.host.isConnected) return true;
    const root = document.documentElement;
    if (!root) return false;
    registerAngle();
    const host = document.createElement("clearcart-frame");
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("inert", "");
    host.setAttribute("tabindex", "-1");
    if ("popover" in host) host.setAttribute("popover", "manual");
    pinHostStyle(host);

    const shadow = host.attachShadow({ mode: "closed" });
    let adopted = false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet]; // not subject to page style-src CSP
      adopted = true;
    } catch {}
    if (!adopted) {
      const style = document.createElement("style");
      style.textContent = CSS;
      shadow.append(style);
    }
    const ring = document.createElement("div");
    ring.className = "ring";
    shadow.append(ring);
    root.append(host);
    Object.assign(ui, { host, ring });
    keepLast(root);
    return true;
  }

  // Top of the top layer: a later showPopover/showModal would stack above us.
  function raise() {
    const host = ui.host;
    if (!host || typeof host.showPopover !== "function") return;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {}
  }

  // Pages that append their own overlay after us, or rewrite our inline style.
  function keepLast(root) {
    if (ui.watcher || typeof MutationObserver !== "function") return;
    ui.watcher = new MutationObserver(() => {
      const host = ui.host;
      if (!host) return;
      if (host.parentNode !== root || root.lastElementChild !== host) {
        root.append(host);
        if (ui.on) raise();
      }
      if (host.style.getPropertyPriority("z-index") !== "important") pinHostStyle(host);
    });
    ui.watcher.observe(root, { childList: true });
  }

  function show() {
    clearTimeout(ui.removeTimer);
    ui.removeTimer = 0;
    if (!mount()) return;
    ui.on = true;
    raise();
    // Next frame, so the fade-in runs from opacity 0 on a fresh mount.
    const add = () => { if (ui.on && ui.ring) ui.ring.classList.add("on"); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(add);
    else add();
  }

  // Fade out, then take the host out of the top layer and the page.
  function hide() {
    ui.on = false;
    if (!ui.ring) return;
    ui.ring.classList.remove("on");
    clearTimeout(ui.removeTimer);
    ui.removeTimer = setTimeout(() => {
      ui.removeTimer = 0;
      if (ui.on) return;
      if (ui.watcher) ui.watcher.disconnect();
      ui.watcher = null;
      try { if (ui.host && ui.host.matches(":popover-open")) ui.host.hidePopover(); } catch {}
      if (ui.host) ui.host.remove();
      ui.host = ui.ring = null;
    }, FADE_MS + 50);
  }

  const chromeApi = globalThis.chrome;
  if (chromeApi && chromeApi.runtime && chromeApi.runtime.onMessage) {
    chromeApi.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== "object" || msg.type !== RT.FRAME) return;
      if (msg.on === true) show();
      else hide();
      // Answered at once, so the worker knows the frame script is here;
      // the channel is never held open.
      try { sendResponse({ frame: true }); } catch {}
    });
  }

  // A page put in the back/forward cache comes back without a message: drop
  // the ring on the way out; the worker sends "on" again if it should show.
  globalThis.addEventListener?.("pagehide", () => {
    ui.on = false;
    clearTimeout(ui.removeTimer);
    ui.removeTimer = 0;
    if (ui.watcher) ui.watcher.disconnect();
    ui.watcher = null;
    if (ui.host) ui.host.remove();
    ui.host = ui.ring = null;
  });
})();
