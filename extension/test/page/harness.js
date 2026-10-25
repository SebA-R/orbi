// Test harness: loads mask.js then page.js into a jsdom window in the same
// order the worker injects them, with a fake chrome.runtime.onMessage.
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const MASK_SRC = readFileSync(here("../../content/mask.js"), "utf8");
const PAGE_PATH = here("../../content/page.js");

export function loadPage(html, { url = "http://localhost:4000/", page = true } = {}) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const listeners = [];
  window.chrome = { runtime: { id: "test", onMessage: { addListener: (fn) => listeners.push(fn) } } };
  window.eval(MASK_SRC);
  if (page && existsSync(PAGE_PATH)) window.eval(readFileSync(PAGE_PATH, "utf8"));
  // Sends a runtime message the way chrome.tabs.sendMessage would.
  const send = (msg) =>
    new Promise((resolve) => {
      let async = false;
      for (const fn of listeners) {
        if (fn(msg, { id: "test" }, resolve) === true) async = true;
      }
      if (!async) resolve(undefined);
    });
  const call = (method, params = {}) => send({ type: "page.call", method, params });
  return { dom, window, document: window.document, listeners, send, call };
}

// Starts the demo store on a free-ish port and returns { base, stop }.
export async function startStore(port = 4200 + Math.floor(Math.random() * 600)) {
  const proc = spawn(process.execPath, [here("../../../store/server.js")], {
    env: { ...process.env, STORE_PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (b) => String(b).includes("demo store") && resolve());
    proc.on("exit", (c) => reject(new Error("store exited " + c)));
  });
  const base = `http://localhost:${port}`;
  return { base, stop: () => proc.kill() };
}

export async function fetchHtml(url, init) {
  const r = await fetch(url, init);
  return r.text();
}
