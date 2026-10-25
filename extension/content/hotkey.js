// Hold-to-talk hotkey, a classic content script on every page.
//
// The default is plain Space. Touching it starts recording at once, silently
// (PTT_START {silent: true}), so the first word is never lost. If it is still
// down after CONFIRM_MS it is a hold: PTT_CONFIRM makes the chime and the
// listening state appear, and the audio from the first moment is kept.
// Letting go before that is a tap: PTT_CANCEL throws the audio away and the
// tap does what Space normally does (press the focused button, or scroll).
// In text fields plain Space just types a space. Releasing a confirmed hold
// sends PTT_STOP, so nothing listens after you let go.
//
// With Space as the talk key, Option+Space (Alt+Space) latches, everywhere
// including text fields: one press sends PTT_START {latch: true} and listening
// stays on after you let go. The next Space or Option+Space (even in a text
// field) sends PTT_STOP and is swallowed: no new hold, no typed space. The
// controller also stops a latch after a minute without speech. The latch is
// also learned from VOICE_STATE {latched}, so other frames and the toggle
// command's hands-free session end on Space the same way.
//
// Double-tap Space while Clearcart is speaking: the first tap ducks the speech
// (silent start) and, instead of bringing it back, waits DOUBLE_TAP_MS for a
// second tap, which sends PTT_HUSH (hard stop plus a boop). A second press
// that is held instead barges in as usual. Both taps are consumed. When not
// speaking, taps behave exactly as before.
//
// The other selectable hotkeys (Alt+Space, Ctrl+Shift+Space, F9) are
// hold-to-talk: they can't be a typing key, so they confirm straight away and
// work inside text fields too. Releasing the key (or one of its modifiers)
// sends PTT_STOP. Key repeat is ignored. Only the hotkey is preventDefault-ed.
//
// Content scripts declared in the manifest can't be ES modules, so this file
// is self-contained. RT values must match lib/protocol.js.

(() => {
  const RT = {
    PTT_START: "ptt.start", PTT_STOP: "ptt.stop", PTT_CONFIRM: "ptt.confirm", PTT_CANCEL: "ptt.cancel", PTT_HUSH: "ptt.hush",
    VOICE_STATE: "voice.state", VOICE_STATE_QUERY: "voice.state.query",
  };
  const CONFIRM_MS = 200;
  const DOUBLE_TAP_MS = 350; // second tap within this long after the first: hush

  // Same names as HOTKEYS in lib/settings.js.
  const SPECS = {
    Space: { code: "Space", alt: false, ctrl: false, shift: false, meta: false, confirmMs: CONFIRM_MS },
    "Alt+Space": { code: "Space", alt: true, ctrl: false, shift: false, meta: false, confirmMs: 0 },
    "Ctrl+Shift+Space": { code: "Space", alt: false, ctrl: true, shift: true, meta: false, confirmMs: 0 },
    F9: { code: "F9", alt: false, ctrl: false, shift: false, meta: false, confirmMs: 0 },
  };
  // A second key that also talks, for hotkeys that can't work in text fields.
  // It latches: one press listens until the next Space or Option+Space.
  const ALSO = { Space: "Alt+Space" };
  const MODIFIER_CODES = {
    alt: ["AltLeft", "AltRight"],
    ctrl: ["ControlLeft", "ControlRight"],
    shift: ["ShiftLeft", "ShiftRight"],
    meta: ["MetaLeft", "MetaRight"],
  };
  const NON_TEXT_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio", "image", "range", "color", "file"]);
  const PRESSABLE_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio", "image"]);
  const PRESSABLE_ROLES = new Set(["button", "checkbox", "switch", "radio", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option"]);

  function matches(spec, e) {
    return e.code === spec.code
      && !!e.altKey === spec.alt && !!e.ctrlKey === spec.ctrl
      && !!e.shiftKey === spec.shift && !!e.metaKey === spec.meta;
  }

  function releasesHold(spec, e) {
    if (e.code === spec.code) return true;
    for (const mod of ["alt", "ctrl", "shift", "meta"]) {
      if (spec[mod] && MODIFIER_CODES[mod].includes(e.code)) return true;
    }
    return false;
  }

  // Where a plain Space should type a space instead of talking.
  function isTextEntry(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName.toUpperCase();
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    return tag === "INPUT" && !NON_TEXT_INPUTS.has(String(el.type || "text").toLowerCase());
  }

  // What a Space press would have activated, if anything.
  function isPressable(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    if (tag === "BUTTON" || tag === "SUMMARY") return true;
    if (tag === "INPUT") return PRESSABLE_INPUTS.has(String(el.type || "").toLowerCase());
    const role = el.getAttribute && el.getAttribute("role");
    return !!role && PRESSABLE_ROLES.has(role);
  }

  function targetOf(e) {
    const path = typeof e.composedPath === "function" ? e.composedPath() : null;
    return (path && path[0]) || e.target;
  }

  // send(type, extra) delivers a runtime message; onTap() replays a plain Space
  // tap. Returns { onKeyDown, onKeyUp, cancel, setHotkey, setVoiceState, held, latched }.
  function createHoldDetector({
    hotkey = "Space", send, onTap = () => {},
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
    doubleTapMs = DOUBLE_TAP_MS,
  }) {
    let specs = [];
    let spec = null; // the spec of the current hold
    const use = (name) => {
      const key = SPECS[name] ? name : "Space";
      specs = [SPECS[key], ...(ALSO[key] ? [{ ...SPECS[ALSO[key]], latch: true }] : [])];
      spec = specs[0];
    };
    use(hotkey);
    let held = false;
    let confirmed = false;
    let timer = null;
    let latched = false; // hands-free listening (ours, or reported by VOICE_STATE)
    let voiceState = "idle";
    let swallowUp = null; // the keyup of a press we already acted on
    let pendingTap = null; // a tap while speaking, waiting to see if a second one follows
    let secondTap = false; // this press continues a pending tap's silent start

    const clearHoldTimer = () => {
      if (timer != null) clearTimer(timer);
      timer = null;
    };
    // The first tap was alone after all: bring the ducked speech back.
    const flushPending = () => {
      if (pendingTap == null) return;
      clearTimer(pendingTap);
      pendingTap = null;
      send(RT.PTT_CANCEL);
    };
    const consume = (e) => { e.preventDefault(); e.stopPropagation(); };
    // Space, Option+Space or the talk key ends a latch, even in a text field.
    const endsLatch = (e) => e.code === "Space"
      ? !e.ctrlKey && !e.shiftKey && !e.metaKey
      : specs.some((s) => matches(s, e));

    // A hold ended (e is its keyup) or was abandoned (no e: focus left).
    const release = (e) => {
      held = false;
      clearHoldTimer();
      const wasConfirmed = confirmed;
      const wasSecond = secondTap;
      confirmed = false;
      secondTap = false;
      if (wasConfirmed) return send(RT.PTT_STOP);
      if (!e) return send(RT.PTT_CANCEL);
      // Second quick tap while speaking: hard-stop the speech.
      if (wasSecond) return send(RT.PTT_HUSH);
      // First quick tap while speaking: keep it ducked and wait for a second.
      if (voiceState === "speaking") {
        pendingTap = setTimer(() => { pendingTap = null; send(RT.PTT_CANCEL); }, doubleTapMs);
        return;
      }
      send(RT.PTT_CANCEL);
      onTap(e);
    };
    return {
      get held() { return held; },
      get latched() { return latched; },
      setHotkey(name) {
        if (held) this.cancel();
        use(name);
      },
      // From the worker's VOICE_STATE broadcast.
      setVoiceState(state, isLatched) {
        voiceState = state;
        if (state === "listening") { if (isLatched) latched = true; } else latched = false;
      },
      onKeyDown(e) {
        if (latched) {
          if (!endsLatch(e)) return;
          consume(e);
          swallowUp = e.code;
          if (e.repeat) return;
          latched = false;
          send(RT.PTT_STOP);
          return;
        }
        const hit = held ? (matches(spec, e) ? spec : null) : specs.find((s) => matches(s, e));
        if (!hit) return;
        spec = hit;
        if (spec.confirmMs && !held && isTextEntry(targetOf(e))) { flushPending(); return; }
        consume(e);
        if (e.repeat || held) return;
        if (spec.latch) {
          flushPending();
          latched = true;
          swallowUp = e.code;
          send(RT.PTT_START, { latch: true });
          return;
        }
        held = true;
        if (!spec.confirmMs) {
          flushPending();
          confirmed = true;
          send(RT.PTT_START);
          return;
        }
        confirmed = false;
        if (pendingTap != null) {
          // Within the double-tap window: the first tap's silent start (and its
          // ducking) carries on into this press.
          clearTimer(pendingTap);
          pendingTap = null;
          secondTap = true;
        } else {
          secondTap = false;
          send(RT.PTT_START, { silent: true });
        }
        timer = setTimer(() => {
          timer = null;
          if (!held) return;
          confirmed = true;
          send(RT.PTT_CONFIRM);
        }, spec.confirmMs);
      },
      onKeyUp(e) {
        if (swallowUp != null && e.code === swallowUp) {
          swallowUp = null;
          consume(e);
          return;
        }
        if (!held || !releasesHold(spec, e)) return;
        if (e.code === spec.code) consume(e);
        release(e);
      },
      // Focus left the page mid-hold (window switch, tab switch): we will never
      // see the keyup. A latch is hands-free, so it stays on.
      cancel() {
        swallowUp = null;
        if (held) release();
        flushPending();
      },
      // The tab was hidden: the worker stops telling it the voice state, and
      // tells it again (replay) when it comes back.
      forgetVoiceState() {
        this.cancel();
        voiceState = "idle";
        latched = false;
      },
    };
  }

  function install({ win = globalThis.window, doc = globalThis.document, chromeApi = globalThis.chrome } = {}) {
    if (!win || win.__clearcartHotkey) return win && win.__clearcartHotkey;
    const send = (type, extra) => {
      try {
        const p = chromeApi.runtime.sendMessage({ type, ...extra });
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        // Extension reloaded or worker unreachable; nothing useful to do from a page.
      }
    };
    // A quick tap of plain Space: do what Space would have done.
    const onTap = () => {
      const el = doc.activeElement;
      if (isPressable(el)) el.click();
      else win.scrollBy({ top: win.innerHeight * 0.85, behavior: "smooth" });
    };
    const detector = createHoldDetector({ send, onTap });
    // After an extension reload this copy is orphaned (runtime.id goes away)
    // and the worker injects a fresh one, so this copy steps aside.
    const myId = chromeApi.runtime && chromeApi.runtime.id;
    const orphaned = () => { try { return !!myId && !chromeApi.runtime.id; } catch { return true; } };
    const onDown = (e) => { if (orphaned()) return detach(); detector.onKeyDown(e); };
    const onUp = (e) => { if (orphaned()) return detach(); detector.onKeyUp(e); };
    const detach = () => {
      detector.cancel();
      win.removeEventListener("keydown", onDown, true);
      win.removeEventListener("keyup", onUp, true);
    };
    win.addEventListener("keydown", onDown, true);
    win.addEventListener("keyup", onUp, true);
    win.addEventListener("blur", () => detector.cancel());
    // Hidden, the tab may stop hearing the voice state; visible again, it asks.
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "hidden") detector.forgetVoiceState();
      else send(RT.VOICE_STATE_QUERY);
    });
    // The worker sends the voice state to the tab that is talking (all frames).
    chromeApi.runtime.onMessage?.addListener((msg) => {
      if (!msg || orphaned()) return;
      if (msg.type === RT.VOICE_STATE) detector.setVoiceState(msg.state, msg.latched === true);
    });

    const storage = chromeApi.storage && chromeApi.storage.local;
    if (storage) {
      Promise.resolve(storage.get("hotkey")).then((r) => { if (r && r.hotkey) detector.setHotkey(r.hotkey); }).catch(() => {});
      chromeApi.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.hotkey) detector.setHotkey(changes.hotkey.newValue);
      });
    }
    win.__clearcartHotkey = detector;
    return detector;
  }

  if (typeof globalThis.__clearcartHotkeyTest === "object") {
    Object.assign(globalThis.__clearcartHotkeyTest, { createHoldDetector, install, isTextEntry, isPressable, SPECS, RT, CONFIRM_MS, DOUBLE_TAP_MS });
  } else if (globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id) {
    install();
  }
})();
