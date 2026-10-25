// User settings, kept in chrome.storage.local. Only extension pages and the
// worker can write them; the agent server cannot change any of this.

export const HOTKEYS = Object.freeze({
  "Alt+Space": "Option + Space (Alt + Space)",
  "Ctrl+Shift+Space": "Control + Shift + Space",
  F9: "F9",
});

export const DEFAULTS = Object.freeze({
  agentUrl: "ws://localhost:5050",
  allowlist: Object.freeze(["http://localhost:4000"]),
  hotkey: "Alt+Space",
  speed: 1,
  subtitles: true,
});

export const SPEED_MIN = 0.6;
export const SPEED_MAX = 2;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The bridge can drive allowlisted tabs and carries card values for pay_now,
// so it may only point at this machine.
export function normalizeAgentUrl(value) {
  try {
    const u = new URL(String(value).trim());
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    if (!LOOPBACK.has(u.hostname)) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function normalizeOrigin(value) {
  try {
    const u = new URL(String(value).trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function normalize(raw = {}) {
  const out = { ...DEFAULTS, allowlist: [...DEFAULTS.allowlist] };
  const url = raw.agentUrl != null && normalizeAgentUrl(raw.agentUrl);
  if (url) out.agentUrl = url;
  if (Array.isArray(raw.allowlist)) {
    const list = [...new Set(raw.allowlist.map(normalizeOrigin).filter(Boolean))];
    if (list.length) out.allowlist = list;
  }
  if (typeof raw.hotkey === "string" && Object.hasOwn(HOTKEYS, raw.hotkey)) out.hotkey = raw.hotkey;
  const speed = Number(raw.speed);
  if (raw.speed != null && Number.isFinite(speed)) out.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
  if (typeof raw.subtitles === "boolean") out.subtitles = raw.subtitles;
  return out;
}

export function endpoints(agentUrl) {
  const base = normalizeAgentUrl(agentUrl) || DEFAULTS.agentUrl;
  const http = base.replace(/^ws/, "http");
  return { ext: `${base}/ext`, session: `${base}/session`, http, token: `${http}/cartesia-token` };
}

const KEYS = Object.keys(DEFAULTS);

export async function loadSettings(storage = globalThis.chrome?.storage?.local) {
  const raw = storage ? await storage.get(KEYS) : {};
  return normalize(raw);
}

export async function saveSettings(patch, storage = globalThis.chrome?.storage?.local) {
  const next = normalize({ ...(await loadSettings(storage)), ...patch });
  await storage.set(next);
  return next;
}
