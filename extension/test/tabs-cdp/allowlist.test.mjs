import { test } from "node:test";
import assert from "node:assert/strict";

import { installChrome } from "./chrome-mock.mjs";
import { allowedOrigins, assertAllowed, isAllowed } from "../../background/allowlist.js";
import { ERR } from "../../lib/protocol.js";

test("defaults to the local store origin", async () => {
  installChrome();
  assert.deepEqual(await allowedOrigins(), ["http://localhost:4000"]);
});

test("reads the allowlist from settings", async () => {
  installChrome({ local: { allowlist: ["https://shop.example", "http://localhost:4100/x"] } });
  assert.deepEqual(await allowedOrigins(), ["https://shop.example", "http://localhost:4100"]);
});

test("assertAllowed passes for an allowlisted origin, any path", async () => {
  installChrome();
  await assertAllowed("http://localhost:4000/checkout?x=1#top");
  assert.equal(await isAllowed("http://localhost:4000"), true);
});

for (const url of [
  "http://localhost:4001/",
  "https://localhost:4000/",
  "http://localhost:4000.evil.com/",
  "http://user:pw@localhost:4000/",
  "javascript:alert(1)",
  "file:///etc/passwd",
  "chrome://settings",
  "not a url",
  "",
  undefined,
]) {
  test(`assertAllowed rejects ${JSON.stringify(url)}`, async () => {
    installChrome();
    await assert.rejects(assertAllowed(url), (e) => e.code === ERR.NOT_ALLOWED);
  });
}
