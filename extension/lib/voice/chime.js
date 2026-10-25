// Two-note earcons, ported from chimeNote/earcon in voice/public/js/app.js.

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

// Rising (E5 -> B5) when the mic opens, falling when it closes.
export function earcon(ctx, kind) {
  if (ctx.state !== "running") return false;
  const t = ctx.currentTime + 0.005;
  const [first, second] = kind === "start" ? [659.25, 987.77] : [987.77, 659.25];
  chimeNote(ctx, first, t);
  chimeNote(ctx, second, t + 0.07);
  return true;
}
