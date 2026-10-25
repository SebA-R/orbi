// Which sites agent-driven tabs may be on. Everything comes from user
// settings (chrome.storage.local, writable only by extension pages), so the
// agent server cannot widen it.
//
// browseMode "allowlist": only the allowlist origins.
// browseMode "open": any http(s) site except the built-in blocklist
// (lib/blocklist.js) and the user's blocklist. Allowlist origins are always
// allowed (that is how the local demo store gets past the localhost block),
// unless the user also put them on the blocklist.
//
// Pay sites (isPaySite) are the allowlist in both modes: open browsing does
// not let the pay flow arm an unlock anywhere new.

import { loadSettings, normalizeOrigin } from "../lib/settings.js";
import { builtinBlockReason } from "../lib/blocklist.js";
import { BridgeError, ERR } from "../lib/protocol.js";

export async function allowedOrigins() {
  const { allowlist } = await loadSettings();
  return [...allowlist];
}

// Pure policy: why `url` is not allowed under `settings`, or null.
export function blockReason(url, settings) {
  const origin = normalizeOrigin(url);
  const listed = !!origin && settings.allowlist.includes(origin);
  if (settings.browseMode !== "open") return listed ? null : "not on the allowlist";
  if (origin && settings.blocklist.includes(origin)) return "on your blocklist";
  if (listed) return null;
  return builtinBlockReason(url, new Set(settings.allowlist));
}

export async function isAllowed(url) {
  return !blockReason(url, await loadSettings());
}

export async function isPaySite(url) {
  const origin = normalizeOrigin(url);
  return !!origin && (await allowedOrigins()).includes(origin);
}

// Throws BridgeError(ERR.NOT_ALLOWED) unless the settings allow this url.
export async function assertAllowed(url) {
  const settings = await loadSettings();
  const why = blockReason(url, settings);
  if (!why) return;
  let shown = "invalid url";
  try {
    shown = new URL(String(url)).origin;
  } catch {}
  if (shown === "null") shown = String(url).split(":")[0] + ":";
  throw new BridgeError(ERR.NOT_ALLOWED, settings.browseMode === "open" ? `site blocked (${why}): ${shown}` : `origin not allowlisted: ${shown}`);
}
