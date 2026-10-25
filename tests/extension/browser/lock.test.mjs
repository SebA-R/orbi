// Button lock end to end in the real extension: an isolated Playwright
// Chromium (never the user's Chrome) loads a temp copy of extension/ whose
// default agent URL points at this test's own fake agent server, so it never
// talks to a live agent on :5050. The fake agent drives the test shop
// (tests/fixtures/shop.mjs), the only allowed site, over the real bridge and
// checks every agent input path is refused on the protected Place order
// button, then that fill_card and press_protected with a lock_arm nonce
// (the pay flow's path) place the order.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

import { startShop } from "../../fixtures/shop.mjs";
import { EXT_DIR } from "./helpers.mjs";

const CARD = { name: "Test Shopper", number: "4111111111111111", exp: "12/30", csc: "737" };

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
          ws.send(JSON.stringify({ type: "welcome", protocol: 1, server: "lock-test" }));
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
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-lock-ext-"));
  fs.cpSync(EXT_DIR, extDir, { recursive: true, filter: (p) => !p.split(path.sep).includes("test") && !p.includes("node_modules") });
  const settings = path.join(extDir, "lib", "settings.js");
  const src = fs.readFileSync(settings, "utf8");
  const patched = src.replace('agentUrl: "ws://localhost:5050"', `agentUrl: "${agentUrl}"`).replace("allowlist: Object.freeze([])", `allowlist: Object.freeze(["${SHOP}"])`);
  assert.notEqual(patched, src, "settings defaults not found");
  fs.writeFileSync(settings, patched);

  profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-lock-profile-"));
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

const refOf = (tree, re) => /\[(ref_\d+)\]/.exec(tree.split("\n").find((l) => re.test(l)) || "")?.[1];

test("every agent input path is locked on Place order; press_protected with a nonce places the order", async () => {
  await fetch(SHOP + "/reset", { method: "POST", redirect: "manual" });
  const { tabId } = await call("tabs_create", { url: SHOP + "/product/mug" });
  const add = (await call("find", { tabId, query: "Add to cart" })).matches.find((m) => m.role === "button");
  assert.equal(add.locked, undefined, "Add to cart is never locked");
  await call("click", { tabId, ref: add.ref });
  await waitFor(async () => (await call("tab_info", { tabId })).url.includes("/cart"), "the cart");

  // Cart: the add-on may be unchecked, never checked again.
  let tree = (await call("read_page", { tabId, filter: "all" })).tree;
  assert.match(tree, /Proceed to checkout" \[ref_\d+\] \[locked\]/);
  const addon = refOf(tree, /checkbox "Subscribe/);
  await call("form_input", { tabId, ref: addon, value: false });
  assert.equal((await fails("form_input", { tabId, ref: addon, value: true })).code, "locked");
  assert.equal((await fails("click", { tabId, ref: addon })).code, "locked", "a click would check it");

  await call("navigate", { tabId, url: SHOP + "/checkout" });
  tree = (await call("read_page", { tabId, filter: "all" })).tree;
  const place = refOf(tree, /button "Place order/);
  assert.match(tree, /Place order[^\n]*\[locked\]/);

  // 1. click by ref
  const byRef = await fails("click", { tabId, ref: place });
  assert.equal(byRef.code, "locked");
  assert.match(byRef.message, /^Locked: 'Place order/);
  // 2. click at its coordinates
  const r = await call("rect", { tabId, ref: place });
  assert.equal((await fails("click", { tabId, x: r.x + r.width / 2, y: r.y + r.height / 2 })).code, "locked");
  // 3. the DOM click fallback
  assert.equal((await fails("click_ref", { tabId, ref: place })).code, "locked");
  // 4. Enter from a checkout field (implicit submit), and a typed newline
  const nameRef = refOf(tree, /textbox "Name on card"/);
  await call("click", { tabId, ref: nameRef });
  assert.equal((await fails("key", { tabId, key: "Enter" })).code, "locked");
  const addr = refOf(tree, /textbox "Shipping address"|textbox "[^"]*ddress/);
  if (addr) {
    await call("click", { tabId, ref: addr });
    await call("type", { tabId, text: "1 Test Lane" });
  }
  // 5. Space with the button focused
  const page = ctx.pages().find((p) => p.url().startsWith(SHOP + "/checkout"));
  await page.focus("#place-order");
  assert.equal((await fails("key", { tabId, key: " " })).code, "locked");
  assert.equal((await fails("key", { tabId, key: "Enter" })).code, "locked");
  // 6. press_protected without a nonce, with a made-up one
  assert.equal((await fails("press_protected", { tabId, ref: place })).code, "locked");
  assert.equal((await fails("press_protected", { tabId, ref: place, nonce: "00000000-0000-4000-8000-000000000000" })).code, "locked");
  // 7. press_protected refuses a non-order element even with a nonce
  const n0 = (await call("lock_arm", { tabId })).nonce;
  assert.equal((await fails("press_protected", { tabId, ref: nameRef, nonce: n0 })).code, "locked");

  // Nothing above placed an order.
  assert.match((await call("tab_info", { tabId })).url, /\/checkout$/);

  // The badge is up for sighted viewers and invisible to the tree.
  const badge = await page.evaluate(() => {
    const h = document.getElementById("clearcart-lock-badges");
    return h && { aria: h.getAttribute("aria-hidden"), pe: getComputedStyle(h).pointerEvents, inBody: document.body.contains(h) };
  });
  assert.deepEqual(badge, { aria: "true", pe: "none", inBody: false });
  // Place order looks grayed out but stays enabled for a person.
  const look = await page.evaluate(() => {
    const b = document.getElementById("place-order");
    return { marked: b.hasAttribute("data-clearcart-locked"), opacity: getComputedStyle(b).opacity, disabled: b.disabled || b.hasAttribute("aria-disabled") || b.inert };
  });
  assert.deepEqual(look, { marked: true, opacity: "0.45", disabled: false });

  // The pay flow's path: fill the card (every frame; here the page's own
  // fields), arm, press once.
  assert.deepEqual((await call("card_state", { tabId })).kinds, { "cc-name": 1, "cc-number": 1, "cc-exp": 1, "cc-csc": 1 });
  const filled = await call("fill_card", { tabId, origin: new URL(SHOP).origin, card: CARD });
  assert.deepEqual(filled, { ok: true, last4: "1111", name: true, zip: false, frames: 1 });
  assert.equal(await page.inputValue('[name="cc-number"]'), CARD.number);
  const tree2 = JSON.stringify(await call("read_page", { tabId, filter: "all" }));
  for (const s of [CARD.number, CARD.name, CARD.exp, `"${CARD.csc}"`]) assert.ok(!tree2.includes(s), `read_page showed ${s}`);
  const { nonce } = await call("lock_arm", { tabId });
  const pressed = await call("press_protected", { tabId, ref: place, nonce });
  assert.equal(pressed.ok, true);
  await waitFor(async () => (await call("tab_info", { tabId })).url.includes("/order/"), "the order page");
  // Single use.
  assert.equal((await fails("press_protected", { tabId, ref: place, nonce })).code, "locked");
});
