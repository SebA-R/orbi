// Latency settings: the ORBI_TIMING log, the spoken acknowledgement
// (ORBI_ACK) and the model effort (ORBI_EFFORT).
import assert from "node:assert/strict";
import { test } from "node:test";

import { ACK_PROMPT } from "../prompt.ts";
import { ackOn, agentEffort, Session } from "../session.ts";
import * as timing from "../timing.ts";

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

test("ORBI_TIMING off: no timing lines", () => {
  delete process.env.ORBI_TIMING;
  const lines = captureLog(() => {
    timing.beginTurn({ releasedAt: Date.now() - 500 });
    timing.mark("to_model");
    timing.clientMark("first_audio", Date.now());
  });
  assert.deepEqual(lines, []);
});

test("ORBI_TIMING on: marks count from the key release, tools get durations, client marks once", () => {
  process.env.ORBI_TIMING = "1";
  try {
    const lines = captureLog(() => {
      const now = Date.now();
      timing.beginTurn({ releasedAt: now - 500, finalAt: now - 100 });
      timing.mark("first_speech", { once: true, detail: "say" });
      timing.mark("first_speech", { once: true, detail: "reply" });
      timing.toolStart("t1", "find");
      timing.toolEnd("t1");
      timing.toolEnd("t1");
      timing.clientMark("first_audio", Date.now());
      timing.clientMark("first_audio", Date.now());
      timing.clientMark("Bad Event!", Date.now());
    });
    const labels = lines.map((l) => l.replace(/^\[timing\] \+\s*\d+ /, ""));
    assert.equal(lines[0], "[timing] ---- turn");
    assert.match(lines[1], /^\[timing\] \+\s+0 released$/);
    assert.match(lines[3], /^\[timing\] \+\s*(49\d|50\d) user_text$/);
    assert.deepEqual(labels.slice(2), ["stt_final", "user_text", "first_speech say", "tool_start find", labels[6], "first_audio"]);
    assert.match(labels[6], /^tool_end find \d+ms$/);
  } finally {
    delete process.env.ORBI_TIMING;
  }
});

test("a release time from the future or long ago is not used", () => {
  process.env.ORBI_TIMING = "1";
  try {
    const lines = captureLog(() => timing.beginTurn({ releasedAt: Date.now() + 60_000 }));
    assert.deepEqual(lines.map((l) => l.replace(/\+\s*\d+/, "+n")), ["[timing] ---- turn", "[timing] +n user_text"]);
  } finally {
    delete process.env.ORBI_TIMING;
  }
});

test("ORBI_ACK: the acknowledgement is in the prompt unless turned off", () => {
  assert.equal(ackOn({}), true);
  assert.equal(ackOn({ ORBI_ACK: "0" }), false);
  assert.equal(ackOn({ ORBI_ACK: "off" }), false);
  const s = new Session(() => {});
  delete process.env.ORBI_ACK;
  assert.ok(s.systemPrompt(false, true).includes(ACK_PROMPT));
  process.env.ORBI_ACK = "0";
  try {
    assert.ok(!s.systemPrompt(false, true).includes("Acknowledge first"));
  } finally {
    delete process.env.ORBI_ACK;
  }
});

test("ORBI_EFFORT: only low, medium or high", () => {
  assert.equal(agentEffort({}), undefined);
  assert.equal(agentEffort({ ORBI_EFFORT: " Medium " }), "medium");
  assert.equal(agentEffort({ ORBI_EFFORT: "max" }), undefined);
});
