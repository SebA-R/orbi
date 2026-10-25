// What the user is pointing at, for "add this one to my cart". A classic
// content script declared for every page (top frame), and injected again on
// demand before page_context in case the tab was open before the extension.
//
// It only remembers elements, never text: the last element under the mouse,
// the last one clicked and the last one focused, each with a time. Mouse
// tracking is throttled. content/page.js (same isolated world) reads this
// with globalThis.__clearcartContext.snapshot() when the worker asks for
// page_context, names the element, masks payment and password fields and
// gives it a ref. Nothing leaves the page from here.

(() => {
  "use strict";
  if (globalThis.__clearcartContext) return;

  const THROTTLE_MS = 150;
  const state = { hover: null, click: null, focus: null };
  const now = () => Date.now();
  const ref = (el) => (typeof WeakRef === "function" ? new WeakRef(el) : { deref: () => el });

  function target(e) {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const el = path.find((n) => n && n.nodeType === 1) || e.target;
    return el && el.nodeType === 1 ? el : null;
  }

  // Trailing throttle: at most one update per THROTTLE_MS, and the element
  // the mouse stops on always wins.
  let pending = null;
  let timer = 0;
  function onOver(e) {
    pending = target(e);
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      if (pending) state.hover = { el: ref(pending), at: now() };
      pending = null;
    }, THROTTLE_MS);
  }

  const remember = (kind) => (e) => {
    const el = target(e);
    if (el) state[kind] = { el: ref(el), at: now() };
  };

  const opts = { capture: true, passive: true };
  window.addEventListener("mouseover", onOver, opts);
  window.addEventListener("pointerdown", remember("click"), opts);
  window.addEventListener("focusin", remember("focus"), opts);
  // The mouse left the page: nothing is under it any more.
  document.documentElement?.addEventListener("mouseleave", () => { state.hover = null; }, opts);

  function live(entry) {
    const el = entry && entry.el.deref();
    return el && el.isConnected ? { el, at: entry.at } : null;
  }

  globalThis.__clearcartContext = {
    snapshot() {
      return { hover: live(state.hover), click: live(state.click), focus: live(state.focus) };
    },
  };
})();
