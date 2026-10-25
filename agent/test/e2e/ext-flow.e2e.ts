// End-to-end: the real agent server (CLEARCART_BROWSER=ext) and the unpacked
// extension in an isolated Playwright Chromium (never the user's Chrome),
// against a private demo store on a spare port. Drives the shopping flow over
// the bridge the way Claude's tools would, without Claude, then runs the ext
// pay_now with a stand-in vault card (never the Keychain) and checks the card
// number never shows up in a tool result or a log.
//
//   npm --prefix agent run test:e2e:ext
//   (needs `npm install` in tests/extension for Playwright)
//
// Ports: store 4300, agent 5300 (override with E2E_STORE_PORT / E2E_AGENT_PORT).
// The browser loads a temp copy of extension/ whose default agent URL is the
// test's agent, so the test extension never connects to a live agent on :5050.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const EXT_DIR = path.join(REPO, "extension");
const PW = path.join(REPO, "tests", "extension", "node_modules", "playwright", "index.mjs");

const STORE_PORT = Number(process.env.E2E_STORE_PORT || 4300);
const AGENT_PORT = Number(process.env.E2E_AGENT_PORT || 5300);
const STORE = `http://localhost:${STORE_PORT}`;

// Visa test number; the stand-in vault hands it to pay_now.
const CARD = { name: "Test Shopper", number: "4111111111111111", exp: "12/30", csc: "737" };
const CARD_RUNS = [CARD.number, "4111 1111 1111 1111", "4111-1111-1111-1111"];

// Must be set before the agent modules load (they read env at import).
process.env.CLEARCART_BROWSER = "ext";
process.env.AGENT_PORT = String(AGENT_PORT);
process.env.AGENT_MODE = "echo"; // /session without Claude; the bridge is unaffected
process.env.CLEARCART_STORE_ORIGIN = STORE;
process.env.CLEARCART_ALLOWED_ORIGINS = STORE;

const skip = !fs.existsSync(PW) && "playwright not installed in tests/extension";

const logs: string[] = [];
const results: string[] = [];
let store: ChildProcess | null = null;
let ctx: any;
let profile = "";
let extCopy = "";
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
  store = spawn(process.execPath, [path.join(REPO, "store", "server.js")], {
    env: { ...process.env, STORE_PORT: String(STORE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  store.stdout!.on("data", (d) => logs.push(`[store] ${d}`));
  store.stderr!.on("data", (d) => logs.push(`[store] ${d}`));
  await waitFor(() => fetch(STORE + "/").then((r) => r.ok), "the store");

  await import("../../server.ts");
  ({ extBridge: bridge } = await import("../../extbridge.ts"));
  pay = await import("../../pay.ts");
  tools = await import("../../exttools.ts");
  assert.equal(pay.STORE_ORIGIN, STORE);
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
  let [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  worker.on?.("console", (m: any) => logs.push(`[worker] ${m.text()}`));
  await sleep(300);
  if (!ctx.pages().length) await ctx.newPage();
  await worker.evaluate(
    ([agentUrl, origin]: string[]) => chrome.storage.local.set({ agentUrl, allowlist: [origin] }),
    [`ws://localhost:${AGENT_PORT}`, STORE]
  );
  await waitFor(async () => bridge.connected(), "the extension to connect to /ext", 20_000);
});

after(async () => {
  await ctx?.close().catch(() => {});
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  if (extCopy) fs.rmSync(extCopy, { recursive: true, force: true });
  store?.kill();
  // The in-process agent server keeps the event loop alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
});

test("full shopping flow over the extension bridge, card never leaks", { skip }, async () => {
  // tabs_create store
  const { tabId } = await call<{ tabId: number }>("tabs_create", { url: STORE + "/" });
  assert.equal(typeof tabId, "number");
  const ctxInfo = await call<{ tabs: Array<{ tabId: number; url: string }> }>("tabs_context");
  assert.ok(ctxInfo.tabs.some((t) => t.tabId === tabId));

  // Open web mode (the default): blocked sites, the agent console and other
  // local ports are refused by the extension itself, before the tab moves.
  for (const url of ["https://mail.google.com/", "https://www.chase.com/", `http://localhost:${AGENT_PORT}/`, "http://localhost:4301/", "chrome://settings"]) {
    assert.equal((await callErr("navigate", { tabId, url })).code, "not_allowed", url);
  }
  assert.equal(await urlOf(tabId), STORE + "/");

  // Search: click the search box by ref, type, press Enter.
  const page = await call<{ tree: string }>("read_page", { tabId, filter: "interactive" });
  assert.match(page.tree, /searchbox|textbox/);
  const box = await findOne(tabId, "Search products", (m) => /search|text/.test(m.role));
  await tools.clickRef(bridge, box.ref, tabId);
  await call("type", { tabId, text: "cetirizine" });
  await call("key", { tabId, key: "Enter" });
  await waitFor(async () => (await urlOf(tabId)).includes("/search?q=cetirizine"), "search results");

  // Open a product.
  const link = await findOne(tabId, "Cetirizine", (m) => m.role === "link" && /Cetirizine/i.test(m.name));
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
  await call("navigate", { tabId, url: STORE + "/checkout" });
  const text = (await call<{ text: string }>("get_page_text", { tabId })).text;
  const total = /Order total\s*:?\s*\$?\s*([0-9][0-9,]*\.[0-9]{2})/i.exec(text)?.[1];
  assert.ok(total, `no Order total in: ${text.slice(0, 600)}`);
  assert.doesNotMatch(text, /Subscribe &? ?Save membership\s*\$4/i);

  // Card safety: form_input and typing into a card field are refused.
  const fields = await call<{ fields: Array<{ name: string; kind: string }> }>("read_fields", { tabId });
  assert.ok(["cc-name", "cc-number", "cc-exp", "cc-csc", "address"].every((k) => fields.fields.some((f) => f.kind === k)));
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
  // Enter in the address textarea is a new line, so press it from the name field.
  const cardName = await findOne(tabId, "name on card", (m) => /text/.test(m.role));
  await tools.clickRef(bridge, cardName.ref, tabId);
  assert.equal((await callErr("key", { tabId, key: "Enter" })).code, "locked");
  assert.match((await call<{ tree: string }>("read_page", { tabId, filter: "all" })).tree, /Place order[^\n]*\[locked\]/);
  assert.match(await urlOf(tabId), /\/checkout$/, "no order was placed by the attempts");

  // pay_now over the extension, with a stand-in vault. The yes is pinned
  // to the tab and its cart the way request_checkout pins it.
  const snap = await pay.checkoutSnapshot(tabId);
  assert.equal(snap.tabId, tabId);
  assert.match(snap.cart, /Order total/);
  const state = {
    lastTabId: tabId,
    confirmation: { item: "Cetirizine 30 tablets", quantity: 1, total: `$${total}`, state: "confirmed" as const, confirmedAt: Date.now(), tabId, cart: snap.cart },
    cardFieldsLive: false,
  };
  const r = await pay.payNowExt(state as any, { getCard: async () => ({ ...CARD }) });
  results.push(`pay_now ${JSON.stringify(r)}`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.ok && r.last4 === "1111" && r.receipt.total === `$${total}`, JSON.stringify(r));
  assert.equal(state.cardFieldsLive, false);

  // Order page shows last4 only.
  assert.match(await urlOf(tabId), /\/order\//);
  const order = (await call<{ text: string }>("get_page_text", { tabId })).text;
  assert.match(order, /ending in\s*1111/);
  for (const run of CARD_RUNS) assert.ok(!order.includes(run));

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

test("a store rejection comes back as the alert text and the card fields are cleared", { skip }, async () => {
  const { tabId } = await call<{ tabId: number }>("tabs_create", { url: STORE + "/product/cetirizine-30" });
  const add = await findOne(tabId, "Add to cart", (m) => m.role === "button");
  await tools.clickRef(bridge, add.ref, tabId);
  await waitFor(async () => (await urlOf(tabId)).includes("/cart"), "the cart");
  await call("navigate", { tabId, url: STORE + "/checkout" });
  const text = (await call<{ text: string }>("get_page_text", { tabId })).text;
  const total = /Order total\s*:?\s*\$?\s*([0-9][0-9,]*\.[0-9]{2})/i.exec(text)![1];
  const state = {
    lastTabId: tabId,
    confirmation: { item: "Cetirizine", quantity: 1, total: `$${total}`, state: "confirmed" as const, confirmedAt: Date.now(), tabId },
    cardFieldsLive: false,
  };
  const bad = { ...CARD, number: "4111111111111112" }; // fails Luhn at the store
  const r = await pay.payNowExt(state as any, { getCard: async () => ({ ...bad }), orderTimeoutMs: 8_000 });
  results.push(`pay_now ${JSON.stringify(r)}`);
  assert.equal(r.ok, false);
  assert.match((r as any).error, /rejected the payment: That card number is not valid/);
  assert.equal(state.cardFieldsLive, false);
  const fields = await call<{ fields: Array<{ kind: string; filled: boolean }> }>("read_fields", { tabId });
  assert.ok(fields.fields.filter((f) => f.kind.startsWith("cc-")).every((f) => !f.filled || f.kind === "cc-name" || f.kind === "cc-exp"));
  const all = [...results, ...logs].join("\n");
  assert.ok(!all.includes(bad.number) && !all.includes(CARD.number), "card number leaked");
});

async function openSession() {
  const ws = new WebSocket(`ws://localhost:${AGENT_PORT}/session`);
  const got: any[] = [];
  ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
  return { ws, got };
}
