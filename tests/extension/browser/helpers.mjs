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

export async function launchWithExtension({ headless = !process.env.HEADED } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearcart-ext-test-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // The "chromium" channel runs new headless mode, which supports extensions.
    channel: "chromium",
    headless,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const close = async () => {
    await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { context, worker, close };
}
