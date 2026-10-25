import { test } from "node:test";
import assert from "node:assert/strict";

import { TYPE, SCROLL, createRng, keyFor, planClick, planPath, planScroll, planTyping } from "../../../extension/background/humanize.js";

const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

test("the rng is deterministic per seed", () => {
  const a = createRng(7), b = createRng(7), c = createRng(8);
  const seq = (r) => Array.from({ length: 5 }, () => r.next());
  assert.deepEqual(seq(a), seq(b));
  assert.notDeepEqual(seq(createRng(7)), seq(c));
});

test("paths start exactly at the pointer and end exactly on the target", () => {
  const cases = [
    [{ x: 0, y: 0 }, { x: 900, y: 100 }], // long: may overshoot mid-path
    [{ x: 12.25, y: 40.5 }, { x: 610.5, y: 333.75 }], // fractional ends stay unrounded
    [{ x: 300, y: 300 }, { x: 301, y: 300 }], // tiny move
    [{ x: 50, y: 60 }, { x: 50, y: 60 }], // no move
  ];
  for (const [from, to] of cases) {
    for (let seed = 1; seed <= 60; seed++) {
      const path = planPath(from, to, createRng(seed), { size: 30 });
      const first = path[0], last = path[path.length - 1];
      assert.deepEqual([first.x, first.y, first.ms], [from.x, from.y, 0], `seed ${seed} starts at the pointer`);
      assert.deepEqual([last.x, last.y], [to.x, to.y], `seed ${seed} ends on the target`);
      const c = planClick(from, to, createRng(seed), { size: 30 });
      assert.deepEqual([c.path[0].x, c.path[0].y], [from.x, from.y]);
      assert.deepEqual([c.path.at(-1).x, c.path.at(-1).y], [to.x, to.y]);
    }
  }
});

test("a whole click takes about 0.4 to 1.2 s", () => {
  for (let s = 1; s <= 300; s++) {
    for (const d of [15, 80, 300, 800, 1500]) {
      const c = planClick({ x: 5, y: 5 }, { x: 5 + d * 0.8, y: 5 + d * 0.6 }, createRng(s * 11 + d), { size: 30 });
      const ms = sum(c.path, (p) => p.ms) + c.dwellMs + c.holdMs;
      assert.ok(ms >= 400 && ms <= 1200, `${ms} ms for ${d}px`);
    }
  }
});

test("typing runs at about 8 to 14 characters a second", () => {
  const texts = ["two percent milk, half gallon", "Hello there", "paper towels 12 pack", "oat milk"];
  let total = 0, chars = 0;
  for (let s = 1; s <= 200; s++) {
    for (const t of texts) {
      const plan = planTyping(t, createRng(s));
      assert.equal(plan.map((k) => k.ch).join(""), t, "every character, once, in order");
      assert.equal(plan[0].gapMs, 0);
      for (let i = 0; i + 1 < plan.length; i++) assert.ok(plan[i].holdMs < plan[i + 1].gapMs, "key up before the next key down");
      total += sum(plan, (k) => k.gapMs);
      chars += plan.length - 1;
    }
  }
  const cps = (chars / total) * 1000;
  assert.ok(cps >= 8 && cps <= 14, `${cps.toFixed(1)} chars/s`);
});

test("long text is typed faster, never in one go, and keeps its variation", () => {
  const plan = planTyping("a".repeat(120), createRng(3));
  assert.equal(plan.length, 120);
  assert.ok(sum(plan, (k) => k.gapMs) <= TYPE.budgetMs);
  const long = planTyping("milk and eggs ".repeat(60), createRng(4));
  assert.equal(long.length, 840);
  const total = sum(long, (k) => k.gapMs);
  assert.ok(total <= 839 * TYPE.fastGapMs && total >= 839 * TYPE.fastGapMs * 0.9, `${total} ms`);
  assert.ok(new Set(long.map((k) => k.gapMs)).size > 10, "gaps still vary");
  assert.deepEqual(planTyping("", createRng(3)), []);
  // Emoji are one character of text, not two halves.
  assert.deepEqual(planTyping("a😀", createRng(3)).map((k) => k.ch), ["a", "😀"]);
});

test("keyFor maps US keys and refuses what has no single key", () => {
  assert.deepEqual(keyFor("a"), { key: "a", code: "KeyA", vk: 65, shift: false });
  assert.deepEqual(keyFor("Q"), { key: "Q", code: "KeyQ", vk: 81, shift: true });
  assert.deepEqual(keyFor("7"), { key: "7", code: "Digit7", vk: 55, shift: false });
  assert.deepEqual(keyFor("@"), { key: "@", code: "Digit2", vk: 50, shift: true });
  assert.deepEqual(keyFor(" "), { key: " ", code: "Space", vk: 32, shift: false });
  assert.equal(keyFor("?").code, "Slash");
  for (const ch of ["é", "\n", "\r", "\t", "😀", "", "ab"]) assert.equal(keyFor(ch), null, JSON.stringify(ch));
});

test("scroll steps add up exactly and taper off", () => {
  for (const [dx, dy] of [[0, 450], [0, -1200], [37, 0], [-250, 300], [0, 5]]) {
    const steps = planScroll(dx, dy, createRng(dx + dy));
    assert.equal(sum(steps, (s) => s.dx), dx);
    assert.equal(sum(steps, (s) => s.dy), dy);
    assert.ok(steps.length >= SCROLL.minSteps && steps.length <= SCROLL.maxSteps);
    assert.ok(steps.every((s) => Number.isInteger(s.dx) && Number.isInteger(s.dy)));
    assert.equal(steps[0].ms, 0);
    const mag = (s) => Math.hypot(s.dx, s.dy);
    if (Math.hypot(dx, dy) > 300) assert.ok(mag(steps[0]) > mag(steps[steps.length - 1]), "eases out");
    assert.ok(sum(steps, (s) => s.ms) <= SCROLL.maxSteps * SCROLL.stepMs[1]);
  }
  assert.deepEqual(planScroll(0, 0, createRng(1)), []);
});
