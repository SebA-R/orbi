// Options page: hotkey, speech speed, subtitles, agent URL, and the one-time
// microphone grant (getUserMedia here, on an extension page, so the
// offscreen document, same origin, inherits the permission).
import { DEFAULTS, HOTKEYS, SPEED_MIN, SPEED_MAX, loadSettings, saveSettings, normalizeAgentUrl } from "../lib/settings.js";
import { RT } from "../lib/protocol.js";

const $ = (id) => document.getElementById(id);
const els = {
  form: $("form"), hotkey: $("hotkey"), speed: $("speed"), speedOut: $("speed-out"),
  subtitles: $("subtitles"), agentUrl: $("agent-url"), status: $("status"),
  grant: $("grant-mic"), micStatus: $("mic-status"), reset: $("reset"),
};

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

function fill(s) {
  els.hotkey.value = s.hotkey;
  els.speed.value = String(s.speed);
  els.subtitles.checked = s.subtitles;
  els.agentUrl.value = s.agentUrl;
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
  const saved = await saveSettings({
    hotkey: els.hotkey.value,
    speed: Number(els.speed.value),
    subtitles: els.subtitles.checked,
    agentUrl: url,
  });
  fill(saved);
  notify(saved);
  say(els.status, "Saved.");
});

els.reset.addEventListener("click", async () => {
  const saved = await saveSettings({ hotkey: DEFAULTS.hotkey, speed: DEFAULTS.speed, subtitles: DEFAULTS.subtitles, agentUrl: DEFAULTS.agentUrl });
  fill(saved);
  notify(saved);
  say(els.status, "Reset to defaults.");
});

async function micPermission() {
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    return p.state;
  } catch {
    return "unknown";
  }
}

async function showMicState() {
  const state = await micPermission();
  if (state === "granted") els.micStatus.textContent = "Microphone allowed.";
  else if (state === "denied") els.micStatus.textContent = "Microphone blocked. Allow it in Chrome's site settings for this extension, then press Grant microphone again.";
  else els.micStatus.textContent = "Microphone not granted yet.";
  return state;
}

els.grant.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    say(els.micStatus, "Microphone allowed. You can close this page and hold the talk key on any page.");
  } catch (err) {
    say(els.micStatus, err && err.name === "NotAllowedError"
      ? "Microphone blocked. Allow it in Chrome's site settings for this extension, then try again."
      : `Could not open the microphone: ${err && err.message}`);
  }
});

fill(await loadSettings());
await showMicState();
document.documentElement.dataset.ready = "true";
