// Screenshots of the subtitles overlay in an isolated Playwright Chromium
// (never the user's Chrome). The manifest is not ours to edit, so this copies
// extension/ to a temp dir and adds
// the subtitles content_scripts entry to the copy. Fake messages come from the worker
// via chrome.tabs.sendMessage, exactly as the real relay will send them.
//
// Run: npm run screenshots (from this folder). Output: ./screenshots/*.png

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.resolve(HERE, "..", "..");
const OUT = path.join(HERE, "screenshots");

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>Store</title>
<meta name=color-scheme content="light dark">
<style>
  body { margin: 0; font: 16px/1.5 Georgia, serif; background: #fff; color: #222; }
  @media (prefers-color-scheme: dark) { body { background: #121212; color: #ddd; } }
  header { padding: 18px 32px; border-bottom: 1px solid #8884; font: 700 22px Georgia; }
  main { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; padding: 32px; }
  .p { border: 1px solid #8884; border-radius: 6px; padding: 16px; height: 220px;
       background: linear-gradient(160deg, #e8d9c4, #c9b79c); color: #222; }
  /* Hostile page CSS the overlay must ignore. */
  * { font-family: "Comic Sans MS", cursive !important; letter-spacing: 2px; }
  div { border: 3px dashed red; }
  span { color: lime !important; font-size: 40px !important; }
</style></head><body>
<header>Corner Grocer</header>
<main>${["Oat milk", "Sourdough", "Free-range eggs", "Honeycrisp apples", "Greek yogurt", "Coffee beans"]
  .map((n) => `<div class=p>${n}<br><b>$4.99</b></div>`).join("")}</main></body></html>`;

let server, port, context, worker, userDataDir, extDir;

before(async () => {
  server = http.createServer((_, res) => { res.setHeader("content-type", "text/html"); res.end(PAGE); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;

  extDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-subs-ext-"));
  fs.cpSync(EXT_SRC, extDir, { recursive: true, filter: (p) => !p.includes(`${path.sep}test${path.sep}`) && !p.endsWith(`${path.sep}test`) });
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  manifest.content_scripts = [{ matches: ["<all_urls>"], js: ["content/orb-face.js", "content/subtitles.js"], run_at: "document_idle", all_frames: false }];
  fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-subs-profile-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  fs.mkdirSync(OUT, { recursive: true });
});

after(async () => {
  await context?.close().catch(() => {});
  server?.close();
  for (const d of [userDataDir, extDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

async function sendAll(msgs) {
  await worker.evaluate(async (msgs) => {
    const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
    for (const m of msgs) await chrome.tabs.sendMessage(tab.id, m).catch(() => {});
  }, msgs);
}

for (const scheme of ["light", "dark"]) {
  test(`overlay renders in ${scheme} mode`, async () => {
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => document.readyState === "complete");
    await page.waitForTimeout(300); // content script at document_idle

    await sendAll([
      { type: "voice.state", state: "listening" },
      { type: "subtitle", speaker: "user", text: "Find me oat milk under five dollars", final: true },
      { type: "voice.state", state: "speaking" },
      { type: "subtitle", speaker: "agent", text: "I found Oatly Barista for", final: false },
      { type: "subtitle", speaker: "agent", text: "I found Oatly Barista for $4.99. Want me to add it to your cart?", final: true },
    ]);
    await page.waitForTimeout(1600); // let the word reveal finish

    const host = await page.$("clearcart-subtitles");
    assert.ok(host, "overlay host mounted");
    assert.equal(await host.getAttribute("aria-hidden"), "true");
    assert.equal(await page.evaluate(() => document.querySelector("clearcart-subtitles").shadowRoot), null);
    // Click-through: the element under the card is still the page.
    const under = await page.evaluate(() => document.elementFromPoint(640, 740)?.tagName);
    assert.notEqual(under, "CLEARCART-SUBTITLES");

    await page.screenshot({ path: path.join(OUT, `subtitles-${scheme}.png`) });
    await page.close();
  });
}

test("thinking state with only the user line", async () => {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(300);
  await sendAll([
    { type: "subtitle", speaker: "user", text: "Add two of those", final: true },
    { type: "voice.state", state: "thinking" },
  ]);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "subtitles-thinking-light.png") });
  await page.close();
});
