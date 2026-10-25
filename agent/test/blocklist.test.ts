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

test("local addresses in every spelling are blocked, the store still passes", () => {
  const local = new Set([STORE]);
  for (const u of [
    "http://[::ffff:127.0.0.1]:5050/cartesia-token", "http://[::ffff:192.168.1.1]/", "http://[::7f00:1]:5050/", "http://[fec0::]/",
    "http://[::1]:5050/", "http://[::]/", "http://[fe80::1]/", "http://[fd00::1]/", "http://[64:ff9b::7f00:1]/", "http://[2002:c0a8:101::]/",
    "http://localtest.me:5050/cartesia-token", "http://127.0.0.1.nip.io:5050/", "http://app.lvh.me/", "http://10-0-0-1.sslip.io/",
    "http://2130706433:5050/", "http://0x7f.1:5050/", "http://0/", "http://100.64.0.1/", "http://router/", "http://printer.local/",
    "http://nas.home.arpa/", "http://x.localhost/", "http://172.20.0.1/", "http://169.254.169.254/latest/meta-data",
  ]) {
    assert.match(agentList.builtinBlockReason(u, local) || "", /local address/, u);
    assert.equal(agentList.builtinBlockReason(u, local), extList.builtinBlockReason(u, local), u);
  }
  assert.equal(builtinBlockReason(`${STORE}/cart`, local), null);
  for (const u of ["http://[2606:4700::1111]/", "http://8.8.8.8/", "http://[::ffff:8.8.8.8]/", "https://www.etsy.com/"]) {
    assert.equal(builtinBlockReason(u, local), null, u);
  }
});

test("isLocalIp: the address Chrome actually connected to", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "10.1.2.3", "192.168.0.10", "fe80::1", "fec0::1", "fc00::", "0.0.0.0", "", "garbage"]) {
    assert.equal(agentList.isLocalIp(ip), true, ip);
    assert.equal(extList.isLocalIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "2606:4700::1111", "::ffff:1.1.1.1", "151.101.1.69"]) {
    assert.equal(agentList.isLocalIp(ip), false, ip);
    assert.equal(extList.isLocalIp(ip), false, ip);
  }
  assert.deepEqual(agentList.LOCAL_DNS, extList.LOCAL_DNS);
});
