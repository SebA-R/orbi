// Integration test: the real chrome.tabs / debugger APIs in an
// isolated Playwright Chromium (never the user's Chrome). The shared
// manifest does not have this module's permissions yet, so the test copies
// extension/ to a temp dir, adds them, and swaps in a tiny worker that
// exposes tabs.js and cdp.js on globalThis. Pages come from a throwaway
// local HTTP server that the test allowlists (loopback sites other than
// the allowlisted ones are blocked in open mode).
//
// Needs playwright installed in tests/extension (npm install there);
// skipped otherwise.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.resolve(HERE, "..", "..");
const REPO = path.resolve(EXT_SRC, "..");
const PW = path.join(REPO, "tests", "extension", "node_modules", "playwright", "index.mjs");

const skip = !fs.existsSync(PW) && "playwright not installed in tests/extension";

const PAGE = `<!doctype html><title>Fixture</title>
<input id="q" autofocus style="position:absolute;left:10px;top:10px;width:200px;height:30px">
<button id="b" style="position:absolute;left:10px;top:60px;width:100px;height:40px">Go</button>
<a id="l" href="/three" style="position:absolute;left:10px;top:120px;width:100px;height:30px;display:block">Next</a>
<div style="height:4000px"></div>
<script>
  window.log = [];
  document.getElementById("b").addEventListener("click", (e) => log.push("click:" + e.isTrusted));
  document.getElementById("q").addEventListener("keydown", (e) => log.push("key:" + e.key));
</script>`;

let server;
let origin;
let ctx;
let worker;
let dirs = [];

before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE.replace("Fixture", `Fixture ${req.url}`));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;

  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-tabs-cdp-ext-"));
  dirs.push(ext);
  // Everything the manifest names (newtab, popup...), without the tests.
  fs.cpSync(EXT_SRC, ext, { recursive: true, filter: (p) => !p.includes("node_modules") && path.relative(EXT_SRC, p).split(path.sep)[0] !== "test" });
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_SRC, "manifest.json"), "utf8"));
  manifest.permissions = [...new Set([...manifest.permissions, "tabs", "tabGroups", "debugger"])];
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(ext, "background", "worker.js"),
    `import * as tabs from "./tabs.js";
import * as cdp from "./cdp.js";
chrome.tabs.onRemoved.addListener((id) => cdp.onTabRemoved(id));
chrome.debugger.onDetach.addListener((s) => cdp.onDetach(s));
chrome.tabs.onRemoved.addListener((id) => tabs.onTabRemoved(id));
globalThis.T = tabs;
globalThis.C = cdp;
`,
  );

  const { chromium } = await import(PW);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-tabs-cdp-profile-"));
  dirs.push(profile);
  ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  await worker.evaluate((o) => chrome.storage.local.set({ allowlist: [o] }), origin);
});

after(async () => {
  await ctx?.close().catch(() => {});
  server?.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const run = (fn, arg) => worker.evaluate(fn, arg);
const pageFor = (url) => ctx.pages().find((p) => p.url() === url);

test("tabs_create opens a background tab, in no group, and loads it", { skip }, async () => {
  const { tabId } = await run((o) => T.tabsCreate({ url: `${o}/one` }), origin);
  const c = await run(() => T.tabsContext());
  assert.equal(c.tabs.length, 1);
  assert.equal(c.tabs[0].tabId, tabId);
  assert.equal(c.tabs[0].url, `${origin}/one`);
  assert.equal(c.tabs[0].title, "Fixture /one");
  const tab = await run((id) => chrome.tabs.get(id), tabId);
  assert.equal(tab.groupId, -1);
  assert.equal(tab.active, false);
  assert.equal(c.tabs[0].openedByClearcart, true);
});

test("navigate waits for load and refuses blocked sites (open mode) and other origins (allowlist mode)", { skip }, async () => {
  const r = await run((o) => T.navigate({ url: `${o}/two` }), origin);
  assert.equal(r.title, "Fixture /two");
  for (const url of ["http://127.0.0.1:1/", "chrome://settings", "https://mail.google.com/"]) {
    const err = await run((u) => T.navigate({ url: u }).then(() => null, (e) => e.code), url);
    assert.equal(err, "not_allowed", url);
  }
  await run(() => chrome.storage.local.set({ browseMode: "allowlist" }));
  const err = await run(() => T.navigate({ url: "https://example.com/" }).then(() => null, (e) => e.code));
  assert.equal(err, "not_allowed");
  await run(() => chrome.storage.local.set({ browseMode: "open" }));
  assert.equal((await run(() => T.tabInfo({}))).url, `${origin}/two`);
});

test("CDP click, type, key and screenshot reach the page as trusted input", { skip }, async () => {
  const tabId = await run(() => T.resolveAllowedTab());
  await run((id) => C.click({ tabId: id, x: 50, y: 25 }), tabId); // focus input
  await run((id) => C.type({ tabId: id, text: "red shoes" }), tabId);
  await run((id) => C.key({ tabId: id, key: "Enter" }), tabId);
  await run((id) => C.click({ tabId: id, x: 50, y: 80 }), tabId); // button
  await run((id) => C.scroll({ tabId: id, x: 100, y: 100, dy: 500 }), tabId);
  const page = pageFor(`${origin}/two`);
  assert.ok(page, "fixture page visible to playwright");
  assert.equal(await page.inputValue("#q"), "red shoes");
  const log = await page.evaluate(() => window.log);
  assert.ok(log.includes("key:Enter"), JSON.stringify(log));
  assert.ok(log.includes("click:true"), JSON.stringify(log));
  await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 3000 });
  const shot = await run((id) => C.screenshot({ tabId: id }), tabId);
  assert.equal(shot.mimeType, "image/jpeg");
  assert.equal(Buffer.from(shot.data, "base64").subarray(0, 2).toString("hex"), "ffd8");
});

test("on a 2x screen the screenshot is CSS-pixel sized and off-viewport points are refused", { skip }, async () => {
  const tabId = await run(() => T.resolveAllowedTab());
  const page = pageFor(`${origin}/two`);
  const css = await page.evaluate(() => [innerWidth, innerHeight]);
  await run((id) => C.send(id, "Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }), tabId);
  try {
    const vp = await run((id) => C.viewport(id), tabId);
    assert.equal(vp.dpr, 2);
    const shot = await run((id) => C.screenshot({ tabId: id }), tabId);
    const size = await run((d) => C.jpegSize(d), shot.data);
    // The image itself is CSS size (give or take a scrollbar), not 2x.
    assert.ok(Math.abs(size.width - css[0]) <= 20 && Math.abs(size.height - css[1]) <= 20, JSON.stringify({ size, css }));
    assert.deepEqual([shot.width, shot.height, shot.scale], [size.width, size.height, 1]);
    // A device-pixel x (twice the CSS width) is outside the viewport.
    const err = await run(async (id) => {
      const v = await C.viewport(id);
      try {
        C.assertInViewport(v, v.width * 2 - 10, 10);
        return null;
      } catch (e) {
        return e.code;
      }
    }, tabId);
    assert.equal(err, "bad_request");
  } finally {
    await run((id) => C.send(id, "Emulation.clearDeviceMetricsOverride"), tabId);
  }
});

test("back and forward follow a user-activated link click", { skip }, async () => {
  const tabId = await run(() => T.resolveAllowedTab());
  await run((id) => C.send(id, "Runtime.evaluate", { expression: "scrollTo(0, 0)" }), tabId);
  // Chrome's history intervention skips entries made without user activation,
  // so make one with a trusted CDP click on a link.
  await run((id) => T.navigateAndWait(id, () => C.click({ tabId: id, x: 40, y: 135 })), tabId);
  assert.equal((await run(() => T.tabInfo({}))).url, `${origin}/three`);
  assert.equal((await run(() => T.navigate({ url: "back" }))).url, `${origin}/two`);
  assert.equal((await run(() => T.navigate({ url: "forward" }))).url, `${origin}/three`);
});

test("closing the tab clears the debugger session", { skip }, async () => {
  const tabId = await run(() => T.resolveTab());
  assert.equal(await run((id) => C.isAttached(id), tabId), true);
  await run((id) => chrome.tabs.remove(id), tabId);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await run((id) => C.isAttached(id), tabId), false);
  assert.deepEqual(await run(() => T.tabsContext()), { tabs: [] });
});
