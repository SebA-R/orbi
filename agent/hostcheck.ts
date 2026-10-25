// DNS rebinding defense for the agent server. A page on any site can point
// its own host name at 127.0.0.1 and then read this server as same origin
// (the voice token at /cartesia-token, the /session socket). The browser
// still sends that site's name in the Host header, so every HTTP request
// and WebSocket upgrade must name this computer and this server's port.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function hostAllowed(host: string | string[] | undefined, port: number): boolean {
  if (typeof host !== "string") return false;
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host.trim().toLowerCase());
  return !!m && LOCAL_NAMES.has(m[1]) && Number(m[2]) === port;
}

// The /memory endpoint (server.ts) is for the Clearcart extension's
// settings page only. On top of the Host check it needs:
//   - a loopback peer (the server listens on every interface), and
//   - an Origin that is the Clearcart extension. A web page cannot set
//     Origin, so no site can read or delete saved facts, even with the
//     Host header right. A request with no Origin is refused too.
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase().replace(/^::ffff:/, "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

// The extension id Chrome derives from a manifest key: the first 128 bits
// of the key's SHA-256, each hex digit written as a to p.
export function extensionIdFromKey(keyBase64: string): string {
  const hex = crypto.createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

// chrome-extension:// origins allowed at /memory: CLEARCART_EXT_IDS
// (comma-separated), else the id fixed by extension/manifest.json's key.
export function extensionOrigins(): Set<string> {
  const env = process.env.CLEARCART_EXT_IDS?.split(",").map((s) => s.trim()).filter((s) => /^[a-p]{32}$/.test(s));
  if (env?.length) return new Set(env.map((id) => `chrome-extension://${id}`));
  try {
    const key = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "manifest.json"), "utf8")).key;
    return new Set(typeof key === "string" ? [`chrome-extension://${extensionIdFromKey(key)}`] : []);
  } catch {
    return new Set();
  }
}

export function memoryRequestAllowed(req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }, port: number, origins = extensionOrigins()): boolean {
  const origin = req.headers.origin;
  return hostAllowed(req.headers.host, port) && isLoopbackAddress(req.socket.remoteAddress) && typeof origin === "string" && origins.has(origin);
}
