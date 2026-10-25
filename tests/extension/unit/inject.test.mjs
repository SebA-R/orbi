import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { canInject, injectIntoOpenTabs } from "../../../extension/lib/inject.js";

test("injects both content scripts into open web tabs and skips the rest quietly", async () => {
  const calls = [];
  const chromeApi = {
    tabs: {
      query: async (q) => {
        assert.deepEqual(q.url, ["http://*/*", "https://*/*"]);
        return [
          { id: 1, url: "https://github.com/SebA-R/clearcart" },
          { id: 2, url: "chrome://extensions/" },
          { id: 3, url: "https://chromewebstore.google.com/detail/x" },
          { id: 4, url: "http://example.com/" },
          { id: 5, url: "https://blocked.example/" },
        ];
      },
    },
    scripting: {
      executeScript: async (o) => {
        if (o.target.tabId === 5) throw new Error("Cannot access contents of the page");
        calls.push(o);
      },
    },
  };
  const done = await injectIntoOpenTabs(chromeApi);
  assert.deepEqual(done.sort(), [1, 4]);
  assert.deepEqual(calls.filter((c) => c.target.tabId === 1), [
    { target: { tabId: 1, allFrames: true }, files: ["content/hotkey.js"] },
    { target: { tabId: 1, allFrames: false }, files: ["content/orb-face.js", "content/subtitles.js"] },
    { target: { tabId: 1, allFrames: false }, files: ["content/frame.js"] },
    { target: { tabId: 1, allFrames: false }, files: ["content/context.js"] },
  ]);
  assert.equal(calls.some((c) => [2, 3].includes(c.target.tabId)), false);
  assert.equal(canInject("https://chrome.google.com/webstore/detail/x"), false);
  assert.deepEqual(await injectIntoOpenTabs({ tabs: { query: async () => { throw new Error("x"); } }, scripting: { executeScript: async () => {} } }), []);
});

test("worker injects on install, update, reload and new site access; scripts guard double runs", async () => {
  const src = (p) => readFile(new URL(`../../../extension/${p}`, import.meta.url), "utf8");
  const worker = await src("background/worker.js");
  assert.match(worker, /onInstalled\.addListener\([\s\S]*?injectIntoOpenTabs\(\)[\s\S]*?\}\);/);
  assert.match(worker, /permissions\.onAdded\.addListener\(\(\) => \{[\s\S]*?injectIntoOpenTabs\(\)/);
  assert.match(await src("content/hotkey.js"), /if \(!win \|\| win\.__clearcartHotkey\) return/);
  assert.match(await src("content/orb-face.js"), /if \(globalThis\.__clearcartOrbFace\) return/);
  assert.match(await src("content/subtitles.js"), /if \(globalThis\[FLAG\]\) return/);
  assert.match(await src("content/frame.js"), /if \(globalThis\[FLAG\]\) return/);
  assert.match(await src("content/context.js"), /if \(globalThis\.__clearcartContext\) return/);
});
