// The new tab page's conversation: when the user talks, the orb glides
// left and makes room. The user's words stream into a bubble on the right
// (its tail on the right, away from the orb), Orbi's bubble grows out of the
// orb with thinking dots, then plays the reply word by word in the
// subtitles' karaoke inks, timed by Sonic's word timestamps (SUBTITLE and
// SUBTITLE_WORD, the same messages content/subtitles.js gets on a website).
// After the reply it holds 2.2 s, fades the bubbles and glides the orb back
// to the centre.
//
// Moves are FLIP: measure, switch the layout, then play the difference back
// as one transform animation, so the glide is right at any width and no
// frame touches layout. Under prefers-reduced-motion positions just switch.
//
// The page has no subtitle card (newtab.html loads no content/subtitles.js);
// these bubbles are its only captions.

export const GLIDE = "cubic-bezier(.32, .72, 0, 1)";
export const GLIDE_MS = 560;
export const YOU_IN_MS = 460; // the user's bubble, after talking starts
export const HOLD_MS = 2200; // after the reply
export const LEAVE_MS = 260; // bubbles fade out, then the orb glides back

const REDUCE = "(prefers-reduced-motion: reduce)";
const STATES = ["idle", "listening", "thinking", "speaking"];
const words = (text) => String(text || "").split(/\s+/).filter(Boolean);

// els: { main, orb, dock, rep, you }. Returns the message handlers.
export function startConvo(els, { win = globalThis } = {}) {
  const { main, orb, dock, rep, you } = els;
  const doc = main.ownerDocument;
  const reduced = () => { try { return win.matchMedia(REDUCE).matches; } catch { return false; } };
  let layout = "idle";
  let state = "idle";
  let startedAt = 0;
  let youTimer = 0;
  let holdTimer = 0;
  let leaveTimer = 0;
  let youWords = [];
  // The agent line: its id, whether it is karaoke, the word being heard.
  const line = { id: null, karaoke: false, index: -1, done: false, early: null };

  main.dataset.layout = "idle";

  function setLayout(next) {
    if (next === layout) return;
    const moving = [orb, dock];
    const first = moving.map((e) => e.getBoundingClientRect());
    for (const e of moving) for (const a of e.getAnimations?.() || []) a.cancel();
    layout = next;
    main.dataset.layout = next;
    if (reduced()) return;
    moving.forEach((e, i) => {
      const last = e.getBoundingClientRect();
      const f = first[i];
      const s = last.width ? f.width / last.width : 1;
      const dx = f.left - last.left;
      const dy = f.top - last.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(s - 1) < 0.01) return;
      e.animate(
        [{ transform: `translate(${dx}px, ${dy}px) scale(${s})` }, { transform: "none" }],
        { duration: GLIDE_MS, easing: GLIDE },
      );
    });
  }

  function clearTimers() {
    clearTimeout(holdTimer);
    clearTimeout(leaveTimer);
    holdTimer = leaveTimer = 0;
    delete main.dataset.leaving;
  }

  function resetYou() {
    clearTimeout(youTimer);
    youTimer = 0;
    youWords = [];
    you.textContent = "";
    main.dataset.you = "off";
  }

  function resetOrbi() {
    rep.textContent = "";
    rep.classList.remove("karaoke", "frozen");
    Object.assign(line, { id: null, karaoke: false, index: -1, done: false, early: null });
    main.dataset.orbi = "off";
    main.dataset.mode = "dots";
  }

  // A new turn: a press of the talk key, or typed words. Restarts the cycle
  // when one is still on screen.
  function begin() {
    clearTimers();
    resetYou();
    resetOrbi();
    startedAt = performance.now();
    setLayout("active");
  }

  function showYou() {
    if (!youWords.length || main.dataset.you === "on") return;
    const wait = YOU_IN_MS - (performance.now() - startedAt);
    if (wait > 0 && !reduced()) {
      if (!youTimer) youTimer = setTimeout(() => { youTimer = 0; showYou(); }, wait);
      return;
    }
    main.dataset.you = "on";
  }

  // The user's words as heard: words already shown stay, new ones fade in.
  function setYou(text) {
    const next = words(text);
    let keep = 0;
    while (keep < youWords.length && keep < next.length && youWords[keep] === next[keep]) keep++;
    while (you.childNodes.length > keep) you.lastChild.remove();
    const frag = doc.createDocumentFragment();
    for (let i = keep; i < next.length; i++) {
      const s = doc.createElement("span");
      s.className = "u";
      s.textContent = (i ? " " : "") + next[i];
      frag.append(s);
    }
    you.append(frag);
    youWords = next;
    showYou();
  }

  function showOrbi() {
    main.dataset.orbi = "on";
  }

  // An agent line: every word drawn at once in the coming ink (karaoke), or
  // plainly when it has no timestamps.
  function setOrbi(text, id, karaoke) {
    rep.textContent = "";
    rep.classList.toggle("karaoke", karaoke);
    rep.classList.remove("frozen");
    Object.assign(line, { id, karaoke, index: -1, done: false });
    const frag = doc.createDocumentFragment();
    words(text).forEach((w, i) => {
      if (i) frag.append(" ");
      const s = doc.createElement("span");
      s.className = karaoke ? "w kp" : "w";
      s.textContent = w;
      frag.append(s);
    });
    rep.append(frag);
    main.dataset.mode = "text";
    showOrbi();
    const early = line.early;
    line.early = null;
    if (early && early.utteranceId === id) onWord(early);
  }

  function paint(timing) {
    const at = line.done ? Infinity : line.index;
    let current = null;
    rep.querySelectorAll(".w").forEach((s, i) => {
      const cls = i < at ? "ks" : i === at ? "kc" : "kp";
      if (cls === "kc") current = s;
      for (const c of ["ks", "kc", "kp"]) if (c !== cls) s.classList.remove(c);
      s.classList.add(cls);
    });
    if (current && timing && Number.isFinite(timing.ms)) {
      current.style.setProperty("--k-dur", `${Math.max(1, timing.ms)}ms`);
      current.style.setProperty("--k-delay", `${-Math.max(0, Math.min(timing.ms, timing.elapsed || 0))}ms`);
    }
  }

  function onWord(msg) {
    if (typeof msg.utteranceId !== "string") return;
    if (msg.utteranceId !== line.id) { line.early = msg; return; } // its line is on the way
    if (!line.karaoke) return;
    if (msg.fallback) {
      line.karaoke = false;
      rep.classList.remove("karaoke", "frozen");
      rep.querySelectorAll(".w").forEach((s) => s.classList.remove("ks", "kc", "kp"));
      return;
    }
    const fresh = msg.done || msg.frozen || (Number.isInteger(msg.index) && msg.index > line.index);
    if (!fresh) return; // late or replayed: never goes back
    if (msg.done) line.done = true;
    else if (Number.isInteger(msg.index)) line.index = msg.index;
    rep.classList.toggle("frozen", msg.frozen === true);
    paint(msg);
  }

  // Back to the centred page: hold, fade the bubbles, glide home.
  function settle() {
    clearTimers();
    if (layout === "idle") return;
    holdTimer = setTimeout(() => {
      holdTimer = 0;
      main.dataset.leaving = "";
      leaveTimer = setTimeout(() => {
        leaveTimer = 0;
        delete main.dataset.leaving;
        resetYou();
        resetOrbi();
        setLayout("idle");
      }, reduced() ? 0 : LEAVE_MS);
    }, HOLD_MS);
  }

  function onState(next) {
    if (!STATES.includes(next)) return;
    const prev = state;
    state = next;
    if (next === "listening") {
      if (prev !== "listening") begin();
      return;
    }
    if (next === "idle") { settle(); return; }
    // Thinking or speaking (a typed turn starts here, or a reload mid-turn).
    if (layout === "idle" || main.dataset.leaving != null) begin();
    else clearTimers();
    showOrbi();
  }

  function onSubtitle(msg) {
    if (typeof msg.text !== "string") return;
    if (msg.speaker === "user") {
      // Typed words, or a turn that started before the page heard its state.
      // After a reply on screen, it is a new turn.
      if (layout === "idle" || main.dataset.leaving != null || main.dataset.mode === "text") begin();
      setYou(msg.text);
      if (state === "idle") settle();
    } else if (msg.speaker === "agent") {
      const id = typeof msg.utteranceId === "string" ? msg.utteranceId : null;
      if (id && id === line.id) return; // the same line again (a replay)
      if (layout === "idle" || main.dataset.leaving != null) begin();
      else clearTimers();
      setOrbi(msg.text, id, !!id && msg.karaoke === true);
      if (state === "idle") settle();
    }
  }

  resetYou();
  resetOrbi();
  return {
    onState,
    onSubtitle,
    onWord,
    // Words sent from the "Type to Orbi" box: shown at once.
    onTyped: (text) => { if (words(text).length) onSubtitle({ speaker: "user", text, final: true }); },
    get layout() { return layout; },
  };
}
