// Basic voice in the worker: runs chrome.tts for the offscreen document's
// BasicSpeaker (lib/voice/basic-tts.js), which can't call it itself
// (offscreen documents only get chrome.runtime).
//
//   offscreen -> worker  { type: BASIC_TTS, from: "offscreen", op, id?, text?, rate? }
//                        op: speak (queued after earlier lines), stop, pause, resume
//   worker -> offscreen  { type: BASIC_TTS_EVENT, target: "offscreen", id, event, charIndex?, errorMessage? }
//
// Only the offscreen document's messages count: not a tab's content script.
import { RT } from "../lib/protocol.js";

export const OFFSCREEN_URL_PATH = "offscreen/offscreen.html";
const EVENTS = new Set(["start", "word", "end", "interrupted", "cancelled", "error"]);

export function createBasicTtsHost({ chromeApi = globalThis.chrome, log = () => {} } = {}) {
  const offscreenUrl = () => chromeApi.runtime.getURL(OFFSCREEN_URL_PATH);
  const send = (msg) => {
    try { chromeApi.runtime.sendMessage({ ...msg, target: "offscreen" })?.catch?.(() => {}); } catch {}
  };

  function onMessage(msg, sender = {}) {
    if (!msg || msg.type !== RT.BASIC_TTS || msg.from !== "offscreen") return false;
    if (sender.tab || sender.id !== chromeApi.runtime.id || sender.url !== offscreenUrl()) return false;
    const tts = chromeApi.tts;
    if (!tts) {
      if (msg.op === "speak") send({ type: RT.BASIC_TTS_EVENT, id: msg.id, event: "error", errorMessage: "chrome.tts is not available" });
      return true;
    }
    switch (msg.op) {
      case "speak": {
        const id = String(msg.id || "");
        const text = String(msg.text || "").slice(0, 32_000);
        const rate = Math.min(10, Math.max(0.1, Number(msg.rate) || 1));
        if (!id || !text) return true;
        tts.speak(text, {
          rate,
          enqueue: true,
          onEvent: (e) => {
            if (!e || !EVENTS.has(e.type)) return;
            send({ type: RT.BASIC_TTS_EVENT, id, event: e.type, ...(Number.isFinite(e.charIndex) ? { charIndex: e.charIndex } : {}), ...(e.errorMessage ? { errorMessage: String(e.errorMessage) } : {}) });
          },
        }, () => {
          const err = chromeApi.runtime.lastError;
          if (err) {
            log(`chrome.tts.speak failed: ${err.message}`);
            send({ type: RT.BASIC_TTS_EVENT, id, event: "error", errorMessage: err.message });
          }
        });
        return true;
      }
      case "stop":
        tts.stop();
        return true;
      case "pause":
        tts.pause();
        return true;
      case "resume":
        tts.resume();
        return true;
      default:
        return true;
    }
  }

  return { onMessage };
}

export function installBasicTtsHost(opts = {}) {
  const chromeApi = opts.chromeApi || globalThis.chrome;
  const host = createBasicTtsHost({ ...opts, chromeApi });
  chromeApi.runtime.onMessage.addListener((msg, sender) => { host.onMessage(msg, sender); });
  return host;
}
