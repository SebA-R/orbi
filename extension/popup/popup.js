// Toolbar popup: the setup checklist plus the everyday settings. Site access
// is asked for right here (a click is a user gesture). The mic button opens
// the setup page in a tab, since the popup closes when Chrome's mic prompt
// shows.
import { DEFAULTS, HOTKEYS, SPEED_MIN, SPEED_MAX, loadSettings, saveSettings } from "../lib/settings.js";
import { SETUP_PATH } from "../lib/setup.js";
import { createChecklist } from "../setup/checklist.js";

const $ = (id) => document.getElementById(id);
const openTab = (path) => {
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
};

const list = createChecklist({
  root: $("checklist"),
  live: $("live"),
  level: 3,
  onMic: () => { openTab(`${SETUP_PATH}#mic`); return null; },
});

for (const [value, label] of Object.entries(HOTKEYS)) $("hotkey").append(new Option(label, value));
$("speed").min = String(SPEED_MIN);
$("speed").max = String(SPEED_MAX);
const showSpeed = () => { $("speed-out").textContent = `${Number($("speed").value).toFixed(1)}x`; };

function fill(s) {
  const radio = document.querySelector(`input[name="browseMode"][value="${s.browseMode}"]`);
  if (radio) radio.checked = true;
  $("hotkey").value = s.hotkey;
  $("speed").value = String(s.speed);
  $("subtitles").checked = s.subtitles;
  showSpeed();
}

// Each control saves on its own; the worker and offscreen document follow
// chrome.storage changes.
const save = (patch) => saveSettings(patch).then(fill);
for (const r of document.querySelectorAll('input[name="browseMode"]')) {
  r.addEventListener("change", () => r.checked && save({ browseMode: r.value || DEFAULTS.browseMode }));
}
$("hotkey").addEventListener("change", () => save({ hotkey: $("hotkey").value }).then(() => list.refresh()));
$("speed").addEventListener("input", showSpeed);
$("speed").addEventListener("change", () => save({ speed: Number($("speed").value) }));
$("subtitles").addEventListener("change", () => save({ subtitles: $("subtitles").checked }));

$("all-settings").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); window.close(); });
$("blocked-sites").addEventListener("click", (e) => { e.preventDefault(); openTab("options/options.html#blocked-sites"); });

fill(await loadSettings());
// No announcement here: moving focus below already reads the state.
await list.refresh();
chrome.permissions.onAdded.addListener(() => list.refresh());

// First focus: the first step still needed, or the summary when all is done.
(list.firstNeeded() || list.summary).focus();
document.documentElement.dataset.ready = "true";
