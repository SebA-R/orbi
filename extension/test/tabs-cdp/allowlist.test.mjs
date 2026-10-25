import { test } from "node:test";
import assert from "node:assert/strict";

import { installChrome } from "./chrome-mock.mjs";
import { allowedOrigins, assertAllowed, blockReason, isAllowed, isPaySite } from "../../background/allowlist.js";
import { normalize } from "../../lib/settings.js";
import { ERR } from "../../lib/protocol.js";

// A local test page the user allowed (local addresses open only when listed).
const LOCAL = "http://localhost:4100";

test("no allowed sites by default", async () => {
  installChrome();
  assert.deepEqual(await allowedOrigins(), []);
});

test("reads the allowlist from settings", async () => {
  installChrome({ local: { allowlist: ["https://shop.example", "http://localhost:4100/x"] } });
  assert.deepEqual(await allowedOrigins(), ["https://shop.example", "http://localhost:4100"]);
});

test("assertAllowed passes for an allowlisted origin, any path", async () => {
  installChrome({ local: { allowlist: [LOCAL] } });
  await assertAllowed(`${LOCAL}/checkout?x=1#top`);
  assert.equal(await isAllowed(LOCAL), true);
});

// Allowlist mode keeps the old behavior; the open mode cases below.
for (const url of [
  "https://www.etsy.com/",
  "http://localhost:4101/",
  "https://localhost:4100/",
  "http://localhost:4100.evil.com/",
  "http://user:pw@localhost:4100/",
  "javascript:alert(1)",
  "file:///etc/passwd",
  "chrome://settings",
  "not a url",
  "",
  undefined,
]) {
  test(`assertAllowed rejects ${JSON.stringify(url)}`, async () => {
    installChrome({ local: { browseMode: "allowlist", allowlist: [LOCAL] } });
    await assert.rejects(assertAllowed(url), (e) => e.code === ERR.NOT_ALLOWED);
  });
}

test("open mode is the default and allows ordinary sites; a local page only once it is allowed", async () => {
  installChrome();
  assert.equal(await isAllowed("https://www.etsy.com/listing/1"), true);
  assert.equal(await isAllowed(`${LOCAL}/cart`), false);
  installChrome({ local: { allowlist: [LOCAL] } });
  assert.equal(await isAllowed(`${LOCAL}/cart`), true);
});

for (const url of [
  "http://localhost:4101/",
  "http://localhost:5050/",
  "https://localhost:4100/",
  "http://localhost:4100.evil.com/",
  "http://user:pw@localhost:4100/",
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
    installChrome({ local: { allowlist: [LOCAL] } });
    await assert.rejects(assertAllowed(url), (e) => e.code === ERR.NOT_ALLOWED);
  });
}

test("blockReason: the user's blocked sites beat the allowlist; the allowlist only gets past the localhost rule", () => {
  const s = normalize({ allowlist: [LOCAL, "https://www.paypal.com"], blocklist: ["etsy.com", "paypal.com"] });
  assert.match(blockReason("https://www.etsy.com/", s), /blocked sites list: etsy\.com/);
  assert.match(blockReason("https://www.paypal.com/", s), /paypal/);
  assert.equal(blockReason(`${LOCAL}/`, s), null);
  assert.equal(blockReason("https://mail.google.com/", s), null, "only what the user lists");
  assert.match(blockReason("http://localhost:5050/", { ...s, blocklist: [] }), /local address/, "fixed rules with an empty list");
  assert.equal(blockReason("https://www.etsy.com/", { ...s, browseMode: "allowlist" }), "not on the allowlist");
});

test("open mode with no saved list uses the suggested one", async () => {
  installChrome();
  await assert.rejects(assertAllowed("https://mail.google.com/"), (e) => e.code === ERR.NOT_ALLOWED && /blocked sites list/.test(e.message));
  assert.equal(await isAllowed("https://www.etsy.com/"), true);
});

test("isPaySite is the allowlist in both modes, empty by default", async () => {
  installChrome();
  assert.equal(await isPaySite(`${LOCAL}/checkout`), false);
  installChrome({ local: { allowlist: [LOCAL] } });
  assert.equal(await isPaySite(`${LOCAL}/checkout`), true);
  assert.equal(await isPaySite("https://www.etsy.com/checkout"), false);
  installChrome({ local: { browseMode: "allowlist", allowlist: ["https://shop.example"] } });
  assert.equal(await isPaySite("https://shop.example/pay"), true);
  assert.equal(await isPaySite(`${LOCAL}/checkout`), false);
});
