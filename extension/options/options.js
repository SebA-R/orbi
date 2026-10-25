// Options page: hotkey, speech speed, subtitles, quiet other tabs, browse mode and site
// lists, agent URL, and the one-time
// microphone grant (getUserMedia here, on an extension page, so the
// offscreen document, same origin, inherits the permission).
import { DEFAULTS, HOTKEYS, SPEED_MIN, SPEED_MAX, loadSettings, saveSettings, normalizeAgentUrl, parseOriginLines } from "../lib/settings.js";
import { RT } from "../lib/protocol.js";
import { SUGGESTED_BLOCKLIST, SUGGESTED_ENTRIES, parseBlockLines } from "../lib/blocklist.js";
import { grantMic, micPermission, micStateMessage } from "../lib/mic-grant.js";
import { bindDangerToggle } from "../lib/danger-toggle.js";

const $ = (id) => document.getElementById(id);
const els = {
  form: $("form"), hotkey: $("hotkey"), speed: $("speed"), speedOut: $("speed-out"),
  subtitles: $("subtitles"), quietTabs: $("quiet-tabs"), followTab: $("follow-tab"), sounds: $("sounds"), guidedMode: $("guided-mode"), newTabPage: $("newtab-page"), agentUrl: $("agent-url"), status: $("status"),
  grant: $("grant-mic"), micStatus: $("mic-status"), reset: $("reset"),
  allowlist: $("allowlist"), blocklist: $("blocklist"), blockErrors: $("blocklist-errors"), restore: $("restore-blocklist"),
};
const modeInput = (mode) => document.querySelector(`input[name="browseMode"][value="${mode}"]`);

for (const [value, label] of Object.entries(HOTKEYS)) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  els.hotkey.append(opt);
}
els.speed.min = String(SPEED_MIN);
els.speed.max = String(SPEED_MAX);

const showSpeed = () => { els.speedOut.textContent = `${Number(els.speed.value).toFixed(1)}x`; };
els.speed.addEventListener("input", showSpeed);

// Saves on its own (not with the Save button), after the confirm press.
const danger = bindDangerToggle({ box: $("danger-mode"), confirm: $("danger-confirm"), yes: $("danger-yes"), no: $("danger-no") }, saveSettings);

function fill(s) {
  els.hotkey.value = s.hotkey;
  els.speed.value = String(s.speed);
  els.subtitles.checked = s.subtitles;
  els.quietTabs.checked = s.quietTabs;
  els.followTab.checked = s.followTab;
  els.sounds.checked = s.sounds;
  els.guidedMode.checked = s.guidedMode;
  els.newTabPage.checked = s.newTabPage;
  els.agentUrl.value = s.agentUrl;
  modeInput(s.browseMode).checked = true;
  els.allowlist.value = s.allowlist.join("\n");
  els.blocklist.value = s.blocklist.join("\n");
  danger.fill(s);
  showSpeed();
}

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
  const saved = await saveSettings({
    browseMode: document.querySelector('input[name="browseMode"]:checked')?.value || DEFAULTS.browseMode,
    allowlist: allow.origins,
    blocklist: block.lines,
    hotkey: els.hotkey.value,
    speed: Number(els.speed.value),
    subtitles: els.subtitles.checked,
    quietTabs: els.quietTabs.checked,
    followTab: els.followTab.checked,
    sounds: els.sounds.checked,
    guidedMode: els.guidedMode.checked,
    newTabPage: els.newTabPage.checked,
    agentUrl: url,
  });
  fill(saved);
  notify(saved);
  say(els.status, "Saved.");
});

els.reset.addEventListener("click", async () => {
  const saved = await saveSettings({
    hotkey: DEFAULTS.hotkey, speed: DEFAULTS.speed, subtitles: DEFAULTS.subtitles, quietTabs: DEFAULTS.quietTabs, followTab: DEFAULTS.followTab, sounds: DEFAULTS.sounds, guidedMode: DEFAULTS.guidedMode, newTabPage: DEFAULTS.newTabPage, agentUrl: DEFAULTS.agentUrl,
    browseMode: DEFAULTS.browseMode, allowlist: [...DEFAULTS.allowlist], blocklist: [...DEFAULTS.blocklist],
    dangerMode: DEFAULTS.dangerMode,
  });
  fill(saved);
  notify(saved);
  say(els.status, "Reset to defaults.");
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
});

fill(await loadSettings());
await showMicState();
// The popup's "Blocked sites" link and the setup page's talk key link land here.
const target = { "#blocked-sites": els.blocklist, "#hotkey": els.hotkey }[location.hash];
if (target) { target.scrollIntoView({ block: "center" }); target.focus(); }
document.documentElement.dataset.ready = "true";
