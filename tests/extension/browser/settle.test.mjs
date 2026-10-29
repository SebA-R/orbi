// Post-action settle end to end in the real extension: an isolated
// headless Playwright Chromium (never the user's Chrome) with a temp copy of
// extension/ pointed at this test's fake agent server. A link click answers
// navigated with the page it opened, once loaded; a key that opens nothing
// answers at once, not navigated.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

import { startShop } from "../../fixtures/shop.mjs";
import { EXT_DIR } from "./helpers.mjs";

let shop, SHOP, wss, ctx, worker, extDir, profile, ext;
let seq = 0;
const pending = new Map();
let connected;

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `t${++seq}`;
    const timer = setTimeout(() => (pending.delete(id), reject(new Error(`${method} timed out`))), 30_000);
    pending.set(id, { resolve, reject, timer });
    ext.send(JSON.stringify({ type: "request", id, method, params }));
  });
}

async function fails(method, params) {
  try {
    await call(method, params);
  } catch (e) {
    return e;
  }
  throw new Error(`${method} unexpectedly succeeded`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  shop = await startShop();
  SHOP = shop.base;

  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const agentUrl = `ws://127.0.0.1:${wss.address().port}`;
  connected = new Promise((resolve) => {
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === "hello") {
          ext = ws;
          ws.send(JSON.stringify({ type: "welcome", protocol: 1, server: "settle-test" }));
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

  // Temp copy with this test's agent URL and the shop as the allowed site.
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-settle-ext-"));
  fs.cpSync(EXT_DIR, extDir, { recursive: true, filter: (p) => !p.split(path.sep).includes("test") && !p.includes("node_modules") });
  const settings = path.join(extDir, "lib", "settings.js");
  const src = fs.readFileSync(settings, "utf8");
  const patched = src.replace('agentUrl: "ws://localhost:5050"', `agentUrl: "${agentUrl}"`).replace("allowlist: Object.freeze([])", `allowlist: Object.freeze(["${SHOP}"])`);
  assert.notEqual(patched, src, "settings defaults not found");
  fs.writeFileSync(settings, patched);

  profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-settle-profile-"));
  ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  await Promise.race([connected, sleep(20_000).then(() => { throw new Error("extension did not connect"); })]);
});

after(async () => {
  await ctx?.close().catch(() => {});
  wss?.close();
  await shop?.stop();
  for (const d of [profile, extDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test("a link click reports navigated and the new page; a key that opens nothing does not", async () => {
  const { tabId } = await call("tabs_create", { url: SHOP + "/" });
  const link = (await call("find", { tabId, query: "Blue mug" })).matches.find((m) => m.role === "link");
  assert.ok(link, "the product link");
  const r = await call("click", { tabId, ref: link.ref });
  assert.equal(r.ok, true);
  assert.equal(r.navigated, true, JSON.stringify(r));
  assert.equal(r.url, SHOP + "/product/mug");
  assert.match(r.title, /Blue mug/i);
  // Settled: the page is readable right away, no wait.
  assert.match((await call("read_page", { tabId, filter: "interactive" })).tree, /Add to cart/);

  const t0 = Date.now();
  const k = await call("key", { tabId, key: "Tab" });
  assert.equal(k.navigated, false, JSON.stringify(k));
  assert.equal(k.url, SHOP + "/product/mug");
  assert.ok(Date.now() - t0 < 2_000, "no long wait without a load");
});
