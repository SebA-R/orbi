// Clearcart's "Can't reach this site" page. The worker sends a tab here when
// its main frame fails with a network error (background/errpage.js), since
// Chrome's own error page runs no content scripts. Like the new tab page it
// loads content/hotkey.js, content/orb-face.js and content/subtitles.js
// (guard.js first), and voice.js shows the orb and the voice state.
//
// The failed address is in chrome.storage.session under the key in this
// page's fragment, not in its address. Retry tells the worker first, so a
// second failure comes back here, then replaces this page with the address.
import { RT } from "../lib/protocol.js";
import { loadSettings } from "../lib/settings.js";
import { recordFor } from "../background/errpage.js";
import { startVoice } from "./voice.js";

const $ = (id) => document.getElementById(id);

const REASONS = {
  "net::ERR_INTERNET_DISCONNECTED": "You're not connected to the internet.",
  "net::ERR_NAME_NOT_RESOLVED": "Chrome couldn't find this site's address. Check the spelling.",
  "net::ERR_NAME_RESOLUTION_FAILED": "Chrome couldn't find this site's address. Check the spelling.",
  "net::ERR_CONNECTION_REFUSED": "The site refused to connect.",
  "net::ERR_CONNECTION_TIMED_OUT": "The site took too long to answer.",
  "net::ERR_TIMED_OUT": "The site took too long to answer.",
  "net::ERR_NETWORK_CHANGED": "Your network connection changed.",
  "net::ERR_EMPTY_RESPONSE": "The site sent nothing back.",
};

// What the user typed, as they would read it: the host, then the rest.
function shown(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, full: u.origin + u.pathname + u.search };
  } catch {
    return null;
  }
}

const [settings, rec] = await Promise.all([loadSettings(), recordFor(location.href).catch(() => null)]);
const addr = rec && shown(rec.url);

if (addr) {
  $("failed-text").textContent = `Chrome could not load ${addr.host}. ${REASONS[rec.error] || "The connection failed."}`;
  $("failed-url").textContent = addr.full;
  $("failed-url").hidden = false;
  $("failed-code").textContent = String(rec.error || "").replace(/^net::/, "");
  $("failed-code").hidden = !rec.error;
  $("retry").hidden = false;
} else {
  $("failed-text").textContent = "Chrome could not load the page, and Clearcart no longer has its address. Type it again in the address bar, or ask Clearcart to go somewhere.";
}

$("retry").addEventListener("click", async () => {
  $("error").hidden = true;
  try {
    const { url } = (await chrome.runtime.sendMessage({ type: RT.ERROR_PAGE_RETRY })) || {};
    if (!url) throw new Error("no address");
    location.replace(url);
  } catch {
    $("error").textContent = "Retry did not start. Type the address in the address bar.";
    $("error").hidden = false;
  }
});

$("settings").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

startVoice(settings);
document.documentElement.dataset.ready = "true";
