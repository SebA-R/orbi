// Watchable pace: plans for on-page input that a person can follow by eye.
// The pointer travels along a gentle curve from where it last was, slows
// into the target, sometimes overshoots and corrects, rests a beat, then
// presses; text goes in a key at a time with a typist's rhythm; a scroll
// glides in a few wheel steps instead of one jump.
//
// Pure: no chrome.*, no CDP, no timers. Every planner takes a seeded random
// source and returns plain data; background/actor.js plays it. What a plan
// may change is only how and when, never what: a pointer path starts exactly
// where the pointer is and ends exactly on the point asked for, a click
// presses there, typing inserts exactly the text, and the wheel steps add
// up to exactly the scroll asked for.

// --------------------------------------------------------------- random

// splitmix32: tiny, seedable, good enough for timing jitter (not crypto).
export function createRng(seed = (Math.random() * 2 ** 32) >>> 0) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return ((z ^ (z >>> 16)) >>> 0) / 2 ** 32;
  };
  const between = (lo, hi) => lo + next() * (hi - lo);
  const normal = () => {
    // Box-Muller; 1 - next() keeps log away from 0.
    const u = 1 - next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return {
    next,
    between,
    chance: (p) => next() < p,
    normal,
    // Right-skewed around a median: human delays have a floor and a tail.
    skewed: (median, lo, hi, spread = 0.3) => clamp(median * Math.exp(normal() * spread), lo, hi),
  };
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// --------------------------------------------------------------- timing

// Chosen so a click reads as deliberate without dragging the turn out:
// about 0.4 to 1.2 s from the first move to the release.
export const CLICK = Object.freeze({
  moveMinMs: 240,
  moveMaxMs: 700,
  dwellMs: [110, 240], // resting on the target before pressing
  holdMs: [55, 120], // button down to button up
  frameMs: 16, // one pointer sample per frame
});

// About 8 to 14 characters a second. Text that would take longer than
// TYPE.budgetMs is typed faster, keeping its rhythm, but never faster than
// TYPE.fastGapMs a key on average. Every character is still a key press.
export const TYPE = Object.freeze({
  gapMs: 82, // median gap between characters
  gapRange: [45, 230],
  holdMs: [28, 70], // key down to key up, inside the gap
  budgetMs: 5_000,
  fastGapMs: 22,
});

export const SCROLL = Object.freeze({
  stepPx: 110, // roughly one notch of a wheel
  minSteps: 3,
  maxSteps: 10,
  stepMs: [28, 48],
});

// --------------------------------------------------------------- pointer

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// Minimum-jerk profile: starts and ends at rest, fastest in the middle.
const minJerk = (u) => u * u * u * (10 + u * (-15 + 6 * u));

function bezier(p0, p1, p2, p3, u) {
  const v = 1 - u;
  const a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

// Where the pointer starts when this tab has none yet: a little off the
// target, so even the first click shows a short approach.
export function entryPoint(to, rng) {
  const angle = rng.between(0, 2 * Math.PI);
  const r = rng.between(140, 320);
  return { x: Math.max(1, Math.round(to.x + Math.cos(angle) * r)), y: Math.max(1, Math.round(to.y + Math.sin(angle) * r)) };
}

// Travel time grows with the log of distance over target size (Fitts).
export function travelMs(d, size, rng, { min = CLICK.moveMinMs, max = CLICK.moveMaxMs } = {}) {
  const w = clamp(size || 30, 10, 300);
  const base = 150 + 95 * Math.log2(1 + d / w);
  return Math.round(clamp(base * rng.skewed(1, 0.8, 1.25, 0.12), min, max));
}

// The path from `from` to `to`: [{x, y, ms}] where ms is the wait before
// that point. Humanizing only shapes the middle: the first point is exactly
// `from` (the pointer where it is now, no wait) and the last is exactly
// `to`, unrounded and unjittered, so the press lands on the point asked for.
// A long move may run past the target and come back, but always before the
// last point.
export function planPath(from, to, rng, opts = {}) {
  const start = { x: from.x, y: from.y, ms: 0 };
  const d = dist(from, to);
  if (d === 0) return [start];
  if (d < 2) return [start, { x: to.x, y: to.y, ms: CLICK.frameMs }];
  const total = opts.ms ?? travelMs(d, opts.size, rng, opts);
  const dx = (to.x - from.x) / d, dy = (to.y - from.y) / d;
  // Normal to the line: the curve bows to one side, more for longer moves.
  const nx = -dy, ny = dx;
  const bow = clamp(d * rng.between(0.06, 0.18), 3, 90) * (rng.chance(0.5) ? 1 : -1);

  // A long move sometimes runs a little past the target and comes back.
  const overshoot = d > 260 && rng.chance(0.3) ? rng.between(6, 18) : 0;
  const end = overshoot ? { x: to.x + dx * overshoot, y: to.y + dy * overshoot } : to;
  const c1 = { x: from.x + (end.x - from.x) * 0.3 + nx * bow, y: from.y + (end.y - from.y) * 0.3 + ny * bow };
  const c2 = { x: from.x + (end.x - from.x) * 0.72 + nx * bow * 0.55, y: from.y + (end.y - from.y) * 0.72 + ny * bow * 0.55 };

  const mainMs = overshoot ? total * 0.82 : total;
  const n = Math.max(4, Math.round(mainMs / CLICK.frameMs));
  const frame = Math.max(1, Math.round(mainMs / n));
  const out = [start];
  for (let i = 1; i <= n; i++) {
    const u = i / n;
    const p = bezier(from, c1, c2, end, minJerk(u));
    // A slight tremor, fading out as the hand settles.
    const shake = 0.7 * (1 - u);
    out.push({ x: Math.round(p.x + rng.normal() * shake), y: Math.round(p.y + rng.normal() * shake), ms: frame });
  }
  if (overshoot) {
    const back = Math.max(2, Math.round((total - mainMs) / CLICK.frameMs));
    for (let i = 1; i <= back; i++) {
      const u = minJerk(i / back);
      out.push({
        x: Math.round(end.x + (to.x - end.x) * u),
        y: Math.round(end.y + (to.y - end.y) * u),
        // The correction is its own small movement, after a short reaction.
        ms: i === 1 ? Math.round(rng.between(50, 110)) : CLICK.frameMs,
      });
    }
  }
  // The end is the target itself, never a rounded or shaken copy of it.
  const last = out[out.length - 1];
  last.x = to.x;
  last.y = to.y;
  return out;
}

// A click: approach path, the rest before pressing, and the press length.
export function planClick(from, to, rng, opts = {}) {
  return {
    path: planPath(from, to, rng, opts),
    dwellMs: Math.round(rng.skewed(150, ...CLICK.dwellMs)),
    holdMs: Math.round(rng.skewed(80, ...CLICK.holdMs, 0.25)),
  };
}

// A hover: a quicker approach, then a short stop.
export function planHover(from, to, rng, opts = {}) {
  return {
    path: planPath(from, to, rng, { min: 140, max: 450, ...opts }),
    dwellMs: Math.round(rng.skewed(120, 60, 220)),
  };
}

// --------------------------------------------------------------- keyboard

const PUNCT_CODE = {
  " ": ["Space", 32], "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190],
  "/": ["Slash", 191], "`": ["Backquote", 192],
};
// Shifted characters, by the unshifted key they sit on (US layout).
const SHIFTED = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};

// The physical key for a character on a US keyboard, or null when there is
// no single key for it (accents, emoji, newlines): those go in as text only.
export function keyFor(ch) {
  if (typeof ch !== "string" || ch.length !== 1) return null;
  let base = ch, shift = false;
  if (ch >= "A" && ch <= "Z") { base = ch.toLowerCase(); shift = true; }
  else if (SHIFTED[ch]) { base = SHIFTED[ch]; shift = true; }
  if (base >= "a" && base <= "z") return { key: ch, code: `Key${base.toUpperCase()}`, vk: base.toUpperCase().charCodeAt(0), shift };
  if (base >= "0" && base <= "9") return { key: ch, code: `Digit${base}`, vk: base.charCodeAt(0), shift };
  const p = PUNCT_CODE[base];
  return p ? { key: ch, code: p[0], vk: p[1], shift } : null;
}

// Typing rhythm for text: [{ch, gapMs, holdMs}], gapMs is the wait before
// that character (0 for the first). Short bursts inside words, a longer
// gap after a space, more after punctuation, the odd pause to think. The
// whole thing is squeezed toward TYPE.budgetMs for long text, down to an
// average of TYPE.fastGapMs a key; the variation stays, scaled.
export function planTyping(text, rng, opts = {}) {
  const chars = [...String(text)];
  const budget = opts.budgetMs ?? TYPE.budgetMs;
  if (!chars.length) return [];
  const out = [];
  let burst = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const prev = chars[i - 1];
    let gap = 0;
    if (i > 0) {
      let median = TYPE.gapMs;
      if (prev === " ") median *= 1.3;
      else if (/[.,;:!?]/.test(prev)) median *= 1.6;
      if (burst > 0) { median *= 0.72; burst--; }
      else if (/\w/.test(ch) && rng.chance(0.12)) burst = 2 + Math.floor(rng.next() * 4);
      gap = rng.skewed(median, ...TYPE.gapRange, 0.28);
      if (rng.chance(0.03)) gap += rng.between(150, 350);
    }
    out.push({ ch, gapMs: gap, holdMs: Math.round(rng.skewed(45, ...TYPE.holdMs, 0.22)) });
  }
  const total = out.reduce((s, k) => s + k.gapMs, 0);
  const target = Math.max(budget, (chars.length - 1) * TYPE.fastGapMs);
  const squeeze = total > target ? target / total : 1;
  // Floor when squeezing, so rounding cannot push the total past the budget.
  for (const k of out) k.gapMs = squeeze < 1 ? Math.floor(k.gapMs * squeeze) : Math.round(k.gapMs);
  // The key comes up before the next one goes down; the hold is spent out
  // of the next gap, not added to it.
  for (let i = 0; i + 1 < out.length; i++) out[i].holdMs = Math.max(1, Math.min(out[i].holdMs, Math.round(out[i + 1].gapMs * 0.6)));
  return out;
}

// --------------------------------------------------------------- scroll

// Splits a scroll into eased wheel steps: [{dx, dy, ms}]. Integer deltas
// that add up exactly to (dx, dy); bigger steps first, tapering off.
export function planScroll(dx, dy, rng) {
  const len = Math.hypot(dx, dy);
  if (!len) return [];
  const n = clamp(Math.round(len / SCROLL.stepPx), SCROLL.minSteps, SCROLL.maxSteps);
  // Ease-out weights: the gesture starts fast and settles.
  const w = Array.from({ length: n }, (_, i) => 1 - Math.pow((i + 0.5) / n, 2) * 0.75);
  const sum = w.reduce((a, b) => a + b, 0);
  const split = (total) => {
    const parts = [];
    let used = 0, acc = 0;
    for (let i = 0; i < n; i++) {
      acc += (total * w[i]) / sum;
      const v = i === n - 1 ? total - used : Math.round(acc) - used;
      parts.push(v);
      used += v;
    }
    return parts;
  };
  const xs = split(dx), ys = split(dy);
  return xs.map((x, i) => ({ dx: x, dy: ys[i], ms: i === 0 ? 0 : Math.round(rng.between(...SCROLL.stepMs)) }));
}
