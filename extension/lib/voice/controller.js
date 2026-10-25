// The voice loop that runs in the offscreen document, with every browser
// dependency injected so it can be tested in node.
//
//   start()  PTT_START: barge-in (stop TTS), start chime, open an STT session,
//            route mic audio to it. state -> listening
//   start({ silent: true }) the key was just touched: record into the STT
//            session right away and duck our own speech to near silence, but
//            show nothing (no chime, no state, transcripts held back).
//            confirm() once the key is held makes it a normal start, keeping
//            the audio from the first moment; cancel() on a quick tap throws
//            it all away and brings the speech back up.
//   confirm() barge-in: hard-stop the speaker, send {type:"interrupt"} so the
//            agent stops the turn, and drop any agent_text that still arrives
//            from it until the next user_text goes out.
//   stop()   PTT_STOP: stop chime, 300 ms tail, then finish() so Ink flushes.
//            state -> thinking once something was said, else idle
//   start({ latch: true }) hands-free (Option+Space, or the toggle command):
//            listens until the next stop(). Finished phrases are held and sent
//            as one user_text after stop(). VOICE_STATE carries latched: true
//            so the page can say "Press Space to send" and end it on Space.
//            LATCH_IDLE_MS without speech stops it, so the mic never stays open.
//   hush()   double-tap Space while speaking: drop the first tap's silent
//            start, hard-stop the speech like a barge-in, play a soft boop.
//            Never listens or sends user_text (can't answer a read-back).
//   each STT turn.end -> {type:"user_text"} to the agent + VOICE_FINAL + SUBTITLE
//   agent_text -> Sonic + SUBTITLE(agent); status/receipt -> STATUS
//
// emit(msg) sends a runtime message (type from RT) towards the worker.
import { RT } from "../protocol.js";

export const STATES = Object.freeze({ IDLE: "idle", LISTENING: "listening", THINKING: "thinking", SPEAKING: "speaking" });
export const TAIL_MS = 300;
export const LATCH_IDLE_MS = 60_000;
const join = (parts) => parts.join(" ").replace(/\s+/g, " ").trim();

export class VoiceController {
  constructor({
    createStt, speaker, mic, chime, agent, emit,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
    resumeAudio = () => {}, log = () => {},
  }) {
    Object.assign(this, { createStt, speaker, mic, chime, agent, emit, setTimer, clearTimer, resumeAudio, log });
    this.listening = false;
    this.session = null;
    this.awaitingReply = false;
    this.speaking = false;
    this.state = STATES.IDLE;
    this.confirmed = false;
    this.held = []; // transcript events from a silent start, replayed on confirm()
    this.muted = false; // after a barge-in: agent_text from the interrupted turn is not spoken
    this.latched = false; // hands-free: listening until the next stop()
    this.turn = null; // this session's held phrases while latched: { latched, open, parts }
    this.latchTimer = null;
  }

  #setState(state, force = false) {
    if (state === this.state && !force) return;
    this.state = state;
    this.emit({ type: RT.VOICE_STATE, state, ...(state === STATES.LISTENING && this.latched ? { latched: true } : {}) });
  }

  #settle() {
    // An unconfirmed silent start shows nothing (it may be a tap).
    if (this.listening && this.confirmed) this.#setState(STATES.LISTENING);
    else if (this.speaking) this.#setState(STATES.SPEAKING);
    else if (this.awaitingReply) this.#setState(STATES.THINKING);
    else this.#setState(STATES.IDLE);
  }

  // The toggle command is hands-free too, so it latches like Option+Space.
  toggle() {
    if (this.listening && this.confirmed) return this.stop();
    return this.start({ latch: true });
  }

  #armLatch() {
    if (this.latchTimer != null) this.clearTimer(this.latchTimer);
    this.latchTimer = null;
    if (!this.listening || !this.latched) return;
    const timer = this.setTimer(() => {
      if (this.latchTimer !== timer || !this.listening || !this.latched) return;
      this.latchTimer = null;
      this.emit({ type: RT.STATUS, kind: "status", text: "Stopped listening after a minute with no speech." });
      this.stop();
    }, LATCH_IDLE_MS);
    this.latchTimer = timer;
  }

  #sendUserText(text) {
    this.awaitingReply = true;
    this.muted = false; // a fresh turn: its replies are spoken
    this.agent.send({ type: "user_text", text });
    this.emit({ type: RT.VOICE_FINAL, text });
    this.emit({ type: RT.SUBTITLE, speaker: "user", text, final: true });
    this.#settle();
  }

  // A latched turn is over: send what was held as one user_text.
  #flush(turn, last = "") {
    const text = join([...turn.parts, last]);
    turn.parts = [];
    if (text) this.#sendUserText(text);
  }

  async start({ silent = false, latch = false } = {}) {
    if (this.listening) {
      // Talking again from another frame or tab during a latch ends it.
      if (this.latched) return this.stop();
      if (!latch) return;
      if (!this.confirmed) {
        this.cancel(); // a tap's silent start: drop it and latch instead
      } else {
        // Option+Space during a hold: keep this session and make it hands-free.
        this.latched = true;
        if (this.turn) this.turn.latched = true;
        this.#armLatch();
        this.#setState(STATES.LISTENING, true);
        return;
      }
    }
    this.listening = true;
    this.confirmed = false;
    this.held = [];
    this.latched = latch;
    const turn = { latched: latch, open: true, parts: [] };
    this.turn = turn;
    if (latch) silent = false;
    this.resumeAudio();
    if (silent) this.speaker.duck?.();
    else this.confirm();

    // Until confirm(), transcript events wait in this.held.
    const gate = (fn) => (...args) => (this.confirmed ? fn(...args) : this.held.push(() => fn(...args)));
    // While latched, speech of any kind pushes the idle timeout back.
    const heard = () => { if (this.turn === turn) this.#armLatch(); };
    const s = this.createStt({
      onTurnStart: gate(() => { heard(); this.speaker.stop(); }),
      onPartial: gate((text) => {
        heard();
        const shown = turn.latched ? join([...turn.parts, text]) : text;
        this.emit({ type: RT.VOICE_PARTIAL, text: shown });
        this.emit({ type: RT.SUBTITLE, speaker: "user", text: shown, final: false });
      }),
      onFinal: gate((text) => {
        if (turn.dropped) return;
        if (!turn.latched) return this.#sendUserText(text);
        if (!turn.open) return this.#flush(turn, text);
        heard();
        turn.parts.push(text);
        this.emit({ type: RT.SUBTITLE, speaker: "user", text: join(turn.parts), final: false });
      }),
      onError: (message) => this.emit({ type: RT.VOICE_ERROR, message }),
      onClosed: () => {
        if (this.session === s) this.session = null;
        // The STT socket closed mid-latch (server close, token expiry): end
        // the latch here rather than listen on a dead session.
        if (turn.latched && turn.open && this.turn === turn && this.listening) {
          turn.open = false;
          this.listening = false;
          this.confirmed = false;
          this.mic.sink = null;
          this.#endLatch();
          this.chime("stop");
        }
        if (turn.latched && !turn.dropped) this.#flush(turn);
        this.#settle();
      },
    });
    this.session = s;
    this.mic.sink = (chunk) => s.sendAudio(chunk);
    s.open();
    this.#armLatch();
    try {
      await this.mic.start();
    } catch (err) {
      this.mic.sink = null;
      s.abort();
      if (!this.confirmed) this.speaker.unduck?.(); // a silent start ducked our speech
      this.listening = false;
      this.confirmed = false;
      this.held = [];
      turn.dropped = true;
      this.#endLatch();
      this.#setState(this.speaking ? STATES.SPEAKING : this.awaitingReply ? STATES.THINKING : STATES.IDLE, true); // the page may think it latched
      const blocked = err && err.name === "NotAllowedError";
      this.emit({
        type: RT.VOICE_ERROR,
        code: blocked ? "mic_blocked" : "mic_failed",
        message: blocked
          ? "Microphone access is blocked. Open Clearcart options and press Grant microphone."
          : `Could not start the microphone: ${err && err.message}`,
      });
    }
  }

  // The key is still held: announce it and keep everything recorded so far.
  confirm() {
    if (!this.listening || this.confirmed) return;
    this.confirmed = true;
    this.#bargeIn();
    this.chime("start");
    this.#setState(STATES.LISTENING);
    const held = this.held;
    this.held = [];
    for (const replay of held) replay();
  }

  #endLatch() {
    this.latched = false;
    if (this.latchTimer != null) this.clearTimer(this.latchTimer);
    this.latchTimer = null;
  }

  // A quick tap: drop the recording without a sound or a state change.
  cancel() {
    if (!this.listening || this.confirmed) return;
    if (this.turn) this.turn.dropped = true;
    this.#endLatch();
    this.listening = false;
    this.held = [];
    this.mic.sink = null;
    const s = this.session;
    this.session = null;
    if (s) s.abort();
    this.speaker.unduck?.();
    this.#settle();
  }

  // Silence our speech now and tell the agent to drop the rest of its turn.
  #bargeIn() {
    this.speaker.stop();
    this.muted = true;
    this.awaitingReply = false;
    this.agent.send({ type: "interrupt" });
  }

  // Double-tap Space while speaking: the first tap's silent start is dropped
  // (it ducked the speech), then the speech is hard-stopped like a barge-in
  // and a soft boop says it's off. Never listens and never sends user_text,
  // so it can't answer a checkout read-back. Returns true if it stopped speech.
  hush() {
    if (this.listening && this.confirmed) return false; // a real turn is on; leave it
    if (this.listening) {
      this.listening = false;
      if (this.turn) this.turn.dropped = true;
      this.#endLatch();
      this.held = [];
      this.mic.sink = null;
      const s = this.session;
      this.session = null;
      if (s) s.abort();
    }
    // Speech that already ended: just bring the ducked level back.
    if (!this.speaking) {
      this.speaker.unduck?.();
      this.#settle();
      return false;
    }
    this.#bargeIn(); // the replaced output node starts at full level
    this.chime("boop");
    this.#settle();
    return true;
  }

  stop() {
    if (!this.listening) return;
    if (!this.confirmed) return this.cancel();
    const turn = this.turn;
    if (turn) {
      turn.open = false;
      if (turn.parts.length) this.awaitingReply = true; // sent after the tail
    }
    this.#endLatch();
    this.listening = false;
    this.chime("stop"); // right on release, so the user knows we heard them let go
    this.#settle();
    const s = this.session;
    // Keep a short tail so the last word isn't clipped, then let Ink finalize.
    this.setTimer(() => {
      if (!this.listening) this.mic.sink = null;
      if (s) s.finish();
    }, TAIL_MS);
  }

  stopSpeaking() {
    this.speaker.stop();
  }

  onSpeakingChange(on) {
    this.speaking = on;
    if (on) this.awaitingReply = false;
    this.#settle();
  }

  onAgentMessage(m) {
    switch (m.type) {
      case "agent_text":
        if (!m.text) return;
        if (this.muted) {
          // Sent before the agent saw our interrupt: log it, never speak it.
          this.emit({ type: RT.STATUS, kind: "status", text: `(not spoken) ${m.text.slice(0, 120)}` });
          return;
        }
        // agent_text arrives whole (not streamed), so its subtitle is final at once.
        // Stay "thinking" until the speaker reports it started (onSpeakingChange clears it).
        this.emit({ type: RT.SUBTITLE, speaker: "agent", text: m.text, final: true });
        this.speaker.speak(m.text);
        break;
      case "status":
        this.emit({ type: RT.STATUS, kind: "status", text: m.text || "" });
        break;
      case "receipt":
        this.awaitingReply = false;
        this.emit({ type: RT.STATUS, kind: "receipt", receipt: { item: m.item, total: m.total, last4: m.last4 } });
        this.#settle();
        break;
      default:
        this.log(`unknown agent message type: ${m.type}`);
    }
  }
}
