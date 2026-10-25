// Hold-to-talk hotkey, a classic content script on every page.
//
// Hold the hotkey (default Alt+Space, i.e. Option+Space on a Mac) to talk:
// the first keydown sends PTT_START to the worker, releasing the key (or
// one of its modifiers) sends PTT_STOP. Key repeat is ignored. Only the
// hotkey itself is preventDefault-ed; every other key is left alone. The
// hotkeys need a modifier (or are a function key), so they also work inside
// text fields without typing anything.
//
// Content scripts declared in the manifest can't be ES modules, so this file
// is self-contained. RT values must match lib/protocol.js.

(() => {
  const RT = { PTT_START: "ptt.start", PTT_STOP: "ptt.stop" };

  // Same names as HOTKEYS in lib/settings.js.
  const SPECS = {
    "Alt+Space": { code: "Space", alt: true, ctrl: false, shift: false, meta: false },
    "Ctrl+Shift+Space": { code: "Space", alt: false, ctrl: true, shift: true, meta: false },
    F9: { code: "F9", alt: false, ctrl: false, shift: false, meta: false },
  };
  const MODIFIER_CODES = {
    alt: ["AltLeft", "AltRight"],
    ctrl: ["ControlLeft", "ControlRight"],
    shift: ["ShiftLeft", "ShiftRight"],
    meta: ["MetaLeft", "MetaRight"],
  };

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

  // send(type) delivers a runtime message; returns { onKeyDown, onKeyUp, cancel, setHotkey, held }.
  function createHoldDetector({ hotkey = "Alt+Space", send }) {
    let spec = SPECS[hotkey] || SPECS["Alt+Space"];
    let held = false;
    return {
      get held() { return held; },
      setHotkey(name) {
        if (held) this.cancel();
        spec = SPECS[name] || SPECS["Alt+Space"];
      },
      onKeyDown(e) {
        if (!matches(spec, e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat || held) return;
        held = true;
        send(RT.PTT_START);
      },
      onKeyUp(e) {
        if (!held || !releasesHold(spec, e)) return;
        if (e.code === spec.code) {
          e.preventDefault();
          e.stopPropagation();
        }
        held = false;
        send(RT.PTT_STOP);
      },
      // Focus left the page mid-hold (window switch, tab switch): we will never see the keyup.
      cancel() {
        if (!held) return;
        held = false;
        send(RT.PTT_STOP);
      },
    };
  }

  function install({ win = globalThis.window, doc = globalThis.document, chromeApi = globalThis.chrome } = {}) {
    if (!win || win.__clearcartHotkey) return win && win.__clearcartHotkey;
    const send = (type) => {
      try {
        const p = chromeApi.runtime.sendMessage({ type });
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        // Extension reloaded or worker unreachable; nothing useful to do from a page.
      }
    };
    const detector = createHoldDetector({ send });
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
    Object.assign(globalThis.__clearcartHotkeyTest, { createHoldDetector, install, SPECS, RT });
  } else if (globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id) {
    install();
  }
})();
