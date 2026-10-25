// Orbi new tab page: runs before content/hotkey.js,
// which this page loads unchanged.
//
// On a website those two only hear chrome.tabs.sendMessage from the worker.
// An extension page also hears every chrome.runtime.sendMessage broadcast:
// the offscreen document's raw VOICE_STATE and SUBTITLE (which the worker
// passes on only to the tab that is talking), the worker's messages to the
// offscreen document, and other tabs' hotkey messages. So every listener
// added here only gets what the worker sent this tab: from the worker and
// not addressed to the offscreen document.
(() => {
  "use strict";
  const ev = globalThis.chrome && chrome.runtime && chrome.runtime.onMessage;
  if (!ev || ev.__clearcartGuard) return;
  const worker = chrome.runtime.getURL(chrome.runtime.getManifest().background.service_worker);
  const add = ev.addListener.bind(ev);
  const remove = ev.removeListener.bind(ev);
  const wrapped = new Map();
  const fromWorker = (msg, sender) => !!msg && typeof msg === "object" && msg.target == null && msg.from == null
    && !!sender && sender.id === chrome.runtime.id && sender.url === worker;
  ev.addListener = (fn) => {
    const w = (msg, sender, reply) => (fromWorker(msg, sender) ? fn(msg, sender, reply) : undefined);
    wrapped.set(fn, w);
    add(w);
  };
  ev.removeListener = (fn) => {
    remove(wrapped.get(fn) || fn);
    wrapped.delete(fn);
  };
  ev.__clearcartGuard = true;
})();
