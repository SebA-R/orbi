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
//   each STT turn.end -> {type:"user_text"} to the agent + VOICE_FINAL + SUBTITLE
//   agent_text -> Sonic + SUBTITLE(agent); status/receipt -> STATUS
//   standby  the agent server gave the conversation to another Clearcart
//            window (agent/hub.ts): stop speaking and stop waiting for a
//            reply; "moved" also drops a turn still listening, unsent
//
// emit(msg) sends a runtime message (type from RT) towards the worker.
import { RT } from "../protocol.js";

export const STATES = Object.freeze({ IDLE: "idle", LISTENING: "listening", THINKING: "thinking", SPEAKING: "speaking" });
export const TAIL_MS = 300;

export class VoiceController {
  constructor({ createStt, speaker, mic, chime, agent, emit, setTimer = (fn, ms) => setTimeout(fn, ms), resumeAudio = () => {}, log = () => {} }) {
    Object.assign(this, { createStt, speaker, mic, chime, agent, emit, setTimer, resumeAudio, log });
    this.listening = false;
    this.session = null;
    this.awaitingReply = false;
    this.speaking = false;
    this.state = STATES.IDLE;
    this.confirmed = false;
    this.held = []; // transcript events from a silent start, replayed on confirm()
    this.muted = false; // after a barge-in: agent_text from the interrupted turn is not spoken
  }

  #setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.emit({ type: RT.VOICE_STATE, state });
  }

  #settle() {
    if (this.listening) this.#setState(STATES.LISTENING);
    else if (this.speaking) this.#setState(STATES.SPEAKING);
    else if (this.awaitingReply) this.#setState(STATES.THINKING);
    else this.#setState(STATES.IDLE);
  }

  toggle() {
    return this.listening ? this.stop() : this.start();
  }

  async start({ silent = false } = {}) {
    if (this.listening) return;
    this.listening = true;
    this.confirmed = false;
    this.held = [];
    this.resumeAudio();
    if (silent) this.speaker.duck?.();
    else this.confirm();

    // Until confirm(), transcript events wait in this.held.
    const gate = (fn) => (...args) => (this.confirmed ? fn(...args) : this.held.push(() => fn(...args)));
    const s = this.createStt({
      onTurnStart: gate(() => this.speaker.stop()),
      onPartial: gate((text) => {
        this.emit({ type: RT.VOICE_PARTIAL, text });
        this.emit({ type: RT.SUBTITLE, speaker: "user", text, final: false });
      }),
      onFinal: gate((text) => {
        this.awaitingReply = true;
        this.muted = false; // a fresh turn: its replies are spoken
        this.agent.send({ type: "user_text", text });
        this.emit({ type: RT.VOICE_FINAL, text });
        this.emit({ type: RT.SUBTITLE, speaker: "user", text, final: true });
        this.#settle();
      }),
      onError: (message) => this.emit({ type: RT.VOICE_ERROR, message }),
      onClosed: () => {
        if (this.session === s) this.session = null;
        this.#settle();
      },
    });
    this.session = s;
    this.mic.sink = (chunk) => s.sendAudio(chunk);
    s.open();
    try {
      await this.mic.start();
    } catch (err) {
      this.mic.sink = null;
      s.abort();
      if (!this.confirmed) this.speaker.unduck?.(); // a silent start ducked our speech
      this.listening = false;
      this.confirmed = false;
      this.held = [];
      this.#settle();
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

  // A quick tap: drop the recording without a sound or a state change.
  cancel() {
    if (!this.listening || this.confirmed) return;
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

  stop() {
    if (!this.listening) return;
    if (!this.confirmed) return this.cancel();
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

  // {type:"standby"} from the agent server: another Clearcart window (the
  // voice console, another browser profile) owns the conversation now.
  // reason "moved": it just took it, so a turn still listening here ends
  // unsent, and nothing here keeps listening alongside it. "stale": the
  // words we sent were dropped; a newer press here (which takes the
  // conversation back) is left alone.
  standby(reason) {
    if (reason === "moved" && this.listening) {
      this.listening = false;
      this.confirmed = false;
      this.held = [];
      this.mic.sink = null;
      const s = this.session;
      this.session = null;
      if (s) s.abort();
    }
    this.speaker.stop();
    this.muted = true;
    this.awaitingReply = false;
    this.#settle();
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
      case "standby":
        this.emit({ type: RT.STATUS, kind: "status", text: m.text || "Clearcart is in use in another window." });
        this.standby(m.reason);
        break;
      default:
        this.log(`unknown agent message type: ${m.type}`);
    }
  }
}
