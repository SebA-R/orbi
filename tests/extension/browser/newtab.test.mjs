// The Clearcart new tab page (chrome_url_overrides): it loads, hotkey.js runs
// on it unchanged, the hero orb is the face, the worker reaches it like any tab, and
// broadcasts meant for the offscreen document never reach those scripts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { EXT_ID, launchWithExtension } from "./helpers.mjs";

let ext;
before(async () => {
  ext = await launchWithExtension();
});
after(async () => {
  await ext?.close();
});

const NEWTAB = `chrome-extension://${EXT_ID}/newtab/newtab.html`;

async function openNewTab() {
  const page = await ext.context.newPage();
  await page.goto("chrome://newtab/");
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  return page;
}

// The worker's tab id for the page, by its reported URL (chrome://newtab/).
const tabIdOf = () => ext.worker.evaluate(async () => {
  const [t] = await chrome.tabs.query({ url: "chrome://newtab/" });
  return t && t.id;
});

test("chrome://newtab opens Clearcart's page with the hotkey and no subtitle card", async () => {
  const page = await openNewTab();
  assert.equal(page.url(), NEWTAB);
  assert.equal(await page.title(), "New Tab");
  assert.equal(await page.evaluate(() => !!window.__clearcartHotkey && globalThis.__clearcartSubtitles !== true), true);
  assert.equal(await page.locator("h1").textContent(), "Clearcart");
  assert.equal(await page.getByRole("heading", { level: 2, name: "Hold Space to talk" }).count(), 1);
  assert.equal(await page.getByLabel("Search the web").count(), 1);
  await page.close();
});

test("the hero orb is the face: it smiles at rest, faceless while active, no mini orb", async () => {
  const page = await openNewTab();
  assert.equal(await page.locator("#mini-orb, .brand .ccf").count(), 0, "no mini orb beside the name");
  const face = page.locator("#orb > .ccf");
  assert.equal(await face.count(), 1);
  assert.equal(await face.getAttribute("aria-hidden"), "true");
  assert.equal(await page.locator("#orb").getAttribute("aria-hidden"), "true");
  const box = await page.locator("#orb").evaluate((o) => {
    const r = o.querySelector(".ccf").getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), bg: getComputedStyle(o).backgroundImage };
  });
  // The face breathes, so allow its scale.
  assert.ok(box.w >= 126 && box.w <= 136 && box.h >= 126 && box.h <= 136, JSON.stringify(box));
  assert.equal(box.bg, "none", "the face paints the orb");
  assert.equal(await face.evaluate((f) => f.classList.contains("ccf-noface")), false, "idle smiles");
  assert.equal(await page.locator("#orb .ccf-eye").count(), 2);
  const id = await tabIdOf();
  for (const state of ["listening", "thinking", "speaking"]) {
    await ext.worker.evaluate(([tabId, s]) => chrome.tabs.sendMessage(tabId, { type: "voice.state", state: s }), [id, state]);
    await page.waitForFunction((s) => document.querySelector("#orb > .ccf").dataset.state === s, state);
    assert.equal(await face.evaluate((f) => f.classList.contains("ccf-noface")), true, state);
  }
  await ext.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: "voice.state", state: "idle" }), id);
  await page.waitForFunction(() => !document.querySelector("#orb > .ccf").classList.contains("ccf-noface"));
  await page.close();
});

test("the worker's VOICE_STATE reaches the page; offscreen broadcasts do not", async () => {
  const page = await openNewTab();
  const id = await tabIdOf();
  assert.ok(Number.isInteger(id));
  // A raw offscreen-style broadcast (from another extension page) is ignored.
  const other = await ext.context.newPage();
  await other.goto(`chrome-extension://${EXT_ID}/options/options.html`);
  await other.evaluate(() => chrome.runtime.sendMessage({ type: "voice.state", state: "speaking", from: "offscreen" }).catch(() => {}));
  await other.evaluate(() => chrome.runtime.sendMessage({ type: "voice.state", state: "speaking" }).catch(() => {}));
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#orb").getAttribute("data-state"), "idle");
  // What the relay sends the talking tab reaches the page and the hotkey.
  await ext.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: "voice.state", state: "listening", latched: true }), id);
  await page.waitForFunction(() => document.getElementById("orb").dataset.state === "listening");
  assert.equal(await page.evaluate(() => window.__clearcartHotkey.latched), true);
  await ext.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: "subtitle", speaker: "agent", text: "Opening Etsy.", final: true }), id);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => !!document.querySelector("clearcart-subtitles")), false, "no subtitle card on the new tab page");
  await ext.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: "voice.state", state: "idle" }), id);
  await other.close();
  await page.close();
});

test("the relay treats the page as a tab: it answers the page's state query on load", async () => {
  const page = await openNewTab();
  const id = await tabIdOf();
  // As if the user switched to this tab and the offscreen document then
  // reported "speaking".
  await ext.worker.evaluate(async (tabId) => {
    const { voice } = globalThis.clearcart;
    await voice.onTabActivated({ tabId });
    voice.onMessage({ type: "voice.state", state: "speaking", from: "offscreen" }, {});
  }, id);
  await page.waitForFunction(() => document.getElementById("orb")?.dataset.state === "speaking");
  // A fresh load asks for the state (sender.tab is this tab) and gets it.
  await page.reload();
  await page.waitForFunction(() => document.getElementById("orb")?.dataset.state === "speaking");
  await ext.worker.evaluate(() => globalThis.clearcart.voice.onMessage({ type: "voice.state", state: "idle", from: "offscreen" }, {}));
  await page.close();
});

test("Space talks on the page and types a space in the search box", async () => {
  const page = await openNewTab();
  // Record what the page sends the worker.
  await page.evaluate(() => {
    window.__sent = [];
    chrome.runtime.sendMessage = (m) => { window.__sent.push(m.type); return Promise.resolve(); };
  });
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.down("Space");
  await page.waitForTimeout(300);
  await page.keyboard.up("Space");
  assert.deepEqual(await page.evaluate(() => window.__sent), ["ptt.start", "ptt.confirm", "ptt.stop"]);
  await page.evaluate(() => { window.__sent = []; });
  await page.getByLabel("Search the web").click();
  await page.keyboard.type("blue mug");
  assert.equal(await page.getByLabel("Search the web").inputValue(), "blue mug");
  assert.deepEqual(await page.evaluate(() => window.__sent), []);
  await page.close();
});

test("with the setting off, a new tab goes on to Chrome's own new tab page", async () => {
  await ext.worker.evaluate(() => chrome.storage.local.set({ newTabPage: false }));
  const page = await ext.context.newPage();
  await page.goto("chrome://newtab/");
  await page.waitForURL("chrome://new-tab-page/", { timeout: 5000 });
  // Back from there lands on a button, not another forward.
  await page.goBack();
  await page.getByRole("button", { name: "Open Chrome's new tab page" }).waitFor();
  assert.equal(page.url(), NEWTAB);
  await page.close();
  await ext.worker.evaluate(() => chrome.storage.local.set({ newTabPage: true }));
});
