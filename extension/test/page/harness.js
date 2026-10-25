// Test harness: loads mask.js, protect.js, then page.js into a jsdom window in the same
// order the worker injects them, with a fake chrome.runtime.onMessage.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const MASK_SRC = readFileSync(here("../../content/mask.js"), "utf8");
const PROTECT_SRC = readFileSync(here("../../content/protect.js"), "utf8");
const PAGE_PATH = here("../../content/page.js");

export function loadPage(html, { url = "https://shop.example/", page = true } = {}) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const listeners = [];
  window.chrome = { runtime: { id: "test", onMessage: { addListener: (fn) => listeners.push(fn) } } };
  window.eval(MASK_SRC);
  window.eval(PROTECT_SRC);
  // Same order as the worker: mask.js, protect.js, then page.js. Re-callable to test idempotence.
  const inject = () => {
    window.eval(MASK_SRC);
    window.eval(PROTECT_SRC);
    window.eval(readFileSync(PAGE_PATH, "utf8"));
  };
  if (page && existsSync(PAGE_PATH)) window.eval(readFileSync(PAGE_PATH, "utf8"));
  // Sends a runtime message the way chrome.tabs.sendMessage would.
  const send = (msg) =>
    new Promise((resolve) => {
      let async = false;
      for (const fn of listeners) {
        // JSON round-trip: chrome messaging serializes, and it drops the jsdom realm.
        const reply = (r) => resolve(r === undefined ? r : JSON.parse(JSON.stringify(r)));
        if (fn(msg, { id: "test" }, reply) === true) async = true;
      }
      if (!async) resolve(undefined);
    });
  const call = (method, params = {}) => send({ type: "page.call", method, params });
  return { inject, dom, window, document: window.document, listeners, send, call };
}

// The small test shop (tests/fixtures/shop.mjs): its pages as HTML, and a
// local server for tests that need real navigation.
export { pages as shopPages, startShop } from "../../../tests/fixtures/shop.mjs";

export async function fetchHtml(url, init) {
  const r = await fetch(url, init);
  return r.text();
}
