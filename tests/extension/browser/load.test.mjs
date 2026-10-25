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

test("the unpacked extension loads with its pinned ID and starts its worker", async () => {
  assert.equal(new URL(ext.worker.url()).host, EXT_ID);
  const manifest = await ext.worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Clearcart");
});
