// Shared helpers for browser tests: an isolated Chromium (never the user's
// Chrome) with the unpacked extension loaded from extension/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..", "..");
export const EXT_DIR = path.join(REPO, "extension");
export const EXT_ID = "dhgknfenfoidnchmjfaicafhieepefoc";

// Nothing listens here: the extension's bridge must never reach a real
// agent server on :5050, which would drive the test browser.
export const DEAD_AGENT_URL = "ws://127.0.0.1:9";

// A copy of extension/ whose default agent server is DEAD_AGENT_URL. Same
// extension id (the manifest key).
function isolatedCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-ext-copy-"));
  fs.cpSync(EXT_DIR, dir, { recursive: true, filter: (p) => !p.split(path.sep).includes("test") && !p.includes("node_modules") });
  const file = path.join(dir, "lib", "settings.js");
  const src = fs.readFileSync(file, "utf8");
  const patched = src.replace('agentUrl: "ws://localhost:5050"', `agentUrl: "${DEAD_AGENT_URL}"`);
  if (patched === src) throw new Error("settings default agentUrl not found");
  fs.writeFileSync(file, patched);
  return dir;
}

export async function launchWithExtension({ headless = !process.env.HEADED } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-ext-test-"));
  const extDir = isolatedCopy();
  const context = await chromium.launchPersistentContext(userDataDir, {
    // The "chromium" channel runs new headless mode, which supports extensions.
    channel: "chromium",
    headless,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const close = async () => {
    await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  };
  return { context, worker, close };
}
