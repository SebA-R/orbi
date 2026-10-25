// Clearcart service worker (Manifest V3, ES module).
//
// Chrome starts and stops this worker on its own. Everything that must
// survive a restart lives in chrome.storage; listeners are registered at the
// top level so Chrome can wake the worker for them.

import * as tabs from "./tabs.js";
import * as cdp from "./cdp.js";
import { createRouter } from "./router.js";
import { BridgeClient } from "../lib/bridge.js";
import { createLogger } from "../lib/log.js";
import { endpoints, loadSettings, seedBlocklist } from "../lib/settings.js";
import { MSG } from "../lib/protocol.js";
import { installVoiceRelay } from "../lib/voice/relay.js";

const VERSION = chrome.runtime.getManifest().version;
const log = createLogger("worker");

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.info(`[clearcart] installed (${reason}), version ${VERSION}`);
  seedBlocklist().catch((e) => log.warn(`blocklist seed failed: ${e.message}`));
  // The offscreen document cannot ask for the microphone, so the first run
  // opens the options page where the user grants it.
  if (reason === "install") chrome.runtime.openOptionsPage().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  console.info(`[clearcart] browser started, version ${VERSION}`);
  bridge?.ensureConnected();
});

// Module A lifecycle: forget debugger sessions and the tab group with them.
chrome.tabs.onRemoved.addListener((tabId) => cdp.onTabRemoved(tabId));
chrome.debugger.onDetach.addListener((source) => cdp.onDetach(source));
chrome.tabGroups.onRemoved.addListener((group) => tabs.onGroupRemoved(group));

// Voice: hold-to-talk relay between content scripts and the offscreen
// document; SUBTITLE and VOICE_STATE go to the talking (or active) tab, where
// content/subtitles.js shows them.
const voice = installVoiceRelay();

// Bridge to the agent server: each request is routed to tabs/CDP or the page
// script. Results never include card values (fill_payment answers last4).
const router = createRouter();

async function onRequest(method, params) {
  const t0 = Date.now();
  try {
    const result = await router.route(method, params);
    log.debug(`${method} ok in ${Date.now() - t0} ms`);
    return result;
  } catch (e) {
    // Params are never logged: fill_payment carries the card.
    log.info(`${method} failed: ${e.code || "internal"} ${e.message}`);
    throw e;
  }
}

let bridge = null;

// The agent server's navigation guard and tab sweep use the user's blocked
// sites too, so send them on every connect and every change.
const sendBlocklist = () =>
  loadSettings().then(({ blocklist }) => bridge?.send({ type: MSG.BLOCKLIST, lines: blocklist })).catch(() => {});

async function startBridge() {
  const settings = await loadSettings();
  const url = endpoints(settings.agentUrl).ext;
  if (!bridge) {
    bridge = new BridgeClient({ url, version: VERSION, log, onRequest, onOpen: sendBlocklist, onState: (s) => log.info(`bridge ${s}`) });
    bridge.start();
  } else {
    bridge.setUrl(url);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.agentUrl) startBridge().catch((e) => log.warn(`bridge restart failed: ${e.message}`));
  if (changes.blocklist) sendBlocklist();
});

startBridge().catch((e) => log.warn(`bridge start failed: ${e.message}`));

// For tests and the console.
globalThis.clearcart = { router, voice, get bridge() { return bridge; } };
