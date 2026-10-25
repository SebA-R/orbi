// Basic voice, text to speech: Chrome's own voice (chrome.tts) for when the
// agent server has no Cartesia key. Same surface as Speaker in tts.js, so
// VoiceController can't tell them apart: speak, stop({release}), duck,
// unduck, captions, onSpeakingChange, onCaption.
//
// chrome.tts lives in the service worker, not in the offscreen document, so
// `engine` is a small relay (offscreen.js wires it to background/basic-tts-host.js):
//   engine.speak({ id, text, rate })   queue one line (enqueue, in order)
//   engine.stop()                      silence everything now
//   engine.pause() / engine.resume()   duck and unduck
// and the engine's events come back through onEvent({ id, event, charIndex }),
// event one of start, word, end, interrupted, cancelled, error.
//
// Captions: a line shows when Chrome starts saying it. Chrome's word events
// (charIndex) drive the karaoke where the voice sends them (most system
// voices do); a line with no word event within NO_WORDS_AFTER_MS shows
// plainly instead, like a Sonic line without timestamps. Each word's sweep
// length is estimated from its letters and the speed.
//
// Lines still in Chrome's queue after stop() can send late events; they
// carry an id stop() already forgot, so they are dropped. A line whose end
// never comes (the worker restarted mid-line) is let go after a generous
// estimate of its length, so the voice never stays "speaking".
import { captionWords } from "./karaoke.js";

export const NO_WORDS_AFTER_MS = 1000;
export const CHROME_TTS_MAX_RATE = 10;

// How long a word takes to say, roughly: for the caption's sweep only.
export const wordMs = (word, rate = 1) => Math.round((60 * String(word).length + 120) / Math.max(0.1, rate));
// Far more than a line could take, so the watchdog never cuts real speech.
const lineDeadlineMs = (text, rate) => 8000 + (3 * 1000 * String(text).length) / (12 * Math.max(0.1, rate));
// The line at the head of the queue gets this long to start.
export const START_DEADLINE_MS = 8000;

export class BasicSpeaker {
  constructor({
    engine, getSpeed = () => 1, log = () => {}, onSpeakingChange, onCaption,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t), now = () => Date.now(),
  }) {
    Object.assign(this, { engine, getSpeed, log, setTimer, clearTimer, now });
    this.onSpeakingChange = onSpeakingChange || (() => {});
    this.onCaption = onCaption || (() => {});
    this.captions = true; // the controller leaves agent captions to us
    this.queue = []; // lines in speaking order: { id, text, words, rate, started, index, plain, timer, deadline }
    this.speaking = false;
    this.ducked = false;
    this.seq = 0;
  }

  speak(text) {
    const words = captionWords(text);
    if (!words.length) return;
    const rate = Math.min(CHROME_TTS_MAX_RATE, Math.max(0.1, Number(this.getSpeed()) || 1));
    const line = { id: `bt-${Date.now().toString(36)}-${(this.seq++).toString(36)}`, text: words.join(" "), words, rate, started: false, index: -1, plain: false, timer: null, deadline: null, deadlineMs: 0 };
    this.queue.push(line);
    this.#setSpeaking(true);
    if (this.queue[0] === line) this.#armDeadline(line, START_DEADLINE_MS);
    try {
      this.engine.speak({ id: line.id, text: line.text, rate });
      // A line queued behind a ducked one waits paused too.
      if (this.ducked) this.engine.pause();
    } catch (err) {
      this.log(`basic TTS failed: ${err && err.message}`);
      this.#finish(line, true);
    }
  }

  duck() {
    if (this.ducked || !this.speaking) return;
    this.ducked = true;
    try { this.engine.pause(); } catch {}
  }

  unduck() {
    if (!this.ducked) return;
    this.ducked = false;
    try { this.engine.resume(); } catch {}
    const head = this.queue[0];
    if (head) this.#armDeadline(head, head.deadlineMs || START_DEADLINE_MS);
  }

  // Barge-in: silence now. release: Speak replies was just turned off, so
  // what was left of the reply shows in full instead of freezing.
  stop({ release = false } = {}) {
    const lines = this.queue;
    this.queue = [];
    for (const l of lines) this.#clearTimers(l);
    if (lines.length) {
      if (release) this.#release(lines);
      else this.#freeze(lines[0]);
    }
    this.ducked = false;
    try { this.engine.stop(); } catch {}
    this.#setSpeaking(false);
  }

  // An event from the engine, for a line of ours or one stop() dropped.
  onEvent(e) {
    if (!e || typeof e.id !== "string") return;
    const line = this.queue.find((l) => l.id === e.id);
    if (!line) return; // stopped or unknown: ignore
    switch (e.event) {
      case "start":
        this.#start(line);
        break;
      case "word":
        this.#start(line);
        this.#word(line, e.charIndex);
        break;
      case "end":
        this.#start(line);
        this.#finish(line, false);
        break;
      case "interrupted":
      case "cancelled":
      case "error":
        if (e.event === "error") this.log(`basic TTS error: ${e.errorMessage || "unknown"}`);
        this.#finish(line, true);
        break;
    }
  }

  #start(line) {
    if (line.started) return;
    // Lines go strictly in order: one before it that never reported is done.
    while (this.queue[0] && this.queue[0] !== line) this.#finish(this.queue[0], true);
    line.started = true;
    this.#armDeadline(line, lineDeadlineMs(line.text, line.rate));
    this.onCaption({ kind: "line", utteranceId: line.id, text: line.text, karaoke: true });
    line.timer = this.setTimer(() => {
      line.timer = null;
      if (line.index < 0 && !line.plain && this.queue.includes(line)) this.#plain(line);
    }, NO_WORDS_AFTER_MS);
  }

  #word(line, charIndex) {
    if (line.plain) return;
    const at = Number(charIndex);
    if (!Number.isFinite(at) || at < 0) return;
    const i = Math.min(line.words.length - 1, (line.text.slice(0, at).match(/ /g) || []).length);
    if (i <= line.index) return;
    line.index = i;
    this.onCaption({ kind: "word", utteranceId: line.id, index: i, ms: wordMs(line.words[i], line.rate), elapsed: 0 });
  }

  #plain(line) {
    line.plain = true;
    this.onCaption({ kind: "word", utteranceId: line.id, fallback: true });
  }

  // The line is over: heard to its end, or dropped (never shown in full yet).
  #finish(line, dropped) {
    const at = this.queue.indexOf(line);
    if (at < 0) return;
    this.queue.splice(at, 1);
    this.#clearTimers(line);
    if (!line.started) {
      // Never heard (an error before it began): show the words anyway.
      this.onCaption({ kind: "line", utteranceId: line.id, text: line.text, karaoke: false });
    } else if (!line.plain) {
      if (dropped && line.index < 0) this.#plain(line);
      else this.onCaption({ kind: "word", utteranceId: line.id, index: line.words.length, done: true });
    }
    if (!this.queue.length) {
      this.ducked = false;
      this.#setSpeaking(false);
    } else if (!this.queue[0].started) this.#armDeadline(this.queue[0], START_DEADLINE_MS);
  }

  #freeze(line) {
    if (!line.started || line.plain) return;
    if (line.index < 0) return this.#plain(line);
    this.onCaption({ kind: "word", utteranceId: line.id, index: line.index, frozen: true });
  }

  #release(lines) {
    const head = lines[0];
    if (lines.length === 1 && head.started) {
      if (!head.plain) this.#plain(head);
      return;
    }
    const text = lines.map((l) => l.text).join(" ");
    this.onCaption({ kind: "line", utteranceId: lines.at(-1).id, text, karaoke: false });
  }

  // The watchdog: a line that never starts or never ends (the worker
  // restarted mid-line) is let go, so the voice never stays "speaking".
  // Paused (ducked) time doesn't count: the deadline is re-armed on unduck.
  #armDeadline(line, ms) {
    if (line.deadline != null) this.clearTimer(line.deadline);
    line.deadlineMs = ms;
    line.deadline = this.setTimer(() => {
      line.deadline = null;
      if (!this.queue.includes(line)) return;
      if (this.ducked) return; // unduck re-arms it
      this.log("basic TTS: a line never reported back; moving on");
      this.#finish(line, !line.started);
    }, ms);
  }

  #clearTimers(line) {
    if (line.timer != null) this.clearTimer(line.timer);
    if (line.deadline != null) this.clearTimer(line.deadline);
    line.timer = null;
    line.deadline = null;
  }

  #setSpeaking(on) {
    if (on === this.speaking) return;
    this.speaking = on;
    this.onSpeakingChange(on);
  }
}
