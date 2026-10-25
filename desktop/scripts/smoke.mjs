#!/usr/bin/env node
// Protocol smoke test: a tiny fake Orbi server (no dependencies) on a Unix
// socket in a temp dir, framed like agent/desktop/link.ts, and the helper run with
// ORBI_DESKTOP_DRY_RUN=1, so it shows nothing, never touches the mouse,
// keyboard, mic or screen, and reports every permission as false.
//
//   swift build && node scripts/smoke.mjs [path/to/OrbiDesktop]
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = process.argv[2] || path.join(here, "..", ".build", "debug", "OrbiDesktop");

// The link's framing (agent/desktop/link.ts): u32 BE length, type byte
// (1 JSON, 2 binary), payload.
function frame(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, payload]);
}
function parser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      onFrame(buf[4], buf.subarray(5, 4 + len));
      buf = buf.subarray(4 + len);
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

// The socket in a private dir, like the server's. It starts 0755, which
// the helper must refuse.
const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbi-smoke-"));
const sockDir = path.join(tokenDir, "Orbi");
fs.mkdirSync(sockDir, { mode: 0o755 });
fs.chmodSync(sockDir, 0o755);
const sockPath = path.join(sockDir, "desktop.sock");
const server = net.createServer((sock) => {
  sockets.push(sock);
  sock.on("data", parser((type, data) => {
    if (type !== 1) return;
    const m = JSON.parse(data.toString("utf8"));
    if (m.type === "ping") sock.write(frame(1, Buffer.from(JSON.stringify({ type: "pong", t: m.t }))));
    else deliver(m);
  }));
  sock.on("error", () => {});
});
await new Promise((r) => server.listen(sockPath, r));

const send = (obj) => sockets.at(-1).write(frame(1, Buffer.from(JSON.stringify(obj))));
let seq = 0;
async function call(method, params) {
  const id = ++seq;
  send({ type: "req", id, method, params });
  return next((m) => m.type === "res" && m.id === id);
}

// A token file of our own, like the server's (it is read on every connect).
const tokenFile = path.join(tokenDir, "desktop.token");
const token = "ab".repeat(32);
const hmac = (msg) => createHmac("sha256", Buffer.from(token)).update(msg).digest("hex");

const child = spawn(bin, [], {
  env: { ...process.env, ORBI_DESKTOP_DRY_RUN: "1", ORBI_DESKTOP_SOCKET: sockPath, ORBI_DESKTOP_TOKEN_FILE: tokenFile },
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
  await new Promise((r) => setTimeout(r, 2500));
  check("no dial into a directory others can enter", sockets.length === 0);
  fs.chmodSync(sockDir, 0o700);
  // First a server that cannot prove the token: the helper must drop it
  // without sending auth (or anything else), then dial again.
  const h0 = await next((m) => m.type === "hello", 15000);
  send({ type: "challenge", nonce: randomBytes(32).toString("hex"), proof: "00".repeat(32) });
  await new Promise((r) => setTimeout(r, 400));
  check("a server without the token gets no auth", !inbox.some((m) => m.type === "auth"));
  send({ type: "welcome", version: 1 });
  send({ type: "req", id: "x", method: "frontmost" });
  await new Promise((r) => setTimeout(r, 300));
  check("and no answers", !inbox.some((m) => m.type === "res"));
  void h0;

  const hello = await next((m) => m.type === "hello", 15000);
  check("hello carries a nonce, never the token", /^[0-9a-f]{64}$/.test(hello.nonce) && !("token" in hello) && !JSON.stringify(hello).includes(token));
  check("hello features", JSON.stringify(hello.features) === JSON.stringify(["element", "focused", "expectRef", "exclude"]));
  check("hello", hello.name === "orbi-desktop" && hello.version === 1, JSON.stringify(hello));
  check("dry run reports no permissions", !hello.permissions.accessibility && !hello.permissions.screen && !hello.permissions.mic);

  send({ type: "req", id: 99, method: "frontmost" });
  await new Promise((r) => setTimeout(r, 300));
  check("no answer before welcome", !inbox.some((m) => m.type === "res"));

  const serverNonce = randomBytes(32).toString("hex");
  send({ type: "challenge", nonce: serverNonce, proof: hmac(`orbi-desktop server ${hello.nonce} ${serverNonce}`) });
  const auth = await next((m) => m.type === "auth");
  check("auth proof", auth.proof === hmac(`orbi-desktop helper ${serverNonce} ${hello.nonce}`));
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

  // The server's close frame: the helper drops the link and dials again.
  sockets.at(-1).write(frame(1, Buffer.from(JSON.stringify({ type: "close", code: 4002, reason: "replaced" }))));
  const back = await next((m) => m.type === "hello", 8000);
  check("reconnects after a close frame", back.type === "hello");
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
