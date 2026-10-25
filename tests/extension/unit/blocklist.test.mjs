// Open web blocklist (extension/lib/blocklist.js): sensitive sites and
// non-web pages are blocked, ordinary stores are not.
import { test } from "node:test";
import assert from "node:assert/strict";

import { BLOCKED_DOMAINS, builtinBlockReason } from "../../../extension/lib/blocklist.js";

const STORE = "http://localhost:4000";

test("ordinary stores pass", () => {
  for (const u of [
    "https://www.etsy.com/search?q=mug",
    "https://www.aritzia.com/us/en/clothing",
    "https://www.nordstrom.com/s/123",
    "https://www.amazon.com/dp/B000",
    "https://www.amazon.ca/s?k=tea",
    "https://www.bestbuy.ca/en-ca",
    "https://www.google.com/search?q=shoes",
    "http://shop.example/",
  ]) assert.equal(builtinBlockReason(u), null, u);
});

test("non-web schemes are blocked", () => {
  for (const u of [
    "chrome://settings", "chrome-extension://abc/options.html", "devtools://devtools/x", "about:blank", "file:///etc/passwd",
    "data:text/html,hi", "javascript:alert(1)", "blob:https://x.example/1", "view-source:https://x.example", "ftp://x.example",
    "not a url", "", undefined,
  ]) assert.ok(builtinBlockReason(u), String(u));
});

test("localhost and private network addresses are blocked unless listed", () => {
  for (const u of ["http://localhost:5050/", "http://localhost:4001/", "http://127.0.0.1:4000/", "http://[::1]:4000/", "http://app.localhost/", "http://192.168.1.1/", "http://10.0.0.5/", "http://172.16.0.1/", "http://169.254.169.254/"]) {
    assert.match(builtinBlockReason(u, new Set([STORE])), /local address/, u);
  }
  assert.equal(builtinBlockReason(`${STORE}/cart`, new Set([STORE])), null);
  assert.equal(builtinBlockReason("http://172.32.0.1/"), null, "not a private range");
});

test("sensitive categories are blocked, with subdomains", () => {
  const cases = {
    "https://mail.google.com/mail/u/0": /email/,
    "https://outlook.live.com/mail": /email/,
    "https://mail.yahoo.com/": /email/,
    "https://account.proton.me/": /email/,
    "https://vault.bitwarden.com/": /password/,
    "https://my.1password.com/": /password/,
    "https://lastpass.com/": /password/,
    "https://www.dashlane.com/": /password/,
    "https://secure.chase.com/": /bank/,
    "https://www.rbcroyalbank.com/": /bank/,
    "https://www.td.com/ca/en": /bank/,
    "https://www.coinbase.com/": /bank/,
    "https://www.paypal.com/": /bank/,
    "https://firstcommunitybank.example/": /bank/,
    "https://www.ufcu-creditunion.org/": /bank/,
    "https://www.irs.gov/": /government/,
    "https://www.canada.ca/en/revenue-agency.html": /government/,
    "https://www.gov.uk/": /government/,
    "https://www2.gov.bc.ca/": /government/,
    "https://turbotax.intuit.com/": /government/,
    "https://mychart.examplehealth.org/": /health/,
    "https://healthy.kp.org/": /health/,
    "https://accounts.google.com/signin": /account/,
    "https://myaccount.google.com/": /account/,
    "https://appleid.apple.com/": /account/,
    "https://account.microsoft.com/": /account/,
    "https://www.amazon.com/ap/signin?x=1": /account/,
    "https://www.amazon.ca/gp/css/homepage.html": /account/,
    "https://www.amazon.com/a/addresses": /account/,
  };
  for (const [u, re] of Object.entries(cases)) assert.match(builtinBlockReason(u) || "", re, u);
});

test("lookalike hosts are judged by the parsed hostname", () => {
  assert.equal(builtinBlockReason("https://notgmail.com/"), null);
  assert.ok(builtinBlockReason("https://www.etsy.com@mail.google.com/"), "a login in the address is refused");
  assert.match(builtinBlockReason("https://MAIL.GOOGLE.COM./") || "", /email/);
});

test("every list entry is a bare lowercase hostname", () => {
  for (const [kind, list] of Object.entries(BLOCKED_DOMAINS)) {
    for (const d of list) assert.match(d, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${kind}: ${d}`);
  }
});

test("IPv4-mapped, compatible and site-local IPv6 and loopback DNS names are local", () => {
  for (const u of [
    "http://[::ffff:127.0.0.1]:5050/", "http://[::ffff:192.168.1.1]/", "http://[::7f00:1]/", "http://[fec0::]/",
    "http://localtest.me:5050/cartesia-token", "http://127.0.0.1.nip.io:5050/",
  ]) assert.match(builtinBlockReason(u, new Set([STORE])) || "", /local address/, u);
  assert.equal(builtinBlockReason(`${STORE}/`, new Set([STORE])), null);
});
