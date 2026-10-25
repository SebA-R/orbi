// Options page, grouped like iOS Settings (see options.html): talk key,
// speech speed, Guided mode, browse mode and site lists, follow tab, Danger mode,
// subtitles, sounds, quiet other tabs, setup status, the agent URL and the one-time
// microphone grant (getUserMedia here, on an extension page, so the
// offscreen document, same origin, inherits the permission).
//
// Two kinds of control:
// - Any input with data-setting="<key>" is a simple setting. It is filled
//   from storage, saves on its own as soon as it changes (like the popup),
//   is part of Save, and goes back to DEFAULTS[key] on Reset. A checkbox
//   saves true or false, a range a number, radios the checked value, and
//   anything else its value. Adding one is a single row in options.html.
// - Text that has to be checked first (allowed sites, blocked sites, the
//   agent address) saves only with the Save button, after validation.
// Danger mode has its own two-press switch (lib/danger-toggle.js).
import { DEFAULTS, HOTKEYS, SPEED_MIN, SPEED_MAX, loadSettings, saveSettings, normalizeAgentUrl, parseOriginLines } from "../lib/settings.js";
import { RT } from "../lib/protocol.js";
import { SUGGESTED_BLOCKLIST, SUGGESTED_ENTRIES, parseBlockLines } from "../lib/blocklist.js";
import { grantMic, micPermission, micStateMessage } from "../lib/mic-grant.js";
import { bindDangerToggle } from "../lib/danger-toggle.js";
import { SETUP_STEPS, agentHealth, hasSiteAccess, keyName, setupDone } from "../lib/setup.js";

const $ = (id) => document.getElementById(id);
const els = {
  form: $("form"), hotkey: $("hotkey"), speed: $("speed"), speedOut: $("speed-out"),
  agentUrl: $("agent-url"), status: $("status"),
  grant: $("grant-mic"), micStatus: $("mic-status"), reset: $("reset"),
  allowlist: $("allowlist"), blocklist: $("blocklist"), blockErrors: $("blocklist-errors"), restore: $("restore-blocklist"),
  setupState: $("setup-state"), agentState: $("agent-state"),
};

for (const value of Object.keys(HOTKEYS)) els.hotkey.append(new Option(keyName(value), value));
els.speed.min = String(SPEED_MIN);
els.speed.max = String(SPEED_MAX);

const showSpeed = () => { els.speedOut.textContent = `${Number(els.speed.value).toFixed(1)}x`; };
els.speed.addEventListener("input", showSpeed);

// Simple settings: every [data-setting] input, by storage key.
const simple = new Map();
for (const el of document.querySelectorAll("[data-setting]")) {
  const key = el.dataset.setting;
  if (!simple.has(key)) simple.set(key, []);
  simple.get(key).push(el);
}
function readSetting(key) {
  const [el, ...rest] = simple.get(key);
  if (el.type === "radio") return [el, ...rest].find((r) => r.checked)?.value ?? DEFAULTS[key];
  if (el.type === "checkbox") return el.checked;
  if (el.type === "range" || el.type === "number") return Number(el.value);
  return el.value;
}
function writeSetting(key, value) {
  for (const el of simple.get(key)) {
    if (el.type === "radio") el.checked = el.value === value;
    else if (el.type === "checkbox") el.checked = value === true;
    else el.value = String(value);
  }
}
const readSimple = () => Object.fromEntries([...simple.keys()].map((k) => [k, readSetting(k)]));
const simpleDefaults = () => Object.fromEntries([...simple.keys()].map((k) => [k, DEFAULTS[k]]));

// Saves on its own (not with the Save button), after the confirm press.
const danger = bindDangerToggle({ box: $("danger-mode"), confirm: $("danger-confirm"), yes: $("danger-yes"), no: $("danger-no") }, saveSettings);

// Leaves Danger mode alone, so an open confirm is not closed by another save.
function fillSimple(s) {
  for (const key of simple.keys()) writeSetting(key, s[key]);
  showSpeed();
}

function fill(s) {
  fillSimple(s);
  danger.fill(s);
  els.agentUrl.value = s.agentUrl;
  els.allowlist.value = s.allowlist.join("\n");
  els.blocklist.value = s.blocklist.join("\n");
}

// Whether the text fields differ from what is stored (they save with Save).
const textDirty = (s) => els.agentUrl.value.trim() !== s.agentUrl
  || els.allowlist.value.trim() !== s.allowlist.join("\n")
  || els.blocklist.value.trim() !== s.blocklist.join("\n").trim();

function say(el, text) {
  el.textContent = "";
  // Re-set on the next frame so screen readers announce a repeated message.
  requestAnimationFrame(() => { el.textContent = text; });
}

function notify(settings) {
  try {
    const p = chrome.runtime.sendMessage({ type: RT.SETTINGS_CHANGED, settings });
    if (p && p.catch) p.catch(() => {});
  } catch {}
}

for (const [key, inputs] of simple) {
  for (const el of inputs) {
    el.addEventListener("change", async () => {
      if (el.type === "radio" && !el.checked) return;
      const saved = await saveSettings({ [key]: readSetting(key) });
      fillSimple(saved);
      notify(saved);
      say(els.status, textDirty(saved) ? "Saved. Site lists and the server address still need Save." : "Saved.");
    });
  }
}

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = els.agentUrl.value.trim();
  if (!normalizeAgentUrl(url)) {
    els.agentUrl.setAttribute("aria-invalid", "true");
    els.agentUrl.focus();
    say(els.status, "The agent address must be ws:// or wss:// on localhost or 127.0.0.1.");
    return;
  }
  els.agentUrl.removeAttribute("aria-invalid");
  const allow = parseOriginLines(els.allowlist.value);
  els.allowlist.removeAttribute("aria-invalid");
  if (allow.bad.length) {
    els.allowlist.setAttribute("aria-invalid", "true");
    els.allowlist.focus();
    say(els.status, `Not a site address in the allowed sites: ${allow.bad.join(", ")}. Use addresses like https://www.etsy.com, with no login in them.`);
    return;
  }
  const block = parseBlockLines(els.blocklist.value);
  els.blocklist.removeAttribute("aria-invalid");
  els.blockErrors.hidden = !block.bad.length;
  els.blockErrors.textContent = `Not a blocked site entry:\n${block.bad.join("\n")}`;
  if (block.bad.length) {
    els.blocklist.setAttribute("aria-invalid", "true");
    els.blocklist.focus();
    say(els.status, `Fix the blocked sites first: ${block.bad.join(", ")}. Use forms like chase.com, amazon.com/ap, *bank* or *.gov.`);
    return;
  }
  if (!allow.origins.length) {
    els.allowlist.setAttribute("aria-invalid", "true");
    els.allowlist.focus();
    say(els.status, "Add at least one allowed site, for example http://localhost:4000.");
    return;
  }
  const before = (await loadSettings()).agentUrl;
  const saved = await saveSettings({
    ...readSimple(),
    allowlist: allow.origins,
    blocklist: block.lines,
    agentUrl: url,
  });
  fill(saved);
  notify(saved);
  say(els.status, "Saved.");
  if (saved.agentUrl !== before) refreshSetup();
});

els.reset.addEventListener("click", async () => {
  const saved = await saveSettings({
    ...simpleDefaults(), agentUrl: DEFAULTS.agentUrl,
    allowlist: [...DEFAULTS.allowlist], blocklist: [...DEFAULTS.blocklist],
    dangerMode: DEFAULTS.dangerMode,
  });
  fill(saved);
  notify(saved);
  say(els.status, "Reset to defaults.");
  refreshSetup();
});

// Puts back the suggested entries the user removed and keeps their own
// additions after them, then saves like the Save button.
els.restore.addEventListener("click", () => {
  const ours = new Set(SUGGESTED_ENTRIES.map((e) => e.text));
  const mine = parseBlockLines(els.blocklist.value).entries.map((e) => e.text).filter((t) => !ours.has(t));
  els.blocklist.value = [...SUGGESTED_BLOCKLIST, ...(mine.length ? ["", "# Your sites", ...mine] : [])].join("\n");
  els.form.requestSubmit();
});

async function showMicState() {
  const state = await micPermission();
  els.micStatus.textContent = micStateMessage(state);
  return state;
}

els.grant.addEventListener("click", async () => {
  say(els.micStatus, (await grantMic()).message);
  refreshSetup();
});

$("open-shortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

// Setup and server status tags. Checks can overlap (each health check takes
// up to 3 s); only the latest counts. Plain text, not announced on load.
const tag = (el, state, text) => { el.dataset.state = state; el.textContent = text; };
let setupRun = 0;
async function refreshSetup() {
  const run = ++setupRun;
  const s = await loadSettings();
  const [site, mic, agent] = await Promise.all([hasSiteAccess(), micPermission(), agentHealth(s.agentUrl)]);
  if (run !== setupRun) return;
  const done = setupDone({ site, mic, agent });
  tag(els.setupState, done === SETUP_STEPS ? "ok" : "todo", done === SETUP_STEPS ? "Complete" : `${done} of ${SETUP_STEPS} done`);
  tag(els.agentState, agent.connected ? "ok" : "todo", agent.connected ? "Connected" : "Not reachable");
}

// Switches and menus changed elsewhere (the popup) show up here. Only the
// changed keys are refilled: text being edited is left alone, and an open
// Danger mode confirm stays open unless dangerMode itself changed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = [...simple.keys()].filter((k) => k in changes);
  if (!keys.length && !changes.dangerMode) return;
  loadSettings().then((s) => {
    for (const k of keys) writeSetting(k, s[k]);
    if (changes.dangerMode) danger.fill(s);
    showSpeed();
  });
});

try { $("version").textContent = chrome.runtime.getManifest().version; } catch {}

fill(await loadSettings());
await showMicState();
refreshSetup();
// The popup's "Blocked sites" link and the setup page's talk key link land here.
const target = { "#blocked-sites": els.blocklist, "#hotkey": els.hotkey }[location.hash];
if (target) { target.scrollIntoView({ block: "center" }); target.focus(); }
document.documentElement.dataset.ready = "true";
