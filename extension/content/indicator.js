// "Clearcart is using this tab": a small pill at the top right of the tab
// the agent is acting on. Injected on demand by the worker
// (chrome.scripting.executeScript, files: ["content/indicator.js"]) on every
// call that touches the tab; each injection shows the pill again and pushes
// back its hide timer, so it stays up while the agent works and fades
// HIDE_AFTER_MS after the last call.
//
// Visual only, like content/subtitles.js: the host is aria-hidden and inert,
// takes no pointer events (so the button lock's hit tests and a person's
// clicks go straight through), and lives in a closed shadow root. It is a
// manual popover so it renders in the top layer, above dialogs and banners,
// and is re-raised each time it shows.

(() => {
  "use strict";

  const HIDE_AFTER_MS = 10_000;
  const existing = globalThis.__clearcartIndicator;
  if (existing) return existing.show();

  const CSS = `
:host { all: initial !important; }
.pill {
  position: fixed; top: 12px; right: 12px;
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px 6px 10px; border-radius: 999px;
  font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif;
  color: #1d1d1f; background: rgb(255 255 255 / .88); border: 1px solid rgb(0 0 0 / .1);
  box-shadow: 0 4px 16px rgb(30 34 60 / .16);
  -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  opacity: 0; transform: translateY(-4px); transition: opacity .25s ease, transform .25s ease;
  pointer-events: none; user-select: none; -webkit-user-select: none;
}
.pill.on { opacity: 1; transform: none; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #2e8bff; }
@media (prefers-color-scheme: dark) {
  .pill { color: #f5f5f7; background: rgb(28 28 30 / .86); border-color: rgb(255 255 255 / .12); }
}
@media (prefers-reduced-motion: reduce) { .pill { transition: none; transform: none; } }
@media (forced-colors: active) { .pill { background: Canvas; color: CanvasText; border-color: CanvasText; } }
`;

  const HOST_STYLE = [
    ["all", "initial"], ["position", "fixed"], ["inset", "0"], ["display", "block"],
    ["width", "100vw"], ["height", "100vh"], ["max-width", "none"], ["max-height", "none"],
    ["margin", "0"], ["padding", "0"], ["border", "0"], ["background", "transparent"],
    ["overflow", "visible"], ["opacity", "1"], ["visibility", "visible"],
    ["pointer-events", "none"], ["z-index", "2147483647"], ["contain", "layout style"],
  ];

  let host = null;
  let pill = null;
  let timer = 0;

  function mount() {
    if (host && host.isConnected) return true;
    const root = document.documentElement;
    if (!root) return false;
    host = document.createElement("clearcart-indicator");
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("inert", "");
    host.setAttribute("translate", "no");
    if ("popover" in host) host.setAttribute("popover", "manual");
    for (const [k, v] of HOST_STYLE) host.style.setProperty(k, v, "important");
    const shadow = host.attachShadow({ mode: "closed" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = CSS;
      shadow.append(style);
    }
    pill = document.createElement("div");
    pill.className = "pill";
    const dot = document.createElement("span");
    dot.className = "dot";
    pill.append(dot, document.createTextNode("Clearcart is using this tab"));
    shadow.append(pill);
    root.append(host);
    return true;
  }

  function raise() {
    if (typeof host.showPopover !== "function") return;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {}
  }

  function hide() {
    clearTimeout(timer);
    timer = 0;
    if (pill) pill.classList.remove("on");
    setTimeout(() => {
      if (!timer && host) {
        host.remove();
        host = pill = null;
      }
    }, 400);
  }

  function show() {
    if (!mount()) return;
    raise();
    pill.classList.add("on");
    clearTimeout(timer);
    timer = setTimeout(hide, HIDE_AFTER_MS);
  }

  globalThis.__clearcartIndicator = { show, hide };
  show();
})();
