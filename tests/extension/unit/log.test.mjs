import { test } from "node:test";
import assert from "node:assert/strict";

import { createLogger, luhnValid, maskCardNumbers, recentLogs, redact } from "../../../extension/lib/log.js";

test("luhnValid", () => {
  assert.equal(luhnValid("4111111111111111"), true);
  assert.equal(luhnValid("4242424242424242"), true);
  assert.equal(luhnValid("4111111111111112"), false);
  assert.equal(luhnValid("12345"), false);
});

test("maskCardNumbers hides Luhn-valid runs, grouped or not, and keeps other numbers", () => {
  assert.equal(maskCardNumbers("card 4111111111111111 ok"), "card [card number] ok");
  assert.equal(maskCardNumbers("4111 1111 1111 1111"), "[card number]");
  assert.equal(maskCardNumbers("4111-1111-1111-1111"), "[card number]");
  assert.equal(maskCardNumbers("order 1234567890123 total $14.27"), "order 1234567890123 total $14.27");
  assert.equal(maskCardNumbers("ending in 1111"), "ending in 1111");
});

test("redact removes secret keys at any depth and masks strings", () => {
  const out = redact({
    method: "fill_card",
    params: { tabId: 3, card: { name: "Ada Lovelace", number: "4111111111111111", exp: "12/30", csc: "123", zip: "94704" }, values: { number: "4111111111111111", csc: "123" } },
    note: "paid with 4111 1111 1111 1111",
    url: "wss://api.cartesia.ai/stt?access_token=abc123&model=ink-2",
    csc: "",
  });
  assert.equal(out.params.card, "[redacted]", "fill_card's card, whole");
  assert.equal(out.params.values, "[redacted]");
  assert.equal(out.params.tabId, 3);
  assert.equal(out.note, "paid with [card number]");
  assert.match(out.url, /access_token=\[redacted\]&model=ink-2/);
  assert.equal(out.csc, "");
  assert.doesNotMatch(JSON.stringify(out), /4111|abc123|"123"|Ada|12\/30|94704/);
});

test("redact truncates long strings and handles errors and cycles of depth", () => {
  assert.match(redact("x".repeat(1000)), /\(1000 chars\)$/);
  const e = new Error("bad 4111111111111111");
  assert.deepEqual(redact(e), { name: "Error", message: "bad [card number]", code: undefined });
  let deep = {};
  const root = deep;
  for (let i = 0; i < 20; i++) deep = deep.next = {};
  assert.match(JSON.stringify(redact(root)), /\[deep\]/);
});

test("logger writes redacted lines to the sink and the ring buffer", () => {
  const lines = [];
  const sink = { info: (...a) => lines.push(a), warn: () => {}, error: () => {}, debug: () => {}, log: () => {} };
  const log = createLogger("test", sink);
  log.info("filling", { number: "4111111111111111" });
  assert.equal(lines[0][0], "[clearcart:test]");
  assert.deepEqual(lines[0][2], { number: "[redacted]" });
  const last = recentLogs().at(-1);
  assert.equal(last.scope, "test");
  assert.doesNotMatch(last.msg, /4111/);
});
