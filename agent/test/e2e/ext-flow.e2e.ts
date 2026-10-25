// End-to-end: the real agent server (CLEARCART_BROWSER=ext) and the unpacked
// extension in an isolated Playwright Chromium (never the user's Chrome),
// against the test shop (tests/fixtures/shop.mjs) on a spare port, the only
// allowed site. Drives the shopping flow over the bridge the way Claude's
// tools would, without Claude, checks that Claude's tools can neither type
// a card nor press Place order, and that pay_now presses nothing while the
// card number is empty (Chrome offers saved cards only on https pages, so
// no card is picked here). The test number never shows up in a tool result
// or a log.
//
//   npm --prefix agent run test:e2e:ext
//   (needs `npm install` in tests/extension for Playwright)
//
// Ports: shop 4300, agent 5300 (override with E2E_SHOP_PORT / E2E_AGENT_PORT).
// The browser loads a temp copy of extension/ whose default agent URL is the
// test's agent, so the test extension never connects to a live agent on :5050.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

import { startShop } from "../../../tests/fixtures/shop.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const EXT_DIR = path.join(REPO, "extension");
const PW = path.join(REPO, "tests", "extension", "node_modules", "playwright", "index.mjs");

const SHOP_PORT = Number(process.env.E2E_SHOP_PORT || 4300);
const AGENT_PORT = Number(process.env.E2E_AGENT_PORT || 5300);
const SHOP = `http://localhost:${SHOP_PORT}`;

// Visa test number, only ever offered to the tools that must refuse it.
const CARD = { name: "Test Shopper", number: "4111111111111111", exp: "12/30", csc: "737" };
const CARD_RUNS = [CARD.number, "4111 1111 1111 1111", "4111-1111-1111-1111"];

// Must be set before the agent modules load (they read env at import).
process.env.CLEARCART_BROWSER = "ext";
process.env.AGENT_PORT = String(AGENT_PORT);
process.env.AGENT_MODE = "echo"; // /session without Claude; the bridge is unaffected
process.env.CLEARCART_VOICE = "false"; // never spend Cartesia credits in tests
process.env.CLEARCART_ALLOWED_ORIGINS = SHOP;

const skip = !fs.existsSync(PW) && "playwright not installed in tests/extension";

const logs: string[] = [];
const results: string[] = [];
let shop: Awaited<ReturnType<typeof startShop>> | null = null;
let ctx: any;
let profile = "";
let extCopy = "";
let worker: any;
let bridge: typeof import("../../extbridge.ts").extBridge;
let pay: typeof import("../../pay.ts");
let tools: typeof import("../../exttools.ts");

// Every console line in this process (the agent server runs in-process).
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
    orig(...a);
  };
}

async function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await bridge.call<T>(method, params, 30_000);
  results.push(`${method} ${JSON.stringify(r)}`);
  return r;
}

async function callErr(method: string, params: Record<string, unknown>): Promise<{ code: string; message: string }> {
  try {
    const r = await bridge.call(method, params, 30_000);
    results.push(`${method} ${JSON.stringify(r)}`);
  } catch (e) {
    const err = { code: (e as any).code, message: (e as Error).message };
    results.push(`${method} error ${JSON.stringify(err)}`);
    return err;
  }
  throw new Error(`${method} unexpectedly succeeded`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function urlOf(tabId: number): Promise<string> {
  return (await call<{ url: string }>("tab_info", { tabId })).url;
}

async function findOne(tabId: number, query: string, pred: (m: { ref: string; role: string; name: string }) => boolean) {
  const { matches } = await call<{ matches: Array<{ ref: string; role: string; name: string }> }>("find", { tabId, query, limit: 20 });
  const m = matches.find(pred);
  assert.ok(m, `no match for ${query}: ${JSON.stringify(matches)}`);
  return m!;
}

before(async () => {
  if (skip) return;
  shop = await startShop({ port: SHOP_PORT });

  await import("../../server.ts");
  ({ extBridge: bridge } = await import("../../extbridge.ts"));
  pay = await import("../../pay.ts");
  tools = await import("../../exttools.ts");
  // Record every bridge reply, including pay_now's own calls.
  const raw = bridge.call.bind(bridge);
  (bridge as any).call = async (method: string, params?: any, ms?: number) => {
    try {
      const r = await raw(method, params, ms);
      results.push(`[bridge] ${method} ${JSON.stringify(r)}`);
      return r;
    } catch (e) {
      results.push(`[bridge] ${method} error ${(e as Error).message}`);
      throw e;
    }
  };
  await waitFor(() => fetch(`http://localhost:${AGENT_PORT}/healthz`).then((r) => r.ok), "the agent server");

  const { chromium } = await import(pathToFileURL(PW).href);
  extCopy = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-e2e-ext-"));
  fs.cpSync(EXT_DIR, extCopy, { recursive: true, filter: (p) => !p.split(path.sep).includes("test") && !p.includes("node_modules") });
  const settingsFile = path.join(extCopy, "lib", "settings.js");
  const settingsSrc = fs.readFileSync(settingsFile, "utf8");
  const patched = settingsSrc.replace('agentUrl: "ws://localhost:5050"', `agentUrl: "ws://localhost:${AGENT_PORT}"`);
  assert.notEqual(patched, settingsSrc, "default agent URL not found in settings.js");
  fs.writeFileSync(settingsFile, patched);
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-e2e-profile-"));
  ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extCopy}`, `--load-extension=${extCopy}`],
  });
  ctx.on("console", (m: any) => logs.push(`[browser] ${m.text()}`));
  [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  worker.on?.("console", (m: any) => logs.push(`[worker] ${m.text()}`));
  await sleep(300);
  if (!ctx.pages().length) await ctx.newPage();
  await worker.evaluate(
    ([agentUrl, origin]: string[]) => chrome.storage.local.set({ agentUrl, allowlist: [origin] }),
    [`ws://localhost:${AGENT_PORT}`, SHOP]
  );
  await waitFor(async () => bridge.connected(), "the extension to connect to /ext", 20_000);
});

after(async () => {
  await ctx?.close().catch(() => {});
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  if (extCopy) fs.rmSync(extCopy, { recursive: true, force: true });
  await shop?.stop();
  // The in-process agent server keeps the event loop alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
});

test("full shopping flow over the extension bridge, card never leaks", { skip }, async () => {
  // tabs_create on the shop
  const { tabId } = await call<{ tabId: number }>("tabs_create", { url: SHOP + "/" });
  assert.equal(typeof tabId, "number");
  const ctxInfo = await call<{ tabs: Array<{ tabId: number; url: string }> }>("tabs_context");
  assert.ok(ctxInfo.tabs.some((t) => t.tabId === tabId));

  // Open web mode (the default): blocked sites, the agent console and other
  // local ports are refused by the extension itself, before the tab moves.
  for (const url of ["https://mail.google.com/", "https://www.chase.com/", `http://localhost:${AGENT_PORT}/`, "http://localhost:4301/", "chrome://settings"]) {
    assert.equal((await callErr("navigate", { tabId, url })).code, "not_allowed", url);
  }
  assert.equal(await urlOf(tabId), SHOP + "/");

  // The extension seeded the suggested blocked sites and sent them over the
  // bridge; an edit on its side reaches the agent's guard too.
  const { SUGGESTED_ENTRIES } = await import("../../blocklist.ts");
  await waitFor(async () => bridge.blocklist()?.length === SUGGESTED_ENTRIES.length, "the seeded blocklist on the agent");
  await worker.evaluate(() => chrome.storage.local.set({ blocklist: ["# test", "*mug-shop*", "etsy.com"] }));
  await waitFor(async () => bridge.blocklist()?.map((e) => e.text).join() === "*mug-shop*,etsy.com", "the edited blocklist on the agent");
  assert.equal((await callErr("navigate", { tabId, url: "https://www.etsy.com/" })).code, "not_allowed");
  const { browseDenyReason } = await import("../../session.ts");
  assert.match(browseDenyReason("https://www.etsy.com/") || "", /etsy\.com/);
  assert.equal(browseDenyReason("https://mail.google.com/"), null, "the extension's list replaced the suggested one");
  await worker.evaluate((lines: string[]) => chrome.storage.local.set({ blocklist: lines }), [...(await import("../../blocklist.ts")).SUGGESTED_BLOCKLIST]);
  await waitFor(async () => bridge.blocklist()?.length === SUGGESTED_ENTRIES.length, "the restored blocklist on the agent");

  // Search: click the search box by ref, type, press Enter.
  const page = await call<{ tree: string }>("read_page", { tabId, filter: "interactive" });
  assert.match(page.tree, /searchbox|textbox/);
  const box = await findOne(tabId, "Search products", (m) => /search|text/.test(m.role));
  await tools.clickRef(bridge, box.ref, tabId);
  await call("type", { tabId, text: "mug" });
  await call("key", { tabId, key: "Enter" });
  await waitFor(async () => (await urlOf(tabId)).includes("/search?q=mug"), "search results");

  // Open a product.
  const link = await findOne(tabId, "Blue mug", (m) => m.role === "link" && /Blue mug/i.test(m.name));
  await tools.clickRef(bridge, link.ref, tabId);
  await waitFor(async () => (await urlOf(tabId)).includes("/product/"), "the product page");

  // Add to cart (click by ref through rect + CDP).
  const add = await findOne(tabId, "Add to cart", (m) => m.role === "button");
  const via = await tools.clickRef(bridge, add.ref, tabId);
  assert.equal(via.via, "cdp");
  await waitFor(async () => (await urlOf(tabId)).includes("/cart"), "the cart");

  // Uncheck the pre-checked add-on with form_input.
  const tree = (await call<{ tree: string }>("read_page", { tabId, filter: "all" })).tree;
  const addonLine = tree.split("\n").find((l) => /checkbox/.test(l) && /Subscribe/i.test(l));
  assert.ok(addonLine && /\bchecked\b/.test(addonLine), `add-on not pre-checked: ${addonLine}`);
  const addonRef = /\[(ref_\d+)\]/.exec(addonLine!)![1];
  await call("form_input", { tabId, ref: addonRef, value: false });
  await sleep(500); // the cart page posts the change
  const after = (await call<{ tree: string }>("read_page", { tabId, filter: "all" })).tree;
  assert.match(after.split("\n").find((l) => l.includes(`[${addonRef}]`))!, /unchecked/);

  // Checkout.
  await call("navigate", { tabId, url: SHOP + "/checkout" });
  const text = (await call<{ text: string }>("get_page_text", { tabId })).text;
  const total = /Order total\s*:?\s*\$?\s*([0-9][0-9,]*\.[0-9]{2})/i.exec(text)?.[1];
  assert.ok(total, `no Order total in: ${text.slice(0, 600)}`);
  assert.doesNotMatch(text, /Subscribe &? ?Save membership\s*\$4/i);

  // Card safety: form_input and typing into a card field are refused.
  const card = await call<{ fields: number; filled: number; number: { filled: boolean } | null }>("card_state", { tabId });
  assert.deepEqual([card.fields, card.filled, card.number?.filled], [4, 0, false]);
  const num = await findOne(tabId, "card number", (m) => /text/.test(m.role));
  assert.equal((await callErr("form_input", { tabId, ref: num.ref, value: "4000" })).code, "payment_field");
  await tools.clickRef(bridge, num.ref, tabId);
  assert.equal((await callErr("type", { tabId, text: "12" })).code, "payment_field");
  assert.equal((await callErr("key", { tabId, key: "4" })).code, "payment_field");
  const addr = await findOne(tabId, "address", (m) => /text/.test(m.role) && /address/i.test(m.name));
  await tools.clickRef(bridge, addr.ref, tabId);
  assert.equal((await callErr("type", { tabId, text: `card ${CARD.number}` })).code, "payment_field");
  await call("type", { tabId, text: "1 Test Lane, Berkeley, CA 94704" });

  // Button lock: Claude's own tools cannot press Place order, by ref, by
  // coordinates or with Enter from a checkout field.
  const defs = Object.fromEntries(tools.extToolDefinitions(bridge).map((d) => [d.name, d]));
  const place = await findOne(tabId, "Place order", (m) => m.role === "button");
  assert.equal((place as any).locked, true);
  const viaTool: any = await defs.click.handler({ tabId, ref: place.ref }, {});
  results.push(`click tool ${JSON.stringify(viaTool)}`);
  assert.equal(viaTool.isError, true);
  assert.match(viaTool.content[0].text, /^Locked: 'Place order/);
  const r0 = await call<{ x: number; y: number; width: number; height: number }>("rect", { tabId, ref: place.ref });
  assert.equal((await callErr("click", { tabId, x: r0.x + r0.width / 2, y: r0.y + r0.height / 2 })).code, "locked");
  // Enter in the address textarea is a new line, and no key at all goes
  // into a card field.
  const cardName = await findOne(tabId, "name on card", (m) => /text/.test(m.role));
  await tools.clickRef(bridge, cardName.ref, tabId);
  assert.equal((await callErr("key", { tabId, key: "Enter" })).code, "payment_field");
  assert.match((await call<{ tree: string }>("read_page", { tabId, filter: "all" })).tree, /Place order[^\n]*\[locked\]/);
  assert.match(await urlOf(tabId), /\/checkout$/, "no order was placed by the attempts");

  // pay_now with a yes pinned the way request_checkout pins it: the card
  // number is empty (no card was picked), so nothing is pressed.
  const page = await pay.readCheckoutExt(bridge, tabId);
  assert.equal(page.total?.text, `$${total}`);
  const state = {
    lastTabId: tabId,
    confirmation: { item: "Blue mug, 12 oz", quantity: 1, total: page.total!.text, state: "confirmed" as const, confirmedAt: Date.now(), tabId, origin: page.origin, cart: page.cart },
    payBusy: false,
  };
  const r = await pay.payNowExt(state);
  results.push(`pay_now ${JSON.stringify(r)}`);
  assert.equal(r.ok, false);
  assert.match((r as any).error, /card number is empty/);
  assert.match(await urlOf(tabId), /\/checkout$/, "no order was placed");

  // Two /session clients at once (the offscreen doc opens its own).
  const a = await openSession();
  const b = await openSession();
  a.ws.send(JSON.stringify({ type: "user_text", text: "hi from a" }));
  b.ws.send(JSON.stringify({ type: "user_text", text: "hi from b" }));
  await waitFor(async () => a.got.some((m) => m.text === "You said: hi from a") && b.got.some((m) => m.text === "You said: hi from b"), "two sessions");
  a.ws.close();
  b.ws.close();

  // The card number appears in no tool result and no log line.
  const all = [...results, ...logs].join("\n");
  for (const run of CARD_RUNS) assert.ok(!all.includes(run), `card number leaked`);
  assert.ok(!all.includes(`"${CARD.csc}"`), "security code leaked");
  if (process.env.E2E_VERBOSE) process.stderr.write(results.map((l) => l.slice(0, 300)).join("\n") + "\n");
});

async function openSession() {
  const ws = new WebSocket(`ws://localhost:${AGENT_PORT}/session`);
  const got: any[] = [];
  ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
  return { ws, got };
}
