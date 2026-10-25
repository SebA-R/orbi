// Connected-address check end to end: an isolated Playwright Chromium
// (never the user's Chrome) maps a public-looking host name to 127.0.0.1
// (--host-resolver-rules, standing in for localtest.me or a DNS rebinding
// domain) and loads a temp copy of extension/ whose agent URL points at this
// test's fake agent, never :5050. The page passes the host name blocklist,
// so only the webRequest IP check (background/netguard.js) can stop it.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

import { EXT_DIR } from "./helpers.mjs";

const REBIND = "rebind.clearcart.test";
let web, port, wss, ctx, extDir, profile, ext;
let seq = 0;
const pending = new Map();

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `n${++seq}`;
    const timer = setTimeout(() => (pending.delete(id), reject(new Error(`${method} timed out`))), 30_000);
    pending.set(id, { resolve, reject, timer });
    ext.send(JSON.stringify({ type: "request", id, method, params }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  web = http.createServer((req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<title>t</title><p>secret-voice-token</p>"));
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  port = web.address().port;

  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const connected = new Promise((resolve) => {
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === "hello") {
          ext = ws;
          ws.send(JSON.stringify({ type: "welcome", protocol: 1, server: "netguard-test" }));
          resolve();
        } else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", t: m.t }));
        else if (m.type === "response") {
          const p = pending.get(m.id);
          if (!p) return;
          clearTimeout(p.timer);
          pending.delete(m.id);
          if (m.ok) p.resolve(m.result);
          else p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
        }
      });
    });
  });

  extDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-netguard-ext-"));
  fs.cpSync(EXT_DIR, extDir, { recursive: true, filter: (p) => !p.split(path.sep).includes("test") && !p.includes("node_modules") });
  const settings = path.join(extDir, "lib", "settings.js");
  const src = fs.readFileSync(settings, "utf8");
  const patched = src
    .replace('agentUrl: "ws://localhost:5050"', `agentUrl: "ws://127.0.0.1:${wss.address().port}"`)
    .replace("allowlist: Object.freeze([])", `allowlist: Object.freeze(["http://localhost:${port}"])`);
  assert.notEqual(patched, src, "settings defaults not found");
  fs.writeFileSync(settings, patched);

  profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-netguard-profile-"));
  ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--host-resolver-rules=MAP ${REBIND} 127.0.0.1`],
  });
  await Promise.race([connected, sleep(20_000).then(() => { throw new Error("extension did not connect"); })]);
});

after(async () => {
  await ctx?.close().catch(() => {});
  wss?.close();
  web?.close();
  for (const d of [profile, extDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("an allowed local page still works", async () => {
  const { tabId } = await call("tabs_create", { url: `http://localhost:${port}/` });
  assert.match((await call("get_page_text", { tabId })).text, /secret-voice-token/);
});

test("a public name that resolves to 127.0.0.1 is refused and its tab closed", async () => {
  const url = `http://${REBIND}:${port}/cartesia-token`;
  const err = await call("tabs_create", { url }).then(() => null, (e) => e);
  assert.ok(err, "tabs_create should fail");
  assert.ok(["not_allowed", "no_tab"].includes(err.code), `${err.code}: ${err.message}`);
  let open = true;
  for (let i = 0; i < 40 && open; i++) {
    // agent_tabs, not tabs_context: tabs_context hides blocked tabs anyway.
    open = (await call("agent_tabs")).tabs.some((t) => t.url.includes(REBIND));
    if (open) await sleep(150);
  }
  assert.equal(open, false, "the tab was closed");

  // A tab already open on an allowed page that then navigates there.
  const { tabId } = await call("tabs_create", { url: `http://localhost:${port}/` });
  const nav = await call("navigate", { tabId, url }).then(() => null, (e) => e);
  assert.ok(nav && ["not_allowed", "no_tab"].includes(nav.code), String(nav?.code));
  const text = await call("get_page_text", { tabId }).then((r) => r.text, (e) => e.code);
  assert.ok(text === "not_allowed" || text === "no_tab", `page text was readable: ${text}`);
});
