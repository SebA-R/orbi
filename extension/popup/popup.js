// Toolbar popup ("orb hero"): the live voice state, a setup pill that counts
// the setup page's four checks, and the everyday settings. Each control saves
// on its own; the worker and offscreen document follow chrome.storage.
import { CLAUDE_MODELS, HOTKEYS, SPEED_MIN, SPEED_MAX, claudeModelLabel, loadSettings, localModels, localStatusText, saveSettings, speakRepliesNote } from "../lib/settings.js";
import { RT } from "../lib/protocol.js";
import { SETUP_PATH, SETUP_STEPS, agentHealth, basicVoice, hasSiteAccess, keyName, micState, setupDone, updateBadge } from "../lib/setup.js";
import { mountTypeBox } from "../lib/typebox.js";
import { bindDangerToggle } from "../lib/danger-toggle.js";

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
  speaking: (key) => ["Speaking", `Orbi is answering. Hold ${key} to interrupt.`],
};
let voiceState = "idle";
// The mini orb face in the header. Decorative: the status region says the state.
const FACE = globalThis.__clearcartOrbFace;
let face = null;
if (FACE) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(FACE.CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    face = FACE.create(document);
    $("mini-orb").append(face.el);
  } catch {}
}
function showVoice(state = voiceState) {
  if (!Object.hasOwn(VOICE, state)) return;
  voiceState = state;
  const [title, sub] = VOICE[state](keyName(settings.hotkey));
  $("orb").dataset.state = state;
  face?.setState(state);
  if ($("voice-title").textContent !== title) $("voice-title").textContent = title;
  if ($("voice-sub").textContent !== sub) $("voice-sub").textContent = sub;
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.from !== "offscreen") return;
  if (msg.type === RT.VOICE_STATE) showVoice(msg.state);
  else if (msg.type === RT.SUBTITLE || msg.type === RT.SUBTITLE_WORD) face?.caption(msg); // lip-sync
  else if (msg.type === "voice.level") face?.setLevel(msg.level); // optional, not sent yet
});

// Setup pill: the same checks as the setup page; it opens the setup page.
// Checks can overlap (each health check takes up to 3 s); only the latest counts.
let setupRun = 0;
let serverVoice = null; // from /healthz: false when CLEARCART_VOICE=false
// The Speak replies note, and the switch locked while the server has voice off.
function showSpeakNote() {
  const note = speakRepliesNote(settings, serverVoice);
  $("speak-replies-note").textContent = note;
  $("speak-replies-note").hidden = !note;
  $("speak-replies").disabled = serverVoice === false;
}
// Basic voice (no Cartesia key): the "Type to Orbi" box.
const typeBox = mountTypeBox($("type-form"));
async function refreshSetup() {
  const run = ++setupRun;
  const s = await loadSettings();
  const [site, mic, agent] = await Promise.all([hasSiteAccess(), micState(), agentHealth(s.agentUrl)]);
  if (run !== setupRun) return;
  const done = setupDone({ site, mic, agent });
  serverVoice = agent.voice;
  showSpeakNote();
  typeBox.show(basicVoice(agent));
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
for (const id of Object.keys(CLAUDE_MODELS)) $("claude-model").append(new Option(claudeModelLabel(id), id));
$("speed").min = String(SPEED_MIN);
$("speed").max = String(SPEED_MAX);
const showSpeed = () => { $("speed-out").textContent = `${Number($("speed").value).toFixed(1)}x`; };

const danger = bindDangerToggle({ box: $("danger-mode"), confirm: $("danger-confirm"), yes: $("danger-yes"), no: $("danger-no"), chip: $("danger-chip") }, saveSettings);

// Model provider: the Local chip names the model and whether the agent
// server can reach it (POST /local-models). Only the latest check counts.
let localRun = 0;
async function refreshLocal() {
  const run = ++localRun;
  const s = await loadSettings();
  const chip = $("local-chip");
  $("local-line").hidden = s.provider !== "local";
  if (s.provider !== "local") return;
  chip.dataset.state = "wait";
  chip.textContent = s.localModel;
  const result = await localModels(s.agentUrl);
  if (run !== localRun) return;
  chip.textContent = localStatusText(s.localModel, result);
  chip.dataset.state = result.state === "ok" && chip.textContent.endsWith(", connected") ? "ok" : result.state === "missing" ? "wait" : "todo";
}
let noteTimer = 0;
function showProviderNote(provider, model) {
  const note = $("provider-note");
  note.textContent = provider === "local" ? "Starting a new conversation with your local model." : `Starting a new conversation with ${model ? CLAUDE_MODELS[model].name : "Claude"}.`;
  note.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { note.hidden = true; }, 4000);
}

function fill(s) {
  settings = s;
  const radio = document.querySelector(`input[name="browseMode"][value="${s.browseMode}"]`);
  if (radio) radio.checked = true;
  const prov = document.querySelector(`input[name="provider"][value="${s.provider}"]`);
  if (prov) prov.checked = true;
  $("claude-model-row").hidden = s.provider !== "claude";
  $("claude-model").value = s.claudeModel;
  $("hotkey").value = s.hotkey;
  $("speed").value = String(s.speed);
  $("subtitles").checked = s.subtitles;
  $("speak-replies").checked = s.speakReplies;
  showSpeakNote();
  $("error-pages").checked = s.errorPages;
  $("sounds").checked = s.sounds;
  $("quiet-tabs").checked = s.quietTabs;
  danger.fill(s);
  $("follow-tab").checked = s.followTab;
  $("watchable-pace").checked = s.watchablePace;
  $("show-cursor").checked = s.showCursor;
  $("guided-mode").checked = s.guidedMode;
  showSpeed();
  showVoice();
}

const save = (patch) => saveSettings(patch).then(fill);
for (const r of document.querySelectorAll('input[name="browseMode"]')) {
  r.addEventListener("change", () => r.checked && save({ browseMode: r.value }));
}
for (const r of document.querySelectorAll('input[name="provider"]')) {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    showProviderNote(r.value);
    save({ provider: r.value });
  });
}
$("claude-model").addEventListener("change", () => {
  showProviderNote("claude", $("claude-model").value);
  save({ claudeModel: $("claude-model").value });
});
$("hotkey").addEventListener("change", () => save({ hotkey: $("hotkey").value }));
$("speed").addEventListener("input", showSpeed);
$("speed").addEventListener("change", () => save({ speed: Number($("speed").value) }));
$("subtitles").addEventListener("change", () => save({ subtitles: $("subtitles").checked }));
$("speak-replies").addEventListener("change", () => save({ speakReplies: $("speak-replies").checked }));
$("error-pages").addEventListener("change", () => save({ errorPages: $("error-pages").checked }));
$("sounds").addEventListener("change", () => save({ sounds: $("sounds").checked }));
$("quiet-tabs").addEventListener("change", () => save({ quietTabs: $("quiet-tabs").checked }));
$("follow-tab").addEventListener("change", () => save({ followTab: $("follow-tab").checked }));
$("watchable-pace").addEventListener("change", () => save({ watchablePace: $("watchable-pace").checked }));
$("show-cursor").addEventListener("change", () => save({ showCursor: $("show-cursor").checked }));
$("guided-mode").addEventListener("change", () => save({ guidedMode: $("guided-mode").checked }));

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
  if (changes.agentUrl || changes.provider || changes.localModel || changes.localBaseUrl) refreshLocal();
});
chrome.permissions.onAdded.addListener(() => refreshSetup());
chrome.permissions.onRemoved.addListener(() => refreshSetup());

fill(settings);
refreshLocal();
await refreshSetup();
document.documentElement.dataset.ready = "true";
