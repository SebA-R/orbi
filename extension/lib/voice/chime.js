// Earcons made with WebAudio (no audio files). start/stop are ported from
// chimeNote/earcon in voice/public/js/app.js.

// One bell-like note: a sine plus a quiet octave, near-instant attack, soft exponential decay.
export function chimeNote(ctx, freq, at, peak = 0.32) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 5000;
  g.connect(lp).connect(ctx.destination);
  for (const [mult, level] of [[1, 1], [2, 0.18]]) {
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * mult;
    og.gain.value = level;
    osc.connect(og).connect(g);
    osc.start(at);
    osc.stop(at + 0.3);
  }
}

// A soft "boop": one sine whose pitch falls (A4 -> D4) over about 120 ms, quiet.
export function boop(ctx, at, peak = 0.12) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
  g.connect(ctx.destination);
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(440, at);
  osc.frequency.exponentialRampToValueAtTime(293.66, at + 0.12);
  osc.connect(g);
  osc.start(at);
  osc.stop(at + 0.13);
}

// Each earcon by name, played at time t. Add new sounds here.
export const EARCONS = {
  // Rising (E5 -> B5) when the mic opens, falling when it closes.
  start: (ctx, t) => { chimeNote(ctx, 659.25, t); chimeNote(ctx, 987.77, t + 0.07); },
  stop: (ctx, t) => { chimeNote(ctx, 987.77, t); chimeNote(ctx, 659.25, t + 0.07); },
  // Double-tap Space while speaking: speech is off.
  boop: (ctx, t) => boop(ctx, t),
};

export function earcon(ctx, kind) {
  if (ctx.state !== "running") return false;
  (EARCONS[kind] || EARCONS.stop)(ctx, ctx.currentTime + 0.005);
  return true;
}
