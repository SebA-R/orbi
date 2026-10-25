// Clearcart's card vault: the cards the user saved in Clearcart settings,
// encrypted on this computer, so the pay flow can fill one at checkout and
// the AI never sees it.
//
// The file (cards.json in the agent's data dir: 0600, its directory 0700,
// gitignored) holds one entry per card. The secret fields (name on card,
// number, expiry, security code, billing ZIP) are a single AES-256-GCM
// record with its own random 96-bit IV; the card's id, brand and last 4
// digits are its additional data, so a record cannot be moved to another
// entry or relabeled without failing to open. Only the nickname, brand and
// last 4 are kept in the clear, for the settings list and for picking a
// card.
//
// The 256-bit data key is made once (crypto.randomBytes) and kept in the
// macOS login Keychain as a generic password, service clearcart-vault-key
// (keychainKeys). It is fetched for each add (to encrypt) and each fill (to
// decrypt), and the Buffer is zeroed after use. Tests pass memoryKeys()
// instead; nothing reads a key from the environment.
//
// Decrypting happens only in withCard(), which only the pay flow calls
// (agent/pay.ts), and the card's fields are dropped when it returns.
// Nothing here logs or returns a card field, and errors are generic.
//
// The old single demo card (Keychain service clearcart-card, account demo,
// from an earlier vault/setup-test-card.sh) moves in once (migrateLegacy).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { addSecret, deleteSecret, readSecret } from "./keychain.ts";

export type CardMeta = { id: string; nickname: string; brand: string; last4: string };
export type CardSecret = { name: string; number: string; exp: string; csc: string; zip: string };
export type CardList = { cards: CardMeta[]; defaultId: string | null };
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

// Where the data key lives. get() answers null when no key was made yet.
export interface KeyStore {
  get(): Promise<Buffer | null>;
  // Stores a new key, never replacing one: "exists" when there is one.
  create(key: Buffer): Promise<"created" | "exists">;
}

// The card from before this vault, if there is one.
export interface LegacyCard {
  read(): Promise<{ name?: unknown; number?: unknown; exp?: unknown; csc?: unknown } | null>;
  remove(): Promise<void>;
}

export class VaultError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export const MAX_CARDS = 10;
export const KEY_SERVICE = "clearcart-vault-key";
const KEY_ACCOUNT = "clearcart";
const LEGACY_SERVICE = "clearcart-card";
const LEGACY_ACCOUNT = "demo";
export const LEGACY_NICKNAME = "Demo card";
export const CARD_ID = /^c[0-9a-f]{8}$/;

export const NO_CARD = "No card is saved in Clearcart. Tell the user to add one in Clearcart settings, under Payment cards.";
const DAMAGED = "The saved cards could not be read.";
const NO_KEY = "The key for the saved cards is missing from the Keychain. Remove the saved cards in Clearcart settings and add them again.";
const OTHER_KEY = "The saved cards were locked with a different key. Remove them in Clearcart settings and add them again.";

// ------------------------------------------------------------- checks

export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl && (n *= 2) > 9) n -= 9;
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function brandOf(digits: string): string {
  const p4 = Number(digits.slice(0, 4));
  if (/^4/.test(digits)) return "Visa";
  if (/^5[1-5]/.test(digits) || (p4 >= 2221 && p4 <= 2720)) return "Mastercard";
  if (/^3[47]/.test(digits)) return "American Express";
  if (/^(6011|65|64[4-9])/.test(digits)) return "Discover";
  if (/^35(2[89]|[3-8])/.test(digits)) return "JCB";
  if (/^3(0[0-5]|[689])/.test(digits)) return "Diners Club";
  return "Card";
}

// "12/30", "12/2030", "1/30", "12 - 30", "1230" -> { mm: "12", yy: "30" },
// or null. Not past the end of its month, and at most 20 years ahead.
export function parseExp(exp: unknown, now = new Date()): { mm: string; yy: string } | { error: string } {
  const s = String(exp ?? "").trim();
  const m = /^(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})$/.exec(s) || /^(\d{2})(\d{2})$/.exec(s);
  if (!m) return { error: "Enter the expiry as MM/YY." };
  const month = Number(m[1]);
  const year = m[2].length === 4 ? Number(m[2]) : 2000 + Number(m[2]);
  if (month < 1 || month > 12) return { error: "Enter the expiry as MM/YY." };
  const y = now.getFullYear();
  if (year < y || (year === y && month < now.getMonth() + 1)) return { error: "That card has expired." };
  if (year > y + 20) return { error: "Check the expiry date." };
  return { mm: String(month).padStart(2, "0"), yy: String(year % 100).padStart(2, "0") };
}

const squash = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const norm = (s: unknown) => squash(s).toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
// Five or more digits in a row (spaces or dashes between them count too):
// never in a nickname, which is stored in the clear.
const LONG_NUMBER = /\d(?:[\s-]?\d){4,}/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type ValidCard = { nickname: string; brand: string; last4: string; secret: CardSecret };

// The card the settings page sent, checked and normalized, or why not. The
// messages are for the person typing; none of them repeats a value.
export function validateCard(input: unknown, now = new Date()): Result<{ card: ValidCard }> {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const k of ["nickname", "name", "number", "exp", "csc", "zip"]) {
    if (o[k] != null && typeof o[k] !== "string") return { ok: false, error: "Some card details are not text." };
  }
  const number = String(o.number ?? "").replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(number) || !luhnValid(number)) return { ok: false, error: "That card number is not valid." };
  const brand = brandOf(number);
  const name = squash(o.name);
  if (!name || name.length > 100 || CONTROL.test(name) || !/\p{L}/u.test(name)) return { ok: false, error: "Enter the name on the card." };
  const exp = parseExp(o.exp, now);
  if ("error" in exp) return { ok: false, error: exp.error };
  const csc = String(o.csc ?? "").trim();
  const cscLen = brand === "American Express" ? 4 : 3;
  if (!new RegExp(`^\\d{${cscLen}}$`).test(csc)) {
    return { ok: false, error: `The security code is ${cscLen} digits${cscLen === 4 ? "" : " (4 for American Express)"}.` };
  }
  const zip = squash(o.zip);
  if (zip && !/^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/.test(zip)) return { ok: false, error: "Enter a valid billing ZIP or postal code." };
  const nickname = squash(o.nickname);
  if (nickname.length > 40 || CONTROL.test(nickname) || LONG_NUMBER.test(nickname)) {
    return { ok: false, error: "Use a short nickname without long numbers, like Work Visa." };
  }
  return { ok: true, card: { nickname, brand, last4: number.slice(-4), secret: { name, number, exp: `${exp.mm}/${exp.yy}`, csc, zip } } };
}

// Drops the strings a card held. JS strings cannot be wiped, so this is the
// most it can do: no reference to a field outlives the call that needed it.
export function scrub(card: Partial<Record<string, unknown>> | null | undefined) {
  if (!card) return;
  for (const k of Object.keys(card)) card[k] = "";
}

// ------------------------------------------------------------- file

type Entry = CardMeta & { addedAt: number; iv: string; tag: string; data: string };
type VaultFile = { version: 1; keyId: string | null; defaultId: string | null; cards: Entry[] };

const empty = (): VaultFile => ({ version: 1, keyId: null, defaultId: null, cards: [] });

function aad(e: { id: string; brand: string; last4: string }) {
  return Buffer.from(`clearcart-card/v1/${e.id}/${e.brand}/${e.last4}`);
}

// Names a key without revealing it, so a vault locked with another key is
// told apart from a damaged one.
function keyIdOf(key: Buffer): string {
  return crypto.createHash("sha256").update("clearcart-vault-key-id/").update(key).digest("hex").slice(0, 16);
}

function seal(key: Buffer, meta: { id: string; brand: string; last4: string }, secret: CardSecret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(meta));
  const plain = Buffer.from(JSON.stringify(secret), "utf8");
  try {
    const data = Buffer.concat([c.update(plain), c.final()]);
    return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
  } finally {
    plain.fill(0);
  }
}

function open(key: Buffer, e: Entry): CardSecret {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
  d.setAAD(aad(e));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  const plain = Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]);
  try {
    const o = JSON.parse(plain.toString("utf8"));
    const s = (k: string) => (typeof o?.[k] === "string" ? o[k] : "");
    const card = { name: s("name"), number: s("number"), exp: s("exp"), csc: s("csc"), zip: s("zip") };
    scrub(o);
    return card;
  } finally {
    plain.fill(0);
  }
}

function isEntry(e: any): e is Entry {
  return !!e && CARD_ID.test(e.id) && typeof e.nickname === "string" && typeof e.brand === "string" && /^\d{4}$/.test(e.last4) &&
    typeof e.iv === "string" && typeof e.tag === "string" && typeof e.data === "string";
}

const metaOf = (e: Entry): CardMeta => ({ id: e.id, nickname: e.nickname, brand: e.brand, last4: e.last4 });

// "Visa ending 1111".
export const cardLabel = (c: { brand: string; last4: string }) => `${c.brand} ending ${c.last4}`;

function savedList(cards: CardMeta[]): string {
  return `Saved cards: ${cards.map((c) => `${c.nickname} (${cardLabel(c)})`).join(", ")}.`;
}

// ------------------------------------------------------------- vault

export class CardVault {
  private file: string;
  private keys: KeyStore;
  private legacy: LegacyCard | null;
  private now: () => Date;
  // Mutations run one at a time (an add awaits the Keychain).
  private queue: Promise<unknown> = Promise.resolve();
  private moved: Promise<"none" | "moved" | "failed"> | null = null;

  constructor(opts: { file: string; keys: KeyStore; legacy?: LegacyCard | null; now?: () => Date }) {
    this.file = opts.file;
    this.keys = opts.keys;
    this.legacy = opts.legacy ?? null;
    this.now = opts.now ?? (() => new Date());
  }

  private read(): VaultFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw new VaultError("damaged", DAMAGED);
    }
    let o: any;
    try {
      o = JSON.parse(raw);
    } catch {
      throw new VaultError("damaged", DAMAGED);
    }
    if (!o || o.version !== 1 || !Array.isArray(o.cards)) throw new VaultError("damaged", DAMAGED);
    const cards = o.cards.filter(isEntry).slice(0, MAX_CARDS);
    const defaultId = cards.some((c: Entry) => c.id === o.defaultId) ? o.defaultId : null;
    return { version: 1, keyId: typeof o.keyId === "string" ? o.keyId : null, defaultId, cards };
  }

  // Temp file and rename, so a crash never leaves half a file; 0600 always.
  private write(v: VaultFile) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // The data key, made the first time when allowed. Zero it after use.
  private async key(v: VaultFile, create: boolean): Promise<Buffer> {
    let key: Buffer | null;
    try {
      key = await this.keys.get();
    } catch {
      throw new VaultError("keychain", "Could not open the card key in the Keychain.");
    }
    if (!key) {
      if (!create || v.cards.length) throw new VaultError("no_key", NO_KEY);
      const fresh = crypto.randomBytes(32);
      try {
        await this.keys.create(fresh);
        // Read back what the Keychain holds: another process may have made
        // one first ("exists"), and then that one is the key.
        key = await this.keys.get();
      } catch {
        key = null;
      } finally {
        fresh.fill(0);
      }
      if (!key) throw new VaultError("keychain", "Could not store the card key in the Keychain.");
    }
    if (key.length !== 32) {
      key.fill(0);
      throw new VaultError("keychain", "The card key in the Keychain is not valid.");
    }
    if (v.cards.length && v.keyId && v.keyId !== keyIdOf(key)) {
      key.fill(0);
      throw new VaultError("other_key", OTHER_KEY);
    }
    return key;
  }

  // Ids, nicknames, brands and last 4 digits. Never decrypts anything.
  list(): CardList {
    const v = this.read();
    return { cards: v.cards.map(metaOf), defaultId: v.defaultId ?? (v.cards.length === 1 ? v.cards[0].id : null) };
  }

  add(input: unknown): Promise<Result<{ card: CardMeta; defaultId: string }>> {
    return this.exclusive(async () => {
      const checked = validateCard(input, this.now());
      if (!checked.ok) return checked;
      const c = checked.card;
      try {
        const v = this.read();
        if (v.cards.length >= MAX_CARDS) return { ok: false as const, error: `You can save up to ${MAX_CARDS} cards. Remove one first.` };
        const taken = new Set(v.cards.map((e) => norm(e.nickname)));
        let nickname = c.nickname;
        if (nickname && taken.has(norm(nickname))) return { ok: false as const, error: "You already have a card with that nickname." };
        if (!nickname || !norm(nickname)) {
          nickname = c.brand;
          for (let n = 2; taken.has(norm(nickname)); n++) nickname = `${c.brand} ${n}`;
        }
        let key: Buffer;
        try {
          key = await this.key(v, true);
        } catch (e) {
          if (e instanceof VaultError) return { ok: false as const, error: e.message };
          throw e;
        }
        let id: string;
        do id = `c${crypto.randomBytes(4).toString("hex")}`;
        while (v.cards.some((e) => e.id === id));
        try {
          const meta = { id, nickname, brand: c.brand, last4: c.last4 };
          v.cards.push({ ...meta, addedAt: this.now().getTime(), ...seal(key, meta, c.secret) });
          v.keyId = keyIdOf(key);
        } finally {
          key.fill(0);
        }
        if (!v.defaultId) v.defaultId = id;
        this.write(v);
        return { ok: true as const, card: { id, nickname, brand: c.brand, last4: c.last4 }, defaultId: v.defaultId };
      } finally {
        scrub(c.secret);
      }
    });
  }

  // True when there was such a card. The default moves to the first card
  // left, if any.
  remove(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const v = this.read();
      const i = v.cards.findIndex((e) => e.id === id);
      if (i < 0) return false;
      v.cards.splice(i, 1);
      if (v.defaultId === id) v.defaultId = v.cards[0]?.id ?? null;
      if (!v.cards.length) v.keyId = null;
      this.write(v);
      return true;
    });
  }

  setDefault(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const v = this.read();
      if (!v.cards.some((e) => e.id === id)) return false;
      v.defaultId = id;
      this.write(v);
      return true;
    });
  }

  // The card pay_with_saved_card should use: the one the nickname names
  // (or "Visa ending 1111", or its last 4), else the default, else the only
  // card. Metadata only. The error says what to ask the user.
  pick(nickname?: string | null): Result<{ card: CardMeta }> {
    const { cards, defaultId } = this.list();
    if (!cards.length) return { ok: false, error: NO_CARD };
    const ask = norm(nickname);
    if (ask) {
      const one = (list: CardMeta[]) => (list.length === 1 ? list[0] : null);
      const four = /\b(\d{4})\b/.exec(ask)?.[1];
      const brand = cards.filter((c) => ` ${ask} `.includes(` ${norm(c.brand)} `));
      const hit =
        one(cards.filter((c) => norm(c.nickname) === ask)) ||
        one(cards.filter((c) => norm(cardLabel(c)) === ask)) ||
        (four ? one(cards.filter((c) => c.last4 === four)) : null) ||
        (!four ? one(brand) : null);
      if (hit) return { ok: true, card: hit };
      return { ok: false, error: `No saved card matches that name. ${savedList(cards)} Ask the user which one to use.` };
    }
    const def = cards.find((c) => c.id === defaultId);
    if (def) return { ok: true, card: def };
    return { ok: false, error: `More than one card is saved and none is the default. ${savedList(cards)} Ask the user which one to use.` };
  }

  // Decrypts one card for fn, the fill. Its fields are dropped when fn
  // settles. Throws a VaultError (generic message) when it can't open.
  async withCard<T>(id: string, fn: (card: CardSecret) => Promise<T>): Promise<T> {
    const v = this.read();
    const e = v.cards.find((x) => x.id === id);
    if (!e) throw new VaultError("not_found", "That card is not saved any more.");
    const key = await this.key(v, false);
    let card: CardSecret;
    try {
      card = open(key, e);
    } catch {
      throw new VaultError("damaged", "The saved card could not be opened.");
    } finally {
      key.fill(0);
    }
    try {
      return await fn(card);
    } finally {
      scrub(card);
    }
  }

  // Moves the demo card from before this vault in, once per process. The
  // old Keychain item is deleted only after the card is saved here.
  migrateLegacy(): Promise<"none" | "moved" | "failed"> {
    if (!this.legacy) return Promise.resolve("none");
    if (this.moved) return this.moved;
    const legacy = this.legacy;
    this.moved = (async (): Promise<"none" | "moved" | "failed"> => {
      let old: Awaited<ReturnType<LegacyCard["read"]>> = null;
      try {
        old = await legacy.read();
        if (!old) return "none";
        const four = String(old.number ?? "").replace(/[\s-]/g, "").slice(-4);
        const there = this.read().cards.some((c) => c.nickname === LEGACY_NICKNAME && c.last4 === four);
        if (!there) {
          const r = await this.add({ nickname: LEGACY_NICKNAME, name: old.name, number: old.number, exp: old.exp, csc: old.csc });
          if (!r.ok) return "failed";
        }
      } catch {
        return "failed";
      } finally {
        scrub(old as Record<string, unknown> | null);
      }
      await legacy.remove().catch(() => {});
      return "moved";
    })();
    return this.moved;
  }
}

// ------------------------------------------------------------- stores

// The data key in the macOS login Keychain, as 64 hex digits.
export function keychainKeys(service = KEY_SERVICE, account = KEY_ACCOUNT): KeyStore {
  return {
    async get() {
      const hex = await readSecret(service, account);
      if (hex == null) return null;
      return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : Buffer.alloc(0);
    },
    create(key) {
      return addSecret(service, account, "Clearcart card vault key", key.toString("hex"));
    },
  };
}

// For tests only: a key held in memory, never in the Keychain.
export function memoryKeys(initial: Buffer | null = null): KeyStore & { key: Buffer | null } {
  const store = {
    key: initial ? Buffer.from(initial) : null,
    async get() {
      return store.key ? Buffer.from(store.key) : null;
    },
    async create(k: Buffer) {
      if (store.key) return "exists" as const;
      store.key = Buffer.from(k);
      return "created" as const;
    },
  };
  return store;
}

// The single card the old vault/setup-test-card.sh stored as JSON.
export function legacyKeychainCard(): LegacyCard {
  return {
    async read() {
      if (process.platform !== "darwin") return null;
      const raw = await readSecret(LEGACY_SERVICE, LEGACY_ACCOUNT);
      if (raw == null) return null;
      try {
        const o = JSON.parse(raw);
        return o && typeof o === "object" ? o : null;
      } catch {
        return null;
      }
    },
    async remove() {
      await deleteSecret(LEGACY_SERVICE, LEGACY_ACCOUNT);
    },
  };
}
