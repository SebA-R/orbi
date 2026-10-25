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

export async function attach(tabId) {
  assertTabId(tabId);
  if (attached.has(tabId)) return;
  try {
    await api().debugger.attach({ tabId }, PROTOCOL);
  } catch (e) {
    // A previous worker instance may still hold the session; reuse it.
    if (!/already attached/i.test(message(e))) {
      if (/no tab/i.test(message(e))) throw new BridgeError(ERR.NO_TAB, `no tab ${tabId}`);
      throw new BridgeError(ERR.INTERNAL, `debugger attach failed: ${message(e)}`);
    }
  }
  attached.add(tabId);
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
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", buttons: 0 });
  await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1 });
  await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 });
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

export async function screenshot({ tabId } = {}) {
  assertTabId(tabId);
  const { data } = await send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
  return { data, mimeType: "image/jpeg" };
}

export function _resetForTests() {
  attached.clear();
}
