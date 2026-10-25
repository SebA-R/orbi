// Saved cards for the extension's settings page (vault/index.ts):
//
//   GET    /cards                { cards: [{ id, nickname, brand, last4 }], defaultId }
//   POST   /cards                add one: { nickname?, name, number, exp, csc, zip? }
//   DELETE /cards/<id>           remove one
//   POST   /cards/<id>/default   the card pay_with_saved_card uses by default
//
// Loopback peers with the Clearcart extension's Origin only, the /memory
// rule (hostcheck.ts), so no web page can reach it. JSON bodies of at most
// 4 KB, and rate limited. No answer ever holds a number, expiry or security
// code, nothing here logs a body, and errors are generic.

import type http from "node:http";
import path from "node:path";

import { CARD_ID, CardVault, keychainKeys, legacyKeychainCard, scrub, VaultError } from "../vault/index.ts";
import { dataDir } from "./memory.ts";

export const BODY_MAX_BYTES = 4 * 1024;
// Per minute, counted only for requests that passed the origin check.
export const READS_PER_MINUTE = 60;
export const WRITES_PER_MINUTE = 10;

let vault: CardVault | null = null;
let vaultFile = "";

// The vault in the agent's data dir (CLEARCART_DATA_DIR, else agent/.data),
// with its key in the macOS Keychain.
export function cardVault(): CardVault {
  const file = path.join(dataDir(), "cards.json");
  if (!vault || file !== vaultFile) {
    vault = new CardVault({ file, keys: keychainKeys(), legacy: legacyKeychainCard() });
    vaultFile = file;
  }
  return vault;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// At most `limit` takes in any `ms` window.
export class RateWindow {
  private hits: number[] = [];
  constructor(private limit: number, private ms = 60_000) {}
  take(now: number): boolean {
    this.hits = this.hits.filter((t) => now - t < this.ms);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}

// The body as JSON. The raw bytes are zeroed once parsed: they hold the card.
function readJson(req: http.IncomingMessage, max = BODY_MAX_BYTES): Promise<unknown> {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return Promise.reject(new HttpError(415, "Send the card as JSON."));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const wipe = () => chunks.forEach((c) => c.fill(0));
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      chunks.push(c);
      if (size > max) {
        done = true;
        wipe();
        reject(new HttpError(413, "That request is too large."));
      }
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const all = Buffer.concat(chunks);
      wipe();
      try {
        resolve(JSON.parse(all.toString("utf8")));
      } catch {
        reject(new HttpError(400, "That request is not valid JSON."));
      } finally {
        all.fill(0);
      }
    });
    req.on("error", () => {
      if (done) return;
      done = true;
      wipe();
      reject(new HttpError(400, "The request did not arrive."));
    });
  });
}

export type CardsRouteOptions = {
  vault?: () => CardVault;
  // The origin rule: memoryRequestAllowed in server.ts.
  allowed: (req: http.IncomingMessage) => boolean;
  now?: () => number;
  log?: (line: string) => void;
};

export function createCardsRoute(opts: CardsRouteOptions) {
  const getVault = opts.vault ?? cardVault;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((l: string) => console.log(l));
  const reads = new RateWindow(READS_PER_MINUTE);
  const writes = new RateWindow(WRITES_PER_MINUTE);

  return async function cardsRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    if (!opts.allowed(req)) return json(res, 403, { error: "forbidden" });
    const read = req.method === "GET";
    if (!(read ? reads : writes).take(now())) {
      res.setHeader("Retry-After", "60");
      return json(res, 429, { error: "Too many requests. Try again in a minute." });
    }
    const v = getVault();
    try {
      if (pathname === "/cards" && read) {
        await v.migrateLegacy().then((r) => r === "moved" && log("cards: moved the old demo card into the vault"), () => {});
        return json(res, 200, v.list());
      }
      if (pathname === "/cards" && req.method === "POST") {
        const body = (await readJson(req)) as Record<string, unknown>;
        const r = await v.add(body).finally(() => scrub(body && typeof body === "object" ? body : null));
        if (!r.ok) return json(res, 400, { error: r.error });
        log("cards: saved a card (settings page)");
        return json(res, 201, { ok: true, card: r.card, defaultId: r.defaultId });
      }
      const m = /^\/cards\/([^/]+)(\/default)?$/.exec(pathname);
      if (m && !CARD_ID.test(m[1])) return json(res, 404, { error: "not found" });
      if (m && !m[2] && req.method === "DELETE") {
        const hit = await v.remove(m[1]);
        if (hit) log("cards: removed a card (settings page)");
        return hit ? json(res, 200, { ok: true, defaultId: v.list().defaultId }) : json(res, 404, { error: "not found" });
      }
      if (m && m[2] && req.method === "POST") {
        const hit = await v.setDefault(m[1]);
        return hit ? json(res, 200, { ok: true, defaultId: m[1] }) : json(res, 404, { error: "not found" });
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      if (e instanceof VaultError) return json(res, 500, { error: e.message });
      return json(res, 500, { error: "Something went wrong with the saved cards." });
    }
  };
}
