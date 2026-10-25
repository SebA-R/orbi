// Origin allowlist for agent-driven tabs. The list comes from user settings
// (chrome.storage.local, writable only by extension pages), so the agent
// server cannot widen it.

import { loadSettings, normalizeOrigin } from "../lib/settings.js";
import { BridgeError, ERR } from "../lib/protocol.js";

export async function allowedOrigins() {
  const { allowlist } = await loadSettings();
  return [...allowlist];
}

export async function isAllowed(url) {
  const origin = normalizeOrigin(url);
  if (!origin) return false;
  return (await allowedOrigins()).includes(origin);
}

// Throws BridgeError(ERR.NOT_ALLOWED) unless new URL(url).origin is allowlisted.
export async function assertAllowed(url) {
  if (await isAllowed(url)) return;
  let shown = "invalid url";
  try {
    shown = new URL(String(url)).origin;
  } catch {}
  throw new BridgeError(ERR.NOT_ALLOWED, `origin not allowlisted: ${shown}`);
}
