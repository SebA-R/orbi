// Open web browsing on the agent side: the built-in blocklist (blocklist.ts,
// kept identical to the extension's) and the browse mode policy
// (origins.ts siteBlockReason).
import assert from "node:assert/strict";
import { test } from "node:test";

import * as agentList from "../blocklist.ts";
import { builtinBlockReason } from "../blocklist.ts";
import { siteBlockReason, type SitePolicy } from "../origins.ts";
// @ts-ignore: plain JS module from the extension
import * as extList from "../../extension/lib/blocklist.js";

const STORE = "http://localhost:4000";
const open = (o: Partial<SitePolicy> = {}): SitePolicy => ({ mode: "open", allowed: new Set([STORE]), blocked: new Set(), ...o });

test("the agent and extension blocklists are the same lists", () => {
  assert.deepEqual(agentList.BLOCKED_DOMAINS, extList.BLOCKED_DOMAINS);
  assert.deepEqual(agentList.BLOCKED_KEYWORDS, extList.BLOCKED_KEYWORDS);
  assert.deepEqual(agentList.BLOCKED_LABELS, extList.BLOCKED_LABELS);
  assert.equal(String(agentList.AMAZON_ACCOUNT_PATH), String(extList.AMAZON_ACCOUNT_PATH));
  for (const u of ["https://www.etsy.com/", "https://mail.google.com/", "http://localhost:5050/", "https://www.amazon.com/ap/signin", "https://x.gov.bc.ca/", "chrome://settings"]) {
    assert.equal(agentList.builtinBlockReason(u, new Set([STORE])), extList.builtinBlockReason(u, new Set([STORE])), u);
  }
});

test("built-in list: stores pass, sensitive and non-web pages do not", () => {
  for (const u of ["https://www.etsy.com/search?q=mug", "https://www.aritzia.com/us/en", "https://www.nordstrom.com/", "https://www.amazon.com/dp/B0"]) {
    assert.equal(builtinBlockReason(u), null, u);
  }
  for (const u of [
    "https://mail.google.com/", "https://outlook.office.com/mail", "https://vault.bitwarden.com/", "https://www.lastpass.com/",
    "https://www.bankofamerica.com/", "https://www.scotiabank.com/", "https://www.kraken.com/", "https://smalltownbank.example/",
    "https://www.irs.gov/", "https://www.canada.ca/", "https://mychart.hospital.example/", "https://accounts.google.com/",
    "https://appleid.apple.com/", "https://account.microsoft.com/", "https://www.amazon.com/ap/signin",
    "chrome://settings", "about:blank", "file:///etc/passwd", "data:text/html,x", "javascript:alert(1)", "devtools://devtools",
    "chrome-extension://abc/x.html", "http://localhost:5050/", "http://127.0.0.1:4001/", "http://192.168.0.1/",
  ]) {
    assert.ok(builtinBlockReason(u, new Set([STORE])), u);
  }
});

test("open mode: any store, the listed store, not localhost or the agent console", () => {
  const p = open();
  assert.equal(siteBlockReason("https://www.etsy.com/listing/1", p), null);
  assert.equal(siteBlockReason(`${STORE}/cart`, p), null);
  assert.match(siteBlockReason("http://localhost:5050/", p) || "", /local address/);
  assert.match(siteBlockReason("http://localhost:4000@mail.google.com/", p) || "", /email|login/);
  assert.match(siteBlockReason("https://mail.google.com/", p) || "", /email/);
});

test("open mode: CLEARCART_BLOCKED_ORIGINS entries win, even over the allowlist", () => {
  const p = open({ blocked: new Set(["https://www.etsy.com", STORE]) });
  assert.equal(siteBlockReason("https://www.etsy.com/x", p), "on the blocklist");
  assert.equal(siteBlockReason(`${STORE}/`, p), "on the blocklist");
  assert.equal(siteBlockReason("https://etsy.com/x", p), null, "exact origins");
});

test("open mode: an allowlisted origin passes the built-in list", () => {
  assert.equal(siteBlockReason("https://www.paypal.com/", open({ allowed: new Set([STORE, "https://www.paypal.com"]) })), null);
});

test("allowlist mode keeps the old origin check", () => {
  const p: SitePolicy = { mode: "allowlist", allowed: new Set([STORE, "https://www.aritzia.com"]), blocked: new Set() };
  assert.equal(siteBlockReason(`${STORE}/x`, p), null);
  assert.equal(siteBlockReason("https://www.aritzia.com/us", p), null);
  assert.equal(siteBlockReason("https://www.etsy.com/", p), "not on the allowlist");
  assert.equal(siteBlockReason("http://localhost:4000@evil.example/", p), "not on the allowlist");
});
