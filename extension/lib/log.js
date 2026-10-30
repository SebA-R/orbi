// Logging with redaction. Every argument passes through redact() before it
// reaches the console or the in-memory ring buffer, so card numbers, security
// codes and tokens never land in a log even if a caller passes them by mistake.

import "../content/mask.js";

const SECRET_KEYS = /^(number|card|card_?number|cc-?(number|csc|exp)|csc|cvc|cvv|cvv2|exp|expiry|token|access_token|api_?key|password|secret|authorization|values|fields)$/i;
const MAX_STRING = 400;
const RING_SIZE = 200;

// Any digit run holding a card number, by content/mask.js's check (a card
// glued to other digits too).
export function maskCardNumbers(text) {
  return globalThis.ClearcartMask.maskCardRuns(String(text), "[card number]");
}

function redactString(s) {
  let out = maskCardNumbers(s).replace(/(access_token|token|api_key|key)=([^&\s"']+)/gi, "$1=[redacted]");
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}... (${out.length} chars)`;
  return out;
}

export function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (depth > 6) return "[deep]";
  if (value instanceof Error) return { name: value.name, message: redactString(value.message), code: value.code };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) && v != null && v !== "" ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

const ring = [];

export function recentLogs() {
  return ring.slice();
}

export function createLogger(scope, sink = console) {
  const emit = (level, args) => {
    const clean = args.map((a) => redact(a));
    ring.push({ t: Date.now(), level, scope, msg: clean.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
    if (ring.length > RING_SIZE) ring.shift();
    const fn = sink[level] || sink.log;
    fn.call(sink, `[clearcart:${scope}]`, ...clean);
  };
  return {
    debug: (...a) => emit("debug", a),
    info: (...a) => emit("info", a),
    warn: (...a) => emit("warn", a),
    error: (...a) => emit("error", a),
  };
}
