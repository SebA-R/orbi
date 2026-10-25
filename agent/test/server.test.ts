// Starts the real server.ts in echo mode on a spare port (never :5050).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import fs from "node:fs";
import os from "node:os";
import { extensionIdFromKey, extensionOrigins, hostAllowed, isLoopbackAddress, memoryRequestAllowed } from "../hostcheck.ts";
import { FakeExt } from "./fake-ext.ts";

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(AGENT, "node_modules", ".bin", "tsx");

async function startServer(port: number, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(TSX, ["server.ts"], {
    cwd: AGENT,
    env: { ...process.env, CLEARCART_BROWSER: "", CLEARCART_VOICE: "false", ...env, AGENT_PORT: String(port), AGENT_MODE: "echo" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 15_000);
    child.stdout!.on("data", (d) => {
      if (String(d).includes("Orbi agent on")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  return child;
}

function sessionEcho(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
    ws.once("error", reject);
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "status") ws.send(JSON.stringify({ type: "user_text", text: "hi" }));
      if (m.type === "agent_text") {
        ws.close();
        resolve(m.text);
      }
    });
  });
}

test("CLEARCART_BROWSER=ext: /ext and /session share the server", async () => {
  const port = 5170;
  const child = await startServer(port, { CLEARCART_BROWSER: "ext" });
  try {
    const ext = new FakeExt(`ws://127.0.0.1:${port}/ext`);
    await ext.open();
    assert.equal(ext.welcome.server, "clearcart-agent");
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.deepEqual(health, { ok: true, echo: true, voice: false, cartesia: false, browser: "ext", extension: true });
    assert.equal(await sessionEcho(port), "You said: hi");
    ext.close();
  } finally {
    child.kill();
  }
});

test("default mode: no /ext endpoint, /session unchanged", async () => {
  const port = 5171;
  const child = await startServer(port, {});
  try {
    await assert.rejects(new FakeExt(`ws://127.0.0.1:${port}/ext`).open());
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.deepEqual(health, { ok: true, echo: true, voice: false, cartesia: false });
    assert.equal(await sessionEcho(port), "You said: hi");
  } finally {
    child.kill();
  }
});

// Status of a GET with the given Host header (fetch will not override Host).
function getStatus(port: number, pathname: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathname, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    }).once("error", reject);
  });
}

// Resolves with the HTTP status of a refused upgrade, or "open".
function upgradeStatus(port: number, pathname: string, host: string, origin?: string): Promise<number | "open"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers: { Host: host, ...(origin ? { Origin: origin } : {}) } });
    ws.once("open", () => {
      ws.close();
      resolve("open");
    });
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode || 0));
    ws.once("error", () => resolve(0));
  });
}

test("hostAllowed: only this computer's names on this port", () => {
  for (const h of ["localhost:5050", "127.0.0.1:5050", "[::1]:5050", "LOCALHOST:5050"]) assert.ok(hostAllowed(h, 5050), h);
  for (const h of ["localtest.me:5050", "127.0.0.1.nip.io:5050", "evil.example:5050", "localhost:4100", "localhost", "[::ffff:127.0.0.1]:5050", "", undefined]) {
    assert.equal(hostAllowed(h as any, 5050), false, String(h));
  }
});

for (const [port, env, label] of [[5172, {}, "default mode"], [5173, { CLEARCART_BROWSER: "ext" }, "ext mode"]] as const) {
  test(`${label}: requests with a foreign Host header are refused (DNS rebinding)`, async () => {
    const child = await startServer(port, env);
    try {
      for (const host of [`localtest.me:${port}`, `127.0.0.1.nip.io:${port}`, `evil.example:${port}`, "localhost:4100"]) {
        assert.equal(await getStatus(port, "/cartesia-token", host), 403, host);
        assert.equal(await getStatus(port, "/healthz", host), 403, host);
        assert.equal(await getStatus(port, "/", host), 403, host);
        assert.equal(await upgradeStatus(port, "/session", host), 403, host);
        if (env.CLEARCART_BROWSER) assert.equal(await upgradeStatus(port, "/ext", host), 403, host);
      }
      assert.equal(await getStatus(port, "/healthz", `localhost:${port}`), 200);
      assert.equal(await upgradeStatus(port, "/session", `127.0.0.1:${port}`), "open");
      // A web page opening the socket (its Host is right, its Origin is not)
      // could speak as the user, so it is refused.
      const paths = env.CLEARCART_BROWSER ? ["/session", "/ext"] : ["/session"];
      for (const p of paths) {
        for (const origin of ["https://evil.example", "null", "http://localhost:4100", "chrome-extension://abcdefghijklmnopabcdefghijklmnop"]) {
          assert.equal(await upgradeStatus(port, p, `localhost:${port}`, origin), 403, `${p} ${origin}`);
        }
      }
      assert.equal(await upgradeStatus(port, "/session", `localhost:${port}`, "chrome-extension://dhgknfenfoidnchmjfaicafhieepefoc"), "open", "the extension");
      assert.equal(await upgradeStatus(port, "/session", `localhost:${port}`, `http://localhost:${port}`), "open", "the voice console");
    } finally {
      child.kill();
    }
  });
}

test("CLEARCART_VOICE=false: no Cartesia token is minted", async () => {
  const port = 5174;
  const child = await startServer(port, {});
  try {
    const r = await fetch(`http://127.0.0.1:${port}/cartesia-token`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).voice, false);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).voice, false);
  } finally {
    child.kill();
  }
});

// Voice on with no key: nothing is fetched from Cartesia (there is no key
// to send), and the extension is told to use basic voice.
test("no Cartesia key: /healthz says cartesia false, no token", async () => {
  const port = 5179;
  const child = await startServer(port, { CLEARCART_VOICE: "true", CARTESIA_API_KEY: "" });
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(health.voice, true);
    assert.equal(health.cartesia, false);
    const r = await fetch(`http://127.0.0.1:${port}/cartesia-token`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).cartesia, false);
  } finally {
    child.kill();
  }
});

// A /session socket that keeps every message it gets.
async function sessionSocket(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
  const got: any[] = [];
  ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
  return { ws, got, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

async function until(ok: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("one session across /session sockets: the one that talks takes over, the other is told and its late words are dropped", async () => {
  const port = 5175;
  const child = await startServer(port, {});
  try {
    const a = await sessionSocket(port);
    const b = await sessionSocket(port);
    a.send({ type: "user_text", text: "hi from a" });
    await until(() => a.got.some((m) => m.text === "You said: hi from a"), "a's echo");
    b.send({ type: "interrupt" });
    b.send({ type: "user_text", text: "hi from b" });
    await until(() => b.got.some((m) => m.text === "You said: hi from b") && a.got.some((m) => m.type === "standby" && m.reason === "moved"), "b takes over");
    a.send({ type: "user_text", text: "late words" });
    await until(() => a.got.some((m) => m.type === "standby" && m.reason === "stale"), "a told its words were dropped");
    assert.ok(![...a.got, ...b.got].some((m) => m.text === "You said: late words"));
    assert.ok(!a.got.some((m) => m.text === "You said: hi from b"), "b's reply went to b only");
    a.ws.close();
    b.ws.close();
  } finally {
    child.kill();
  }
});

// /memory: the settings page's view of saved facts. Loopback, this
// computer's Host and the Orbi extension's Origin only.
const EXT_ORIGIN = "chrome-extension://dhgknfenfoidnchmjfaicafhieepefoc";

function request(port: number, method: string, pathname: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.once("error", reject);
    req.end();
  });
}

test("memory endpoint origin rules: the extension id from the manifest key, loopback peers only", () => {
  const key = JSON.parse(fs.readFileSync(path.join(AGENT, "..", "extension", "manifest.json"), "utf8")).key;
  assert.equal(extensionIdFromKey(key), "dhgknfenfoidnchmjfaicafhieepefoc");
  assert.ok(extensionOrigins().has(EXT_ORIGIN));
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.2"]) assert.ok(isLoopbackAddress(a), a);
  for (const a of ["192.168.1.5", "10.0.0.1", "::ffff:10.0.0.1", "fe80::1", "", undefined]) assert.equal(isLoopbackAddress(a), false, String(a));
  const req = (origin: string | undefined, remoteAddress: string, host = "localhost:5050") => ({ headers: { host, origin }, socket: { remoteAddress } });
  assert.ok(memoryRequestAllowed(req(EXT_ORIGIN, "127.0.0.1"), 5050));
  assert.equal(memoryRequestAllowed(req(EXT_ORIGIN, "192.168.1.5"), 5050), false, "LAN peer");
  assert.equal(memoryRequestAllowed(req(EXT_ORIGIN, "127.0.0.1", "evil.example:5050"), 5050), false, "foreign Host");
  assert.equal(memoryRequestAllowed(req("https://evil.example", "127.0.0.1"), 5050), false, "web page");
  assert.equal(memoryRequestAllowed(req("chrome-extension://abcdefghijklmnopabcdefghijklmnop", "127.0.0.1"), 5050), false, "another extension");
  assert.equal(memoryRequestAllowed(req(undefined, "127.0.0.1"), 5050), false, "no Origin");
});

test("memory endpoint: the extension lists and deletes, pages and foreign hosts are refused", async () => {
  const port = 5176;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mem-srv-"));
  const file = path.join(dir, "memory.json");
  const facts = [{ id: "m0000000a", text: "you wear a medium", at: 1 }, { id: "m0000000b", text: "you prefer Etsy", at: 2 }];
  fs.writeFileSync(file, JSON.stringify({ version: 1, facts }));
  const child = await startServer(port, { CLEARCART_DATA_DIR: dir });
  try {
    const ok = await request(port, "GET", "/memory", { Origin: EXT_ORIGIN });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { enabled: true, facts, purchases: [] });
    for (const h of [{}, { Origin: "https://evil.example" }, { Origin: "null" }, { Origin: EXT_ORIGIN, Host: `evil.example:${port}` }]) {
      assert.equal((await request(port, "GET", "/memory", h)).status, 403, JSON.stringify(h));
      assert.equal((await request(port, "DELETE", "/memory", h)).status, 403, JSON.stringify(h));
      assert.equal((await request(port, "DELETE", "/memory/m0000000a", h)).status, 403, JSON.stringify(h));
    }
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).facts.length, 2, "nothing deleted by refused requests");
    assert.equal((await request(port, "POST", "/memory", { Origin: EXT_ORIGIN })).status, 405, "no way to add a fact over HTTP");
    assert.equal((await request(port, "DELETE", "/memory/m0000000a", { Origin: EXT_ORIGIN })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).facts.map((f: any) => f.id), ["m0000000b"]);
    assert.equal((await request(port, "DELETE", "/memory/m0000000a", { Origin: EXT_ORIGIN })).status, 404);
    fs.writeFileSync(path.join(dir, "transcript.json"), JSON.stringify({ turns: [{ role: "user", text: "hi", at: Date.now() }] }));
    const all = await request(port, "DELETE", "/memory", { Origin: EXT_ORIGIN });
    assert.deepEqual(JSON.parse(all.body), { ok: true, removed: 1 });
    assert.ok(!fs.existsSync(file) && !fs.existsSync(path.join(dir, "transcript.json")), "forget everything clears both");
  } finally {
    child.kill();
  }
});
