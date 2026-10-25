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
  // Speak Clearcart's replies with Sonic. Off: no speech is requested at
  // all (no Cartesia speech credits), and the replies show in the subtitles
  // only. Listening and earcons are unchanged.
  speakReplies: true,
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
  // A main-frame network error (no connection, unknown address, refused)
  // in a normal tab goes to Clearcart's "Can't reach this site" page
  // (background/errpage.js), where Space to talk works. Off: Chrome's own
  // error page stays.
  errorPages: true,
  // Danger mode: the button lock is off and orders are placed without a
  // spoken yes (content/protect.js, agent/session.ts). Off unless the user
  // turns it on, with a confirm step (lib/danger-toggle.js). Masking of card
  // and password fields, the blocklist and the CAPTCHA hand-off never
  // change with it.
  dangerMode: false,
  // Clicks and scrolls go at a pace the user can follow
  // (background/actor.js). Off, they happen at once. Typing is always
  // key by key at a typist's cadence, either way.
  watchablePace: true,
  // Memory: the agent keeps facts the user asked it to remember and the
  // last two hours of the conversation, on this computer only
  // (agent/memory.ts). Off, it neither uses nor saves them.
  memory: true,
  // Clearcart's own pointer on the page while it clicks, types and scrolls
  // (content/cursor.js). Purely visual.
  showCursor: true,
});

export const DANGER_MODE_COPY = "Danger mode. Clearcart acts on its own with no locks, including placing orders without asking. It still never sees your card or passwords, and blocked sites stay blocked.";

export const SPEAK_REPLIES_COPY = "Speak replies. Turn off to read Clearcart's answers in the subtitles without hearing them.";
export const VOICE_OFF_ON_SERVER = "Voice is off on the server";

// With Speak replies and subtitles both off, the user would never learn
// what Clearcart said: the popup and options page show this. Voice off on
// the server (serverVoice false) counts as not speaking.
export function replyWarning(s, serverVoice = null) {
  if (!s || s.subtitles !== false) return null;
  if (s.speakReplies !== false && serverVoice !== false) return null;
  return "Clearcart's replies won't be shown or spoken at all. Turn on Speak replies or subtitles.";
}

// The note under the Speak replies switch, or "" for none.
export function speakRepliesNote(s, serverVoice = null) {
  return [serverVoice === false && `${VOICE_OFF_ON_SERVER}.`, replyWarning(s, serverVoice)].filter(Boolean).join(" ");
}

export const SPEED_MIN = 0.6;
export const SPEED_MAX = 2;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The bridge drives the user's tabs and carries card values for pay_now,
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
  if (typeof raw.speakReplies === "boolean") out.speakReplies = raw.speakReplies;
  if (typeof raw.quietTabs === "boolean") out.quietTabs = raw.quietTabs;
  if (typeof raw.followTab === "boolean") out.followTab = raw.followTab;
  if (typeof raw.sounds === "boolean") out.sounds = raw.sounds;
  if (typeof raw.guidedMode === "boolean") out.guidedMode = raw.guidedMode;
  if (typeof raw.watchablePace === "boolean") out.watchablePace = raw.watchablePace;
  if (typeof raw.showCursor === "boolean") out.showCursor = raw.showCursor;
  if (typeof raw.newTabPage === "boolean") out.newTabPage = raw.newTabPage;
  if (typeof raw.memory === "boolean") out.memory = raw.memory;
  if (typeof raw.errorPages === "boolean") out.errorPages = raw.errorPages;
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

// Earlier versions allowed one local test page by default, and saving any
// setting stored that list. It is gone now: on update the old default is
// taken out of the stored allowlist once, so only sites the user added stay
// allowed. Answers true when it removed something.
export const RETIRED_ALLOWED = Object.freeze(["http://localhost:4000"]);
export const MIGRATIONS_KEY = "settingsMigrations";
const DROP_RETIRED_ALLOWED = "drop-retired-allowed-site";

export async function migrateSettings(storage = globalThis.chrome?.storage?.local) {
  const got = await storage.get([MIGRATIONS_KEY, "allowlist"]);
  const done = Array.isArray(got[MIGRATIONS_KEY]) ? got[MIGRATIONS_KEY] : [];
  if (done.includes(DROP_RETIRED_ALLOWED)) return false;
  const patch = { [MIGRATIONS_KEY]: [...done, DROP_RETIRED_ALLOWED] };
  if (Array.isArray(got.allowlist)) {
    const kept = got.allowlist.filter((o) => !RETIRED_ALLOWED.includes(normalizeOrigin(o)));
    if (kept.length !== got.allowlist.length) patch.allowlist = kept;
  }
  await storage.set(patch);
  return "allowlist" in patch;
}

export async function saveSettings(patch, storage = globalThis.chrome?.storage?.local) {
  const next = normalize({ ...(await loadSettings(storage)), ...patch });
  await storage.set(next);
  return next;
}
