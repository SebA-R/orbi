// Connected-address check (background/netguard.js): a tab whose page came
// from a local IP on an origin that is not allowed is refused, wherever its
// host name pointed.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { installChrome } from "./chrome-mock.mjs";
import { _reset, assertNetSafe, flagOf, forget, noteResponse, setAllowlist } from "../../background/netguard.js";
import { resolveAllowedTab, tabsCreate } from "../../background/tabs.js";
import { ERR } from "../../lib/protocol.js";

// A local test page the user put on the allowed sites.
const LOCAL = "http://localhost:4100";
const res = (tabId, url, ip, type = "main_frame") => ({ tabId, url, ip, type });

beforeEach(() => {
  _reset();
  setAllowlist([LOCAL]);
});

test("a public name served from loopback or a private address is flagged", () => {
  for (const [url, ip] of [
    ["http://localtest.me:5050/cartesia-token", "127.0.0.1"], ["http://127.0.0.1.nip.io:5050/", "127.0.0.1"],
    ["https://rebind.example/", "::1"], ["https://rebind.example/", "::ffff:127.0.0.1"], ["https://lan.example/", "192.168.1.1"],
    ["https://lan.example/", "fec0::1"], ["https://lan.example/", "10.0.0.8"],
  ]) {
    _reset();
    setAllowlist([LOCAL]);
    assert.ok(noteResponse(res(7, url, ip)), `${url} ${ip}`);
    assert.throws(() => assertNetSafe(7), (e) => e.code === ERR.NOT_ALLOWED && /local address/.test(e.message));
  }
});

test("an allowed local page and public sites pass; a clean page clears the flag", () => {
  assert.equal(noteResponse(res(7, `${LOCAL}/cart`, "127.0.0.1")), null);
  assert.equal(noteResponse(res(7, "https://www.etsy.com/", "151.101.1.69")), null);
  assertNetSafe(7);
  assert.ok(noteResponse(res(7, "https://evil.example/", "8.8.8.8")) === null);
  assert.ok(noteResponse(res(7, "https://frame.example/", "127.0.0.1", "sub_frame")));
  assert.throws(() => assertNetSafe(7));
  noteResponse(res(7, "https://www.etsy.com/", "151.101.1.69"));
  assertNetSafe(7);
  noteResponse(res(8, "https://rebind.example/", "127.0.0.1"));
  forget(8);
  assertNetSafe(8);
});

test("a cached response without an ip uses the last address seen for its origin", () => {
  noteResponse(res(7, "https://rebind.example/a", "127.0.0.1"));
  noteResponse(res(7, "https://www.etsy.com/", "151.101.1.69"));
  assert.ok(noteResponse(res(7, "https://rebind.example/b", undefined)));
  assert.equal(noteResponse(res(9, "https://unknown.example/", undefined)), null);
});

test("before settings load, an allowed local page is flagged until the allowlist arrives", () => {
  _reset();
  assert.ok(noteResponse(res(7, `${LOCAL}/`, "127.0.0.1")));
  setAllowlist([LOCAL]);
  assert.equal(flagOf(7), null);
});

test("tabs.js refuses calls on a flagged agent tab", async () => {
  installChrome();
  const { tabId } = await tabsCreate({ url: "https://www.etsy.com/" });
  assert.equal(await resolveAllowedTab(tabId), tabId);
  noteResponse(res(tabId, "https://www.etsy.com/", "127.0.0.1"));
  await assert.rejects(resolveAllowedTab(tabId), (e) => e.code === ERR.NOT_ALLOWED);
});
