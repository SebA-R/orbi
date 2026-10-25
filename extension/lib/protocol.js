// Message protocol shared by the extension and the agent server.
//
// Bridge socket (extension <-> agent server, ws://localhost:5050/ext), JSON:
//   ext -> server  { type: "hello", protocol, ext, version }
//   server -> ext  { type: "welcome", protocol, server }
//   server -> ext  { type: "request", id, method, params }
//   ext -> server  { type: "response", id, ok: true, result }
//                  { type: "response", id, ok: false, error: { code, message } }
//   ext -> server  { type: "blocklist", lines } after welcome and whenever
//                  the user saves it (the options page's blocked sites).
//                  One way: the server cannot change extension settings.
//   ext -> server  { type: "danger_mode", on } the same way, for the user's
//                  Danger mode setting (the extension enforces it itself).
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
  BLOCKLIST: "blocklist",
  // { type: "settings", guidedMode, memory, provider, localBaseUrl, localModel }:
  // agent behavior settings, worker to agent (lib/settings.js agentSettingsMessage).
  SETTINGS: "settings",
  DANGER_MODE: "danger_mode",
});

// Tools the agent may expose to Claude.
export const TOOLS = Object.freeze([
  "tabs_context",
  "tabs_create",
  "tabs_close",
  "tabs_activate",
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

// Methods only the agent server's own code calls (pay_now, the tab sweep).
// Never exposed to Claude as tools. lock_arm and press_protected are the
// button lock's unlock: a single-use nonce, then one press of an order
// button (see background/router.js). press_unlocked is the same for a
// control the user asked for (lock_arm scope "user"); lock_info reads what
// a ref is locked as. agent_tabs feeds the server's tab sweep;
// page_context is what the user is looking at, attached to their words.
// actions_stop ends any paced click, typing or scroll still playing (sent
// at turn end and on interrupt).
export const INTERNAL = Object.freeze([
  "tab_info",
  "agent_tabs",
  "page_context",
  "read_fields",
  "fill_payment",
  "clear_payment",
  "rect",
  "click_ref",
  "lock_arm",
  "press_protected",
  "press_unlocked",
  "lock_info",
  "actions_stop",
]);

export const METHODS = Object.freeze([...TOOLS, ...INTERNAL]);

export const ERR = Object.freeze({
  BAD_REQUEST: "bad_request",
  UNKNOWN_METHOD: "unknown_method",
  NOT_ALLOWED: "not_allowed",
  NO_TAB: "no_tab",
  NO_ELEMENT: "no_element",
  PAYMENT_FIELD: "payment_field",
  LOCKED: "locked",
  TIMEOUT: "timeout",
  NOT_CONNECTED: "not_connected",
  // A watchable-pace action stopped early: the user barged in, switched
  // tabs, or the page went away (background/actor.js).
  INTERRUPTED: "interrupted",
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
  PTT_CONFIRM: "ptt.confirm",
  PTT_CANCEL: "ptt.cancel",
  PTT_TOGGLE: "ptt.toggle",
  PTT_HUSH: "ptt.hush",
  VOICE_START: "voice.start",
  VOICE_STOP: "voice.stop",
  VOICE_CONFIRM: "voice.confirm",
  VOICE_CANCEL: "voice.cancel",
  VOICE_HUSH: "voice.hush",
  VOICE_PARTIAL: "voice.partial",
  VOICE_FINAL: "voice.final",
  VOICE_STATE: "voice.state",
  VOICE_STATE_QUERY: "voice.state.query",
  VOICE_ERROR: "voice.error",
  TTS_SPEAK: "tts.speak",
  TTS_STOP: "tts.stop",
  SUBTITLE: "subtitle",
  // offscreen -> worker -> active tab: the word of the agent line being heard
  // ({utteranceId, index, done?, frozen?, fallback?}).
  SUBTITLE_WORD: "subtitle.word",
  FRAME: "frame",
  // worker -> top frame: an agent pointer sample for content/cursor.js.
  CURSOR: "cursor",
  SETTINGS_CHANGED: "settings.changed",
  STATUS: "status",
  // Clearcart's "Can't reach this site" page: the user pressed Retry.
  ERROR_PAGE_RETRY: "errorpage.retry",
  // worker -> offscreen: say your VOICE_STATE again (a restarted worker asks).
  VOICE_SYNC: "voice.sync",
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
