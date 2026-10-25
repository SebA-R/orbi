import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// DNS rebinding defense for the agent server. A page on any site can point
// its own host name at 127.0.0.1 and then read this server as same origin
// (the voice token at /cartesia-token, the /session socket). The browser
// still sends that site's name in the Host header, so every HTTP request
// and WebSocket upgrade must name this computer and this server's port.

const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function hostAllowed(host: string | string[] | undefined, port: number): boolean {
  if (typeof host !== "string") return false;
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host.trim().toLowerCase());
  return !!m && LOCAL_NAMES.has(m[1]) && Number(m[2]) === port;
}

// The Origin header of a WebSocket upgrade. A browser always sends one, so
// a web page cannot hide its own; a client outside a browser sends none.
// /ext takes only Clearcart's extension (its id comes from the manifest
// key) or no Origin. /session also takes this server's own page. Any other
// page, on any site, is refused: it could otherwise talk to the agent as
// the user (or, on /ext, pose as the extension and send its settings).

// Chrome's id for an extension: sha256 of its public key, first 32 hex
// digits written with a-p. null when the manifest has no key.
export function extensionIdFromKey(key: string): string {
  const hex = crypto.createHash("sha256").update(Buffer.from(key.replace(/\s+/g, ""), "base64")).digest("hex").slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

function manifestExtensionId(): string | null {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "manifest.json");
    const key = JSON.parse(fs.readFileSync(file, "utf8")).key;
    return typeof key === "string" && key ? extensionIdFromKey(key) : null;
  } catch {
    return null;
  }
}

// Clearcart's extension ids: the manifest's, plus CLEARCART_EXTENSION_IDS
// (comma separated) for a build with another key.
export const EXTENSION_IDS: ReadonlySet<string> = new Set(
  [manifestExtensionId(), ...String(process.env.CLEARCART_EXTENSION_IDS || "").split(",")]
    .map((s) => (s || "").trim())
    .filter((s): s is string => /^[a-p]{32}$/.test(s))
);

export function extOriginAllowed(origin: string | string[] | undefined, ids: ReadonlySet<string> = EXTENSION_IDS): boolean {
  if (origin === undefined) return true;
  if (typeof origin !== "string") return false;
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin.trim());
  return !!m && ids.has(m[1]);
}

export function sessionOriginAllowed(origin: string | string[] | undefined, port: number, ids: ReadonlySet<string> = EXTENSION_IDS): boolean {
  if (extOriginAllowed(origin, ids)) return true;
  if (typeof origin !== "string") return false;
  const m = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)$/.exec(origin.trim().toLowerCase());
  return !!m && Number(m[2]) === port;
}
