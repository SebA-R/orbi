// Blocked sites (extension/lib/blocklist.js): the entry forms, the fixed
// rules, and the suggested list the extension seeds on install.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SUGGESTED_BLOCKLIST, SUGGESTED_ENTRIES, blocklistReason, parseBlockLines, parseEntry } from "../../../extension/lib/blocklist.js";

// A local test page the user allowed.
const LOCAL = "http://localhost:4100";
const reason = (u, lines) => blocklistReason(u, parseBlockLines(lines).entries, new Set([LOCAL]));

test("entry forms parse and normalize", () => {
  assert.deepEqual(parseEntry("Chase.com"), { text: "chase.com", host: "chase.com", any: false, path: "" });
  assert.equal(parseEntry("https://www.etsy.com/").text, "etsy.com", "a pasted address keeps only the site");
  assert.equal(parseEntry("http://shop.example:8080/a/b/?q=1#x").text, "shop.example/a/b");
  assert.deepEqual(parseEntry("amazon.com/AP/"), { text: "amazon.com/ap", host: "amazon.com", any: false, path: "/ap" });
  assert.deepEqual(parseEntry("amazon.*/ap"), { text: "amazon.*/ap", host: "amazon", any: true, path: "/ap" });
  assert.deepEqual(parseEntry("*Bank*"), { text: "*bank*", keyword: "bank" });
  assert.deepEqual(parseEntry("*.gov"), { text: "*.gov", label: "gov" });
  for (const bad of ["chase", "*", "**", "*ba nk*", "*.g.ov", "has space.com", "javascript:alert(1)", "@@@", ".com"]) {
    assert.equal(parseEntry(bad), null, bad);
  }
});

test("parseBlockLines keeps comments, one blank between groups, drops duplicates and reports bad lines", () => {
  const r = parseBlockLines("\n# Banks\nchase.com\n\n\nCHASE.com\nnot valid\n# Shops\n*shoe*\n\n");
  assert.deepEqual(r.lines, ["# Banks", "chase.com", "", "# Shops", "*shoe*"]);
  assert.deepEqual(r.entries.map((e) => e.text), ["chase.com", "*shoe*"]);
  assert.deepEqual(r.bad, ["not valid"]);
  assert.deepEqual(parseBlockLines(["a.com", "", "b.com"]).lines, ["a.com", "", "b.com"], "arrays too");
});

test("a domain matches itself and its subdomains, not lookalikes", () => {
  const l = ["chase.com"];
  assert.match(reason("https://chase.com/", l), /chase\.com/);
  assert.match(reason("https://secure.chase.com/x", l), /blocked sites list: chase\.com/);
  assert.match(reason("https://MAIL.CHASE.COM./", l), /chase/);
  assert.equal(reason("https://notchase.com/", l), null);
  assert.equal(reason("https://chase.com.evil.example/", l), null);
});

test("a path entry matches that path and below, on that host", () => {
  const l = ["amazon.com/ap", "amazon.*/gp/css"];
  assert.ok(reason("https://www.amazon.com/ap/signin?x=1", l));
  assert.ok(reason("https://www.amazon.com/AP", l));
  assert.equal(reason("https://www.amazon.com/apple", l), null, "a whole path part");
  assert.equal(reason("https://www.amazon.ca/ap/signin", l), null, "amazon.com only");
  assert.ok(reason("https://www.amazon.ca/gp/css/homepage.html", l), "amazon.* is any ending");
  assert.ok(reason("https://www.amazon.co.uk/gp/css/x", l));
  assert.equal(reason("https://www.amazon.com/dp/B0", l), null);
});

test("keyword and label entries", () => {
  assert.ok(reason("https://firstcommunitybank.example/", ["*bank*"]));
  assert.equal(reason("https://shop.bank/", ["*bank*"]), null, "not the ending");
  assert.ok(reason("https://www.irs.gov/", ["*.gov"]));
  assert.ok(reason("https://www.gov.uk/", ["*.gov"]));
  assert.ok(reason("https://www2.gov.bc.ca/", ["*.gov"]));
  assert.equal(reason("https://govee.com/", ["*.gov"]), null, "a whole part");
});

test("fixed rules hold with an empty list", () => {
  for (const u of [
    "chrome://settings", "chrome-extension://abc/options.html", "devtools://devtools/x", "about:blank", "file:///etc/passwd",
    "data:text/html,hi", "javascript:alert(1)", "blob:https://x.example/1", "view-source:https://x.example", "ftp://x.example",
    "not a url", "", undefined,
  ]) assert.ok(reason(u, []), String(u));
  for (const u of ["http://localhost:5050/", "http://localhost:4101/", "http://127.0.0.1:4100/", "http://[::1]:4100/", "http://app.localhost/", "http://192.168.1.1/", "http://10.0.0.5/", "http://172.16.0.1/", "http://169.254.169.254/"]) {
    assert.match(reason(u, []), /local address/, u);
  }
  assert.match(reason("https://www.etsy.com@mail.google.com/", []), /login/);
  assert.equal(reason(`${LOCAL}/cart`, []), null, "the allowlisted local page");
  assert.equal(reason("http://172.32.0.1/", []), null, "not a private range");
  assert.equal(reason("https://mail.google.com/", []), null, "everything else is the user's list");
});

test("the suggested list is valid and covers today's sensitive sites", () => {
  assert.deepEqual(parseBlockLines(SUGGESTED_BLOCKLIST).bad, []);
  assert.deepEqual(parseBlockLines(SUGGESTED_BLOCKLIST).lines, [...SUGGESTED_BLOCKLIST], "already normalized");
  assert.ok(SUGGESTED_BLOCKLIST.includes("# Banks and money: any address with these words in its name"));
  const r = (u) => blocklistReason(u, SUGGESTED_ENTRIES, new Set([LOCAL]));
  for (const u of [
    "https://mail.google.com/mail/u/0", "https://outlook.live.com/mail", "https://account.proton.me/", "https://vault.bitwarden.com/",
    "https://my.1password.com/", "https://secure.chase.com/", "https://www.rbcroyalbank.com/", "https://www.td.com/ca/en",
    "https://www.coinbase.com/", "https://www.paypal.com/", "https://www.ufcu-creditunion.org/", "https://www.irs.gov/",
    "https://www.canada.ca/en/revenue-agency.html", "https://www.gov.uk/", "https://service.gouv.qc.ca/", "https://army.mil/",
    "https://turbotax.intuit.com/", "https://mychart.examplehealth.org/", "https://healthy.kp.org/", "https://accounts.google.com/signin",
    "https://appleid.apple.com/", "https://account.microsoft.com/", "https://www.amazon.com/ap/signin?x=1",
    "https://www.amazon.ca/gp/css/homepage.html", "https://www.amazon.com/a/addresses",
  ]) assert.match(r(u) || "", /blocked sites list/, u);
  for (const u of ["https://www.etsy.com/search?q=mug", "https://www.aritzia.com/us/en", "https://www.amazon.com/dp/B000", "https://www.google.com/search?q=shoes", "https://notgmail.com/"]) {
    assert.equal(r(u), null, u);
  }
});

test("IPv4-mapped, compatible and site-local IPv6 and loopback DNS names are local", () => {
  for (const u of [
    "http://[::ffff:127.0.0.1]:5050/", "http://[::ffff:192.168.1.1]/", "http://[::7f00:1]/", "http://[fec0::]/",
    "http://localtest.me:5050/cartesia-token", "http://127.0.0.1.nip.io:5050/",
  ]) assert.match(blocklistReason(u, SUGGESTED_ENTRIES, new Set([LOCAL])) || "", /local address/, u);
  assert.equal(blocklistReason(`${LOCAL}/`, SUGGESTED_ENTRIES, new Set([LOCAL])), null);
});
