// Starts the real server.ts in echo mode on a spare port (never :5050).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

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

test("CLEARCART_VOICE=false: no Cartesia token is minted", async () => {
  const port = 5172;
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
