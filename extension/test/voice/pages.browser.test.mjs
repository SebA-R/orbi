// Loads the options page and the offscreen document in an isolated Playwright
// Chromium (never the user's Chrome) with a fake mic, and mocks every socket:
// the agent /session, the token endpoint and both Cartesia websockets.
// Needs `npm ci` in tests/extension; skipped otherwise.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, "..", "..");
const PW = path.resolve(EXT_DIR, "..", "tests", "extension", "node_modules", "playwright", "index.mjs");
const EXT_ID = "dhgknfenfoidnchmjfaicafhieepefoc";
const skip = !fs.existsSync(PW) && "playwright not installed (npm ci in tests/extension)";

let context, userDataDir;
const sockets = { session: [], stt: [], tts: [] };

before(async () => {
  if (skip) return;
  const { chromium } = await import(pathToFileURL(PW).href);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-voice-test-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [
      `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`,
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    ],
  });
  if (!context.serviceWorkers().length) await context.waitForEvent("serviceworker", { timeout: 15_000 });
  await context.route("http://localhost:5050/cartesia-token", (r) => r.fulfill({ json: { token: "fake-token", expires_in: 300 } }));
  await context.routeWebSocket(/localhost:5050\/session/, (ws) => {
    const entry = { ws, got: [] };
    ws.onMessage((m) => entry.got.push(JSON.parse(m)));
    sockets.session.push(entry);
  });
  await context.routeWebSocket(/api\.cartesia\.ai\/stt/, (ws) => {
    const entry = { ws, url: ws.url(), binary: 0, got: [] };
    ws.onMessage((m) => { if (typeof m === "string") entry.got.push(JSON.parse(m)); else entry.binary++; });
    sockets.stt.push(entry);
  });
  await context.routeWebSocket(/api\.cartesia\.ai\/tts/, (ws) => {
    const entry = { ws, url: ws.url(), got: [] };
    ws.onMessage((m) => entry.got.push(JSON.parse(m)));
    sockets.tts.push(entry);
  });
});

after(async () => {
  await context?.close().catch(() => {});
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("options page saves settings and grants the microphone", { skip }, async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/options/options.html`);
  await page.waitForSelector("html[data-ready=true]");
  assert.equal(await page.locator("#hotkey option").count(), 4);
  assert.equal(await page.inputValue("#agent-url"), "ws://localhost:5050");
  await page.selectOption("#hotkey", "F9");
  await page.fill("#speed", "1.4");
  await page.uncheck("#subtitles");
  await page.click("button[type=submit]");
  await page.waitForFunction(() => document.getElementById("status").textContent === "Saved.");
  const stored = await page.evaluate(() => chrome.storage.local.get(["hotkey", "speed", "subtitles"]));
  assert.deepEqual(stored, { hotkey: "F9", speed: 1.4, subtitles: false });

  // Sites: open web by default, editable allowlist, origins only.
  assert.equal(await page.isChecked("#mode-open"), true);
  assert.equal(await page.inputValue("#allowlist"), "http://localhost:4000");
  await page.fill("#allowlist", "http://localhost:4000\nhttps://me:pw@shop.example");
  await page.click("button[type=submit]");
  await page.waitForFunction(() => /Not a site address in the allowed sites: https:\/\/me:pw@shop\.example/.test(document.getElementById("status").textContent));
  assert.equal(await page.getAttribute("#allowlist", "aria-invalid"), "true");

  // Blocked sites: seeded on install, shown grouped, user editable.
  const suggested = await page.evaluate(async () => (await import("/lib/blocklist.js")).SUGGESTED_BLOCKLIST);
  assert.equal(await page.inputValue("#blocklist"), suggested.join("\n"));
  assert.deepEqual((await page.evaluate(() => chrome.storage.local.get("blocklist"))).blocklist, suggested, "seeded on install");
  assert.match(await page.textContent("#blocked-sites"), /Always blocked: non-web pages, local network addresses, addresses with a login in them/);
  await page.fill("#allowlist", "http://localhost:4000\nwww.etsy.com/c/home");
  await page.fill("#blocklist", "# mine\nhttps://www.nordstrom.com/s/1\nnot a site\n*shoe*\nchase");
  await page.click("button[type=submit]");
  await page.waitForFunction(() => /Fix the blocked sites first: not a site, chase/.test(document.getElementById("status").textContent));
  assert.equal(await page.getAttribute("#blocklist", "aria-invalid"), "true");
  assert.equal(await page.isVisible("#blocklist-errors"), true);
  assert.match(await page.textContent("#blocklist-errors"), /not a site\nchase/);
  await page.fill("#blocklist", "# mine\nhttps://www.nordstrom.com/\n*shoe*\namazon.com/ap/");
  await page.check("#mode-allowlist");
  // Browse mode saves on its own; clear its "Saved." so the wait is for Save.
  await page.waitForFunction(() => document.getElementById("status").textContent === "Saved.");
  await page.evaluate(() => { document.getElementById("status").textContent = ""; });
  await page.click("button[type=submit]");
  await page.waitForFunction(() => document.getElementById("status").textContent === "Saved.");
  assert.deepEqual(await page.evaluate(() => chrome.storage.local.get(["browseMode", "allowlist", "blocklist"])), {
    browseMode: "allowlist", allowlist: ["http://localhost:4000", "https://www.etsy.com"], blocklist: ["# mine", "nordstrom.com", "*shoe*", "amazon.com/ap"],
  });
  assert.equal(await page.inputValue("#allowlist"), "http://localhost:4000\nhttps://www.etsy.com");
  assert.equal(await page.inputValue("#blocklist"), "# mine\nnordstrom.com\n*shoe*\namazon.com/ap");
  assert.equal(await page.isVisible("#blocklist-errors"), false);

  // Restore puts the suggested list back and keeps the user's own entries.
  await page.evaluate(() => { document.getElementById("status").textContent = ""; });
  await page.click("#restore-blocklist");
  await page.waitForFunction(() => document.getElementById("status").textContent === "Saved.");
  assert.deepEqual((await page.evaluate(() => chrome.storage.local.get("blocklist"))).blocklist, [...suggested, "", "# Your sites", "nordstrom.com", "*shoe*", "amazon.com/ap"]);

  // An emptied list stays empty.
  await page.evaluate(() => { document.getElementById("status").textContent = ""; });
  await page.fill("#blocklist", "");
  await page.click("button[type=submit]");
  await page.waitForFunction(() => document.getElementById("status").textContent === "Saved.");
  assert.deepEqual((await page.evaluate(() => chrome.storage.local.get("blocklist"))).blocklist, []);

  await page.fill("#agent-url", "ws://evil.example:5050");
  await page.click("button[type=submit]");
  await page.waitForFunction(() => /must be ws/.test(document.getElementById("status").textContent));

  await page.click("#grant-mic");
  await page.waitForFunction(() => /Microphone allowed/.test(document.getElementById("mic-status").textContent));
  await page.click("#reset");
  await page.waitForFunction(() => document.getElementById("status").textContent === "Reset to defaults.");
  assert.equal(await page.isChecked("#mode-open"), true);
  assert.deepEqual(await page.evaluate(() => chrome.storage.local.get(["browseMode", "allowlist", "blocklist"])), {
    browseMode: "open", allowlist: ["http://localhost:4000"], blocklist: suggested,
  });
  await page.close();
});

test("offscreen document: talk turn goes to the agent, the reply goes to Sonic", { skip }, async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/offscreen/offscreen.html`);
  await page.waitForFunction(() => !!globalThis.__clearcartVoice);
  const session = await until(() => sockets.session[0]);

  // Start listening: STT socket opens with Ink 2 params and receives mic audio.
  await page.evaluate(() => __clearcartVoice.controller.start());
  const stt = await until(() => sockets.stt[0]);
  const u = new URL(stt.url);
  assert.equal(u.searchParams.get("model"), "ink-2");
  assert.equal(u.searchParams.get("access_token"), "fake-token");
  assert.ok(u.searchParams.getAll("keyterm").includes("Clearcart"));
  await until(() => stt.binary > 0);
  assert.equal(await page.evaluate(() => __clearcartVoice.controller.state), "listening");

  stt.ws.send(JSON.stringify({ type: "turn.end", transcript: "find cheap allergy pills" }));
  await page.evaluate(() => __clearcartVoice.controller.stop());
  await until(() => stt.got.some((m) => m.type === "close"));
  await until(() => session.got.length);
  assert.deepEqual(session.got[0], { type: "user_text", text: "find cheap allergy pills" });
  assert.equal(await page.evaluate(() => __clearcartVoice.controller.state), "thinking");

  // Agent reply is spoken through Sonic 3.6 with the configured voice.
  session.ws.send(JSON.stringify({ type: "agent_text", text: "I found two options." }));
  const tts = await until(() => sockets.tts[0]?.got.length && sockets.tts[0]);
  assert.equal(tts.got[0].model_id, "sonic-3.6");
  assert.equal(tts.got[0].transcript, "I found two options.");
  assert.equal(tts.got[0].voice, "6ccbfb76-1fc6-48f7-b71d-91ac6298247b");
  assert.equal(await page.evaluate(() => __clearcartVoice.controller.state), "speaking");

  // Barge-in: starting to talk cancels the reply.
  await page.evaluate(() => __clearcartVoice.controller.start());
  await until(() => tts.got.some((m) => m.cancel === true));
  await page.evaluate(() => __clearcartVoice.controller.stop());
  await page.close();
});
