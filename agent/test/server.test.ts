// Starts the real server.ts in echo mode on a spare port (never :5050).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { hostAllowed } from "../hostcheck.ts";
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
      if (String(d).includes("Clearcart agent on")) {
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
    assert.deepEqual(health, { ok: true, echo: true, voice: false, browser: "ext", extension: true });
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
    assert.deepEqual(health, { ok: true, echo: true, voice: false });
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
function upgradeStatus(port: number, pathname: string, host: string): Promise<number | "open"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers: { Host: host } });
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
  for (const h of ["localtest.me:5050", "127.0.0.1.nip.io:5050", "evil.example:5050", "localhost:4000", "localhost", "[::ffff:127.0.0.1]:5050", "", undefined]) {
    assert.equal(hostAllowed(h as any, 5050), false, String(h));
  }
});

for (const [port, env, label] of [[5172, {}, "default mode"], [5173, { CLEARCART_BROWSER: "ext" }, "ext mode"]] as const) {
  test(`${label}: requests with a foreign Host header are refused (DNS rebinding)`, async () => {
    const child = await startServer(port, env);
    try {
      for (const host of [`localtest.me:${port}`, `127.0.0.1.nip.io:${port}`, `evil.example:${port}`, "localhost:4000"]) {
        assert.equal(await getStatus(port, "/cartesia-token", host), 403, host);
        assert.equal(await getStatus(port, "/healthz", host), 403, host);
        assert.equal(await getStatus(port, "/", host), 403, host);
        assert.equal(await upgradeStatus(port, "/session", host), 403, host);
        if (env.CLEARCART_BROWSER) assert.equal(await upgradeStatus(port, "/ext", host), 403, host);
      }
      assert.equal(await getStatus(port, "/healthz", `localhost:${port}`), 200);
      assert.equal(await upgradeStatus(port, "/session", `127.0.0.1:${port}`), "open");
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
