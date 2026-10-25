// Clearcart's earcons: every cue is in CUES, played by one small synth.
// Recipes are version A of each cue from the earcon design page.
//
//   listen  talk key held (confirm): whoop, 280 -> 560 Hz
//   sent    talk key let go (stop): tick, 520 -> 260 Hz
//   cut     cut off while speaking or thinking: boop, 440 -> 180 Hz
//   placed  confirm_done paid: bell, G4 then D5
//   failed  confirm_done failed: triangle, D4 then A3
//   error   mic blocked or failed, STT error: two soft 150 Hz buzzes
//   closed  agent link down for 2 s: beep, 392 -> 370 Hz
//
// Gains are peak levels before MASTER.

export const MASTER = 0.7;

export const CUES = Object.freeze({
  listen: [{ f0: 280, f1: 560, dur: 0.15, glide: 0.11, gain: 0.16, harm: 0.15, attack: 0.012, lp: 2500 }],
  sent: [{ f0: 520, f1: 260, dur: 0.045, glide: 0.03, gain: 0.12, attack: 0.002, lp: 2500 }],
  cut: [{ f0: 440, f1: 180, dur: 0.14, glide: 0.12, gain: 0.16, harm: 0.1, attack: 0.006, lp: 2000 }],
  placed: [
    { f0: 392, dur: 0.32, gain: 0.16, harm: 0.2, lp: 4000 },
    { at: 0.11, f0: 587.33, dur: 0.36, gain: 0.16, harm: 0.2, lp: 4000 },
  ],
  failed: [
    { type: "triangle", f0: 293.66, dur: 0.26, gain: 0.2, lp: 1600 },
    { at: 0.15, type: "triangle", f0: 220, dur: 0.3, gain: 0.2, lp: 1400 },
  ],
  error: [
    { type: "square", f0: 150, dur: 0.07, gain: 0.09, shape: "flat", lp: 800 },
    { at: 0.1, type: "square", f0: 150, dur: 0.07, gain: 0.09, shape: "flat", lp: 800 },
  ],
  closed: [{ f0: 392, f1: 370, dur: 0.16, gain: 0.14, harm: 0.15, shape: "flat", attack: 0.01, lp: 2500 }],
});

// How long a cue lasts, so the next one can wait for it.
export const cueLength = (name) => Math.max(0, ...(CUES[name] || []).map((n) => (n.at || 0) + n.dur));

// One note. shape "bell": quick attack, exponential decay. "flat": holds,
// then a short release. f0 -> f1 glides exponentially over `glide` seconds
// (default: the whole note). harm adds an octave partial at that level.
export function note(ctx, out, n, t0, scale = 1) {
  const at = t0 + (n.at || 0);
  const dur = n.dur;
  const peak = Math.max(0.0002, n.gain * scale);
  const attack = n.attack ?? 0.005;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + attack);
  if ((n.shape || "bell") === "bell") {
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  } else {
    const rel = Math.min(0.04, dur / 3);
    g.gain.setValueAtTime(peak, at + dur - rel);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  }
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = n.lp || 4000;
  lp.Q.value = 0.5;
  g.connect(lp).connect(out);
  const partials = [[1, 1]];
  if (n.harm) partials.push([2, n.harm]);
  for (const [mult, level] of partials) {
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = n.type || "sine";
    o.frequency.setValueAtTime(n.f0 * mult, at);
    if (n.f1 && n.f1 !== n.f0) o.frequency.exponentialRampToValueAtTime(n.f1 * mult, at + (n.glide ?? dur));
    og.gain.value = level;
    o.connect(og).connect(g);
    o.start(at);
    o.stop(at + dur + 0.03);
  }
}

// Plays cue `name` `when` seconds from now, gains times `scale`. Returns
// false (and plays nothing) for an unknown cue or a context that isn't running.
export function playCue(ctx, name, { scale = 1, when = 0 } = {}) {
  const notes = CUES[name];
  if (!notes || ctx.state !== "running") return false;
  const out = ctx.createGain();
  out.gain.value = MASTER;
  out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.01 + when;
  for (const n of notes) note(ctx, out, n, t0, scale);
  return true;
}

// The agent link's sounds. "closed" plays only after the link was open and
// has stayed down for `delayMs`, so backoff retries don't chirp; coming back
// after that plays "listen" at 0.6.
export function linkCues({ play, delayMs = 2000, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) }) {
  let wasOpen = false;
  let timer = null;
  let down = false; // the closed cue played
  return (state) => {
    if (state === "open") {
      if (timer != null) { clearTimer(timer); timer = null; }
      if (down) play("listen", { scale: 0.6 });
      down = false;
      wasOpen = true;
    } else if (state === "closed") {
      if (!wasOpen || down || timer != null) return;
      timer = setTimer(() => {
        timer = null;
        down = true;
        play("closed");
      }, delayMs);
    }
  };
}

// The offscreen document's chime(name, opts): plays nothing while
// sounds() is false (the "Play sounds" setting).
export function createChime({ ctx, sounds = () => true, resume = () => {} }) {
  return (name, opts) => {
    if (!sounds()) return false;
    resume();
    return playCue(ctx, name, opts);
  };
}
