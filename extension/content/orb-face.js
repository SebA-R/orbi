// Clearcart mini orb face: the small status orb. It always has a face, as
// picked from the "Mini orb, happier" board (Mini-Orb-Happy): F1 "Dot eyes,
// soft smile" at idle, thinking and speaking, and F2 "Happy arcs, wide smile"
// while listening.
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
// hero uses 128px); the face is drawn in a 100 x 100 viewBox (1 unit =
// .01em on the board), so the eyes and mouth scale with it. --ccf-glow
// likewise replaces the small glow.
//
// States:
//   idle       F1: dot eyes that blink every 5 s, soft smile, slow breathing
//   listening  F2: happy arc eyes, wide smile, voice swell (from the mic level
//              when one is fed in)
//   thinking   F1: the face glances up and right, the smile narrows, inner
//              spectrum swirl
//   speaking   F1: blinking dot eyes, a talking mouth, cadence pulse (from the
//              TTS level when one is fed in)
// Between states the eyes crossfade and the mouth morphs over 180 ms. After
// 20 minutes of continuous idle it plays one squint-smile blink (H1, 500 ms),
// then waits for the next activity. Under prefers-reduced-motion each state
// is a static pose and the happy moment never plays.

(() => {
  "use strict";
  if (globalThis.__clearcartOrbFace) return;

  const SVGNS = "http://www.w3.org/2000/svg";
  const STATES = ["idle", "listening", "thinking", "speaking"];
  const HAPPY_AFTER_MS = 20 * 60 * 1000;
  const HAPPY_MS = 500;
  const MORPH = ".18s ease-out"; // between states
  const LEVEL_HOLD_MS = 300; // without a new level for this long, fall back to the loop
  const REDUCE = "(prefers-reduced-motion: reduce)";

  // Face geometry in a 100 x 100 box, taken from the board's em units
  // (.01em = 1 unit). The board draws its arcs as .035em borders with square
  // ends; here they are the same arcs traced along the middle of that border
  // with round caps, so no corner is pointed.
  // F1 eyes: .11em dots, .3em in from each side, .38em from the top.
  const DOT = { r: 5.5, cy: 43.5, lx: 35.5, rx: 64.5 };
  // F2 listening eyes: .15em x .08em arches, .27em in, .35em from the top.
  const ARC_L = "M28.75 43V42.5A5.75 5.75 0 0 1 40.25 42.5V43";
  const ARC_R = "M59.75 43V42.5A5.75 5.75 0 0 1 71.25 42.5V43";
  // Smiles: half ellipses .08em deep at .6em. F1 is .2em wide, F2 .28em.
  const SMILE_F1 = "M41.75 60A8.25 6.25 0 0 0 58.25 60";
  const SMILE_F2 = "M37.75 60A12.25 6.25 0 0 0 62.25 60";
  // F1 speaking: a filled half ellipse .2em wide whose depth runs .06 to
  // .15em, inset by half its 1.4 round-join stroke so the size is unchanged.
  const talk = (h) => `path("M40.7 60.7A9.3 ${(h - 1.4).toFixed(1)} 0 0 0 59.3 60.7Z")`;
  const TALK = [[0, 6], [8, 14], [17, 8], [27, 12], [38, 6], [47, 15], [58, 8], [67, 11], [78, 6], [100, 6]]
    .map(([at, h]) => `${at}% { d: ${talk(h)}; }`).join(" ");

  // Transforms and animations are never !important: an important declaration
  // beats animations, and keyframes drop important values.
  const CSS = `
@keyframes ccf-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.035); } }
@keyframes ccf-voice {
  0% { transform: scale(1); } 10% { transform: scale(1.08); } 18% { transform: scale(1.03); }
  30% { transform: scale(1.12); } 42% { transform: scale(1.04); } 54% { transform: scale(1.1); }
  64% { transform: scale(1.02); } 78% { transform: scale(1.07); } 90%, 100% { transform: scale(1); }
}
@keyframes ccf-spin { to { transform: rotate(360deg); } }
@keyframes ccf-cadence {
  0% { transform: scale(1); } 7% { transform: scale(1.05); } 18% { transform: scale(1.01); }
  27% { transform: scale(1.04); } 38% { transform: scale(1); } 47% { transform: scale(1.06); }
  58% { transform: scale(1.01); } 67% { transform: scale(1.03); } 78%, 100% { transform: scale(1); }
}
@keyframes ccf-blink { 0%, 93%, 100% { transform: scaleY(1); } 96.5% { transform: scaleY(.12); } }
@keyframes ccf-talk { ${TALK} }
@keyframes ccf-squint { 0%, 100% { transform: scaleY(1) translateY(0); } 35%, 65% { transform: scaleY(.3) translateY(-1.2px); } }
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
  opacity: 0; transition: opacity ${MORPH};
}
.ccf-svg {
  position: absolute !important; inset: 0 !important; display: block !important;
  width: 100% !important; height: 100% !important; overflow: visible !important;
}
.ccf-f { transform: translate(0, 0); transition: transform ${MORPH}; }
.ccf-eye, .ccf-t { fill: #22264f !important; stroke: #22264f !important; }
.ccf-eye { stroke-width: 0; }
.ccf-t { stroke-width: 1.4px; stroke-linejoin: round; }
.ccf-ae, .ccf-m {
  fill: none !important; stroke: #22264f !important; stroke-width: 3.5px;
  stroke-linecap: round; stroke-linejoin: round;
}
.ccf-eye, .ccf-ae, .ccf-m, .ccf-t { transform-box: fill-box; }
.ccf-eye { transform-origin: center; }
.ccf-m, .ccf-t { transform-origin: 50% 0; }
.ccf-dots, .ccf-arcs, .ccf-m, .ccf-t { transition: opacity ${MORPH}; }
.ccf-m { d: path("${SMILE_F1}"); transform: scaleX(1); transition: opacity ${MORPH}, d ${MORPH}, transform ${MORPH}; }
.ccf-arcs, .ccf-t { opacity: 0; }

.ccf.ccf--idle { animation: ccf-breathe 4s ease-in-out infinite; }
.ccf.ccf--idle .ccf-eye, .ccf.ccf--speaking .ccf-eye { animation: ccf-blink 5s ease-in-out infinite; }

.ccf.ccf--listening { animation: ccf-voice 1.6s linear infinite; }
.ccf.ccf--listening.ccf-live { animation: none; transition: transform .08s ease-out; }
.ccf.ccf--listening .ccf-dots { opacity: 0; }
.ccf.ccf--listening .ccf-arcs { opacity: 1; }
.ccf.ccf--listening .ccf-m { d: path("${SMILE_F2}"); }

.ccf.ccf--thinking .ccf-sw { opacity: .55; animation: ccf-spin 3.2s linear infinite; }
.ccf.ccf--thinking .ccf-f { transform: translate(5px, -5px); }
.ccf.ccf--thinking .ccf-m { transform: scaleX(.82); }

.ccf.ccf--speaking { animation: ccf-cadence 1.4s linear infinite; }
.ccf.ccf--speaking.ccf-live { animation: none; transition: transform .06s ease-out; }
.ccf.ccf--speaking .ccf-m { opacity: 0; }
.ccf.ccf--speaking .ccf-t { opacity: 1; animation: ccf-talk 1.4s linear infinite; }

.ccf.ccf-happy .ccf-eye { animation: ccf-squint ${HAPPY_MS}ms ease-in-out; }
.ccf.ccf-happy .ccf-m { animation: ccf-grin ${HAPPY_MS}ms ease-in-out; }

@media (prefers-reduced-motion: reduce) {
  .ccf, .ccf *, .ccf.ccf-live, .ccf.ccf-live * { animation: none !important; transition: none !important; }
}
@media (forced-colors: active) {
  .ccf { background: CanvasText !important; box-shadow: none !important; forced-color-adjust: none; }
  .ccf-eye, .ccf-t { fill: Canvas !important; stroke: Canvas !important; }
  .ccf-ae, .ccf-m { stroke: Canvas !important; }
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
    const dots = svg(doc, "g", { class: "ccf-dots" });
    dots.append(
      svg(doc, "circle", { class: "ccf-eye", cx: String(DOT.lx), cy: String(DOT.cy), r: String(DOT.r) }),
      svg(doc, "circle", { class: "ccf-eye", cx: String(DOT.rx), cy: String(DOT.cy), r: String(DOT.r) }),
    );
    const arcs = svg(doc, "g", { class: "ccf-arcs" });
    arcs.append(
      svg(doc, "path", { class: "ccf-ae", d: ARC_L }),
      svg(doc, "path", { class: "ccf-ae", d: ARC_R }),
    );
    f.append(
      dots,
      arcs,
      svg(doc, "path", { class: "ccf-m", d: SMILE_F1 }),
      svg(doc, "path", { class: "ccf-t", d: "M40.7 60.7A9.3 4.6 0 0 0 59.3 60.7Z" }),
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
      el.style.setProperty("--ccf-swell", String(1 + smooth * (state === "listening" ? 0.12 : 0.06)));
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
