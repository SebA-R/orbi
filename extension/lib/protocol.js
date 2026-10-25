// Message protocol shared by the extension and the agent server.
//
// Bridge socket (extension <-> agent server, ws://localhost:5050/ext), JSON:
//   ext -> server  { type: "hello", protocol, ext, version }
//   server -> ext  { type: "welcome", protocol, server }
//   server -> ext  { type: "request", id, method, params }
//   ext -> server  { type: "response", id, ok: true, result }
//                  { type: "response", id, ok: false, error: { code, message } }
//   either way     { type: "ping", t } answered by { type: "pong", t }
//
// Runtime messages (inside the extension, chrome.runtime / chrome.tabs
// messaging) all carry a `type` from RT below.

export const PROTOCOL_VERSION = 1;
export const EXT_NAME = "clearcart";

export const MSG = Object.freeze({
  HELLO: "hello",
  WELCOME: "welcome",
  REQUEST: "request",
  RESPONSE: "response",
  PING: "ping",
  PONG: "pong",
});

// Tools the agent may expose to Claude.
export const TOOLS = Object.freeze([
  "tabs_context",
  "tabs_create",
  "navigate",
  "read_page",
  "find",
  "get_page_text",
  "form_input",
  "click",
  "type",
  "key",
  "scroll",
  "screenshot",
]);

// Methods only the agent server's own code calls (pay_now, the store guard).
// Never exposed to Claude as tools.
export const INTERNAL = Object.freeze([
  "tab_info",
  "read_fields",
  "fill_payment",
  "clear_payment",
]);

export const METHODS = Object.freeze([...TOOLS, ...INTERNAL]);

export const ERR = Object.freeze({
  BAD_REQUEST: "bad_request",
  UNKNOWN_METHOD: "unknown_method",
  NOT_ALLOWED: "not_allowed",
  NO_TAB: "no_tab",
  NO_ELEMENT: "no_element",
  PAYMENT_FIELD: "payment_field",
  TIMEOUT: "timeout",
  NOT_CONNECTED: "not_connected",
  INTERNAL: "internal",
});

export const TIMING = Object.freeze({
  // Chrome 116+ keeps a service worker alive while WebSocket traffic flows;
  // the docs suggest a message at least every 20-30 s.
  HEARTBEAT_MS: 20_000,
  // No pong for this long means the socket is dead even if it looks open.
  DEAD_AFTER_MS: 45_000,
  REQUEST_TIMEOUT_MS: 30_000,
  BACKOFF_MIN_MS: 500,
  BACKOFF_MAX_MS: 15_000,
});

// Runtime message types inside the extension.
export const RT = Object.freeze({
  PAGE_CALL: "page.call",
  PTT_START: "ptt.start",
  PTT_STOP: "ptt.stop",
  PTT_TOGGLE: "ptt.toggle",
  VOICE_START: "voice.start",
  VOICE_STOP: "voice.stop",
  VOICE_PARTIAL: "voice.partial",
  VOICE_FINAL: "voice.final",
  VOICE_STATE: "voice.state",
  VOICE_ERROR: "voice.error",
  TTS_SPEAK: "tts.speak",
  TTS_STOP: "tts.stop",
  CHIME: "chime",
  SUBTITLE: "subtitle",
  SETTINGS_CHANGED: "settings.changed",
  STATUS: "status",
});

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export function hello(version) {
  return { type: MSG.HELLO, protocol: PROTOCOL_VERSION, ext: EXT_NAME, version: String(version || "0") };
}

export function okResponse(id, result) {
  return { type: MSG.RESPONSE, id, ok: true, result: result === undefined ? null : result };
}

export function errorResponse(id, code, message) {
  return { type: MSG.RESPONSE, id, ok: false, error: { code: code || ERR.INTERNAL, message: String(message || "failed") } };
}

// Parses one frame. Returns null for anything that is not a well-formed
// protocol message, so callers can drop it without throwing.
export function parseMessage(raw) {
  let m;
  try {
    m = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || typeof m.type !== "string") return null;
  switch (m.type) {
    case MSG.REQUEST:
      if (typeof m.id !== "string" && typeof m.id !== "number") return null;
      if (typeof m.method !== "string") return null;
      if (m.params != null && typeof m.params !== "object") return null;
      return { type: m.type, id: m.id, method: m.method, params: m.params || {} };
    case MSG.RESPONSE:
      if (typeof m.id !== "string" && typeof m.id !== "number") return null;
      return m;
    case MSG.HELLO:
    case MSG.WELCOME:
    case MSG.PING:
    case MSG.PONG:
      return m;
    default:
      return null;
  }
}
