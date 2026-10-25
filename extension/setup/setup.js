// Setup page: opened by the worker on install, and on update when site
// access or the microphone is still missing. The popup's mic button opens it
// with #mic, since a popup closes when Chrome's mic prompt appears.
import { grantMic } from "../lib/mic-grant.js";
import { createChecklist } from "./checklist.js";

const live = document.getElementById("live");
const list = createChecklist({
  root: document.getElementById("checklist"),
  live,
  level: 2,
  onMic: async () => (await grantMic()).message,
});

await list.refresh({ announceAll: true });

// Back from chrome://extensions or a permission prompt: check again.
let pending = false;
const recheck = () => {
  if (pending || document.hidden) return;
  pending = true;
  list.refresh().finally(() => { pending = false; });
};
window.addEventListener("focus", recheck);
document.addEventListener("visibilitychange", recheck);
chrome.permissions.onAdded.addListener(recheck);
chrome.permissions.onRemoved.addListener(recheck);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.agentUrl || changes.hotkey)) recheck();
});

if (location.hash === "#mic" && list.state.mic !== "granted") {
  list.items.mic.button.focus();
  list.items.mic.button.click();
} else {
  (list.firstNeeded() || document.getElementById("title")).focus();
}
document.documentElement.dataset.ready = "true";
