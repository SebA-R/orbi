// /cards (cards.ts): the settings page's saved cards. In process, with a
// vault whose key is in memory (never the Keychain): the list never holds
// a number, expiry or code, web pages and other origins are refused, bad
// cards are refused without echoing them, and writes are rate limited. The
// real server is started only for requests it must refuse before any vault
// is opened. Test numbers only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CardVault, memoryKeys } from "../../vault/index.ts";
import { createCardsRoute, WRITES_PER_MINUTE } from "../cards.ts";
import { memoryRequestAllowed } from "../hostcheck.ts";

const EXT = "chrome-extension://dhgknfenfoidnchmjfaicafhieepefoc";
const VISA = { nickname: "Work Visa", name: "Ada Lovelace", number: "4111 1111 1111 1111", exp: "12/30", csc: "123", zip: "94704" };
const SECRETS = ["4111111111111111", "4111 1111", "Ada Lovelace", "12/30", '"123"', "94704"];

async function startRoute(opts: { now?: () => number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cards-api-"));
  const vault = new CardVault({ file: path.join(dir, "cards.json"), keys: memoryKeys() });
  const logs: string[] = [];
  let port = 0;
  const route = createCardsRoute({ vault: () => vault, allowed: (req) => memoryRequestAllowed(req, port, new Set([EXT])), log: (l) => logs.push(l), now: opts.now });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/cards" || url.pathname.startsWith("/cards/")) return void route(req, res, url.pathname);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  return { port, vault, logs, dir, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

function request(port: number, method: string, pathname: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

const fromExt = { Origin: EXT, "Content-Type": "application/json" };
const noSecrets = (s: string, what: string) => {
  for (const x of SECRETS) assert.ok(!s.includes(x), `${what} holds ${x}`);
};

test("the list holds id, nickname, brand and last 4 only; add, default and delete work", async () => {
  const r = await startRoute();
  try {
    const add = await request(r.port, "POST", "/cards", fromExt, JSON.stringify(VISA));
    assert.equal(add.status, 201, add.body);
    const card = JSON.parse(add.body).card;
    assert.deepEqual({ ...card, id: "x" }, { id: "x", nickname: "Work Visa", brand: "Visa", last4: "1111" });
    const second = await request(r.port, "POST", "/cards", fromExt, JSON.stringify({ ...VISA, nickname: "Stripe test", number: "4242424242424242", csc: "456" }));
    assert.equal(second.status, 201);
    const id2 = JSON.parse(second.body).card.id;
    const list = await request(r.port, "POST", "/cards/list", { Origin: EXT });
    assert.equal(list.status, 200);
    const body = JSON.parse(list.body);
    assert.equal(body.defaultId, card.id, "the first card is the default");
    for (const c of body.cards) assert.deepEqual(Object.keys(c).sort(), ["brand", "id", "last4", "nickname"]);
    noSecrets(list.body, "POST /cards/list");
    noSecrets(add.body, "POST /cards");
    assert.ok(!list.body.includes("4242424242424242") && !list.body.includes('"456"'));
    assert.equal((await request(r.port, "POST", `/cards/${id2}/default`, { Origin: EXT })).status, 200);
    assert.equal(JSON.parse((await request(r.port, "POST", "/cards/list", { Origin: EXT })).body).defaultId, id2);
    assert.equal((await request(r.port, "DELETE", `/cards/${card.id}`, { Origin: EXT })).status, 200);
    assert.equal((await request(r.port, "DELETE", `/cards/${card.id}`, { Origin: EXT })).status, 404);
    assert.equal((await request(r.port, "DELETE", "/cards/not-an-id", { Origin: EXT })).status, 404);
    assert.deepEqual(JSON.parse((await request(r.port, "POST", "/cards/list", { Origin: EXT })).body).cards.map((c: any) => c.last4), ["4242"]);
    noSecrets(r.logs.join("\n"), "server log");
  } finally {
    await r.stop();
  }
});

test("web pages, other extensions, no Origin and foreign hosts are refused, and nothing changes", async () => {
  const r = await startRoute();
  try {
    assert.equal((await request(r.port, "POST", "/cards", fromExt, JSON.stringify(VISA))).status, 201);
    for (const h of [{}, { Origin: "https://evil.example" }, { Origin: "null" }, { Origin: "http://localhost:5050" }, { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }, { Origin: EXT, Host: "evil.example:5050" }]) {
      const why = JSON.stringify(h);
      const list = await request(r.port, "POST", "/cards/list", h);
      assert.equal(list.status, 403, why);
      assert.ok(!list.body.includes("1111"), why);
      assert.equal((await request(r.port, "POST", "/cards", { "Content-Type": "application/json", ...h }, JSON.stringify(VISA))).status, 403, why);
      const id = r.vault.list().cards[0].id;
      assert.equal((await request(r.port, "DELETE", `/cards/${id}`, h)).status, 403, why);
      assert.equal((await request(r.port, "POST", `/cards/${id}/default`, h)).status, 403, why);
    }
    assert.equal(r.vault.list().cards.length, 1, "nothing added or removed by refused requests");
  } finally {
    await r.stop();
  }
});

test("bad cards and bad requests are refused without echoing the card", async () => {
  const r = await startRoute();
  try {
    for (const [o, why] of [[{ number: "4111111111111112" }, /not valid/], [{ exp: "01/20" }, /expired/], [{ csc: "12" }, /3 digits/]] as const) {
      const res = await request(r.port, "POST", "/cards", fromExt, JSON.stringify({ ...VISA, ...o }));
      assert.equal(res.status, 400);
      assert.match(JSON.parse(res.body).error, why);
      noSecrets(res.body, "error");
      assert.ok(!res.body.includes("4111111111111112"));
    }
    assert.equal((await request(r.port, "POST", "/cards", { Origin: EXT, "Content-Type": "text/plain" }, JSON.stringify(VISA))).status, 415);
    assert.equal((await request(r.port, "POST", "/cards", fromExt, "{not json")).status, 400);
    assert.equal((await request(r.port, "POST", "/cards", fromExt, JSON.stringify({ ...VISA, name: "x".repeat(5000) }))).status, 413);
    assert.equal((await request(r.port, "PUT", "/cards", fromExt, "{}")).status, 405);
    assert.equal((await request(r.port, "GET", "/cards", { Origin: EXT })).status, 405, "the list is a POST");
    assert.equal(r.vault.list().cards.length, 0);
    noSecrets(r.logs.join("\n"), "server log");
  } finally {
    await r.stop();
  }
});

test("writes are rate limited", async () => {
  let t = 1_000;
  const r = await startRoute({ now: () => t });
  try {
    const statuses: number[] = [];
    for (let i = 0; i <= WRITES_PER_MINUTE; i++) statuses.push((await request(r.port, "POST", "/cards", fromExt, JSON.stringify({ ...VISA, nickname: `Card ${"abcdefghijklmnop"[i]}` }))).status);
    assert.deepEqual(statuses.slice(0, WRITES_PER_MINUTE), Array(WRITES_PER_MINUTE).fill(201));
    assert.equal(statuses.at(-1), 429);
    assert.equal((await request(r.port, "POST", "/cards/list", { Origin: EXT })).status, 200, "reads have their own budget");
    t += 61_000;
    assert.equal((await request(r.port, "DELETE", `/cards/${r.vault.list().cards[0].id}`, { Origin: EXT })).status, 200, "a minute later writes work again");
  } finally {
    await r.stop();
  }
});

test("the real server refuses /cards from web pages before opening any vault", async () => {
  const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cards-srv-"));
  const port = 5177;
  const child = spawn(path.join(AGENT, "node_modules", ".bin", "tsx"), ["server.ts"], {
    cwd: AGENT,
    env: { ...process.env, CLEARCART_BROWSER: "", CLEARCART_VOICE: "false", AGENT_PORT: String(port), AGENT_MODE: "echo", CLEARCART_DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not start")), 15_000);
      child.stdout!.on("data", (d) => String(d).includes("Orbi agent on") && (clearTimeout(timer), resolve()));
      child.once("exit", (code) => reject(new Error(`server exited ${code}`)));
    });
    for (const h of [{}, { Origin: "https://evil.example" }, { Origin: EXT, Host: `evil.example:${port}` }]) {
      assert.equal((await request(port, "POST", "/cards/list", h)).status, 403, JSON.stringify(h));
      assert.equal((await request(port, "POST", "/cards", { "Content-Type": "application/json", ...h }, JSON.stringify(VISA))).status, 403, JSON.stringify(h));
    }
    assert.ok(!fs.existsSync(path.join(dir, "cards.json")), "no vault file was made");
  } finally {
    child.kill();
  }
});
