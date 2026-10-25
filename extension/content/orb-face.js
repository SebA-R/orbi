// Clearcart mini orb face: the small status orb. At rest it shows two eyes
// and a gentle smile ("3. Eyes and mouth" from the Mini Orb Faces board);
// while listening, thinking or speaking the face fades out and the bare orb
// carries the state (the faceless set from the Mini Orb States board).
//
// A classic script with no imports, so it can load as a content script ahead
// of subtitles.js and as a plain <script> in the popup. It defines
// globalThis.__clearcartOrbFace = { CSS, STATES, HAPPY_AFTER_MS, HAPPY_MS, create }.
//
// create(doc, { canPlay }) returns { el, setState, setLevel, poke, destroy }. The caller
// puts el (aria-hidden, decorative) wherever it likes and adds CSS to the
// same root, ideally a closed shadow root. The state is always said in text
// elsewhere; the face never carries meaning on its own.
//
// It is 26 px unless the page sets --ccf-size on an ancestor (the new tab
// hero uses 128px); the face is drawn in a 100 x 100 viewBox, so the eyes and
// mouth scale with it. --ccf-glow likewise replaces the small glow.
//
// States (Mini Orb States board, recommended faceless set):
//   idle       I1 slow breathing, smiling
//   listening  L1 voice swell, from the mic level when one is fed in, no face
//   thinking   T1 inner spectrum swirl, no face
//   speaking   S1 cadence pulse, from the TTS level when one is fed in, no face
// The face fades out and back in over 150 ms (class ccf-noface off idle).
// After 20 minutes of continuous idle it plays one squint-smile blink (Happy
// board H1, 500 ms), then waits for the next activity. Under
// prefers-reduced-motion nothing moves and the happy moment never plays.

(() => {
  "use strict";
  if (globalThis.__clearcartOrbFace) return;

  const SVGNS = "http://www.w3.org/2000/svg";
  const STATES = ["idle", "listening", "thinking", "speaking"];
  const HAPPY_AFTER_MS = 20 * 60 * 1000;
  const HAPPY_MS = 500;
  const LEVEL_HOLD_MS = 300; // without a new level for this long, fall back to the loop
  const REDUCE = "(prefers-reduced-motion: reduce)";

  // Face geometry in a 100 x 100 box (1 unit = 0.26 px at the default 26 px). Eyes are
  // face 3's dots. The mouth is a thin, shallow crescent (top sag 2, bottom
  // sag 6), so it reads as a friendly smile rather than a grin.
  const SMILE = "M40.5 60Q50 64 59.5 60Q50 72 40.5 60Z";

  // Transforms and animations are never !important: an important declaration
  // beats animations, and keyframes drop important values.
  const CSS = `
@keyframes ccf-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
@keyframes ccf-voice {
  0% { transform: scale(1); } 10% { transform: scale(1.09); } 18% { transform: scale(1.03); }
  30% { transform: scale(1.14); } 42% { transform: scale(1.05); } 54% { transform: scale(1.11); }
  64% { transform: scale(1.02); } 78% { transform: scale(1.08); } 90%, 100% { transform: scale(1); }
}
@keyframes ccf-spin { to { transform: rotate(360deg); } }
@keyframes ccf-cadence {
  0% { transform: scale(1); } 7% { transform: scale(1.08); } 18% { transform: scale(1.01); }
  27% { transform: scale(1.06); } 38% { transform: scale(1); } 47% { transform: scale(1.09); }
  58% { transform: scale(1.02); } 67% { transform: scale(1.05); } 78%, 100% { transform: scale(1); }
}
@keyframes ccf-squint { 0%, 100% { transform: scaleY(1); } 35%, 65% { transform: scaleY(.3); } }
@keyframes ccf-grin { 0%, 100% { transform: scaleX(1); } 35%, 65% { transform: scaleX(1.12); } }
.ccf {
  position: relative !important; display: inline-block !important; flex: none !important;
  box-sizing: border-box !important; width: var(--ccf-size, 26px) !important; height: var(--ccf-size, 26px) !important;
  margin: 0; padding: 0 !important; border: 0 !important; border-radius: 50% !important;
  background: radial-gradient(circle at 35% 30%, #ffffff, #c9b8ff 40%, #5e8bff 75%) !important;
  box-shadow: var(--ccf-glow, 0 0 8px .5px rgb(94 139 255 / .4)) !important;
  overflow: visible !important; pointer-events: none !important; vertical-align: middle;
  transform: scale(var(--ccf-swell, 1)); transform-origin: 50% 50%;
  transition: transform .22s ease-out;
}
.ccf-core {
  position: absolute !important; inset: 0 !important; display: block !important;
  border-radius: 50% !important; overflow: hidden !important;
}
.ccf-sw {
  position: absolute !important; inset: -30% !important; display: block !important;
  background: conic-gradient(from 0deg, #ff9f6b, #ff5f8f, #b56cff, #5e8bff, #4fd1ff, #ff9f6b) !important;
  -webkit-mask: radial-gradient(circle, transparent 14%, #000 62%); mask: radial-gradient(circle, transparent 14%, #000 62%);
  opacity: 0; transition: opacity .22s ease-out;
}
.ccf-svg {
  position: absolute !important; inset: 0 !important; display: block !important;
  width: 100% !important; height: 100% !important; overflow: visible !important;
}
.ccf-f { opacity: 1; transition: opacity .15s ease-out; }
.ccf.ccf-noface .ccf-f { opacity: 0; }
.ccf-eye, .ccf-m { fill: #22264f !important; stroke: none; }
.ccf-m { stroke: #22264f !important; stroke-width: 1.4px; stroke-linejoin: round; }
.ccf-eye, .ccf-m { transform-box: fill-box; }
.ccf-eye { transform-origin: center; }
.ccf-m { transform-origin: 50% 0; }

.ccf.ccf--idle { animation: ccf-breathe 4s ease-in-out infinite; }
.ccf.ccf--listening { animation: ccf-voice 1.6s linear infinite; }
.ccf.ccf--listening.ccf-live { animation: none; transition: transform .08s ease-out; }
.ccf.ccf--thinking .ccf-sw { opacity: .6; animation: ccf-spin 3.2s linear infinite; }
.ccf.ccf--speaking { animation: ccf-cadence 1.4s linear infinite; }
.ccf.ccf--speaking.ccf-live { animation: none; transition: transform .06s ease-out; }
.ccf.ccf-happy .ccf-eye { animation: ccf-squint ${HAPPY_MS}ms ease-in-out; }
.ccf.ccf-happy .ccf-m { animation: ccf-grin ${HAPPY_MS}ms ease-in-out; }

@media (prefers-reduced-motion: reduce) {
  .ccf, .ccf *, .ccf.ccf-live, .ccf.ccf-live * { animation: none !important; transition: none !important; }
  .ccf.ccf--listening { transform: scale(1.08); }
  .ccf.ccf--speaking { transform: scale(1.04); }
}
@media (forced-colors: active) {
  .ccf { background: CanvasText !important; box-shadow: none !important; forced-color-adjust: none; }
  .ccf-eye, .ccf-m { fill: Canvas !important; stroke: Canvas !important; }
}
`;

  function svg(doc, tag, attrs) {
    const node = doc.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  // canPlay (optional): returns false while the face can't be seen, so the
  // happy moment never plays to an empty room.
  function create(doc = document, { canPlay = () => true } = {}) {
    const win = doc.defaultView || globalThis;
    const el = doc.createElement("span");
    el.className = "ccf";
    el.setAttribute("aria-hidden", "true");
    const core = doc.createElement("span");
    core.className = "ccf-core";
    const sw = doc.createElement("i");
    sw.className = "ccf-sw";
    core.append(sw);
    const face = svg(doc, "svg", { class: "ccf-svg", viewBox: "0 0 100 100", focusable: "false", "aria-hidden": "true" });
    const f = svg(doc, "g", { class: "ccf-f" });
    f.append(
      svg(doc, "circle", { class: "ccf-eye", cx: "35", cy: "45", r: "5" }),
      svg(doc, "circle", { class: "ccf-eye", cx: "65", cy: "45", r: "5" }),
      svg(doc, "path", { class: "ccf-m", d: SMILE }),
    );
    face.append(f);
    el.append(core, face);

    let state = null;
    let happyTimer = 0;
    let happyEnd = 0;
    let liveTimer = 0;
    let smooth = 0;

    const reduced = () => {
      try { return !!(win.matchMedia && win.matchMedia(REDUCE).matches); } catch { return false; }
    };

    function stopHappy() {
      clearTimeout(happyTimer);
      clearTimeout(happyEnd);
      happyTimer = happyEnd = 0;
      el.classList.remove("ccf-happy");
    }

    // One quiet squint-smile, only after 20 minutes of unbroken idle.
    function armHappy() {
      stopHappy();
      if (state !== "idle" || reduced()) return;
      happyTimer = setTimeout(() => {
        happyTimer = 0;
        if (state !== "idle" || reduced() || !canPlay()) return;
        el.classList.add("ccf-happy");
        happyEnd = setTimeout(() => { happyEnd = 0; el.classList.remove("ccf-happy"); }, HAPPY_MS);
      }, HAPPY_AFTER_MS);
    }

    function endLive() {
      clearTimeout(liveTimer);
      liveTimer = 0;
      smooth = 0;
      el.classList.remove("ccf-live");
      el.style.removeProperty("--ccf-swell");
    }

    function setState(next) {
      if (!STATES.includes(next) || next === state) return;
      if (state) el.classList.remove(`ccf--${state}`);
      state = next;
      el.classList.add(`ccf--${state}`);
      el.dataset.state = state;
      el.classList.toggle("ccf-noface", state !== "idle"); // the face is for rest only
      endLive();
      armHappy(); // a state change is activity
    }

    // Any other activity (a caption, a key press): restart the idle clock.
    function poke() { if (state === "idle") armHappy(); else stopHappy(); }

    // A live 0..1 level: the mic while listening, the speech audio while
    // speaking. Fast attack, slower release; the loop comes back when it stops.
    function setLevel(level) {
      if (typeof level !== "number" || !Number.isFinite(level)) return;
      if ((state !== "listening" && state !== "speaking") || reduced()) return;
      const v = Math.min(1, Math.max(0, level));
      smooth += (v - smooth) * (v > smooth ? 0.6 : 0.25);
      el.classList.add("ccf-live");
      el.style.setProperty("--ccf-swell", String(1 + smooth * (state === "listening" ? 0.14 : 0.09)));
      clearTimeout(liveTimer);
      liveTimer = setTimeout(endLive, LEVEL_HOLD_MS);
    }

    function destroy() {
      stopHappy();
      endLive();
      el.remove();
    }

    setState("idle");
    return { el, setState, setLevel, poke, destroy, get state() { return state; } };
  }

  globalThis.__clearcartOrbFace = Object.freeze({ CSS, STATES, HAPPY_AFTER_MS, HAPPY_MS, create });
})();
