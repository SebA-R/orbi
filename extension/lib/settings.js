// User settings, kept in chrome.storage.local. Only extension pages and the
// worker can write them; the agent server cannot change any of this (the
// worker only tells it the current blocklist).

import { SUGGESTED_BLOCKLIST, parseBlockLines } from "./blocklist.js";

export const HOTKEYS = Object.freeze({
  Space: "Space (hold to talk; Option + Space keeps listening until you press Space)",
  "Alt+Space": "Option + Space (Alt + Space)",
  "Ctrl+Shift+Space": "Control + Shift + Space",
  F9: "F9",
});

// browseMode "open": any web site except the fixed rules in lib/blocklist.js
// and `blocklist`, the user's blocked sites (lines in lib/blocklist.js's
// format, seeded with SUGGESTED_BLOCKLIST until the user saves their own).
// "allowlist": only the `allowlist` origins, empty until the user adds some.
// In both modes the allowlist sites are the only ones where the pay flow may
// arm an unlock; open browsing never widens that.
export const BROWSE_MODES = Object.freeze(["open", "allowlist"]);

export const DEFAULTS = Object.freeze({
  agentUrl: "ws://localhost:5050",
  allowlist: Object.freeze([]),
  browseMode: "open",
  blocklist: SUGGESTED_BLOCKLIST,
  hotkey: "Space",
  speed: 1,
  subtitles: true,
  // Fade out and mute other tabs' audio while the user talks and while
  // Clearcart answers (lib/voice/duck.js).
  quietTabs: true,
  // Bring the user to the tab Clearcart acts on (background/follow.js).
  followTab: true,
  // Earcons: listening, sent, cut off, order result, errors (lib/voice/chime.js).
  sounds: true,
  // Guided mode, the mode for blind and low-vision users: the agent
  // describes each page, reads out the choices and lets the user pick
  // (agent/prompt.ts GUIDED_PROMPT). Off unless the user turns it on.
  guidedMode: false,
  // Clearcart's new tab page (newtab/newtab.html), so Space to talk and
  // subtitles work on new tabs. Off: it forwards to Chrome's own.
  newTabPage: true,
  // Danger mode: Clearcart presses sign in and sign up without asking
  // (content/protect.js says what it lifts). Off unless the user turns it
  // on, with a confirm step (lib/danger-toggle.js). Paying, checkout,
  // masking, the blocklist and the CAPTCHA hand-off never change with it.
  dangerMode: false,
  // Clicks and scrolls go at a pace the user can follow
  // (background/actor.js). Off, they happen at once. Typing is always
  // key by key at a typist's cadence, either way.
  watchablePace: true,
});

export const DANGER_MODE_COPY = "Danger mode. Clearcart can press any button without asking first. You still say yes out loud before anything is bought.";

export const SPEED_MIN = 0.6;
export const SPEED_MAX = 2;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The bridge drives the user's tabs and reads their pages, so it may only
// point at this machine.
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
  const out = { ...DEFAULTS, allowlist: [...DEFAULTS.allowlist], blocklist: [...DEFAULTS.blocklist] };
  const url = raw.agentUrl != null && normalizeAgentUrl(raw.agentUrl);
  if (url) out.agentUrl = url;
  if (Array.isArray(raw.allowlist)) out.allowlist = [...new Set(raw.allowlist.map(normalizeOrigin).filter(Boolean))];
  if (BROWSE_MODES.includes(raw.browseMode)) out.browseMode = raw.browseMode;
  if (Array.isArray(raw.blocklist)) out.blocklist = parseBlockLines(raw.blocklist).lines;
  if (typeof raw.hotkey === "string" && Object.hasOwn(HOTKEYS, raw.hotkey)) out.hotkey = raw.hotkey;
  const speed = Number(raw.speed);
  if (raw.speed != null && Number.isFinite(speed)) out.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
  if (typeof raw.subtitles === "boolean") out.subtitles = raw.subtitles;
  if (typeof raw.quietTabs === "boolean") out.quietTabs = raw.quietTabs;
  if (typeof raw.followTab === "boolean") out.followTab = raw.followTab;
  if (typeof raw.sounds === "boolean") out.sounds = raw.sounds;
  if (typeof raw.guidedMode === "boolean") out.guidedMode = raw.guidedMode;
  if (typeof raw.watchablePace === "boolean") out.watchablePace = raw.watchablePace;
  if (typeof raw.newTabPage === "boolean") out.newTabPage = raw.newTabPage;
  // Only a stored true turns it on.
  out.dangerMode = raw.dangerMode === true;
  return out;
}

// Parses the options page's one-origin-per-line text. Returns the origins
// and the lines that are not a plain http(s) origin (paths are dropped,
// logins in the address are refused).
export function parseOriginLines(text) {
  const origins = [];
  const bad = [];
  for (const line of String(text ?? "").split(/[\n,]/).map((l) => l.trim()).filter(Boolean)) {
    const o = normalizeOrigin(/^[a-z][a-z0-9+.-]*:/i.test(line) ? line : `https://${line}`);
    if (o) origins.push(o);
    else bad.push(line);
  }
  return { origins: [...new Set(origins)], bad };
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

// First install: store the suggested blocked sites, so the list the user
// sees and edits is the one in force. A stored list, even an empty one, is
// left alone.
export async function seedBlocklist(storage = globalThis.chrome?.storage?.local) {
  const { blocklist } = await storage.get("blocklist");
  if (blocklist !== undefined) return false;
  await storage.set({ blocklist: [...SUGGESTED_BLOCKLIST] });
  return true;
}

export async function saveSettings(patch, storage = globalThis.chrome?.storage?.local) {
  const next = normalize({ ...(await loadSettings(storage)), ...patch });
  await storage.set(next);
  return next;
}
