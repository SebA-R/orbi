// Options page, grouped like iOS Settings (see options.html): talk key,
// speech speed, Speak replies, Guided mode, browse mode and site lists, follow tab, Danger mode,
// Payment cards (saved on the agent server, never in extension storage),
// Memory (on or off, saved facts, Forget everything),
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
import { DEFAULTS, HOTKEYS, SPEED_MIN, SPEED_MAX, loadSettings, localModels, saveSettings, normalizeAgentUrl, normalizeLocalBaseUrl, normalizeLocalModel, parseOriginLines, speakRepliesNote } from "../lib/settings.js";
import { RT } from "../lib/protocol.js";
import { SUGGESTED_BLOCKLIST, SUGGESTED_ENTRIES, parseBlockLines } from "../lib/blocklist.js";
import { grantMic, micPermission, micStateMessage } from "../lib/mic-grant.js";
import { bindDangerToggle } from "../lib/danger-toggle.js";
import { SETUP_STEPS, agentHealth, basicVoice, hasSiteAccess, keyName, setupDone } from "../lib/setup.js";
import { forgetAll, forgetFact, listMemory } from "../lib/memory.js";
import { addCard, cardLabel, checkCard, listCards, removeCard, setDefaultCard } from "../lib/cards.js";

const $ = (id) => document.getElementById(id);
const els = {
  form: $("form"), hotkey: $("hotkey"), speed: $("speed"), speedOut: $("speed-out"),
  agentUrl: $("agent-url"), status: $("status"),
  grant: $("grant-mic"), micStatus: $("mic-status"), reset: $("reset"),
  allowlist: $("allowlist"), blocklist: $("blocklist"), blockErrors: $("blocklist-errors"), restore: $("restore-blocklist"),
  setupState: $("setup-state"), agentState: $("agent-state"),
  localUrl: $("local-base-url"), localUrlError: $("local-base-url-error"),
  localModel: $("local-model"), localModelError: $("local-model-error"),
  localPick: $("local-model-pick"), localPickLine: $("local-pick-line"),
  localTest: $("local-test"), localState: $("local-state"), localStatus: $("local-test-status"),
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

// The note under Speak replies: subtitles off too, or voice off on the
// server (the switch is locked then). From the switches as they stand.
let serverVoice = null;
function showSpeakNote() {
  const note = speakRepliesNote({ speakReplies: readSetting("speakReplies"), subtitles: readSetting("subtitles") }, serverVoice);
  $("speak-replies-note").textContent = note;
  $("speak-replies-note").hidden = !note;
  $("speak-replies").disabled = serverVoice === false;
}

// Leaves Danger mode alone, so an open confirm is not closed by another save.
function fillSimple(s) {
  for (const key of simple.keys()) writeSetting(key, s[key]);
  showSpeed();
  showSpeakNote();
}

function fill(s) {
  fillSimple(s);
  danger.fill(s);
  els.agentUrl.value = s.agentUrl;
  els.localUrl.value = s.localBaseUrl;
  els.localModel.value = s.localModel;
  els.allowlist.value = s.allowlist.join("\n");
  els.blocklist.value = s.blocklist.join("\n");
}

// Whether the text fields differ from what is stored (they save with Save).
const textDirty = (s) => els.agentUrl.value.trim() !== s.agentUrl
  || els.localUrl.value.trim() !== s.localBaseUrl
  || els.localModel.value.trim() !== s.localModel
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
  if (!checkLocalFields()) return;
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
  if (!allow.origins.length && readSetting("browseMode") === "allowlist") {
    els.allowlist.setAttribute("aria-invalid", "true");
    els.allowlist.focus();
    say(els.status, "Add at least one allowed site, for example https://www.etsy.com, or choose Open web.");
    return;
  }
  const before = (await loadSettings()).agentUrl;
  const saved = await saveSettings({
    ...readSimple(),
    allowlist: allow.origins,
    blocklist: block.lines,
    agentUrl: url,
    localBaseUrl: normalizeLocalBaseUrl(els.localUrl.value),
    localModel: normalizeLocalModel(els.localModel.value),
  });
  fill(saved);
  notify(saved);
  say(els.status, "Saved.");
  if (saved.agentUrl !== before) { refreshSetup(); refreshMemory(); refreshCards(); }
});

els.reset.addEventListener("click", async () => {
  const saved = await saveSettings({
    ...simpleDefaults(), agentUrl: DEFAULTS.agentUrl,
    localBaseUrl: DEFAULTS.localBaseUrl, localModel: DEFAULTS.localModel,
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

// Local model: the address and model name are checked inline (the address
// may only be on this computer) and save with Save or Test connection.
function fieldError(input, errorEl, text) {
  errorEl.hidden = !text;
  errorEl.textContent = text || "";
  if (text) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}
function checkLocalFields() {
  const urlOk = !!normalizeLocalBaseUrl(els.localUrl.value);
  const modelOk = !!normalizeLocalModel(els.localModel.value);
  fieldError(els.localUrl, els.localUrlError, urlOk ? "" : "Use an http:// or https:// address on this computer: localhost, 127.0.0.1 or [::1].");
  fieldError(els.localModel, els.localModelError, modelOk ? "" : "Use the model name only: letters, numbers and . _ : / - characters.");
  if (urlOk && modelOk) return true;
  (urlOk ? els.localModel : els.localUrl).focus();
  say(els.status, urlOk ? "Fix the local model name first." : "Fix the local server address first.");
  return false;
}
els.localUrl.addEventListener("change", () => {
  if (normalizeLocalBaseUrl(els.localUrl.value)) fieldError(els.localUrl, els.localUrlError, "");
});
els.localModel.addEventListener("change", () => {
  if (normalizeLocalModel(els.localModel.value)) fieldError(els.localModel, els.localModelError, "");
});

// The installed models from the agent server's GET /local-models. A server
// without it (404) leaves just the text field.
function showPicker(models, current) {
  els.localPickLine.hidden = !models.length;
  els.localPick.replaceChildren(
    new Option(models.includes(current) ? "Choose a model" : "Choose an installed model", ""),
    ...models.map((m) => new Option(m, m)),
  );
  els.localPick.value = models.includes(current) ? current : "";
}
els.localPick.addEventListener("change", async () => {
  const name = normalizeLocalModel(els.localPick.value);
  if (!name) return;
  els.localModel.value = name;
  fieldError(els.localModel, els.localModelError, "");
  const saved = await saveSettings({ localModel: name });
  notify(saved);
  say(els.status, `Saved. Local model: ${name}.`);
});
let localRun = 0;
async function refreshLocal() {
  const run = ++localRun;
  const s = await loadSettings();
  const result = await localModels(s.agentUrl);
  if (run !== localRun) return result;
  showPicker(result.models, s.localModel);
  if (result.state === "ok") tag(els.localState, "ok", "Connected");
  else if (result.state === "down") tag(els.localState, "todo", "Not reachable");
  else tag(els.localState, "wait", "Can't check");
  return result;
}
els.localTest.addEventListener("click", async () => {
  if (!checkLocalFields()) return;
  const saved = await saveSettings({ localBaseUrl: normalizeLocalBaseUrl(els.localUrl.value), localModel: normalizeLocalModel(els.localModel.value) });
  // Only these two fields: other unsaved text (site lists, agent address) stays as typed.
  els.localUrl.value = saved.localBaseUrl;
  els.localModel.value = saved.localModel;
  notify(saved);
  tag(els.localState, "wait", "Checking");
  els.localStatus.textContent = "";
  // Give the worker a moment to send the saved address to the agent server.
  await new Promise((r) => setTimeout(r, 400));
  const result = await refreshLocal();
  const msg = result.state === "missing"
    ? "This agent server can't check local models yet. Type the model name above."
    : result.state === "down"
      ? "Local model not reachable. Check that Ollama or LM Studio is running at the address above."
      : !result.models.length ? "Connected, but the local server lists no models."
        : result.models.includes(saved.localModel) ? `Connected. ${saved.localModel} is ready.`
          : `Connected, but ${saved.localModel} is not installed. Choose one of the installed models.`;
  say(els.localStatus, msg);
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

// Memory: the saved facts live on the agent server (lib/memory.js). Each
// has a Delete button; Forget everything takes two presses, like Danger
// mode. Facts are shown as text only.
const mem = {
  list: $("memory-list"), state: $("memory-state"), all: $("memory-forget-all"),
  confirm: $("memory-confirm"), yes: $("memory-forget-yes"), no: $("memory-forget-no"),
};
let memoryRun = 0;
async function refreshMemory() {
  const run = ++memoryRun;
  const { agentUrl } = await loadSettings();
  let data = null;
  try { data = await listMemory(agentUrl); } catch {}
  if (run !== memoryRun) return;
  if (!data) {
    mem.list.replaceChildren();
    mem.all.disabled = true;
    mem.state.textContent = "The agent server is not reachable, so saved facts can't be shown.";
    return;
  }
  mem.all.disabled = !data.facts.length;
  mem.state.textContent = data.facts.length ? `${data.facts.length} saved.` : "Nothing saved yet.";
  mem.list.replaceChildren(...data.facts.map((f) => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.className = "fact";
    text.textContent = f.text;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn";
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete: ${f.text}`);
    del.dataset.id = f.id;
    li.append(text, del);
    return li;
  }));
}
mem.list.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  const li = btn.closest("li");
  const next = li.nextElementSibling || li.previousElementSibling;
  const nextId = next?.querySelector("button")?.dataset.id;
  const fact = li.querySelector(".fact").textContent;
  try {
    await forgetFact((await loadSettings()).agentUrl, btn.dataset.id);
    say(els.status, `Forgot: ${fact}.`);
  } catch {
    say(els.status, "Could not delete it: the agent server is not reachable.");
  }
  await refreshMemory();
  (mem.list.querySelector(`button[data-id="${nextId}"]`) || $("memory-list-label")).focus?.();
});
mem.all.addEventListener("click", () => { mem.confirm.hidden = false; mem.yes.focus(); });
mem.no.addEventListener("click", () => { mem.confirm.hidden = true; mem.all.focus(); });
mem.yes.addEventListener("click", async () => {
  mem.confirm.hidden = true;
  try {
    await forgetAll((await loadSettings()).agentUrl);
    say(els.status, "Forgot everything.");
  } catch {
    say(els.status, "Could not forget: the agent server is not reachable.");
  }
  await refreshMemory();
  mem.all.focus();
});
// Facts saved by voice while this page is open show up when it is back in front.
window.addEventListener("focus", () => void refreshMemory());

// Payment cards: saved encrypted on the agent server (lib/cards.js), which
// answers nicknames, brands and last 4 digits only. The add-card fields
// belong to #card-form, have no data-setting and are never written to
// extension storage: what the user typed is sent once, then the fields are
// cleared whether it was saved or not.
const cardUi = {
  list: $("cards-list"), state: $("cards-state"), form: $("card-form"), error: $("card-error"), add: $("card-add"),
  nickname: $("card-nickname"), name: $("card-name"), number: $("card-number"), exp: $("card-exp"), csc: $("card-csc"), zip: $("card-zip"),
};
const CARD_FIELDS = ["nickname", "name", "number", "exp", "csc", "zip"];

function cardRow(c, isDefault) {
  const label = `${c.nickname}, ${cardLabel(c)}`;
  const li = document.createElement("li");
  li.dataset.id = c.id;
  li.dataset.label = label;
  const text = document.createElement("span");
  text.className = "fact";
  const nick = document.createElement("span");
  nick.className = "card-nick";
  nick.textContent = c.nickname;
  const which = document.createElement("span");
  which.className = "hint";
  which.textContent = ` ${cardLabel(c)}`;
  text.append(nick, which);
  const end = document.createElement("span");
  end.className = "row-end";
  if (isDefault) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.dataset.state = "ok";
    tag.textContent = "Default";
    end.append(tag);
  } else {
    const def = document.createElement("button");
    def.type = "button";
    def.className = "btn";
    def.dataset.act = "default";
    def.textContent = "Make default";
    def.setAttribute("aria-label", `Make ${label} the default card`);
    end.append(def);
  }
  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn";
  del.dataset.act = "delete";
  del.textContent = "Delete";
  del.setAttribute("aria-label", `Delete ${label}`);
  end.append(del);
  li.append(text, end);
  return li;
}

let cardsRun = 0;
async function refreshCards() {
  const run = ++cardsRun;
  const { agentUrl } = await loadSettings();
  let data = null;
  try { data = await listCards(agentUrl); } catch {}
  if (run !== cardsRun) return;
  if (!data) {
    cardUi.list.replaceChildren();
    cardUi.state.textContent = "The agent server is not reachable, so saved cards can't be shown.";
    return;
  }
  cardUi.state.textContent = data.cards.length ? `${data.cards.length} saved.` : "No cards saved yet.";
  cardUi.list.replaceChildren(...data.cards.map((c) => cardRow(c, c.id === data.defaultId)));
}

function cardError(text) {
  cardUi.error.textContent = text;
  cardUi.error.hidden = !text;
}

function sendError(err) {
  if (err && err.status === 403) return "The agent server refused this page. Check the agent server address under Setup.";
  if (err && err.status && err.status < 500) return err.message;
  if (err && err.status) return "The agent server could not save the card.";
  return "Could not save the card: the agent server is not reachable.";
}

cardUi.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const card = Object.fromEntries(CARD_FIELDS.map((k) => [k, cardUi[k].value]));
  // Caught here, nothing is sent and the fields stay for fixing.
  const why = checkCard(card);
  if (why) {
    cardError(why);
    for (const k of CARD_FIELDS) card[k] = "";
    return;
  }
  cardError("");
  cardUi.add.disabled = true;
  try {
    const saved = await addCard((await loadSettings()).agentUrl, card);
    say(els.status, `Saved ${saved.nickname}, ${cardLabel(saved)}.`);
  } catch (err) {
    cardError(sendError(err));
  } finally {
    for (const k of CARD_FIELDS) {
      card[k] = "";
      cardUi[k].value = "";
    }
    cardUi.add.disabled = false;
  }
  await refreshCards();
  cardUi.nickname.focus();
});

cardUi.list.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const li = btn.closest("li");
  const { id, label } = li.dataset;
  const next = li.nextElementSibling || li.previousElementSibling;
  const nextId = next?.dataset.id;
  try {
    const agentUrl = (await loadSettings()).agentUrl;
    if (btn.dataset.act === "delete") {
      await removeCard(agentUrl, id);
      say(els.status, `Deleted ${label}.`);
    } else {
      await setDefaultCard(agentUrl, id);
      say(els.status, `${label} is now the default card.`);
    }
  } catch {
    say(els.status, "Could not change the saved cards: the agent server is not reachable.");
  }
  await refreshCards();
  const keep = btn.dataset.act === "delete" ? nextId : id;
  (cardUi.list.querySelector(`li[data-id="${keep}"] button`) || $("cards-list-label")).focus?.();
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
  serverVoice = agent.voice;
  showSpeakNote();
  $("basic-voice-note").hidden = !basicVoice(agent);
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
    showSpeakNote();
  });
});

try { $("version").textContent = chrome.runtime.getManifest().version; } catch {}

fill(await loadSettings());
await showMicState();
refreshSetup();
refreshMemory();
refreshCards();
refreshLocal();
// The popup's "Blocked sites" link and the setup page's talk key link land here.
const target = { "#blocked-sites": els.blocklist, "#hotkey": els.hotkey }[location.hash];
if (target) { target.scrollIntoView({ block: "center" }); target.focus(); }
document.documentElement.dataset.ready = "true";
