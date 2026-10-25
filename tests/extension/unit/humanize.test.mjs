import { test } from "node:test";
import assert from "node:assert/strict";

import { CLICK, TYPE, SCROLL, createRng, keyFor, planClick, planPath, planScroll, planTyping } from "../../../extension/background/humanize.js";

const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

test("the rng is deterministic per seed", () => {
  const a = createRng(7), b = createRng(7), c = createRng(8);
  const seq = (r) => Array.from({ length: 5 }, () => r.next());
  assert.deepEqual(seq(a), seq(b));
  assert.notDeepEqual(seq(createRng(7)), seq(c));
});

test("paths end exactly on the target and stay near the straight line", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rng = createRng(seed);
    const from = { x: 20 + seed, y: 40 };
    const to = { x: 20 + ((seed * 37) % 1200), y: 30 + ((seed * 53) % 700) };
    const path = planPath(from, to, rng, { size: 30 });
    const last = path[path.length - 1];
    assert.deepEqual([last.x, last.y], [to.x, to.y], `seed ${seed} lands on the target`);
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    // Bow is at most 18% of the distance (90px cap), the overshoot 18px.
    const slack = Math.min(90, 0.18 * d) + 18 + 4;
    for (const p of path) {
      assert.ok(p.x >= Math.min(from.x, to.x) - slack && p.x <= Math.max(from.x, to.x) + slack, `seed ${seed} x in bounds`);
      assert.ok(p.y >= Math.min(from.y, to.y) - slack && p.y <= Math.max(from.y, to.y) + slack, `seed ${seed} y in bounds`);
      assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y) && p.ms >= 1);
    }
    if (d > 10) assert.ok(path.length >= 4, "a real move has several samples");
  }
});

test("longer moves take longer, within the click limits", () => {
  const avg = (d) => {
    let t = 0;
    for (let s = 1; s <= 50; s++) t += sum(planPath({ x: 0, y: 0 }, { x: d, y: 0 }, createRng(s), { size: 30 }), (p) => p.ms);
    return t / 50;
  };
  assert.ok(avg(60) < avg(400) && avg(400) < avg(1200));
  assert.ok(avg(60) >= CLICK.moveMinMs - 20 && avg(1200) <= CLICK.moveMaxMs + 130);
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

test("some long moves overshoot and come back; short ones never do", () => {
  let over = 0;
  for (let s = 1; s <= 200; s++) {
    const path = planPath({ x: 0, y: 100 }, { x: 900, y: 100 }, createRng(s), { size: 30 });
    if (path.some((p) => p.x > 905)) over++;
    const short = planPath({ x: 0, y: 100 }, { x: 150, y: 100 }, createRng(s), { size: 30 });
    assert.ok(short.every((p) => p.x <= 152), "no overshoot on a short move");
  }
  assert.ok(over > 20 && over < 120, `${over} of 200 overshoot`);
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

test("typing has a word rhythm: longer gaps after spaces and punctuation", () => {
  let afterSpace = 0, inWord = 0, ns = 0, nw = 0;
  for (let s = 1; s <= 200; s++) {
    const t = "milk eggs bread, butter";
    planTyping(t, createRng(s)).forEach((k, i) => {
      if (i === 0) return;
      if (t[i - 1] === " ") { afterSpace += k.gapMs; ns++; } else if (/\w/.test(t[i - 1])) { inWord += k.gapMs; nw++; }
    });
  }
  assert.ok(afterSpace / ns > (inWord / nw) * 1.1);
});

test("long text is squeezed into the budget, and past maxChars falls back", () => {
  const plan = planTyping("a".repeat(TYPE.maxChars), createRng(3));
  assert.ok(sum(plan, (k) => k.gapMs) <= TYPE.budgetMs);
  assert.equal(planTyping("a".repeat(TYPE.maxChars + 1), createRng(3)), null);
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
