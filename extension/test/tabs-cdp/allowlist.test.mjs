import { test } from "node:test";
import assert from "node:assert/strict";

import { installChrome } from "./chrome-mock.mjs";
import { allowedOrigins, assertAllowed, blockReason, frameAllowed, isAllowed } from "../../background/allowlist.js";
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

test("a payment provider's frame needs only the fixed rules; local frames only when allowed", async () => {
  // js.stripe.com is on the suggested blocked list, but a card frame inside
  // an allowed checkout page is still filled.
  installChrome();
  assert.equal(await isAllowed("https://js.stripe.com/v3/elements-inner-card.html"), false);
  assert.equal(await frameAllowed("https://js.stripe.com/v3/elements-inner-card.html"), true);
  assert.equal(await frameAllowed("https://checkoutshopper-live.adyen.com/securedfields/x.html"), true);
  for (const url of ["http://127.0.0.1:4101/card-frame", `${LOCAL}/card`, "https://user:pw@pay.example/", "about:blank", "data:text/html,x", "chrome-extension://abc/x.html"]) {
    assert.equal(await frameAllowed(url), false, url);
  }
  installChrome({ local: { browseMode: "allowlist", allowlist: [LOCAL, "http://127.0.0.1:4101"] } });
  assert.equal(await frameAllowed("http://127.0.0.1:4101/card-frame"), true);
  assert.equal(await frameAllowed("https://js.stripe.com/v3/"), true, "the browse mode does not narrow frames");
});
