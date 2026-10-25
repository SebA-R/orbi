// The card vault (vault/index.ts): AES-256-GCM round trip, nothing in the
// clear but nickname, brand and last 4, the checks on what is saved, and
// picking a card. Keys come from memoryKeys(), never the Keychain. Test
// numbers only: Visa 4111 1111 1111 1111, Stripe 4242 4242 4242 4242.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CardVault, LEGACY_NICKNAME, memoryKeys, NO_CARD, validateCard, VaultError, type LegacyCard } from "../../vault/index.ts";

const VISA = { nickname: "Work Visa", name: "Ada Lovelace", number: "4111 1111 1111 1111", exp: "12/30", csc: "123", zip: "94704" };
const STRIPE = { nickname: "Personal", name: "Ada Lovelace", number: "4242424242424242", exp: "11/29", csc: "456" };
const SECRETS = ["4111111111111111", "4111 1111", "4242424242424242", "Ada Lovelace", "12/30", "11/29", '"123"', '"456"', "94704"];

function fresh(opts: { legacy?: LegacyCard; keys?: ReturnType<typeof memoryKeys> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-vault-"));
  const file = path.join(dir, "data", "cards.json");
  const keys = opts.keys ?? memoryKeys();
  return { dir, file, keys, vault: new CardVault({ file, keys, legacy: opts.legacy, now: () => new Date("2026-10-25T12:00:00Z") }) };
}

const noSecrets = (s: string, what: string) => {
  for (const x of SECRETS) assert.ok(!s.includes(x), `${what} holds ${x}`);
};

test("round trip: what is saved decrypts back exactly, and the file holds no card field", async () => {
  const { file, keys, vault } = fresh();
  const a = await vault.add(VISA);
  assert.ok(a.ok, JSON.stringify(a));
  const b = await vault.add(STRIPE);
  assert.ok(b.ok);
  assert.equal(keys.key?.length, 32, "one 256-bit key, made on the first add");
  const got = await vault.withCard(a.card.id, async (c) => ({ ...c }));
  assert.deepEqual(got, { name: "Ada Lovelace", number: "4111111111111111", exp: "12/30", csc: "123", zip: "94704" });
  assert.equal((await vault.withCard(b.card.id, async (c) => c.number)), "4242424242424242");
  const raw = fs.readFileSync(file, "utf8");
  noSecrets(raw, "cards.json");
  assert.match(raw, /"last4":"1111"/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  // Each record has its own IV.
  const cards = JSON.parse(raw).cards;
  assert.notEqual(cards[0].iv, cards[1].iv);
});

test("the card is dropped after the fill, and a record moved or relabeled does not open", async () => {
  const { file, vault } = fresh();
  const a = await vault.add(VISA);
  assert.ok(a.ok);
  let kept: any;
  await vault.withCard(a.card.id, async (c) => {
    kept = c;
  });
  assert.deepEqual(kept, { name: "", number: "", exp: "", csc: "", zip: "" }, "fields cleared once withCard returns");
  const v = JSON.parse(fs.readFileSync(file, "utf8"));
  v.cards[0].last4 = "4242";
  fs.writeFileSync(file, JSON.stringify(v));
  await assert.rejects(vault.withCard(a.card.id, async () => null), (e: unknown) => e instanceof VaultError && !/4111|123/.test((e as Error).message));
});

test("another key cannot open the cards, and the error says so without detail", async () => {
  const { file, vault } = fresh();
  const a = await vault.add(VISA);
  assert.ok(a.ok);
  const other = new CardVault({ file, keys: memoryKeys(Buffer.alloc(32, 7)) });
  await assert.rejects(other.withCard(a.card.id, async () => null), (e: unknown) => e instanceof VaultError && e.code === "other_key");
  const r = await other.add(STRIPE);
  assert.equal(r.ok, false, "nor add with a different key");
});

test("list and pick never return a number, expiry or code", async () => {
  const { vault } = fresh();
  await vault.add(VISA);
  await vault.add(STRIPE);
  const list = vault.list();
  for (const c of list.cards) assert.deepEqual(Object.keys(c).sort(), ["brand", "id", "last4", "nickname"]);
  noSecrets(JSON.stringify(list), "list");
  const pick = vault.pick("work visa");
  assert.ok(pick.ok && pick.card.nickname === "Work Visa");
  noSecrets(JSON.stringify(pick), "pick");
});

test("checks: Luhn, expiry, security code length, nickname; messages never repeat a value", () => {
  const now = new Date("2026-10-25T12:00:00Z");
  const bad = (o: object) => {
    const r = validateCard({ ...VISA, ...o }, now);
    assert.equal(r.ok, false, JSON.stringify(o));
    noSecrets(JSON.stringify(r), "error");
    return (r as any).error as string;
  };
  assert.match(bad({ number: "4111111111111112" }), /not valid/);
  assert.match(bad({ number: "4111" }), /not valid/);
  assert.match(bad({ exp: "09/26" }), /expired/);
  assert.match(bad({ exp: "13/30" }), /MM\/YY/);
  assert.match(bad({ exp: "12/60" }), /expiry/);
  assert.match(bad({ csc: "12" }), /3 digits/);
  assert.match(bad({ csc: "1234" }), /3 digits/);
  assert.match(bad({ name: " " }), /name on the card/);
  assert.match(bad({ nickname: "my 4111 1111 card" }), /nickname/);
  assert.match(bad({ zip: "94704; drop" }), /ZIP/);
  // American Express takes 4 digits (378282246310005 is its published test number).
  assert.equal(validateCard({ ...VISA, number: "378282246310005", csc: "1234" }, now).ok, true);
  assert.equal(validateCard({ ...VISA, number: "378282246310005", csc: "123" }, now).ok, false);
  const ok = validateCard({ ...VISA, exp: "10/2026" }, now);
  assert.ok(ok.ok && ok.card.secret.exp === "10/26" && ok.card.brand === "Visa" && ok.card.last4 === "1111");
});

test("pick: the default, then a nickname or its last 4; no card or no clear choice asks the user", async () => {
  const { vault } = fresh();
  assert.deepEqual(vault.pick(), { ok: false, error: NO_CARD });
  const a = await vault.add(VISA);
  const b = await vault.add(STRIPE);
  assert.ok(a.ok && b.ok);
  assert.equal(vault.list().defaultId, a.card.id, "the first card is the default");
  assert.equal((vault.pick() as any).card.id, a.card.id);
  assert.equal((vault.pick("Personal") as any).card.id, b.card.id);
  assert.equal((vault.pick("the one ending 4242") as any).card.id, b.card.id);
  assert.equal((vault.pick("visa ending 1111") as any).card.id, a.card.id);
  const miss = vault.pick("Amex");
  assert.equal(miss.ok, false);
  assert.match((miss as any).error, /Work Visa \(Visa ending 1111\), Personal \(Visa ending 4242\)/);
  assert.equal(await vault.setDefault(b.card.id), true);
  assert.equal((vault.pick() as any).card.id, b.card.id);
  assert.equal(await vault.remove(b.card.id), true);
  assert.equal(vault.list().defaultId, a.card.id, "the default moves to a card that is left");
  assert.equal((await vault.add({ ...STRIPE, nickname: "work VISA" })).ok, false, "nicknames are unique");
  const plain = await vault.add({ ...STRIPE, nickname: "" });
  assert.ok(plain.ok && plain.card.nickname === "Visa", "no nickname: the brand");
});

test("the old Keychain demo card moves in once and the old item is removed", async () => {
  let removed = 0;
  let reads = 0;
  const legacy: LegacyCard = {
    read: async () => (reads++, removed ? null : { name: "Demo Shopper", number: "4111111111111111", exp: "12/30", csc: "123" }),
    remove: async () => void removed++,
  };
  const { vault } = fresh({ legacy });
  assert.equal(await vault.migrateLegacy(), "moved");
  assert.equal(await vault.migrateLegacy(), "moved", "once per process");
  assert.equal(reads, 1);
  assert.equal(removed, 1);
  const list = vault.list();
  assert.deepEqual(list.cards.map((c) => [c.nickname, c.brand, c.last4]), [[LEGACY_NICKNAME, "Visa", "1111"]]);
  assert.equal(await vault.withCard(list.cards[0].id, async (c) => c.csc), "123");
  // A bad old card stays where it was.
  const keep: LegacyCard = { read: async () => ({ number: "4111111111111112" }), remove: async () => assert.fail("removed a card that did not move") };
  assert.equal(await fresh({ legacy: keep }).vault.migrateLegacy(), "failed");
});
