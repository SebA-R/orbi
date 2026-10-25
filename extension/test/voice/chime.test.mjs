import { test } from "node:test";
import assert from "node:assert/strict";

import { CUES, MASTER, cueLength, createChime, linkCues, playCue } from "../../lib/voice/chime.js";

// A stub AudioContext that records oscillators (type, start frequency, glide
// target) and gain peaks.
function stubCtx(state = "running") {
  const oscs = [];
  const peaks = [];
  const param = (onRamp) => ({
    value: 0,
    setValueAtTime(v) { this.value = v; },
    exponentialRampToValueAtTime(v, t) { onRamp?.(v, t); },
  });
  const node = (extra = {}) => ({ connect(n) { return n; }, ...extra });
  const ctx = {
    state,
    currentTime: 10,
    destination: node(),
    createGain: () => node({ gain: param((v) => { if (v > 0.001) peaks.push(v); }) }),
    createBiquadFilter: () => node({ type: "", frequency: param(), Q: param() }),
    createOscillator() {
      const o = node({ type: "", started: null, stopped: null, glide: null,
        start(t) { this.started = t; }, stop(t) { this.stopped = t; } });
      o.frequency = { value: 0, setValueAtTime(v) { o.f0 = v; }, exponentialRampToValueAtTime(v) { o.glide = v; } };
      oscs.push(o);
      return o;
    },
  };
  return { ctx, oscs, peaks };
}

const fundamentals = (oscs) => oscs.filter((o, i, all) => !all.some((p) => p !== o && p.started === o.started && p.f0 * 2 === o.f0));

test("every cue in the table plays (version A recipes)", () => {
  assert.deepEqual(Object.keys(CUES).sort(), ["closed", "cut", "error", "failed", "listen", "placed", "sent"]);
  const want = {
    listen: [[280, 560]], sent: [[520, 260]], cut: [[440, 180]], closed: [[392, 370]],
    placed: [[392, null], [587.33, null]], failed: [[293.66, null], [220, null]], error: [[150, null], [150, null]],
  };
  for (const [name, notes] of Object.entries(want)) {
    const { ctx, oscs } = stubCtx();
    assert.equal(playCue(ctx, name), true, name);
    assert.deepEqual(fundamentals(oscs).map((o) => [o.f0, o.glide]), notes, name);
  }
});

test("the octave partial, waveform and quiet peaks", () => {
  const { ctx, oscs, peaks } = stubCtx();
  playCue(ctx, "listen");
  assert.deepEqual(oscs.map((o) => o.f0), [280, 560], "fundamental plus octave");
  assert.deepEqual(peaks, [0.16], "listen peaks at 0.16 (before the master level)");
  assert.ok(MASTER < 1);
  const e = stubCtx();
  playCue(e.ctx, "error");
  assert.ok(e.oscs.every((o) => o.type === "square"));
  assert.ok(Math.max(...Object.values(CUES).flat().map((n) => n.gain)) <= 0.2, "quieter than the old 0.32 chime");
});

test("scale and when shift the gain and the start time", () => {
  const { ctx, oscs, peaks } = stubCtx();
  playCue(ctx, "listen", { scale: 0.6, when: 0.5 });
  assert.ok(Math.abs(oscs[0].started - 10.51) < 1e-9);
  assert.ok(peaks.some((p) => Math.abs(p - 0.16 * 0.6) < 1e-9));
});

test("unknown cues and a suspended context play nothing", () => {
  const a = stubCtx();
  assert.equal(playCue(a.ctx, "nope"), false);
  const b = stubCtx("suspended");
  assert.equal(playCue(b.ctx, "listen"), false);
  assert.equal(a.oscs.length + b.oscs.length, 0);
});

test("cueLength covers the last note", () => {
  assert.equal(cueLength("cut"), 0.14);
  assert.ok(Math.abs(cueLength("placed") - 0.47) < 1e-9);
  assert.equal(cueLength("nope"), 0);
});

test("createChime: sounds off means silence, on plays", () => {
  let on = false;
  const { ctx, oscs } = stubCtx();
  const chime = createChime({ ctx, sounds: () => on });
  for (const name of Object.keys(CUES)) assert.equal(chime(name), false);
  assert.equal(oscs.length, 0);
  on = true;
  assert.equal(chime("sent"), true);
  assert.equal(oscs.length, 1);
});

test("createChime: a suspended context is resumed, then the cue plays", async () => {
  const { ctx, oscs } = stubCtx("suspended");
  let resumed = 0;
  ctx.resume = async () => { resumed++; ctx.state = "running"; };
  const chime = createChime({ ctx });
  assert.equal(chime("closed"), true);
  assert.equal(resumed, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(oscs.length, 2, "closed: fundamental and octave");
  const off = createChime({ ctx: stubCtx("suspended").ctx, sounds: () => false });
  assert.equal(off("closed"), false);
});

function linkRig() {
  const played = [];
  const timers = new Map();
  let id = 0;
  const on = linkCues({
    play: (name, opts) => played.push(opts ? [name, opts.scale] : [name]),
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimer: (t) => timers.delete(t),
  });
  const fire = () => { for (const [k, t] of [...timers]) { timers.delete(k); t.fn(); } };
  return { on, played, timers, fire };
}

test("closed: debounced 2 s, so a quick backoff retry doesn't chirp", () => {
  const r = linkRig();
  r.on("open");
  r.on("closed");
  assert.equal(r.timers.size, 1);
  assert.equal([...r.timers.values()][0].ms, 2000);
  r.on("closed"); // retries fail again: still one timer
  assert.equal(r.timers.size, 1);
  r.on("open"); // back within 2 s
  assert.equal(r.timers.size, 0);
  assert.deepEqual(r.played, []);
});

test("closed: plays once when it stays down, then listen at 0.6 on reconnect", () => {
  const r = linkRig();
  r.on("open");
  r.on("closed");
  r.fire();
  assert.deepEqual(r.played, [["closed"]]);
  r.on("closed");
  r.on("closed");
  assert.equal(r.timers.size, 0, "no more closed cues while down");
  r.on("open");
  assert.deepEqual(r.played, [["closed"], ["listen", 0.6]]);
  r.on("open");
  assert.equal(r.played.length, 2);
});

test("closed: never plays if the link was never open (server not up at start)", () => {
  const r = linkRig();
  r.on("closed");
  r.on("closed");
  assert.equal(r.timers.size, 0);
  r.on("open");
  assert.deepEqual(r.played, []);
});
