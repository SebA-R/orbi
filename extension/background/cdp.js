// Trusted input and screenshots through chrome.debugger (CDP protocol 1.3).
// Attaches lazily per tab; Chrome detaches automatically when a tab closes,
// and onTabRemoved/onDetach keep the attached set in sync. Callers resolve
// and allowlist-check the tab first (tabs.resolveAllowedTab).

import { BridgeError, ERR } from "../lib/protocol.js";

export const PROTOCOL = "1.3";
const api = () => globalThis.chrome;
const attached = new Set();

// CDP modifier bits.
const MOD = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

// Named keys: [key, code, windowsVirtualKeyCode, text?]
const KEYS = {
  enter: ["Enter", "Enter", 13, "\r"],
  return: ["Enter", "Enter", 13, "\r"],
  tab: ["Tab", "Tab", 9],
  escape: ["Escape", "Escape", 27],
  esc: ["Escape", "Escape", 27],
  backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46],
  space: [" ", "Space", 32, " "],
  arrowup: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
};

function message(e) {
  return e?.message || String(e);
}

function assertTabId(tabId) {
  if (!Number.isInteger(tabId)) throw new BridgeError(ERR.BAD_REQUEST, "tabId must be an integer");
}

function num(v, name) {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) throw new BridgeError(ERR.BAD_REQUEST, `${name} must be a finite number`);
  return n;
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

// How long a fresh attach waits for Chrome's "started debugging this
// browser" bar to open: it slides in over about 150 ms and shrinks the
// viewport, which moves anything not pinned to the top of the page.
const BAR_WAIT_MS = 400;
const BAR_SETTLE_MS = 150;
const BAR_POLL_MS = 50;
export const _barTiming = { wait: BAR_WAIT_MS, settle: BAR_SETTLE_MS, poll: BAR_POLL_MS };
// Off in the unit tests that check the exact commands sent.
let settleOnAttach = true;

// Attaches if needed. Answers true when this call attached and the
// viewport changed size meanwhile (the debugging bar opened): points and
// screenshots taken before it are stale.
export async function attach(tabId) {
  assertTabId(tabId);
  if (attached.has(tabId)) return false;
  let ours = true;
  try {
    await api().debugger.attach({ tabId }, PROTOCOL);
  } catch (e) {
    // A previous worker instance may still hold the session; reuse it.
    if (!/already attached/i.test(message(e))) {
      if (/no tab/i.test(message(e))) throw new BridgeError(ERR.NO_TAB, `no tab ${tabId}`);
      throw new BridgeError(ERR.INTERNAL, `debugger attach failed: ${message(e)}`);
    }
    ours = false;
  }
  attached.add(tabId);
  return ours && settleOnAttach ? barSettled(tabId) : false;
}

// Waits for the viewport to stop changing after an attach: up to
// _barTiming.wait for the bar to start, then until the height holds for
// _barTiming.settle. Answers whether it changed.
async function barSettled(tabId) {
  const height = async () => {
    try {
      const m = (await api().debugger.sendCommand({ tabId }, "Page.getLayoutMetrics")) || {};
      return (m.cssLayoutViewport || m.cssVisualViewport || {}).clientHeight ?? null;
    } catch {
      return null;
    }
  };
  const { wait, settle, poll } = _barTiming;
  const first = await height();
  if (first == null) return false;
  let last = first;
  let changedAt = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < wait + settle * 4) {
    await new Promise((r) => setTimeout(r, poll));
    const h = await height();
    if (h == null) break;
    if (h !== last) {
      last = h;
      changedAt = Date.now();
    } else if (changedAt ? Date.now() - changedAt >= settle : Date.now() - t0 >= wait) break;
  }
  return last !== first;
}

export async function detach(tabId) {
  if (!attached.delete(tabId)) return;
  try {
    await api().debugger.detach({ tabId });
  } catch {}
}

export async function detachAll() {
  await Promise.all([...attached].map(detach));
}

// Listener bodies for the worker to register at top level.
export function onTabRemoved(tabId) {
  attached.delete(tabId);
}

export function onDetach(source) {
  if (source?.tabId != null) attached.delete(source.tabId);
}

export async function send(tabId, method, params = {}) {
  await attach(tabId);
  try {
    return await api().debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    if (!/not attached/i.test(message(e))) throw new BridgeError(ERR.INTERNAL, `${method} failed: ${message(e)}`);
    // Detached behind our back (e.g. user dismissed the banner): retry once.
    attached.delete(tabId);
    await attach(tabId);
    try {
      return await api().debugger.sendCommand({ tabId }, method, params);
    } catch (e2) {
      throw new BridgeError(ERR.INTERNAL, `${method} failed: ${message(e2)}`);
    }
  }
}

export async function click({ tabId, x, y } = {}) {
  assertTabId(tabId);
  const px = num(x, "x");
  const py = num(y, "y");
  const base = { x: px, y: py, button: "left", clickCount: 1 };
  // A failed move pressed nothing: callers may fall back to a DOM click.
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", buttons: 0 });
  // From the press on, a failure may follow a press the page already took
  // (a mousedown handler, an order placed), as in actor.click: callers must
  // not click again by DOM, and the message tells the model to look first.
  try {
    await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1 });
    await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 });
  } catch (e) {
    throw Object.assign(new BridgeError(ERR.INTERNAL, `the click may have reached the page (${message(e)}); check the page before clicking again`), { noFallback: true });
  }
}

export async function type({ tabId, text } = {}) {
  assertTabId(tabId);
  if (typeof text !== "string") throw new BridgeError(ERR.BAD_REQUEST, "text must be a string");
  if (!text) return;
  await send(tabId, "Input.insertText", { text });
}

// Parses "Enter", "a", "Shift+Tab", "Ctrl+A" into CDP key event fields.
export function parseKey(spec) {
  if (typeof spec !== "string" || !spec) throw new BridgeError(ERR.BAD_REQUEST, "key must be a non-empty string");
  // Control characters ("\r", "\n", "\t", NUL...) are not key names, and
  // "\r" as text would press Enter past every check keyed on the name.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(spec)) throw new BridgeError(ERR.BAD_REQUEST, "key must not contain control characters");
  const parts = spec === "+" ? ["+"] : spec.split("+");
  const main = parts.pop();
  let modifiers = 0;
  for (const p of parts) {
    const bit = MOD[p.trim().toLowerCase()];
    if (!bit) throw new BridgeError(ERR.BAD_REQUEST, `unknown modifier: ${p}`);
    modifiers |= bit;
  }
  const named = KEYS[main.toLowerCase()];
  if (named) {
    const [key, code, vk, text] = named;
    return { key, code, windowsVirtualKeyCode: vk, text: modifiers & ~MOD.shift ? undefined : text, modifiers };
  }
  if ([...main].length === 1) {
    const upper = main.toUpperCase();
    const isLetter = /[a-z]/i.test(main);
    const isDigit = /[0-9]/.test(main);
    return {
      key: modifiers & MOD.shift && isLetter ? upper : main,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${main}` : undefined,
      windowsVirtualKeyCode: isLetter || isDigit ? upper.charCodeAt(0) : undefined,
      text: modifiers & ~MOD.shift ? undefined : modifiers & MOD.shift && isLetter ? upper : main,
      modifiers,
    };
  }
  throw new BridgeError(ERR.BAD_REQUEST, `unknown key: ${main}`);
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export async function key({ tabId, key: spec } = {}) {
  assertTabId(tabId);
  const k = parseKey(spec);
  const { text, ...rest } = k;
  await send(tabId, "Input.dispatchKeyEvent", clean({ ...rest, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text }));
  await send(tabId, "Input.dispatchKeyEvent", clean({ ...rest, type: "keyUp" }));
}

export async function scroll({ tabId, x, y, dx = 0, dy = 0 } = {}) {
  assertTabId(tabId);
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: num(x, "x"),
    y: num(y, "y"),
    deltaX: num(dx, "dx"),
    deltaY: num(dy, "dy"),
  });
}

// The tab's viewport in CSS pixels, the space Input.dispatchMouseEvent
// takes, and its device pixel ratio (device px per CSS px).
export async function viewport(tabId) {
  assertTabId(tabId);
  const m = (await send(tabId, "Page.getLayoutMetrics")) || {};
  // The layout viewport: input goes in window coordinates, which pinch zoom
  // does not shrink.
  const css = m.cssLayoutViewport || m.cssVisualViewport;
  if (!css || !(css.clientWidth > 0) || !(css.clientHeight > 0)) throw new BridgeError(ERR.INTERNAL, "no viewport size");
  const dev = m.cssLayoutViewport ? m.layoutViewport : m.visualViewport;
  let dpr = dev && dev.clientWidth > 0 ? dev.clientWidth / css.clientWidth : 1;
  if (!Number.isFinite(dpr) || dpr <= 0) dpr = 1;
  return { width: Math.round(css.clientWidth), height: Math.round(css.clientHeight), dpr };
}

// Refuses a point outside the viewport, in words the model can act on: on a
// 2x screen a coordinate read off a device-pixel image lands past the edge.
export function assertInViewport(vp, x, y) {
  if (x < 0 || y < 0 || x > vp.width || y > vp.height) {
    throw new BridgeError(
      ERR.BAD_REQUEST,
      `x ${Math.round(x)}, y ${Math.round(y)} is outside the ${vp.width}x${vp.height} viewport. Coordinates are CSS pixels, the same as the screenshot's size; take a new screenshot, or click by ref.`
    );
  }
}

// Width and height of a base64 JPEG, from its frame header.
export function jpegSize(data) {
  const bin = atob(data.slice(0, 87_384)); // the header sits near the start
  for (let i = 2; i + 8 < bin.length; ) {
    if (bin.charCodeAt(i) !== 0xff) return null;
    const m = bin.charCodeAt(i + 1);
    const len = (bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (bin.charCodeAt(i + 5) << 8) | bin.charCodeAt(i + 6), width: (bin.charCodeAt(i + 7) << 8) | bin.charCodeAt(i + 8) };
    }
    i += 2 + len;
  }
  return null;
}

// Shrinks a device-pixel capture to w x h. Needs createImageBitmap and
// OffscreenCanvas (a service worker has both); null without them.
async function resize(data, w, h) {
  const g = globalThis;
  if (typeof g.createImageBitmap !== "function" || typeof g.OffscreenCanvas !== "function") return null;
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const bitmap = await g.createImageBitmap(new Blob([bytes], { type: "image/jpeg" }), { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
  const canvas = new g.OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const out = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 })).arrayBuffer());
  let bin = "";
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(bin);
}

// A JPEG of the viewport at CSS-pixel size: on a 2x screen Chrome captures
// device pixels (2880x1800 for a 1440x900 viewport), and coordinates read
// off that image would land outside the page. width and height are the
// image's size in CSS px; scale is image px per CSS px (1 unless the
// capture could not be resized).
export async function screenshot({ tabId } = {}) {
  assertTabId(tabId);
  const vp = await viewport(tabId);
  const { data } = await send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
  let size = null;
  try {
    size = jpegSize(data);
  } catch {}
  const img = size || { width: Math.round(vp.width * vp.dpr), height: Math.round(vp.height * vp.dpr) };
  // Image px per CSS px: the device pixel ratio, or 1 when Chrome already
  // captured at CSS size.
  const ratio = Math.abs(img.width / vp.width - 1) < 0.05 ? 1 : vp.dpr;
  const css = { width: Math.round(img.width / ratio), height: Math.round(img.height / ratio) };
  if (ratio === 1) return { data, mimeType: "image/jpeg", ...css, scale: 1 };
  const small = await resize(data, css.width, css.height).catch(() => null);
  if (small) return { data: small, mimeType: "image/jpeg", ...css, scale: 1 };
  return { data, mimeType: "image/jpeg", ...css, scale: ratio };
}

export function _resetForTests({ settle = false } = {}) {
  attached.clear();
  settleOnAttach = settle;
}
