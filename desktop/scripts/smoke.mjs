#!/usr/bin/env node
// Protocol smoke test: a tiny fake Orbi server (no dependencies, minimal
// WebSocket framing) on a spare port, and the helper run with
// ORBI_DESKTOP_DRY_RUN=1, so it shows nothing, never touches the mouse,
// keyboard, mic or screen, and reports every permission as false.
//
//   swift build && node scripts/smoke.mjs [path/to/OrbiDesktop]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = process.argv[2] || path.join(here, "..", ".build", "debug", "OrbiDesktop");

function frame(op, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536
    ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x80 | op, 127, 0, 0, 0, 0]), Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255])]);
  return Buffer.concat([head, payload]);
}

// Client frames are masked; enough parsing for text, binary, close and ping.
function parser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 128;
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const m = buf.subarray(off, off + 4);
        data = Buffer.from(data.map((b, i) => b ^ m[i % 4]));
      }
      buf = buf.subarray(need);
      onFrame(op, data);
    }
  };
}

const sockets = [];
let inbox = [];
let waiters = [];
function deliver(msg) {
  const w = waiters.find((x) => x.match(msg));
  if (w) { waiters = waiters.filter((x) => x !== w); w.resolve(msg); } else inbox.push(msg);
}
function next(match = () => true, ms = 8000) {
  const i = inbox.findIndex(match);
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { match, resolve };
    waiters.push(w);
    setTimeout(() => { waiters = waiters.filter((x) => x !== w); reject(new Error("timed out waiting for a message")); }, ms);
  });
}

const server = http.createServer();
server.on("upgrade", (req, sock) => {
  if (req.url !== "/desktop") { sock.destroy(); return; }
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.push(sock);
  sock.on("data", parser((op, data) => {
    if (op === 1) deliver(JSON.parse(data.toString("utf8")));
    else if (op === 9) sock.write(frame(10, data));
    else if (op === 8) sock.end();
  }));
  sock.on("error", () => {});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const send = (obj) => sockets.at(-1).write(frame(1, Buffer.from(JSON.stringify(obj))));
let seq = 0;
async function call(method, params) {
  const id = ++seq;
  send({ type: "req", id, method, params });
  return next((m) => m.type === "res" && m.id === id);
}

// A token file of our own, like the server's (it is read on every connect).
const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbi-smoke-"));
const tokenFile = path.join(tokenDir, "desktop.token");
const token = "ab".repeat(32);

const child = spawn(bin, [], {
  env: { ...process.env, ORBI_DESKTOP_DRY_RUN: "1", ORBI_DESKTOP_URL: `ws://127.0.0.1:${port}/desktop`, ORBI_DESKTOP_TOKEN_FILE: tokenFile },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d; });

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures++;
}
const code = (r) => r.error && r.error.code;

try {
  await new Promise((r) => setTimeout(r, 1200));
  check("no dial without a token", sockets.length === 0);
  fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  const hello = await next((m) => m.type === "hello", 15000);
  check("hello carries the token", hello.token === token);
  check("hello features", JSON.stringify(hello.features) === JSON.stringify(["element", "focused", "expectRef", "exclude"]));
  check("hello", hello.name === "orbi-desktop" && hello.version === 1, JSON.stringify(hello));
  check("dry run reports no permissions", !hello.permissions.accessibility && !hello.permissions.screen && !hello.permissions.mic);

  send({ type: "req", id: 99, method: "frontmost" });
  await new Promise((r) => setTimeout(r, 300));
  check("no answer before welcome", !inbox.some((m) => m.type === "res"));

  send({ type: "welcome", version: 1, blockedApps: ["com.example.blocked"] });
  const fm = await call("frontmost", {});
  check("frontmost", fm.result && "bundleId" in fm.result && "appName" in fm.result, JSON.stringify(fm));
  const apps = await call("apps_list", {});
  check("apps_list", Array.isArray(apps.result && apps.result.apps), JSON.stringify(apps).slice(0, 200));
  check("unknown method", code(await call("teleport", {})) === "unknown_method");
  check("bad combo", code(await call("key", { combo: "cmd+nope" })) === "bad_request");
  check("missing text", code(await call("type", {})) === "bad_request");
  check("bad maxNodes", code(await call("ax_tree", { maxNodes: 0 })) === "bad_request");
  check("maxNodes over 1500", code(await call("ax_tree", { maxNodes: 1501 })) === "bad_request");
  check("element needs a ref", code(await call("element", {})) === "bad_request");
  check("focused without Accessibility", code(await call("focused", {})) === "no_permission");
  check("element without Accessibility", code(await call("element", { ref: "e1" })) === "no_permission");
  check("built-in blocked app", code(await call("app_activate", { bundleId: "com.apple.Terminal" })) === "blocked_app");
  check("Chrome is blocked", code(await call("app_activate", { bundleId: "com.google.Chrome" })) === "blocked_app");
  check("server-blocked app", code(await call("app_activate", { bundleId: "com.example.blocked" })) === "blocked_app");
  send({ type: "config", blockedApps: [] });
  check("config replaces the server list", code(await call("app_activate", { bundleId: "com.example.blocked" })) === "no_permission");
  check("ax_tree of a blocked app", code(await call("ax_tree", { bundleId: "com.1password.1password" })) === "blocked_app");
  const click = await call("click", { x: 1, y: 1 });
  check("click refused without input", ["no_permission", "blocked_app"].includes(code(click)), JSON.stringify(click));
  check("scroll refused without input", ["no_permission", "blocked_app"].includes(code(await call("scroll", { x: 5, y: 5, dy: 100 }))));
  check("screenshot refused without screen", code(await call("screenshot", {})) === "no_permission");
  check("screenshot bad exclude", code(await call("screenshot", { exclude: "com.x" })) === "bad_request");
  check("overlay bad state", code(await call("overlay", { state: "dancing" })) === "bad_request");
  check("overlay ring frame", (await call("overlay", { state: "thinking", ring: { x: 1, y: 2, w: 30, h: 20 } })).result?.ok === true);
  check("overlay empty ring frame", code(await call("overlay", { state: "thinking", ring: { x: 1, y: 2, w: 0, h: 20 } })) === "bad_request");
  check("overlay ok", (await call("overlay", { state: "thinking", subtitle: "Hi", ring: true, cursor: { x: 10, y: 10 } })).result?.ok === true);
  send({ type: "req", id: "m", params: {} });
  check("request without method", code(await next((m) => m.type === "res" && m.id === "m")) === "bad_request");
  sockets.at(-1).write(frame(2, Buffer.alloc(4800))); // TTS audio: must not crash
  send({ type: "audio_stop" });
  check("still answering after audio", (await call("frontmost", {})).result !== undefined);

  sockets.at(-1).destroy();
  const again = await next((m) => m.type === "hello", 6000);
  check("reconnects after a drop", again.type === "hello");
} catch (e) {
  check("smoke", false, e.message);
} finally {
  child.kill();
  server.close();
  fs.rmSync(tokenDir, { recursive: true, force: true });
  for (const s of sockets) s.destroy();
}
if (failures) { console.error(stderr); process.exit(1); }
console.log("smoke passed");
process.exit(0);
