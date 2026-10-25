// Clearcart mini orb face: the small status orb. It always has a face, as
// picked from the "Mini orb, happier" board (Mini-Orb-Happy): F1 "Dot eyes,
// soft smile" at idle, thinking and speaking, and F2 "Happy arcs, wide smile"
// while listening.
//
// A classic script with no imports, so it can load as a content script ahead
// of subtitles.js and as a plain <script> in the popup. It defines
// globalThis.__clearcartOrbFace = { CSS, STATES, HAPPY_AFTER_MS, HAPPY_MS,
// VISEMES, VISEME_MS, visemeOf, wordVisemes, plan, create }.
//
// create(doc, { canPlay }) returns { el, setState, setLevel, poke, caption,
// viseme, destroy }. The caller
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
// Lip-sync: while speaking, caption(msg) takes the SUBTITLE and SUBTITLE_WORD
// messages the subtitles get. Each heard word (with its length `ms`, the
// `elapsed` ms already heard, and Sonic's phonemes when it sent any) is
// planned into mouth shapes (visemes) and played from where the voice is
// now, so it holds across a tab switch replay. Without phonemes the word's
// letters are split into vowel groups (wordVisemes). A stop, barge-in or the
// end of the line snaps the mouth to rest; a line with no timestamps keeps
// the talking loop. Reduced motion keeps the static speaking pose.
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

  // Lip-sync mouths: one closed shape of four cubic curves around the talk
  // mouth's top line (y 60.7), so every shape has the same commands and the
  // d transition morphs between them. w is the half width, t how far the top
  // lip rises (negative: dips into a smile), b how far the bottom drops.
  // Drawn filled with a round 2-unit join, so no corner is sharp.
  const K = 0.5523;
  const n1 = (v) => Number(v.toFixed(2));
  const mouth = (w, t, b, y = 60.7) => {
    const L = n1(50 - w), R = n1(50 + w), lk = n1(50 - w * K), rk = n1(50 + w * K);
    const T = n1(y - t), B = n1(y + b), tk = n1(y - t * K), bk = n1(y + b * K);
    return `M${L} ${y}C${L} ${tk} ${lk} ${T} 50 ${T}C${rk} ${T} ${R} ${tk} ${R} ${y}`
      + `C${R} ${bk} ${rk} ${B} 50 ${B}C${lk} ${B} ${L} ${bk} ${L} ${y}Z`;
  };
  const VISEME_D = Object.freeze({
    rest: mouth(7.5, -1.4, 2.4), // M B P and pauses: a closed soft smile
    A: mouth(9, 0.6, 10), // ah: open
    E: mouth(11, 0.8, 5.5), // eh, ee: wide
    I: mouth(8.5, 0.4, 3.2), // ih: small and wide
    O: mouth(6, 4.5, 6.5), // oh: round
    U: mouth(3.8, 3, 3.6), // oo, w: small and round
    F: mouth(7.5, -0.4, 1.8), // f v: lips nearly together
  });
  const VISEMES = Object.freeze(Object.keys(VISEME_D));
  const VISEME_MS = 75; // easing between shapes

  // Sonic's phonemes (IPA, sometimes with stress or length marks) to a shape;
  // null for consonants that don't shape the lips (they share the next vowel).
  const IPA = [
    [/^(aɪ|aʊ|ɑ|a|æ|ʌ|ə|ɐ)/, "A"],
    [/^(eɪ|e|ɛ|i|ɚ|ɝ|ɜ)/, "E"],
    [/^(ɪ|ɨ|j|y)/, "I"],
    [/^(oʊ|ɔɪ|o|ɔ|ɒ|ɹ|r)/, "O"],
    [/^(u|ʊ|w|ʍ)/, "U"],
    [/^(m|b|p)/, "rest"],
    [/^(f|v)/, "F"],
  ];
  function visemeOf(phoneme) {
    const p = String(phoneme || "").toLowerCase().replace(/[ˈˌːˑ.\d]/g, "");
    if (!p) return null;
    for (const [re, v] of IPA) if (re.test(p)) return v;
    return null;
  }

  // Letters to shapes, for a word without phonemes: vowel groups take the
  // time, with a short close for m b p and a lip bite for f v. A weight per
  // part says how much of the word it gets.
  const VOWELS = [
    ["oo", "U"], ["ew", "U"], ["ue", "U"], ["ui", "U"], ["ou", "O"], ["ow", "O"], ["oa", "O"], ["oe", "O"], ["oi", "O"], ["oy", "O"],
    ["au", "A"], ["aw", "A"], ["ai", "E"], ["ay", "E"], ["ea", "E"], ["ee", "E"], ["ei", "E"], ["ey", "E"], ["ie", "E"],
    ["a", "A"], ["e", "E"], ["i", "I"], ["y", "I"], ["o", "O"], ["u", "U"],
  ];
  function wordVisemes(word) {
    let w = String(word || "").toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
    if (!w) return /\d/.test(String(word || "")) ? [{ v: "A", weight: 2 }] : [];
    if (/^you/.test(w)) w = "oo" + w.slice(3); // you, your
    // Silent e: make, five. A long i before it (five, nine) opens wide first.
    if (w.length > 3 && /[^aeiou]e$/.test(w)) w = w.slice(0, -1).replace(/i([^aeiou]+)$/, "ahi$1");
    const out = [];
    let between = false; // a consonant since the last vowel
    const push = (v, weight) => {
      const last = out.at(-1);
      if (last && last.v === v) last.weight += weight;
      else out.push({ v, weight });
    };
    for (let i = 0; i < w.length;) {
      const c = w[i];
      // y is a vowel only after a consonant (very, my), not at the start (yes).
      const vowel = VOWELS.find(([g]) => w.startsWith(g, i) && !(g === "y" && i === 0));
      if (vowel && "aeiouy".includes(c)) {
        // Two syllables on one shape (banana): the lips half close between.
        if (between && out.at(-1)?.v === vowel[1]) push(vowel[1] === "I" ? "rest" : "I", 0.4);
        push(vowel[1], 2);
        between = false;
        i += vowel[0].length;
        continue;
      }
      between = true;
      if (c === "f" || c === "v" || (c === "p" && w[i + 1] === "h")) push("F", 0.6);
      else if (c === "m" || c === "b" || c === "p") push("rest", 0.6);
      else if (c === "w" && w[i + 1] !== "h") push("U", 0.6);
      i++;
    }
    if (!out.some((p) => p.v !== "rest" && p.v !== "F")) out.push({ v: "A", weight: 2 }); // hmm, shh
    return out;
  }

  // A word's shapes in time: [{ v, at, end }] in ms from the word's start.
  // phonemes (optional) are [[ipa, startMs, endMs], ...] on the same clock.
  function plan(word, ms, phonemes) {
    const len = Math.max(0, Number(ms) || 0);
    if (Array.isArray(phonemes) && phonemes.length) {
      const segs = [];
      let carry = null; // a consonant's time goes to the shape after it
      for (const ph of phonemes) {
        if (!Array.isArray(ph)) continue;
        const v = visemeOf(ph[0]);
        const at = Math.max(0, Number(ph[1]) || 0);
        const end = Math.min(len || Infinity, Math.max(at, Number(ph[2]) || at));
        if (!v) { if (carry == null) carry = at; continue; }
        const from = carry != null ? carry : at;
        carry = null;
        const last = segs.at(-1);
        if (last && last.v === v) last.end = end;
        else segs.push({ v, at: from, end });
      }
      if (segs.length) {
        for (let i = 0; i < segs.length - 1; i++) segs[i].end = segs[i + 1].at; // no gaps inside a word
        segs.at(-1).end = len || segs.at(-1).end;
        return segs.map((x) => ({ v: x.v, at: Math.round(x.at), end: Math.round(x.end) }));
      }
    }
    const parts = wordVisemes(word);
    const total = parts.reduce((a, p) => a + p.weight, 0);
    if (!total || !len) return [];
    let at = 0;
    return parts.map((p, i) => {
      const end = i === parts.length - 1 ? len : at + (len * p.weight) / total;
      const seg = { v: p.v, at: Math.round(at), end: Math.round(end) };
      at = end;
      return seg;
    });
  }

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
.ccf-v { fill: #22264f !important; stroke: #22264f !important; stroke-width: 2px; stroke-linejoin: round; opacity: 0; transition: opacity ${MORPH}, d ${VISEME_MS}ms ease-out; }
.ccf-v.ccf-snap { transition: opacity ${MORPH}; }
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
.ccf.ccf--speaking.ccf-sync .ccf-t { opacity: 0; animation: none; }
.ccf.ccf--speaking.ccf-sync .ccf-v { opacity: 1; }

.ccf.ccf-happy .ccf-eye { animation: ccf-squint ${HAPPY_MS}ms ease-in-out; }
.ccf.ccf-happy .ccf-m { animation: ccf-grin ${HAPPY_MS}ms ease-in-out; }

@media (prefers-reduced-motion: reduce) {
  .ccf, .ccf *, .ccf.ccf-live, .ccf.ccf-live * { animation: none !important; transition: none !important; }
}
@media (forced-colors: active) {
  .ccf { background: CanvasText !important; box-shadow: none !important; forced-color-adjust: none; }
  .ccf-eye, .ccf-t, .ccf-v { fill: Canvas !important; stroke: Canvas !important; }
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
    const lips = svg(doc, "path", { class: "ccf-v", d: VISEME_D.rest });
    f.append(lips);
    face.append(f);
    el.append(core, face);

    let state = null;
    let happyTimer = 0;
    let happyEnd = 0;
    let liveTimer = 0;
    let smooth = 0;
    // Lip-sync: the agent line's words, a word that came before its line,
    // the last word played, and the timers of the shapes still to come.
    const sync = { id: null, words: [], early: null, key: null, index: -1, timers: [] };

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

    // Shows one mouth shape; snap skips the easing (a stop, a barge-in).
    function viseme(v, { snap = false } = {}) {
      if (!Object.hasOwn(VISEME_D, v)) return;
      const d = VISEME_D[v];
      if (snap) lips.classList.add("ccf-snap");
      lips.setAttribute("d", d);
      try { lips.style.setProperty("d", `path("${d}")`); } catch {}
      lips.dataset.v = v;
      el.dataset.viseme = v;
      if (snap) {
        try { lips.getBoundingClientRect(); } catch {} // apply before the easing comes back
        lips.classList.remove("ccf-snap");
      }
    }

    function clearSync() {
      for (const id of sync.timers) clearTimeout(id);
      sync.timers = [];
    }

    // Back to the closed mouth; keepSync false hands back to the talking loop.
    function rest({ snap = true, keepSync = true } = {}) {
      clearSync();
      viseme("rest", { snap });
      if (!keepSync) el.classList.remove("ccf-sync");
    }

    function playWord(msg) {
      const key = `${msg.utteranceId}:${msg.index}`;
      if (msg.utteranceId === sync.id && msg.index < sync.index) return; // late: never goes back
      if (key === sync.key) return; // the same word again (the page heard it twice)
      sync.key = key;
      sync.index = msg.index;
      if (state !== "speaking" || reduced()) return;
      const segs = plan(sync.words[msg.index], msg.ms, msg.phonemes);
      if (!segs.length) return;
      clearSync();
      el.classList.add("ccf-sync");
      const elapsed = Math.max(0, Number(msg.elapsed) || 0);
      for (const seg of segs) {
        if (seg.end <= elapsed) continue;
        const wait = seg.at - elapsed;
        if (wait <= 0) viseme(seg.v);
        else sync.timers.push(setTimeout(() => viseme(seg.v), wait));
      }
      // Closed in the pause after the word, until the next one is heard.
      const len = segs.at(-1).end;
      sync.timers.push(setTimeout(() => viseme("rest"), Math.max(0, len - elapsed)));
    }

    // SUBTITLE and SUBTITLE_WORD, as the subtitles get them.
    function caption(msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "subtitle") {
        if (msg.speaker !== "agent" || typeof msg.text !== "string") return;
        if (msg.utteranceId === sync.id) return; // the same line again (a replay)
        sync.id = typeof msg.utteranceId === "string" && msg.karaoke === true ? msg.utteranceId : null;
        sync.words = String(msg.text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
        sync.key = null;
        sync.index = -1;
        const early = sync.early;
        sync.early = null;
        if (!sync.id) rest({ keepSync: false });
        else if (early && early.utteranceId === sync.id) caption(early);
        return;
      }
      if (msg.type !== "subtitle.word" || typeof msg.utteranceId !== "string") return;
      if (msg.utteranceId !== sync.id) { sync.early = msg; return; } // its line is on the way
      if (msg.fallback) return rest({ keepSync: false }); // no timestamps: the loop
      if (msg.frozen || msg.done) return rest();
      if (Number.isInteger(msg.index) && Number.isFinite(msg.ms)) playWord(msg);
    }

    function setState(next) {
      if (!STATES.includes(next) || next === state) return;
      rest({ keepSync: false });
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
      clearSync();
      stopHappy();
      endLive();
      el.remove();
    }

    setState("idle");
    return { el, setState, setLevel, poke, caption, viseme, destroy, get state() { return state; } };
  }

  globalThis.__clearcartOrbFace = Object.freeze({
    CSS, STATES, HAPPY_AFTER_MS, HAPPY_MS, VISEMES, VISEME_MS, visemeOf, wordVisemes, plan, create,
  });
})();
