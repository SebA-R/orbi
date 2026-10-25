// Orbi service worker (Manifest V3, ES module).
//
// Chrome starts and stops this worker on its own. Everything that must
// survive a restart lives in chrome.storage; listeners are registered at the
// top level so Chrome can wake the worker for them.

import * as tabs from "./tabs.js";
import * as cdp from "./cdp.js";
import * as netguard from "./netguard.js";
import { createRouter } from "./router.js";
import { createFollower } from "./follow.js";
import { createErrorPages, FILTER as ERROR_FILTER } from "./errpage.js";
import { BridgeClient } from "../lib/bridge.js";
import { createLogger } from "../lib/log.js";
import { AGENT_SETTING_KEYS, agentSettingsMessage, endpoints, loadSettings, migrateSettings, seedBlocklist } from "../lib/settings.js";
import { MSG, RT } from "../lib/protocol.js";
import { installVoiceRelay } from "../lib/voice/relay.js";
import { installBasicTtsHost } from "./basic-tts-host.js";
import { installFrame } from "./frame.js";
import { createCursorRelay } from "./cursor.js";
import { onInstalledSetup, refreshBadge } from "../lib/setup.js";
import { injectIntoOpenTabs } from "../lib/inject.js";

const VERSION = chrome.runtime.getManifest().version;
const log = createLogger("worker");

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.info(`[clearcart] installed (${reason}), version ${VERSION}`);
  seedBlocklist().catch((e) => log.warn(`blocklist seed failed: ${e.message}`));
  // An update takes the old default allowed site out of stored settings.
  migrateSettings()
    .then((removed) => removed && log.info("removed the old default allowed site"))
    .catch((e) => log.warn(`settings migration failed: ${e.message}`));
  // Earlier versions kept agent tabs in a "Orbi" tab group: take them
  // out of it, closing nothing.
  tabs.ungroupLegacy().then((n) => n && log.info(`ungrouped ${n} tab(s) from the old Orbi group`)).catch(() => {});
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

// Module A lifecycle: forget debugger sessions and which tabs Orbi
// opened.
chrome.tabs.onRemoved.addListener((tabId) => cdp.onTabRemoved(tabId));
chrome.tabs.onRemoved.addListener((tabId) => void tabs.onTabRemoved(tabId).catch(() => {}));
chrome.debugger.onDetach.addListener((source) => cdp.onDetach(source));

// Connected-address check (netguard.js): a tab Orbi opened whose page
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

// Network error pages: Chrome's runs no content scripts, so a failed main
// frame in a normal tab goes on to Orbi's "Can't reach this site" page
// (errpage.js), where Space to talk works.
const errorPages = createErrorPages({ loadSettings });
chrome.webRequest.onErrorOccurred.addListener((d) => errorPages.onRequestError(d), ERROR_FILTER);
chrome.tabs.onUpdated.addListener((tabId, change, tab) => void errorPages.onTabUpdated(tabId, change, tab).catch(() => {}));
chrome.tabs.onRemoved.addListener((tabId) => void errorPages.forget(tabId));
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== RT.ERROR_PAGE_RETRY || msg.target != null || sender.id !== chrome.runtime.id) return;
  errorPages.onRetry(sender).then(reply, () => reply({ url: null }));
  return true;
});

const loadAllowlist = () => loadSettings().then((s) => netguard.setAllowlist(s.allowlist)).catch(() => {});
loadAllowlist();

// Voice: hold-to-talk relay between content scripts and the offscreen
// document; SUBTITLE and VOICE_STATE go to the talking (or active) tab, where
// content/subtitles.js shows them.
// The active-tab frame (content/frame.js) goes on the tab Orbi is
// acting on during a turn; the relay reports voice states, the router calls.
const frame = installFrame();
// Orbi's cursor (content/cursor.js), cached like the settings below.
let showCursor = true;
loadSettings().then((s) => { showCursor = s.showCursor; }).catch(() => {});
const cursor = createCursorRelay({ enabled: () => showCursor });
// Basic voice (no Cartesia key): chrome.tts for the offscreen document.
installBasicTtsHost({ log: (m) => log.info(m) });
const voice = installVoiceRelay({
  onVoiceState: (state, tabId) => {
    frame.onVoiceState(state, tabId);
    cursor.onVoiceState(state);
  },
});

// Bridge to the agent server: each request is routed to tabs/CDP or the page
// script. Results never include card values (fill_card answers last4).
// Danger mode, cached from chrome.storage.local and kept current by
// onChanged below. Starts off, so a page call before the first load is
// locked as usual.
// On a local model Danger mode lifts nothing: small models are easier to
// steer with page text, so every lock stays (the agent server does the same
// for the spoken yes and the checkout page block).
let dangerMode = false;
let providerLocal = false;
const dangerReady = loadSettings().then((s) => { dangerMode = s.dangerMode; providerLocal = s.provider === "local"; }).catch(() => { dangerMode = false; });
// Follow: the tab Orbi acts on comes to the front (follow.js). A tab or
// window the user picks themselves pauses that until their next turn.
const follow = createFollower();
chrome.tabs.onActivated.addListener((info) => follow.onActivated(info));
chrome.windows?.onFocusChanged?.addListener((id) => follow.onWindowFocused(id));
chrome.tabs.onRemoved.addListener((tabId) => follow.forget(tabId));
// Watchable pace (background/actor.js), cached like Danger mode. Starts
// on, the default, so the first action after a restart is paced too.
let watchablePace = true;
const paceReady = loadSettings().then((s) => { watchablePace = s.watchablePace; }).catch(() => {});
const router = createRouter({
  follow,
  onAgentTab: frame.onAgentTab,
  dangerMode: () => dangerReady.then(() => dangerMode && !providerLocal),
  watchable: () => paceReady.then(() => watchablePace),
});
// A paced click, typing or scroll stops when the user barges in, switches
// to another tab in that window, or the page goes away.
const actor = router.actor;
chrome.tabs.onActivated.addListener((info) => actor.onTabActivated(info));
chrome.tabs.onRemoved.addListener((tabId) => actor.onTabRemoved(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => actor.onTabUpdated(tabId, change));
// The cursor follows the actor's input; a tab switch or interrupt hides it.
actor.onPointer(cursor.onPointer);
chrome.tabs.onActivated.addListener((info) => cursor.onTabActivated(info));
chrome.tabs.onRemoved.addListener((tabId) => cursor.onTabRemoved(tabId));
const BARGE_IN = new Set([RT.PTT_CONFIRM, RT.PTT_HUSH, RT.PTT_TOGGLE]);
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target === "offscreen") return;
  // A silent start may still be a tap; it barges in once confirmed.
  if (BARGE_IN.has(msg.type) || (msg.type === RT.PTT_START && !msg.silent)) actor.abortAll("the user started talking");
});
chrome.commands?.onCommand.addListener(() => actor.abortAll("the user started talking"));

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
    // Params are never logged: fill_card carries the card.
    log.info(`${method} failed: ${e.code || "internal"} ${e.message}`);
    throw e;
  }
}

let bridge = null;

// The agent server's navigation guard and tab sweep use the user's blocked
// sites too, so send them on every connect and every change.
const sendBlocklist = () =>
  loadSettings().then(({ blocklist }) => bridge?.send({ type: MSG.BLOCKLIST, lines: blocklist })).catch(() => {});
// Guided mode, Memory and the model provider shape the agent; sent on
// connect and on change.
const sendAgentSettings = () =>
  loadSettings().then((s) => bridge?.send(agentSettingsMessage(s))).catch(() => {});

// Danger mode too, the same way, so the agent says "Danger mode is on." and
// tells Claude. The extension enforces the click lock itself; the server
// also reads it to skip the spoken yes, so only the user sets it.
const sendDangerMode = () =>
  loadSettings().then(({ dangerMode: on }) => bridge?.send({ type: MSG.DANGER_MODE, on })).catch(() => {});
const sendSettings = () => { sendBlocklist(); sendDangerMode(); sendAgentSettings(); };

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
  if (AGENT_SETTING_KEYS.some((k) => changes[k])) sendAgentSettings();
  if (changes.watchablePace) watchablePace = changes.watchablePace.newValue !== false;
  if (changes.showCursor) {
    showCursor = changes.showCursor.newValue !== false;
    if (!showCursor) cursor.hide();
  }
  if (changes.provider) providerLocal = changes.provider.newValue === "local";
  if (changes.dangerMode) {
    // Straight from the change, so the very next page call has it.
    dangerMode = changes.dangerMode.newValue === true;
    sendDangerMode();
  }
});

startBridge().catch((e) => log.warn(`bridge start failed: ${e.message}`));

// For tests and the console.
// actor.onPointer(fn) feeds the on-page cursor (background/cursor.js).
globalThis.clearcart = { router, voice, frame, actor, cursor, get bridge() { return bridge; } };
