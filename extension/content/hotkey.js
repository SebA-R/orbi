// Hold-to-talk hotkey, a classic content script on every page.
//
// The default is plain Space. Touching it starts recording at once, silently
// (PTT_START {silent: true}), so the first word is never lost. If it is still
// down after CONFIRM_MS it is a hold: PTT_CONFIRM makes the chime and the
// listening state appear, and the audio from the first moment is kept.
// Letting go before that is a tap: PTT_CANCEL throws the audio away and the
// tap does what Space normally does (press the focused button, or scroll).
// In text fields plain Space just types a space.
//
// The modifier hotkeys (Alt+Space, Ctrl+Shift+Space, F9) can't be a typing
// key, so they confirm straight away and work inside text fields too.
// Releasing the key (or one of its modifiers) sends PTT_STOP. Key repeat is
// ignored. Only the hotkey itself is preventDefault-ed.
//
// Content scripts declared in the manifest can't be ES modules, so this file
// is self-contained. RT values must match lib/protocol.js.

(() => {
  const RT = { PTT_START: "ptt.start", PTT_STOP: "ptt.stop", PTT_CONFIRM: "ptt.confirm", PTT_CANCEL: "ptt.cancel" };
  const CONFIRM_MS = 200;

  // Same names as HOTKEYS in lib/settings.js.
  const SPECS = {
    Space: { code: "Space", alt: false, ctrl: false, shift: false, meta: false, confirmMs: CONFIRM_MS },
    "Alt+Space": { code: "Space", alt: true, ctrl: false, shift: false, meta: false, confirmMs: 0 },
    "Ctrl+Shift+Space": { code: "Space", alt: false, ctrl: true, shift: true, meta: false, confirmMs: 0 },
    F9: { code: "F9", alt: false, ctrl: false, shift: false, meta: false, confirmMs: 0 },
  };
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
  // tap. Returns { onKeyDown, onKeyUp, cancel, setHotkey, held }.
  function createHoldDetector({
    hotkey = "Space", send, onTap = () => {},
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
  }) {
    let spec = SPECS[hotkey] || SPECS.Space;
    let held = false;
    let confirmed = false;
    let timer = null;
    const release = () => {
      held = false;
      if (timer != null) clearTimer(timer);
      timer = null;
      const wasConfirmed = confirmed;
      confirmed = false;
      send(wasConfirmed ? RT.PTT_STOP : RT.PTT_CANCEL);
      return wasConfirmed;
    };
    return {
      get held() { return held; },
      setHotkey(name) {
        if (held) this.cancel();
        spec = SPECS[name] || SPECS.Space;
      },
      onKeyDown(e) {
        if (!matches(spec, e)) return;
        if (spec.confirmMs && !held && isTextEntry(targetOf(e))) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat || held) return;
        held = true;
        if (!spec.confirmMs) {
          confirmed = true;
          send(RT.PTT_START);
          return;
        }
        confirmed = false;
        send(RT.PTT_START, { silent: true });
        timer = setTimer(() => {
          timer = null;
          if (!held) return;
          confirmed = true;
          send(RT.PTT_CONFIRM);
        }, spec.confirmMs);
      },
      onKeyUp(e) {
        if (!held || !releasesHold(spec, e)) return;
        if (e.code === spec.code) {
          e.preventDefault();
          e.stopPropagation();
        }
        if (!release()) onTap(e);
      },
      // Focus left the page mid-hold (window switch, tab switch): we will never see the keyup.
      cancel() {
        if (held) release();
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
    win.addEventListener("keydown", (e) => detector.onKeyDown(e), true);
    win.addEventListener("keyup", (e) => detector.onKeyUp(e), true);
    win.addEventListener("blur", () => detector.cancel());
    doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "hidden") detector.cancel(); });

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
    Object.assign(globalThis.__clearcartHotkeyTest, { createHoldDetector, install, isTextEntry, isPressable, SPECS, RT, CONFIRM_MS });
  } else if (globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id) {
    install();
  }
})();
