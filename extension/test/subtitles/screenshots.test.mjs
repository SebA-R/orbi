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

// Karaoke: a line mid-utterance. Screenshots hold the sweep halfway across
// the word being heard (frozen at 50%, so the frame is the same every run).
const KLINE = "I found Oatly Barista for $4.99. Want me to add it to your cart?";
const karaoke = (index, extra = {}) => [
  { type: "subtitle", speaker: "user", text: "Find me oat milk under five dollars", final: true },
  { type: "voice.state", state: "speaking" },
  { type: "subtitle", speaker: "agent", text: KLINE, final: true, utteranceId: "u1", karaoke: true },
  { type: "subtitle.word", utteranceId: "u1", index, ...extra },
];
const KOUT = process.env.KARAOKE_OUT || OUT;

for (const [name, media] of [
  ["light", { colorScheme: "light" }],
  ["dark", { colorScheme: "dark" }],
  ["reduced-motion", { colorScheme: "light", reducedMotion: "reduce" }],
  ["forced-colors", { colorScheme: "light", forcedColors: "active" }],
]) {
  test(`karaoke line mid-utterance (${name})`, async () => {
    const page = await context.newPage();
    await page.emulateMedia(media);
    await page.goto(`http://localhost:${port}/`);
    await page.waitForTimeout(300);
    await sendAll(karaoke(3, { ms: 600, elapsed: 300, frozen: true })); // "Barista", half said
    await page.waitForTimeout(700); // the sweep is .3 s
    fs.mkdirSync(KOUT, { recursive: true });
    await page.screenshot({ path: path.join(KOUT, `karaoke-${name}.png`) });
    await page.close();
  });
}

// Real Chromium styles for the heard word: the overlay script runs in the
// page itself here, with a fake chrome.runtime and its shadow root kept.
async function heardWordStyle(media) {
  const page = await context.newPage();
  await page.emulateMedia(media);
  await page.goto(`http://localhost:${port}/`);
  await page.evaluate(() => {
    const listeners = [];
    window.chrome = { runtime: { onMessage: { addListener: (f) => listeners.push(f) } } };
    window.__send = (m) => listeners.forEach((f) => f(m, {}, () => {}));
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) { return (window.__root = attach.call(this, init)); };
  });
  for (const f of ["orb-face.js", "subtitles.js"]) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(EXT_SRC, "content", f), "utf8") });
  }
  const out = await page.evaluate(async (msgs) => {
    for (const m of msgs) window.__send(m);
    await new Promise((r) => setTimeout(r, 400));
    const kc = window.__root.querySelector(".agent .w.kc");
    const cs = getComputedStyle(kc);
    const after = getComputedStyle(kc, "::after");
    const said = getComputedStyle(kc.previousElementSibling.previousElementSibling).color;
    const next = getComputedStyle(kc.nextElementSibling.nextElementSibling).color;
    return { text: kc.textContent, anim: cs.animationName, line: after.animationName, deco: cs.textDecorationLine, color: cs.color, fill: cs.webkitTextFillColor, said, next };
  }, karaoke(2));
  await page.close();
  return out;
}

test("karaoke: reduced motion has no animation on the heard word; forced colors underline it", async () => {
  const moving = await heardWordStyle({ reducedMotion: "no-preference", forcedColors: "none" });
  assert.equal(moving.text, "Oatly");
  assert.equal(moving.anim, "k-sweep");
  assert.notEqual(moving.said, moving.next, "said and coming words differ in ink");
  const still = await heardWordStyle({ reducedMotion: "reduce", forcedColors: "none" });
  assert.equal(still.anim, "none");
  assert.equal(still.line, "none");
  assert.equal(still.color, still.said, "the color steps to the said ink, no sweep");
  const forced = await heardWordStyle({ reducedMotion: "no-preference", forcedColors: "active" });
  assert.equal(forced.deco, "underline");
});
