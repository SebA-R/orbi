// Basic voice, speech to text: Chrome's Web Speech API
// (webkitSpeechRecognition) for when the agent server has no Cartesia key.
// Same surface as SttSession in stt.js: open(), sendAudio() (unused: the
// recognizer opens the mic itself), finish(), abort(), and the handlers
// onTurnStart, onPartial(text), onFinal(text), onError(msg), onClosed().
//
// Each final result is one segment (onFinal), and the results not final yet
// are the open partial (onPartial), which is how the controller already
// treats Ink's turns. Chrome may end recognition on its own after a pause;
// while the key is still held it is started again (up to MAX_RESTARTS).
//
// Chrome's recognizer sends the audio to Google's speech service. Where it
// can't run (no recognizer in this context, blocked, offline), onError says
// so and onUnavailable(code) fires, so the voice can point at typing.
export const MAX_RESTARTS = 5;
export const FINISH_WAIT_MS = 4000;
// Errors that mean recognition can't work here, not just this once.
export const UNAVAILABLE = new Set(["not-allowed", "service-not-allowed", "network", "language-not-supported", "unsupported"]);

const MESSAGES = {
  "not-allowed": "Chrome's speech recognition is blocked here. Type to Orbi in the toolbar popup or on the new tab page.",
  "service-not-allowed": "Chrome's speech recognition is not available. Type to Orbi in the toolbar popup or on the new tab page.",
  network: "Chrome's speech recognition needs the internet. Type to Orbi in the toolbar popup or on the new tab page.",
  "language-not-supported": "Chrome's speech recognition doesn't support this language. Type to Orbi in the toolbar popup or on the new tab page.",
  "audio-capture": "Chrome's speech recognition could not use the microphone.",
  unsupported: "This Chrome has no speech recognition. Type to Orbi in the toolbar popup or on the new tab page.",
};

export function recognitionClass(g = globalThis) {
  return g.SpeechRecognition || g.webkitSpeechRecognition || null;
}

export class WebSpeechSttSession {
  constructor({ Recognition = recognitionClass(), lang = globalThis.navigator?.language || "en-US", handlers, log = () => {}, onUnavailable = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) }) {
    Object.assign(this, { Recognition, lang, h: handlers, log, onUnavailable, setTimer, clearTimer });
    this.rec = null;
    this.finishing = false;
    this.closed = false;
    this.fatal = false;
    this.restarts = 0;
    this.started = false; // onTurnStart sent
    this.openText = "";
    this.timer = null;
  }

  open() {
    if (this.closed) return;
    if (!this.Recognition) return this.#fail("unsupported");
    this.#startOne();
  }

  #startOne() {
    let rec;
    try {
      rec = new this.Recognition();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = this.lang;
      rec.maxAlternatives = 1;
    } catch (err) {
      this.log(`speech recognition could not start: ${err && err.message}`);
      return this.#fail("unsupported");
    }
    const finals = new Set(); // result indexes already sent as finals, for this recognizer
    rec.onresult = (e) => {
      if (this.closed || this.rec !== rec) return;
      if (!this.started) {
        this.started = true;
        this.h.onTurnStart();
      }
      let open = "";
      const results = e.results || [];
      for (let i = e.resultIndex || 0; i < results.length; i++) {
        const r = results[i];
        const text = String((r && r[0] && r[0].transcript) || "").trim();
        if (r && r.isFinal) {
          if (finals.has(i)) continue;
          finals.add(i);
          if (text) this.h.onFinal(text);
        } else if (text) open = open ? `${open} ${text}` : text;
      }
      this.openText = open;
      if (open) this.h.onPartial(open);
    };
    rec.onerror = (e) => {
      if (this.closed || this.rec !== rec) return;
      const code = String((e && e.error) || "unknown");
      if (code === "no-speech" || code === "aborted") return this.log(`speech recognition: ${code}`);
      this.fatal = true;
      if (UNAVAILABLE.has(code)) this.onUnavailable(code);
      this.h.onError(MESSAGES[code] || `Speech recognition error: ${code}`);
    };
    rec.onend = () => {
      if (this.closed || this.rec !== rec) return;
      // Ended on its own while the key is held: listen again.
      if (!this.finishing && !this.fatal && this.restarts < MAX_RESTARTS) {
        this.restarts++;
        const open = this.openText.trim();
        this.openText = "";
        if (open) this.h.onFinal(open); // the old recognizer's last words

        return this.#startOne();
      }
      this.#done();
    };
    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.log(`speech recognition could not start: ${err && err.message}`);
      this.#fail("unsupported");
    }
  }

  sendAudio() {}

  // Released: let Chrome send the last results, then close.
  finish() {
    if (this.closed || this.finishing) return;
    this.finishing = true;
    try { this.rec && this.rec.stop(); } catch {}
    this.timer = this.setTimer(() => this.#done(), FINISH_WAIT_MS);
  }

  abort() {
    this.openText = "";
    this.finishing = true;
    const rec = this.rec;
    this.rec = null;
    try { rec && rec.abort(); } catch {}
    this.#done();
  }

  #fail(code) {
    this.fatal = true;
    if (UNAVAILABLE.has(code)) this.onUnavailable(code);
    this.h.onError(MESSAGES[code] || `Speech recognition error: ${code}`);
    this.#done();
  }

  #done() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    const rec = this.rec;
    this.rec = null;
    if (rec && !this.finishing) try { rec.abort(); } catch {}
    // Words still open when it ends count, like Ink's unfinished turn.
    const leftover = this.openText.trim();
    this.openText = "";
    if (leftover) this.h.onFinal(leftover);
    this.h.onClosed();
  }
}
