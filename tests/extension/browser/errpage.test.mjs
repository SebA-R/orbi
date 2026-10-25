// Network error pages: Chrome's own runs no content scripts, so a failed
// main frame goes on to Clearcart's "Can't reach this site" page, where the
// hotkey and the orb face run. Back keeps working; Retry comes back here.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { EXT_ID, launchWithExtension } from "./helpers.mjs";

let ext;
before(async () => {
  ext = await launchWithExtension();
  // A failure while the new install is still starting is missed (Chrome
  // has not wired the worker's listeners yet): wait for its setup tab.
  await ext.worker.evaluate(async () => {
    const setup = chrome.runtime.getURL("setup/setup.html");
    for (let i = 0; i < 100; i++) {
      const t = (await chrome.tabs.query({})).find((x) => x.url === setup && x.status === "complete");
      if (t && globalThis.clearcart) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
});
after(async () => {
  await ext?.close();
});

const BASE = `chrome-extension://${EXT_ID}/newtab/error.html`;
const BAD = "http://nowhere.clearcart-errpage.test/shop";

// Until the page is a ready Clearcart error page other than `not`.
async function onErrorPage(page, not = null) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const u = page.url();
    if (u.startsWith(BASE) && u !== not) {
      const ready = await page.evaluate(() => document.documentElement.dataset.ready === "true").catch(() => false);
      if (ready) return u;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`not on the error page: ${page.url()}`);
}

async function failTo(page, url) {
  await page.goto(url).catch(() => {});
  return onErrorPage(page);
}

test("an unreachable address opens Clearcart's page with the hotkey, Retry and the address", async () => {
  const page = await ext.context.newPage();
  await page.goto("data:text/html,<title>start</title>start");
  await failTo(page, BAD);
  assert.ok(!page.url().includes("nowhere"), page.url());
  assert.equal(await page.title(), "Can't reach this site");
  assert.equal(await page.evaluate(() => !!window.__clearcartHotkey && !!document.querySelector("#orb > .ccf")), true);
  assert.equal(await page.getByRole("heading", { level: 1, name: "Can't reach this site" }).count(), 1);
  assert.equal(await page.getByRole("heading", { level: 2, name: "Hold Space to talk" }).count(), 1);
  assert.equal(await page.locator("#failed-url").textContent(), BAD);
  assert.equal(await page.locator("#failed-code").textContent(), "ERR_NAME_NOT_RESOLVED");

  // Space talks here.
  await page.evaluate(() => {
    window.__sent = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m) => (m.type.startsWith("ptt.") ? (window.__sent.push(m.type), Promise.resolve()) : send(m));
  });
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.down("Space");
  await page.waitForTimeout(300);
  await page.keyboard.up("Space");
  assert.deepEqual(await page.evaluate(() => window.__sent), ["ptt.start", "ptt.confirm", "ptt.stop"]);

  // The agent sees it as an error page it may navigate, not the address.
  const ctx = await ext.worker.evaluate(() => globalThis.clearcart.router.route("tabs_context", {}));
  const row = ctx.tabs.find((t) => t.url === "chrome-error://chromewebdata/");
  assert.ok(row, JSON.stringify(ctx));
  assert.ok(!JSON.stringify(ctx).includes("nowhere"));

  // Back loads the failed address again; Chrome's page stays, and Back
  // after it reaches the start page.
  await page.goBack().catch(() => {});
  await page.waitForTimeout(1000);
  assert.ok(!page.url().startsWith(BASE), page.url());
  await page.goBack().catch(() => {});
  await page.waitForTimeout(500);
  assert.equal(await page.title(), "start");

  // Forward fails again and comes to Clearcart's page; Retry from there
  // fails again and comes back, as a new page.
  await page.goForward().catch(() => {});
  const first = await onErrorPage(page);
  await page.getByRole("button", { name: "Retry" }).click();
  await onErrorPage(page, first);
  // Retry went Back to the failed entry, so it added none: two Backs still
  // reach the start page.
  await page.goBack().catch(() => {});
  await page.waitForTimeout(1000);
  await page.goBack().catch(() => {});
  await page.waitForTimeout(500);
  assert.equal(await page.title(), "start");
  await page.close();
});

test("with the setting off, Chrome's own error page stays", async () => {
  await ext.worker.evaluate(() => chrome.storage.local.set({ errorPages: false }));
  const page = await ext.context.newPage();
  await page.goto("http://nowhere-else.clearcart-errpage.test/").catch(() => {});
  await page.waitForTimeout(1000);
  assert.equal(page.url(), "chrome-error://chromewebdata/");
  await page.close();
  await ext.worker.evaluate(() => chrome.storage.local.set({ errorPages: true }));
});
