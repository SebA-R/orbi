// Clearcart new tab page (chrome_url_overrides). Chrome pages can't run
// content scripts, so this page loads content/hotkey.js and
// content/subtitles.js itself (see newtab.html; guard.js keeps them to the
// worker's messages for this tab). The worker sees it as any other tab:
// hold-to-talk, the latch, double-tap, replay on tab switch.
//
// This file adds the orb, the search box and the setting: with "Use the
// Clearcart new tab page" off it forwards to Chrome's own new tab page.
import { RT } from "../lib/protocol.js";
import { loadSettings } from "../lib/settings.js";
import { keyName } from "../lib/setup.js";

// "⌃⇧Space" or "Ctrl+Shift+Space" as words a screen reader says clearly.
const MAC_KEYS = { "⌃": "Control", "⇧": "Shift", "⌥": "Option", "⌘": "Command" };
export function spellShortcut(s) {
  const parts = [];
  let rest = String(s || "");
  while (rest && MAC_KEYS[rest[0]]) { parts.push(MAC_KEYS[rest[0]]); rest = rest.slice(1); }
  parts.push(...rest.split("+").filter(Boolean).map((k) => (k === "Ctrl" ? "Control" : k)));
  return parts.join(" + ");
}

export const CHROME_NTP = "chrome://new-tab-page/";
const $ = (id) => document.getElementById(id);

const settings = await loadSettings();

if (!settings.newTabPage) {
  try {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.update(tab.id, { url: CHROME_NTP });
  } catch {
    document.documentElement.dataset.ready = "true";
    const err = $("error");
    err.hidden = false;
    err.textContent = "Chrome did not let Clearcart open its own new tab page. Turn on \"Use the Clearcart new tab page\" in Clearcart settings, or open a site from the address bar.";
  }
} else {
  start();
}

function start() {
  let hotkey = settings.hotkey;
  let state = "idle";
  const TEXT = {
    idle: (k) => [`Hold ${k} to talk`, k === "Space" ? "Option + Space keeps listening until you press Space." : "Let go to send."],
    listening: (k) => ["Listening", `Let go of ${k} when you're done.`],
    thinking: () => ["Thinking", "Working on your request."],
    speaking: (k) => ["Speaking", `Hold ${k} to interrupt${k === "Space" ? ", or tap it twice to stop" : ""}.`],
  };
  // The popup's mini orb face beside the name. Decorative: the heading says the state.
  let face = null;
  const FACE = globalThis.__clearcartOrbFace;
  if (FACE) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(FACE.CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      face = FACE.create(document);
      $("mini-orb").append(face.el);
    } catch {}
  }
  const show = (next = state) => {
    if (!Object.hasOwn(TEXT, next)) return;
    state = next;
    const [title, sub] = TEXT[state](keyName(hotkey));
    $("orb").dataset.state = state;
    face?.setState(state);
    if ($("voice-title").textContent !== title) $("voice-title").textContent = title;
    if ($("voice-sub").textContent !== sub) $("voice-sub").textContent = sub;
  };

  // The worker sends VOICE_STATE here only while this tab is the one talking
  // or was just switched to, the same as a website's content scripts.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === RT.VOICE_STATE) show(msg.state);
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) show("idle"); });
  // A tab opened with Command + T may load after the worker's tab-switch
  // replay, so ask once (hotkey.js and subtitles.js hear the answer too).
  chrome.runtime.sendMessage({ type: RT.VOICE_STATE_QUERY }).catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.hotkey) { hotkey = changes.hotkey.newValue; show(); }
  });

  // A new tab opens with the keyboard in the address bar, where Space types.
  const focusHint = () => { $("focus-hint").hidden = document.hasFocus(); };
  window.addEventListener("focus", focusHint);
  window.addEventListener("blur", focusHint);
  focusHint();

  // The toggle shortcut is browser-wide, so it works on Chrome's own pages too.
  chrome.commands?.getAll?.().then((cmds) => {
    const c = (cmds || []).find((x) => x.name === "toggle-listening");
    if (!c || !c.shortcut) return;
    const el = $("shortcut");
    const kbd = document.createElement("kbd");
    kbd.textContent = spellShortcut(c.shortcut);
    el.replaceChildren("Or press ", kbd, " on any page, Chrome's own pages too, to start or stop listening.");
    el.hidden = false;
  }).catch(() => {});

  // Search with the default search engine. Space in the box types a space
  // (hotkey.js leaves text fields alone).
  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("q").value.trim();
    if (!text) { $("q").focus(); return; }
    chrome.search.query({ text, disposition: "CURRENT_TAB" }).catch(() => {});
  });

  $("settings").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  show();
  document.documentElement.dataset.ready = "true";
}
