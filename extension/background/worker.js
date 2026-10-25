// Clearcart service worker (Manifest V3, ES module).
//
// Chrome starts and stops this worker on its own. Everything that must
// survive a restart lives in chrome.storage; listeners are registered at the
// top level so Chrome can wake the worker for them.

import * as tabs from "./tabs.js";
import * as cdp from "./cdp.js";
import * as netguard from "./netguard.js";
import { createRouter } from "./router.js";
import { BridgeClient } from "../lib/bridge.js";
import { createLogger } from "../lib/log.js";
import { endpoints, loadSettings, seedBlocklist } from "../lib/settings.js";
import { MSG, RT } from "../lib/protocol.js";
import { installVoiceRelay } from "../lib/voice/relay.js";
import { onInstalledSetup, refreshBadge } from "../lib/setup.js";
import { injectIntoOpenTabs } from "../lib/inject.js";

const VERSION = chrome.runtime.getManifest().version;
const log = createLogger("worker");

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.info(`[clearcart] installed (${reason}), version ${VERSION}`);
  seedBlocklist().catch((e) => log.warn(`blocklist seed failed: ${e.message}`));
  // Earlier versions kept agent tabs in a "Clearcart" tab group: take them
  // out of it, closing nothing.
  tabs.ungroupLegacy().then((n) => n && log.info(`ungrouped ${n} tab(s) from the old Clearcart group`)).catch(() => {});
  // Setup page (site access, microphone, agent server): always on install,
  // on update only when site access or the mic is still missing.
  onInstalledSetup(reason).catch((e) => log.warn(`setup check failed: ${e.message}`));
  // Tabs open before this install, update or reload have no content scripts yet.
  injectIntoOpenTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  console.info(`[clearcart] browser started, version ${VERSION}`);
  bridge?.ensureConnected();
});

// "!" on the toolbar icon while site access or the mic is missing. Checked
// whenever the worker starts and when site access changes; the setup page
// and popup also update it after their checks.
const badge = () => refreshBadge().catch(() => {});
badge();
chrome.permissions.onAdded.addListener(() => {
  badge();
  // New site access: add the content scripts to the tabs already open.
  injectIntoOpenTabs().catch(() => {});
});
chrome.permissions.onRemoved.addListener(badge);

// Module A lifecycle: forget debugger sessions and which tabs Clearcart
// opened.
chrome.tabs.onRemoved.addListener((tabId) => cdp.onTabRemoved(tabId));
chrome.tabs.onRemoved.addListener((tabId) => void tabs.onTabRemoved(tabId).catch(() => {}));
chrome.debugger.onDetach.addListener((source) => cdp.onDetach(source));

// Connected-address check (netguard.js): a tab Clearcart opened whose page
// came from a local address it may not use is closed. The user's own tabs
// are never closed; every call on a flagged tab is refused instead.
chrome.tabs.onRemoved.addListener((tabId) => netguard.forget(tabId));
chrome.webRequest.onResponseStarted.addListener((d) => {
  const flag = netguard.noteResponse(d);
  if (flag) void closeIfAgentTab(d.tabId, flag);
}, netguard.FILTER);

async function closeIfAgentTab(tabId, flag) {
  try {
    if (!(await tabs.isCreated(tabId)) || netguard.flagOf(tabId) !== flag) return;
    log.info(`closing agent tab: ${flag.origin} is served from a local address`);
    await chrome.tabs.remove(tabId);
  } catch {}
}

const loadAllowlist = () => loadSettings().then((s) => netguard.setAllowlist(s.allowlist)).catch(() => {});
loadAllowlist();

// Voice: hold-to-talk relay between content scripts and the offscreen
// document; SUBTITLE and VOICE_STATE go to the talking (or active) tab, where
// content/subtitles.js shows them.
const voice = installVoiceRelay();

// Bridge to the agent server: each request is routed to tabs/CDP or the page
// script. Results never include card values (fill_payment answers last4).
// Danger mode, cached from chrome.storage.local and kept current by
// onChanged below. Starts off, so a page call before the first load is
// locked as usual.
let dangerMode = false;
const loadDangerMode = () => loadSettings().then((s) => { dangerMode = s.dangerMode; }).catch(() => { dangerMode = false; });
const dangerReady = loadDangerMode();
const router = createRouter({ dangerMode: () => dangerReady.then(() => dangerMode) });

// The user started talking: snapshot what they are looking at and pointing
// at now, for the page_context call that comes with their words.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === RT.PTT_START && msg.target !== "offscreen") void router.noteTalkStart();
});
chrome.commands?.onCommand.addListener(() => void router.noteTalkStart());

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

// Danger mode too, the same way, so the agent says "Danger mode is on." and
// tells Claude. The extension enforces the lock itself; this only informs.
const sendDangerMode = () =>
  loadSettings().then(({ dangerMode: on }) => bridge?.send({ type: MSG.DANGER_MODE, on })).catch(() => {});
const sendSettings = () => { sendBlocklist(); sendDangerMode(); };

async function startBridge() {
  const settings = await loadSettings();
  const url = endpoints(settings.agentUrl).ext;
  if (!bridge) {
    bridge = new BridgeClient({ url, version: VERSION, log, onRequest, onOpen: sendSettings, onState: (s) => log.info(`bridge ${s}`) });
    bridge.start();
  } else {
    bridge.setUrl(url);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.allowlist) loadAllowlist();
  if (changes.agentUrl) startBridge().catch((e) => log.warn(`bridge restart failed: ${e.message}`));
  if (changes.blocklist) sendBlocklist();
  if (changes.dangerMode) {
    loadDangerMode();
    sendDangerMode();
  }
});

startBridge().catch((e) => log.warn(`bridge start failed: ${e.message}`));

// For tests and the console.
globalThis.clearcart = { router, voice, get bridge() { return bridge; } };
