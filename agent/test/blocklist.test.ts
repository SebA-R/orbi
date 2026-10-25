// Open web browsing on the agent side: the shared blocked sites check
// (blocklist.ts over extension/lib/blocklist.js) and the browse mode policy
// (origins.ts siteBlockReason).
import assert from "node:assert/strict";
import { test } from "node:test";

import { blocklistReason, isLocalIp, LOCAL_DNS, parseBlockLines, SUGGESTED_BLOCKLIST, SUGGESTED_ENTRIES } from "../blocklist.ts";
import { SITE_POLICY, siteBlockReason, type SitePolicy } from "../origins.ts";
// @ts-ignore: plain JS module from the extension
import * as extList from "../../extension/lib/blocklist.js";
// @ts-ignore: plain JS module from the extension
import { DEFAULTS } from "../../extension/lib/settings.js";

const STORE = "http://localhost:4000";
const open = (o: Partial<SitePolicy> = {}): SitePolicy => ({ mode: "open", allowed: new Set([STORE]), blocked: new Set(), entries: SUGGESTED_ENTRIES, ...o });

test("the agent uses the extension's code and suggested list, and the extension seeds the same list", () => {
  assert.equal(blocklistReason, extList.blocklistReason);
  assert.equal(SUGGESTED_BLOCKLIST, extList.SUGGESTED_BLOCKLIST);
  assert.deepEqual([...DEFAULTS.blocklist], [...SUGGESTED_BLOCKLIST]);
  assert.equal(SITE_POLICY.entries, SUGGESTED_ENTRIES, "the OCIC path falls back to the suggested list");
});

test("suggested list: stores pass, the old built-in categories do not", () => {
  for (const u of ["https://www.etsy.com/search?q=mug", "https://www.aritzia.com/us/en", "https://www.nordstrom.com/", "https://www.amazon.com/dp/B0"]) {
    assert.equal(siteBlockReason(u, open()), null, u);
  }
  for (const u of [
    "https://mail.google.com/", "https://outlook.office.com/mail", "https://vault.bitwarden.com/", "https://www.lastpass.com/",
    "https://www.bankofamerica.com/", "https://www.scotiabank.com/", "https://www.kraken.com/", "https://smalltownbank.example/",
    "https://www.irs.gov/", "https://www.canada.ca/", "https://www2.gov.bc.ca/", "https://mychart.hospital.example/",
    "https://accounts.google.com/", "https://appleid.apple.com/", "https://account.microsoft.com/", "https://www.amazon.com/ap/signin",
  ]) {
    assert.match(siteBlockReason(u, open()) || "", /blocked sites list/, u);
  }
});

test("fixed rules hold with an empty list", () => {
  const p = open({ entries: [] });
  assert.equal(siteBlockReason("https://mail.google.com/", p), null, "the list is user data");
  for (const u of ["chrome://settings", "about:blank", "file:///etc/passwd", "data:text/html,x", "javascript:alert(1)", "http://localhost:5050/", "http://127.0.0.1:4001/", "http://192.168.0.1/"]) {
    assert.ok(siteBlockReason(u, p), u);
  }
  assert.match(siteBlockReason("http://localhost:4000@mail.google.com/", p) || "", /login/);
  assert.equal(siteBlockReason(`${STORE}/cart`, p), null);
});

test("open mode: CLEARCART_BLOCKED_ORIGINS entries win, even over the allowlist", () => {
  const p = open({ blocked: new Set(["https://www.etsy.com", STORE]) });
  assert.equal(siteBlockReason("https://www.etsy.com/x", p), "on the blocklist");
  assert.equal(siteBlockReason(`${STORE}/`, p), "on the blocklist");
  assert.equal(siteBlockReason("https://etsy.com/x", p), null, "exact origins");
});

test("open mode: a user list entry beats the allowlist", () => {
  const p = open({ allowed: new Set([STORE, "https://www.etsy.com"]), entries: parseBlockLines(["etsy.com"]).entries });
  assert.match(siteBlockReason("https://www.etsy.com/", p) || "", /etsy\.com/);
});

test("allowlist mode keeps the old origin check", () => {
  const p: SitePolicy = { mode: "allowlist", allowed: new Set([STORE, "https://www.aritzia.com"]), blocked: new Set(), entries: [] };
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
    assert.match(blocklistReason(u, [], local) || "", /local address/, u);
    assert.match(blocklistReason(u, SUGGESTED_ENTRIES, local) || "", /local address/, u);
  }
  assert.equal(blocklistReason(`${STORE}/cart`, SUGGESTED_ENTRIES, local), null);
  for (const u of ["http://[2606:4700::1111]/", "http://8.8.8.8/", "http://[::ffff:8.8.8.8]/", "https://www.etsy.com/"]) {
    assert.equal(blocklistReason(u, SUGGESTED_ENTRIES, local), null, u);
  }
});

test("isLocalIp: the address Chrome actually connected to", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "10.1.2.3", "192.168.0.10", "fe80::1", "fec0::1", "fc00::", "0.0.0.0", "", "garbage"]) {
    assert.equal(isLocalIp(ip), true, ip);
    assert.equal(extList.isLocalIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "2606:4700::1111", "::ffff:1.1.1.1", "151.101.1.69"]) {
    assert.equal(isLocalIp(ip), false, ip);
    assert.equal(extList.isLocalIp(ip), false, ip);
  }
  assert.equal(LOCAL_DNS, extList.LOCAL_DNS);
  assert.equal(isLocalIp, extList.isLocalIp);
});
