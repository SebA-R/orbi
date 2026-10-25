// Hold-to-talk hotkey, a classic content script on every page.
//
// The default is plain Space. Touching it starts recording at once, silently
// (PTT_START {silent: true}), so the first word is never lost. If it is still
// down after CONFIRM_MS it is a hold: PTT_CONFIRM makes the listen sound and the
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
// Double-tap Space while Orbi is speaking: the first tap ducks the speech
// (silent start) and, instead of bringing it back, waits DOUBLE_TAP_MS for a
// second tap, which sends PTT_HUSH (hard stop plus the cut-off sound). A second press
// that is held instead barges in as usual. Both taps are consumed. When not
// speaking, taps behave exactly as before.
//
// The other selectable hotkeys (Alt+Space, Ctrl+Shift+Space, F9) are
// hold-to-talk: they can't be a typing key, so they confirm straight away and
// work inside text fields too. Releasing the key (or one of its modifiers)
// sends PTT_STOP. Key repeat is ignored. Only the hotkey is preventDefault-ed.
// A key press that is part of an IME composition is never a hotkey.
// Synthetic key events (isTrusted false) from page scripts are ignored.
//
// Shadow DOM and frames: "is the user typing?" looks at the focused element
// through open shadow roots (and closed ones, through chrome.dom where the
// content script has it). The manifest runs this script in every frame, so
// each frame has its own detector and the key goes to whichever has focus;
// they all talk to the worker's one voice controller, which ignores a second
// start while listening. Focus leaving a frame mid-hold blurs it, which ends
// that hold. A frame whose page rewrites it with document.open() gets its
// listeners back. As a backstop, a talk-key keyup in a frame that did not see the
// press ends a hold (not a latch) another frame of this tab left open.
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
  const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox"]);
  // Custom elements that are text fields by name (sl-input, md-outlined-text-field,
  // vaadin-text-field, lightning-textarea, x-editor...), for a focused host
  // whose shadow root can't be read or holds no focused field.
  const EDITABLE_TAG = /-(input|textarea|text-?field|textbox|searchbox|search-input|combobox|autocomplete|editor|composer)$/i;
  const NOT_EDITABLE_TAG = /-(file|checkbox|radio|toggle|switch|range|color|slider)-input$/i;

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

  function attr(el, name) {
    try { return typeof el.getAttribute === "function" ? el.getAttribute(name) : null; } catch { return null; }
  }

  // el's shadow root: open, or closed through chrome.dom (content scripts only).
  function shadowRootOf(el, dom) {
    try { if (el.shadowRoot) return el.shadowRoot; } catch {}
    if (dom && typeof dom.openOrClosedShadowRoot === "function") {
      try { return dom.openOrClosedShadowRoot(el) || null; } catch {}
    }
    return null;
  }

  // The element that really has focus, from el down through shadow roots.
  function deepFocus(el, dom) {
    for (let i = 0; el && i < 32; i++) {
      const root = shadowRootOf(el, dom);
      const inner = root && root.activeElement;
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // Where a plain Space should type a space instead of talking.
  function isTextEntry(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName).toUpperCase();
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") return !NON_TEXT_INPUTS.has(String(el.type || "text").toLowerCase());
    const role = String(attr(el, "role") || "").trim().split(/\s+/)[0].toLowerCase();
    if (EDITABLE_ROLES.has(role)) return true;
    const editable = attr(el, "contenteditable");
    if (editable != null && String(editable).toLowerCase() !== "false") return true;
    return EDITABLE_TAG.test(tag) && !NOT_EDITABLE_TAG.test(tag);
  }

  // Is the key event e typed into a text field, here or in a shadow root?
  function isTyping(e, dom) {
    return isTextEntry(deepFocus(targetOf(e), dom));
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
    doubleTapMs = DOUBLE_TAP_MS, dom = null,
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
        // Space confirms or spaces an IME candidate: never ours.
        if (e.isComposing || e.keyCode === 229) return;
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
        if (spec.confirmMs && !held && isTyping(e, dom)) { flushPending(); return; }
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
        if (!held) {
          // The press began in another frame of this tab and focus moved
          // here before the release: still a release. Only for a hold that
          // is listening; a latch stays on.
          // Only the talk key itself, never in a text field or an IME.
          if (!latched && voiceState === "listening" && !e.isComposing && specs.some((s) => !s.latch && e.code === s.code)
            && !isTyping(e, dom)) {
            consume(e);
            voiceState = "idle";
            send(RT.PTT_STOP);
          }
          return;
        }
        if (!releasesHold(spec, e)) return;
        if (e.code === spec.code) consume(e);
        release(e);
      },
      // Focus left the page mid-hold (window switch, tab switch): we will never
      // see the keyup. A latch is hands-free, so it stays on.
      cancel() {
        swallowUp = null;
        // Focus left: a listening hold reported here is over or another
        // window's, and this frame may stop hearing the state, so forget it.
        if (voiceState === "listening" && !latched) voiceState = "idle";
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
    const dom = chromeApi && chromeApi.dom;
    const onTap = () => {
      const el = deepFocus(doc.activeElement, dom);
      if (isPressable(el)) el.click();
      else win.scrollBy({ top: win.innerHeight * 0.85, behavior: "smooth" });
    };
    const detector = createHoldDetector({ send, onTap, dom });
    // After an extension reload this copy is orphaned (runtime.id goes away)
    // and the worker injects a fresh one, so this copy steps aside.
    const myId = chromeApi.runtime && chromeApi.runtime.id;
    const orphaned = () => { try { return !!myId && !chromeApi.runtime.id; } catch { return true; } };
    // A press another listener already took (a second Orbi build, such
    // as Orbi Preview, registered first in this frame) is left to it, so
    // one press never opens two mics. Never while ours is held or latched:
    // that press may be the one that ends it.
    // Only the user's own keys: a page's synthetic events never talk.
    const onDown = (e) => {
      if (e.isTrusted === false) return;
      if (orphaned()) return detach();
      if (e.defaultPrevented && !detector.held && !detector.latched) return;
      detector.onKeyDown(e);
    };
    const onUp = (e) => { if (e.isTrusted === false) return; if (orphaned()) return detach(); detector.onKeyUp(e); };
    const onLeave = () => detector.cancel();
    // Hidden, the tab may stop hearing the voice state; visible again, it asks.
    const onVisibility = () => {
      if (doc.visibilityState === "hidden") detector.forgetVoiceState();
      else send(RT.VOICE_STATE_QUERY);
    };
    let rewrites = null;
    const detach = () => {
      detector.cancel();
      win.removeEventListener("keydown", onDown, true);
      win.removeEventListener("keyup", onUp, true);
      if (rewrites) rewrites.disconnect();
    };
    // Adding a listener that is already there does nothing, so this can run
    // again.
    const listen = () => {
      // Navigating away or removing this frame mid-hold: its keyup will never
      // come here, so release now rather than leave the mic listening.
      win.addEventListener("pagehide", onLeave);
      win.addEventListener("keydown", onDown, true);
      win.addEventListener("keyup", onUp, true);
      win.addEventListener("blur", onLeave);
      doc.addEventListener("visibilitychange", onVisibility);
    };
    listen();
    // document.open() (a page writing a frame's document, as iframe rich-text
    // editors do) erases every listener on the window and the document, ours
    // too, and replaces the document's children: put ours back then.
    try {
      rewrites = new win.MutationObserver(() => { if (!orphaned()) listen(); });
      rewrites.observe(doc, { childList: true });
    } catch {}
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
    Object.assign(globalThis.__clearcartHotkeyTest, { createHoldDetector, install, isTextEntry, isPressable, deepFocus, isTyping, SPECS, RT, CONFIRM_MS, DOUBLE_TAP_MS });
  } else if (globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id) {
    install();
  }
})();
