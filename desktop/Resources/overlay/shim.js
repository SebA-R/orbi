// The chrome.* the extension's content scripts expect, inside Orbi
// Desktop's overlay page. Loaded first, before ext/orb-face.js,
// ext/subtitles.js, ext/frame.js and ext/cursor.js, which are the
// extension's own files, copied in unchanged.
//
//   chrome.runtime.onMessage  a local bus: __orbiBus.send(msg) delivers msg
//                             to every listener, like a message from the
//                             extension's worker
//   chrome.storage            the helper's own settings (showCursor, from
//                             its menu): __orbiBus.setting(key, value)
//                             stores one and tells the onChanged listeners;
//                             any other setting has its default
//
// The scripts keep their shadow roots closed. The bridge needs to see the
// subtitle card (to put the native blur behind it), so attachShadow also
// records each root by its host's tag name. This page runs no other code.
(() => {
  "use strict";
  const listeners = [];
  const settings = {};
  const changed = [];
  const roots = new Map();
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = attach.call(this, init);
    roots.set(this.localName, root);
    return root;
  };
  globalThis.chrome = {
    runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } },
    storage: {
      local: { get: async (k) => (typeof k === "string" && k in settings ? { [k]: settings[k] } : {}) },
      onChanged: { addListener: (fn) => changed.push(fn) },
    },
  };
  globalThis.__orbiBus = Object.freeze({
    send(msg) {
      for (const fn of listeners) {
        try { fn(msg, {}, () => {}); } catch (e) { console.error(e); }
      }
    },
    root: (tag) => roots.get(tag) || null,
    setting(key, value) {
      if (settings[key] === value) return;
      const oldValue = settings[key];
      settings[key] = value;
      for (const fn of changed) {
        try { fn({ [key]: { oldValue, newValue: value } }, "local"); } catch (e) { console.error(e); }
      }
    },
  });
})();
