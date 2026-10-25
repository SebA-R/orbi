import { test } from "node:test";
import assert from "node:assert/strict";

import { Backoff } from "../../../extension/lib/backoff.js";

test("doubles up to the cap without jitter", () => {
  const b = new Backoff({ min: 100, max: 1000, jitter: 0 });
  assert.deepEqual([b.next(), b.next(), b.next(), b.next(), b.next(), b.next()], [100, 200, 400, 800, 1000, 1000]);
  b.reset();
  assert.equal(b.next(), 100);
});

test("jitter stays within the spread and the cap", () => {
  const lo = new Backoff({ min: 1000, max: 1100, jitter: 0.2, random: () => 0 });
  const hi = new Backoff({ min: 1000, max: 1100, jitter: 0.2, random: () => 1 });
  assert.equal(lo.next(), 800);
  assert.equal(hi.next(), 1100);
});
