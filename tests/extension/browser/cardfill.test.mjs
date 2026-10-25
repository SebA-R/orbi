// Saved-card fill in the real extension: an isolated Playwright Chromium
// (never the user's Chrome) loads a temp copy of extension/ that talks to
// this test's own fake agent server, never a live agent on :5050. The card
// fields are in frames from another origin (tests/fixtures/card-frame.mjs on
// 127.0.0.1, the shops on localhost: two sites, so Chrome runs each frame in
// its own process), the way Stripe, Adyen and Braintree host them. fill_card
// puts each value in the frame that has its field and answers no value; the
// page-reading tools never show one; a card frame from a local address
// nobody allowed gets its tab closed; and the order goes through with the
// card ending 1111. Test numbers only.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

import { startCardFrame } from "../../fixtures/card-frame.mjs";
import { startShop } from "../../fixtures/shop.mjs";
import { EXT_DIR } from "./helpers.mjs";

const CARD = { name: "Test Shopper", number: "4111111111111111", exp: "12/30", csc: "737", zip: "94704" };
const SECRETS = [CARD.number, "4111 1111", CARD.name, "12/30", "12 / 30", `"${CARD.csc}"`, CARD.zip];

let frame, one, split, stray, wss, ctx, extDir, profile, ext;
let seq = 0;
const pending = new Map();

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
  frame = await startCardFrame();
  one = await startShop({ cardFrame: frame });
  split = await startShop({ cardFrame: frame, cardLayout: "split" });
  // The same frames under an origin that is not allowed (a local address
  // nobody listed).
  stray = await startShop({ cardFrame: { ...frame, origin: `http://localhost:${frame.port}` } });

  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const agentUrl = `ws://127.0.0.1:${wss.address().port}`;
  const connected = new Promise((resolve) => {
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === "hello") {
          ext = ws;
          ws.send(JSON.stringify({ type: "welcome", protocol: 1, server: "cardfill-test" }));
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

  // Temp copy with this test's agent URL; the shops and the frame server
  // are the allowed sites (local addresses open only when listed).
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-cardfill-ext-"));
  fs.cpSync(EXT_DIR, extDir, { recursive: true, filter: (p) => !p.split(path.sep).includes("test") && !p.includes("node_modules") });
  const settings = path.join(extDir, "lib", "settings.js");
  const src = fs.readFileSync(settings, "utf8");
  const allowed = JSON.stringify([one.base, split.base, stray.base, frame.origin]);
  const patched = src.replace('agentUrl: "ws://localhost:5050"', `agentUrl: "${agentUrl}"`).replace("allowlist: Object.freeze([])", `allowlist: Object.freeze(${allowed})`);
  assert.notEqual(patched, src, "settings defaults not found");
  fs.writeFileSync(settings, patched);

  profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-cardfill-profile-"));
  ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  await Promise.race([connected, sleep(20_000).then(() => { throw new Error("extension did not connect"); })]);
});

after(async () => {
  await ctx?.close().catch(() => {});
  wss?.close();
  for (const s of [one, split, stray, frame]) await s?.stop();
  for (const d of [profile, extDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

// A checkout tab on `shop` with one mug in the cart, and its Playwright page.
async function checkout(shop) {
  const { tabId } = await call("tabs_create", { url: shop.base + "/product/mug" });
  const add = (await call("find", { tabId, query: "Add to cart" })).matches.find((m) => m.role === "button");
  await call("click", { tabId, ref: add.ref });
  await waitFor(async () => (await call("tab_info", { tabId })).url.includes("/cart"), "the cart");
  await call("navigate", { tabId, url: shop.base + "/checkout" });
  const page = await waitFor(async () => ctx.pages().find((p) => p.url() === shop.base + "/checkout"), "the checkout page");
  const want = shop === split ? 3 : 1;
  await waitFor(async () => page.frames().filter((f) => f.url().includes("/fields?")).length === want && (await Promise.all(page.frames().filter((f) => f.url().includes("/fields?")).map((f) => f.$("input")))).every(Boolean), "the card frames");
  return { tabId, page };
}

const cardFrames = (page) => page.frames().filter((f) => f.url().startsWith(frame.origin + "/fields?"));
const valuesIn = async (page) => {
  const out = {};
  for (const f of cardFrames(page)) Object.assign(out, await f.$$eval("input[data-kind]", (els) => Object.fromEntries(els.map((e) => [e.dataset.kind, e.value]))));
  return out;
};

// What Claude's page-reading tools could see on the tab, as one string.
async function readable(tabId) {
  return JSON.stringify([
    await call("read_page", { tabId, filter: "all" }),
    await call("get_page_text", { tabId }),
    await call("find", { tabId, query: "card number" }),
  ]);
}

test("one cross-origin card frame: each value goes into its own frame, none comes back, and the order goes through", async () => {
  const { tabId, page } = await checkout(one);
  assert.deepEqual(await call("card_state", { tabId }), { fields: 5, filled: 0, kinds: { "cc-name": 1, "cc-number": 1, "cc-exp": 1, "cc-csc": 1, "postal-code": 1 }, frames: 2 });

  const filled = await call("fill_card", { tabId, card: CARD });
  assert.deepEqual(filled, { ok: true, last4: "1111", name: true, zip: true, frames: 2 });
  assert.deepEqual(await valuesIn(page), { number: CARD.number, exp: "12 / 30", cvc: CARD.csc, postal: CARD.zip }, "the frame's MM / YY format");
  assert.equal(await page.inputValue('[name="cc-name"]'), CARD.name);
  // The shop's own page holds none of the frame's values: they never left the frame.
  const top = await page.evaluate(() => ({ values: [...document.querySelectorAll("input,textarea")].map((i) => i.value).join("|"), text: document.body.innerText }));
  for (const s of [CARD.number, CARD.csc, CARD.zip]) assert.ok(!top.values.split("|").includes(s) && !top.text.includes(s), `the shop page holds ${s}`);
  const seen = await readable(tabId);
  for (const s of SECRETS) assert.ok(!seen.includes(s), `a page-reading tool showed ${s}`);
  assert.equal((await call("card_state", { tabId })).filled, 5);

  // The pay flow's press: arm, press Place order once.
  const place = (await call("find", { tabId, query: "Place order" })).matches.find((m) => m.role === "button");
  const { nonce } = await call("lock_arm", { tabId });
  assert.equal((await call("press_protected", { tabId, ref: place.ref, nonce })).ok, true);
  await waitFor(async () => (await call("tab_info", { tabId })).url.includes("/order/"), "the order page");
  assert.match((await call("get_page_text", { tabId })).text, /card ending in\s*1111/);
  assert.deepEqual(await call("card_state", { tabId }), { fields: 0, filled: 0, kinds: {}, frames: 0 });
});

test("one frame per field, the name on the shop's page: four frames filled, then cleared", async () => {
  const { tabId, page } = await checkout(split);
  assert.deepEqual((await call("card_state", { tabId })).kinds, { "cc-name": 1, "cc-number": 1, "cc-exp": 1, "cc-csc": 1 });
  assert.deepEqual(await call("fill_card", { tabId, card: CARD }), { ok: true, last4: "1111", name: true, zip: false, frames: 4 });
  assert.deepEqual(await valuesIn(page), { number: CARD.number, exp: "12 / 30", cvc: CARD.csc });
  const seen = await readable(tabId);
  for (const s of SECRETS) assert.ok(!seen.includes(s), `a page-reading tool showed ${s}`);
  assert.deepEqual(await call("clear_card", { tabId }), { ok: true, cleared: 4 });
  assert.deepEqual(await valuesIn(page), { number: "", exp: "", cvc: "" });
  assert.equal(await page.inputValue('[name="cc-name"]'), "");
  assert.equal((await call("card_state", { tabId })).filled, 0);
  assert.match((await call("tab_info", { tabId })).url, /\/checkout$/, "nothing was pressed");
});

// fill_card skips a frame Orbi may not use (unit/cardfill.test.mjs). A card
// frame from a local address nobody listed never gets that far: the
// connected-address check (background/netguard.js) closes the tab.
test("a card frame from a local address nobody allowed: the tab is closed, so no card can go in", async () => {
  const { tabId } = await call("tabs_create", { url: stray.base + "/product/mug" });
  const add = (await call("find", { tabId, query: "Add to cart" })).matches.find((m) => m.role === "button");
  await call("click", { tabId, ref: add.ref });
  await waitFor(async () => (await call("tab_info", { tabId })).url.includes("/cart"), "the cart");
  await call("navigate", { tabId, url: stray.base + "/checkout" }).catch(() => {});
  await waitFor(async () => !(await call("tabs_context")).tabs.some((t) => t.tabId === tabId), "the tab to close");
  const e = await fails("fill_card", { tabId, card: CARD });
  assert.ok(["no_tab", "not_allowed"].includes(e.code), e.code);
  for (const s of SECRETS) assert.ok(!e.message.includes(s));
});

test("fill_card refuses a card that is not complete, without echoing it", async () => {
  const { tabId } = await checkout(one);
  for (const card of [{ ...CARD, number: "4111111111111112" }, { ...CARD, exp: "1230x" }, { ...CARD, csc: "7" }]) {
    const e = await fails("fill_card", { tabId, card });
    assert.equal(e.code, "bad_request");
    for (const s of [CARD.number, "4111111111111112", CARD.name]) assert.ok(!e.message.includes(s));
  }
  assert.equal((await call("card_state", { tabId })).filled, 0);
});
