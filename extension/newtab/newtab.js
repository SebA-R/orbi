// Orbi new tab page (chrome_url_overrides). Chrome pages can't run
// content scripts, so this page loads content/hotkey.js itself (see
// newtab.html; guard.js keeps it to the worker's messages for this tab). No
// subtitle card here: it would sit over the centered orb, which already
// shows the voice state. The worker sees it as any other tab:
// hold-to-talk, the latch, double-tap, replay on tab switch.
//
// voice.js adds the orb face and the voice state. This file adds the search
// box and the setting: with "Use the Orbi new tab page" off it forwards
// to Chrome's own new tab page.
import { loadSettings } from "../lib/settings.js";
import { agentHealth, basicVoice } from "../lib/setup.js";
import { mountTypeBox } from "../lib/typebox.js";
import { startVoice } from "./voice.js";

export const CHROME_NTP = "chrome://new-tab-page/";
const $ = (id) => document.getElementById(id);

const settings = await loadSettings();

const forward = async () => {
  const tab = await chrome.tabs.getCurrent();
  await chrome.tabs.update(tab.id, { url: CHROME_NTP });
};

if (!settings.newTabPage) {
  // Coming back with the Back button: forwarding again would undo it, so
  // offer a button instead.
  const back = performance.getEntriesByType?.("navigation")?.[0]?.type === "back_forward";
  try {
    if (back) throw new Error("back");
    await forward();
  } catch (e) {
    document.documentElement.dataset.ready = "true";
    for (const el of document.querySelectorAll("main > :not(#off, h1)")) el.hidden = true;
    $("off").hidden = false;
    $("off-text").textContent = back
      ? "The Orbi new tab page is turned off in Orbi settings."
      : "Chrome did not let Orbi open its own new tab page. Turn on \"Use the Orbi new tab page\" in Orbi settings, or open a site from the address bar.";
    $("off-go").addEventListener("click", () => forward().catch(() => {}));
  }
} else {
  start();
}

function start() {
  startVoice(settings);

  // Search with the default search engine. Space in the box types a space
  // (hotkey.js leaves text fields alone).
  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("q").value.trim();
    if (!text) { $("q").focus(); return; }
    $("error").hidden = true;
    chrome.search.query({ text, disposition: "CURRENT_TAB" }).catch(() => {
      $("error").textContent = "The search did not start. Try again, or type it in the address bar.";
      $("error").hidden = false;
    });
  });

  $("settings").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  // Basic voice (no Cartesia key): the "Type to Orbi" box.
  const typeBox = mountTypeBox($("type-form"));
  agentHealth(settings.agentUrl).then((h) => typeBox.show(basicVoice(h)), () => {});

  document.documentElement.dataset.ready = "true";
}
