// Connected-address check for agent tabs. The blocklist judges a URL by its
// host name, but a public-looking name can resolve to this computer or the
// local network (localtest.me, a DNS rebinding domain), which would let a
// prompt-injected page send Claude to the agent server or a router. Chrome
// reports the IP each response actually came from (webRequest
// onResponseStarted `ip`); a tab whose page or frame came from a local
// address, on an origin that is not on the allowlist, is
// flagged here. The worker closes flagged Clearcart tabs and tabs.js refuses
// every call on them until then.
//
// Responses served from cache carry no `ip`; those use the last address seen
// for that origin, and pass when none is known (Chrome only caches what it
// fetched before). Flags live in memory: a flagged tab is closed right away,
// so a worker restart in between is the only gap.

import { isLocalIp } from "../lib/blocklist.js";
import { BridgeError, ERR } from "../lib/protocol.js";
import { normalizeOrigin } from "../lib/settings.js";

const flagged = new Map(); // tabId -> { origin, ip }
const lastIp = new Map(); // origin -> last connected ip
let allowlist = null; // Set of origins that may be local; null until settings load

export const FILTER = { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] };

// Settings loaded or changed. Drops flags the allowlist now covers (a
// response that arrived before the settings did).
export function setAllowlist(list) {
  allowlist = new Set(list || []);
  for (const [tabId, f] of flagged) if (allowlist.has(f.origin)) flagged.delete(tabId);
}

// webRequest.onResponseStarted details. Returns the flag when this response
// makes the tab unsafe, else null.
export function noteResponse(d) {
  if (!d || typeof d.tabId !== "number" || d.tabId < 0) return null;
  if (d.type !== "main_frame" && d.type !== "sub_frame") return null;
  const origin = normalizeOrigin(d.url);
  if (!origin) return null;
  if (d.ip) lastIp.set(origin, d.ip);
  const ip = d.ip || lastIp.get(origin) || null;
  const local = !!ip && isLocalIp(ip);
  if (local && !(allowlist && allowlist.has(origin))) {
    const flag = { origin, ip };
    flagged.set(d.tabId, flag);
    return flag;
  }
  if (d.type === "main_frame") flagged.delete(d.tabId);
  return null;
}

export function flagOf(tabId) {
  return flagged.get(tabId) || null;
}

export function forget(tabId) {
  flagged.delete(tabId);
}

// Throws BridgeError(ERR.NOT_ALLOWED) when the tab's page came from a local
// address it may not use.
export function assertNetSafe(tabId) {
  const f = flagged.get(tabId);
  if (f) throw new BridgeError(ERR.NOT_ALLOWED, `site blocked (it is served from a local address, ${f.ip}): ${f.origin}`);
}

// For tests.
export function _reset() {
  flagged.clear();
  lastIp.clear();
  allowlist = null;
}
