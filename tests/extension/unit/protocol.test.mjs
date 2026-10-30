import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ERR, INTERNAL, METHODS, MSG, PROTOCOL_VERSION, TOOLS,
  errorResponse, hello, okResponse, parseMessage,
} from "../../../extension/lib/protocol.js";

test("hello carries the protocol version and extension name", () => {
  assert.deepEqual(hello("0.1.0"), { type: "hello", protocol: PROTOCOL_VERSION, ext: "clearcart", version: "0.1.0" });
  assert.equal(hello("0.1.0", "install-1234").client, "install-1234", "the install's id when it has one");
});

test("responses have the expected shapes", () => {
  assert.deepEqual(okResponse("a1", { x: 1 }), { type: "response", id: "a1", ok: true, result: { x: 1 } });
  assert.deepEqual(okResponse(3), { type: "response", id: 3, ok: true, result: null });
  assert.deepEqual(errorResponse("a2", ERR.NOT_ALLOWED, "nope"), {
    type: "response", id: "a2", ok: false, error: { code: "not_allowed", message: "nope" },
  });
});

test("parseMessage accepts well-formed requests and fills params", () => {
  assert.deepEqual(parseMessage('{"type":"request","id":"r1","method":"navigate"}'), {
    type: "request", id: "r1", method: "navigate", params: {},
  });
  const m = parseMessage({ type: "request", id: 7, method: "click", params: { ref: "e1" } });
  assert.equal(m.params.ref, "e1");
});

test("parseMessage drops malformed frames", () => {
  for (const raw of [
    "not json",
    "null",
    "[]",
    '{"type":5}',
    '{"type":"request","method":"x"}',
    '{"type":"request","id":{},"method":"x"}',
    '{"type":"request","id":"1","method":3}',
    '{"type":"request","id":"1","method":"x","params":"str"}',
    '{"type":"evil"}',
  ]) {
    assert.equal(parseMessage(raw), null, raw);
  }
  assert.equal(parseMessage({ type: MSG.PING, t: 1 }).type, "ping");
});

test("tools and internal methods never overlap, and no eval-style tool exists", () => {
  for (const m of INTERNAL) assert.ok(!TOOLS.includes(m), m);
  assert.equal(new Set(METHODS).size, METHODS.length);
  for (const m of METHODS) assert.doesNotMatch(m, /eval|javascript|exec|script/i);
});
