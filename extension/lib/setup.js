// First-run setup checks, shared by the worker (badge, open on install or
// update), the setup page and the toolbar popup. Every check takes its
// browser APIs as arguments so the unit tests can pass fakes.

import { HOTKEYS, endpoints } from "./settings.js";
import { micPermission } from "./mic-grant.js";

export const SETUP_PATH = "setup/setup.html";
export const ALL_SITES = Object.freeze({ origins: ["<all_urls>"] });
export const EXTENSIONS_PAGE = (id) => `chrome://extensions/?id=${id}`;

// Chrome can hold back <all_urls> after an update when the user had limited
// the extension's site access earlier, so this is checked, not assumed.
export async function hasSiteAccess(chromeApi = globalThis.chrome) {
  try {
    return !!(await chromeApi.permissions.contains(ALL_SITES));
  } catch {
    return false;
  }
}

// Must run inside a click handler: Chrome only asks on a user gesture.
// Returns whether access is on afterwards.
export async function requestSiteAccess(chromeApi = globalThis.chrome) {
  try {
    if (await chromeApi.permissions.request(ALL_SITES)) return true;
  } catch {}
  return hasSiteAccess(chromeApi);
}

export const micState = micPermission;

// GET /healthz on the configured agent server. voice is null when unknown.
export async function agentHealth(agentUrl, fetchFn = globalThis.fetch, timeoutMs = 3000) {
  const url = `${endpoints(agentUrl).http}/healthz`;
  try {
    const res = await fetchFn(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { connected: false, voice: null, url };
    const body = await res.json();
    return { connected: body?.ok === true, voice: typeof body?.voice === "boolean" ? body.voice : null, url };
  } catch {
    return { connected: false, voice: null, url };
  }
}

// What the badge and the update check care about: the two grants only the
// user can give. A mic state the worker can't read ("unknown") is not
// counted as missing.
export async function missingSetup({ chromeApi = globalThis.chrome, permissions = globalThis.navigator?.permissions } = {}) {
  const [site, mic] = await Promise.all([hasSiteAccess(chromeApi), micState(permissions)]);
  const missing = [];
  if (!site) missing.push("site");
  if (mic !== "granted" && mic !== "unknown") missing.push("mic");
  return missing;
}

export function shouldOpenSetup(reason, missing) {
  if (reason === "install") return true;
  if (reason === "update") return missing.length > 0;
  return false;
}

const MISSING_NAMES = { site: "site access", mic: "microphone" };

export async function updateBadge(chromeApi, missing) {
  const action = chromeApi?.action;
  if (!action) return;
  const need = missing.length > 0;
  try {
    await action.setBadgeText({ text: need ? "!" : "" });
    if (need) await action.setBadgeBackgroundColor({ color: "#b3261e" });
    // The title is what screen readers announce for the toolbar button.
    await action.setTitle({ title: need ? `Clearcart: setup needed (${missing.map((m) => MISSING_NAMES[m]).join(", ")})` : "Clearcart" });
  } catch {}
}

export async function refreshBadge(apis = {}) {
  const missing = await missingSetup(apis);
  await updateBadge(apis.chromeApi ?? globalThis.chrome, missing);
  return missing;
}

// onInstalled: badge first, then the setup page on install, and on update
// only if something is still missing.
export async function onInstalledSetup(reason, apis = {}) {
  const chromeApi = apis.chromeApi ?? globalThis.chrome;
  const missing = await refreshBadge({ ...apis, chromeApi });
  if (!shouldOpenSetup(reason, missing)) return false;
  await chromeApi.tabs.create({ url: chromeApi.runtime.getURL(SETUP_PATH) });
  return true;
}

export const keyName = (hotkey) => (HOTKEYS[hotkey] || HOTKEYS.Space).split(" (")[0];

export function talkKeyHelp(hotkey) {
  const name = keyName(hotkey);
  const hold = `Hold ${name}, wait for the chime, speak, then let go.`;
  if (name === "Space") return `${hold} In a text field, Space types a space, so hold Option + Space there instead.`;
  return `${hold} It works in text fields too.`;
}

export const allReady = ({ site, mic, agent }) => site === true && mic === "granted" && agent?.connected === true;
