// Toolbar popup ("orb hero"): the live voice state, a setup pill that counts
// the setup page's four checks, and the everyday settings. Each control saves
// on its own; the worker and offscreen document follow chrome.storage.
import { HOTKEYS, SPEED_MIN, SPEED_MAX, loadSettings, saveSettings } from "../lib/settings.js";
import { RT } from "../lib/protocol.js";
import { SETUP_PATH, SETUP_STEPS, agentHealth, hasSiteAccess, keyName, micState, setupDone, updateBadge } from "../lib/setup.js";

const $ = (id) => document.getElementById(id);
const openTab = (path) => {
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
};

let settings = await loadSettings();

// Voice state, from the offscreen document's VOICE_STATE broadcasts. The
// popup can't ask for the current state, so it starts at idle.
const MISSING = { site: "site access", mic: "microphone", agent: "agent server" };
let missing = [];
const VOICE = {
  idle: (key) => missing.length
    ? ["Not ready", `Finish setup to talk. Needed: ${missing.map((m) => MISSING[m]).join(", ")}.`]
    : ["Ready", key === "Space" ? "Hold Space to talk. Option\u00a0+\u00a0Space keeps listening until you press Space." : `Hold ${key} on any page to talk.`],
  listening: (key) => ["Listening", `Let go of ${key} when you're done.`],
  thinking: () => ["Thinking", "Working on your request."],
  speaking: (key) => ["Speaking", `Clearcart is answering. Hold ${key} to interrupt.`],
};
let voiceState = "idle";
function showVoice(state = voiceState) {
  if (!Object.hasOwn(VOICE, state)) return;
  voiceState = state;
  const [title, sub] = VOICE[state](keyName(settings.hotkey));
  $("orb").dataset.state = state;
  if ($("voice-title").textContent !== title) $("voice-title").textContent = title;
  if ($("voice-sub").textContent !== sub) $("voice-sub").textContent = sub;
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.from === "offscreen" && msg.type === RT.VOICE_STATE) showVoice(msg.state);
});

// Setup pill: the same checks as the setup page; it opens the setup page.
// Checks can overlap (each health check takes up to 3 s); only the latest counts.
let setupRun = 0;
async function refreshSetup() {
  const run = ++setupRun;
  const s = await loadSettings();
  const [site, mic, agent] = await Promise.all([hasSiteAccess(), micState(), agentHealth(s.agentUrl)]);
  if (run !== setupRun) return;
  const done = setupDone({ site, mic, agent });
  missing = [!site && "site", mic !== "granted" && "mic", !agent.connected && "agent"].filter(Boolean);
  // The voice status region names what is missing, so it is announced.
  showVoice();
  const pill = $("setup-pill");
  pill.dataset.state = done === SETUP_STEPS ? "ok" : "todo";
  $("setup-text").textContent = done === SETUP_STEPS ? `Setup complete, ${done} of ${SETUP_STEPS}` : `Setup: ${done} of ${SETUP_STEPS}`;
  pill.setAttribute("aria-label", done === SETUP_STEPS
    ? `Setup complete, ${done} of ${SETUP_STEPS}. Open setup`
    : `Setup: ${done} of ${SETUP_STEPS} done. Needed: ${missing.map((m) => MISSING[m]).join(", ")}. Open setup to finish`);
  updateBadge(chrome, [!site && "site", mic !== "granted" && mic !== "unknown" && "mic"].filter(Boolean));
}
$("setup-pill").addEventListener("click", () => openTab(SETUP_PATH));

// Settings
for (const value of Object.keys(HOTKEYS)) $("hotkey").append(new Option(keyName(value), value));
$("speed").min = String(SPEED_MIN);
$("speed").max = String(SPEED_MAX);
const showSpeed = () => { $("speed-out").textContent = `${Number($("speed").value).toFixed(1)}x`; };

function fill(s) {
  settings = s;
  const radio = document.querySelector(`input[name="browseMode"][value="${s.browseMode}"]`);
  if (radio) radio.checked = true;
  $("hotkey").value = s.hotkey;
  $("speed").value = String(s.speed);
  $("subtitles").checked = s.subtitles;
  $("sounds").checked = s.sounds;
  $("quiet-tabs").checked = s.quietTabs;
  $("follow-tab").checked = s.followTab;
  showSpeed();
  showVoice();
}

const save = (patch) => saveSettings(patch).then(fill);
for (const r of document.querySelectorAll('input[name="browseMode"]')) {
  r.addEventListener("change", () => r.checked && save({ browseMode: r.value }));
}
$("hotkey").addEventListener("change", () => save({ hotkey: $("hotkey").value }));
$("speed").addEventListener("input", showSpeed);
$("speed").addEventListener("change", () => save({ speed: Number($("speed").value) }));
$("subtitles").addEventListener("change", () => save({ subtitles: $("subtitles").checked }));
$("sounds").addEventListener("change", () => save({ sounds: $("sounds").checked }));
$("quiet-tabs").addEventListener("change", () => save({ quietTabs: $("quiet-tabs").checked }));
$("follow-tab").addEventListener("change", () => save({ followTab: $("follow-tab").checked }));

// Links
const allSettings = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); window.close(); };
$("gear").addEventListener("click", allSettings);
$("all-settings").addEventListener("click", allSettings);
$("blocked-sites").addEventListener("click", (e) => { e.preventDefault(); openTab("options/options.html#blocked-sites"); });

// Changes made elsewhere (the options page, another window) show up here.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  loadSettings().then(fill);
  if (changes.agentUrl) refreshSetup();
});
chrome.permissions.onAdded.addListener(() => refreshSetup());
chrome.permissions.onRemoved.addListener(() => refreshSetup());

fill(settings);
await refreshSetup();
document.documentElement.dataset.ready = "true";
