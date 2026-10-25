import { test } from "node:test";
import assert from "node:assert/strict";

import { installChrome } from "./chrome-mock.mjs";
import { allowedOrigins, assertAllowed, blockReason, isAllowed, isPaySite } from "../../background/allowlist.js";
import { normalize } from "../../lib/settings.js";
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

// Allowlist mode keeps the old behavior; the open mode cases below.
for (const url of [
  "https://www.etsy.com/",
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
    installChrome({ local: { browseMode: "allowlist" } });
    await assert.rejects(assertAllowed(url), (e) => e.code === ERR.NOT_ALLOWED);
  });
}

test("open mode is the default and allows ordinary sites", async () => {
  installChrome();
  assert.equal(await isAllowed("https://www.etsy.com/listing/1"), true);
  assert.equal(await isAllowed("http://localhost:4000/cart"), true);
});

for (const url of [
  "http://localhost:4001/",
  "http://localhost:5050/",
  "https://localhost:4000/",
  "http://localhost:4000.evil.com/",
  "http://user:pw@localhost:4000/",
  "https://mail.google.com/",
  "https://vault.bitwarden.com/",
  "https://www.rbcroyalbank.com/",
  "javascript:alert(1)",
  "file:///etc/passwd",
  "chrome://settings",
  "chrome-extension://abc/options/options.html",
  "about:blank",
  "not a url",
  "",
  undefined,
]) {
  test(`open mode rejects ${JSON.stringify(url)}`, async () => {
    installChrome();
    await assert.rejects(assertAllowed(url), (e) => e.code === ERR.NOT_ALLOWED);
  });
}

test("blockReason: the user blocklist beats the allowlist; allowlist beats the built-in list", () => {
  const s = normalize({ allowlist: ["http://localhost:4000", "https://www.paypal.com"], blocklist: ["https://www.etsy.com", "http://localhost:4000"] });
  assert.match(blockReason("https://www.etsy.com/", s), /your blocklist/);
  assert.match(blockReason("http://localhost:4000/", s), /your blocklist/);
  assert.equal(blockReason("https://www.paypal.com/", s), null);
  assert.equal(blockReason("https://www.etsy.com/", { ...s, browseMode: "allowlist" }), "not on the allowlist");
});

test("isPaySite is the allowlist in both modes", async () => {
  installChrome();
  assert.equal(await isPaySite("http://localhost:4000/checkout"), true);
  assert.equal(await isPaySite("https://www.etsy.com/checkout"), false);
  installChrome({ local: { browseMode: "allowlist", allowlist: ["https://shop.example"] } });
  assert.equal(await isPaySite("https://shop.example/pay"), true);
  assert.equal(await isPaySite("http://localhost:4000/checkout"), false);
});
