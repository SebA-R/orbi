// Headless repro for "the viewport shrinks mid-run" (local page only).
// Launches Playwright Chromium the way the film recorder did (1440x900
// viewport at device scale 2, --silent-debugger-extension-api) with the
// unpacked extension, then turns the overlays on and off and drives CDP
// input and screenshots from the extension, logging innerWidth/innerHeight
// after every step. Needs `npm ci` in tests/extension.
//   node scripts/repro-viewport.mjs
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(path.join(REPO, "tests/extension/node_modules/playwright/index.mjs"));

const server = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html><title>vp</title><button style='margin:40px'>Go</button><div style='height:3000px'></div>"); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const ext = fs.mkdtempSync(path.join(os.tmpdir(), "cc-vp-ext-"));
fs.cpSync(path.join(REPO, "extension"), ext, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.split(path.sep).includes("test") });
fs.writeFileSync(path.join(ext, "background", "worker.js"), `import * as cdp from "./cdp.js"; chrome.debugger.onDetach.addListener((s) => cdp.onDetach(s)); globalThis.C = cdp;`);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cc-vp-prof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: !process.env.HEADED,
  viewport: process.env.NO_EMULATION ? null : { width: 1440, height: 900 }, deviceScaleFactor: process.env.NO_EMULATION ? undefined : 2,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--silent-debugger-extension-api", "--force-device-scale-factor=2", "--window-size=1440,900"],
});
let [worker] = ctx.serviceWorkers();
if (!worker) worker = await ctx.waitForEvent("serviceworker");
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(origin);
await page.waitForTimeout(500);
const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id);
const msg = (m) => worker.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m).catch(() => {}), [tabId, m]);
const size = () => page.evaluate(() => `${innerWidth}x${innerHeight} dpr ${devicePixelRatio}`);
const step = async (name, fn) => { await fn(); await page.waitForTimeout(400); console.log(name.padEnd(36), await size()); };

await step("baseline", async () => {});
await step("frame on", () => msg({ type: "frame", on: true }));
await step("cursor move", () => msg({ type: "cursor", phase: "move", action: "click", x: 300, y: 300, to: { x: 300, y: 300 } }));
await step("subtitle", () => msg({ type: "subtitle", speaker: "agent", text: "Hello there", final: true }));
await step("debugger attach + click", () => worker.evaluate((id) => C.click({ tabId: id, x: 60, y: 50 }), tabId));
await step("screenshot", async () => {
  const s = await worker.evaluate((id) => C.screenshot({ tabId: id }).then((s) => ({ ...s, img: C.jpegSize(s.data) })), tabId);
  console.log("  screenshot image", `${s.img.width}x${s.img.height}`, "reported", `${s.width}x${s.height} scale ${s.scale}`);
});
await step("click past the edge is refused", async () => {
  const e = await worker.evaluate(async (id) => { const v = await C.viewport(id); try { C.assertInViewport(v, 1878, 574); return "accepted"; } catch (e) { return e.message; } }, tabId);
  console.log("  ", e);
});
await step("frame off", () => msg({ type: "frame", on: false }));
await step("debugger detach", () => worker.evaluate(() => C.detachAll()));
await step("re-attach + screenshot", () => worker.evaluate((id) => C.screenshot({ tabId: id }), tabId));
await step("detach again", () => worker.evaluate(() => C.detachAll()));
await step("screenshot clip scale .5", () => worker.evaluate((id) => C.send(id, "Page.captureScreenshot", { format: "jpeg", clip: { x: 0, y: 0, width: 1440, height: 900, scale: 0.5 } }), tabId));
await step("screenshot beyond viewport", () => worker.evaluate((id) => C.send(id, "Page.captureScreenshot", { format: "jpeg", captureBeyondViewport: true }), tabId));
await step("detach", () => worker.evaluate(() => C.detachAll()));
await step("cross-origin nav via chrome.tabs", () => worker.evaluate(([id, u]) => chrome.tabs.update(id, { url: u }), [tabId, origin.replace("127.0.0.1", "localhost")]).then(() => page.waitForLoadState("load")));
const p2 = ctx.waitForEvent("page");
await worker.evaluate((u) => chrome.tabs.create({ url: u, active: false }), origin);
const page2 = await p2; await page2.waitForLoadState("load");
console.log("new tab via chrome.tabs.create".padEnd(36), await page2.evaluate(() => `${innerWidth}x${innerHeight}`));
await ctx.close();
server.close();
for (const d of [ext, profile]) fs.rmSync(d, { recursive: true, force: true });
