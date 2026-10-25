// The voice loop that runs in the offscreen document, with every browser
// dependency injected so it can be tested in node.
//
//   start()  PTT_START: barge-in (stop TTS), start chime, open an STT session,
//            route mic audio to it. state -> listening
//   stop()   PTT_STOP: stop chime, 300 ms tail, then finish() so Ink flushes.
//            state -> thinking once something was said, else idle
//   each STT turn.end -> {type:"user_text"} to the agent + VOICE_FINAL + SUBTITLE
//   agent_text -> Sonic + SUBTITLE(agent); status/receipt -> STATUS
//
// emit(msg) sends a runtime message (type from RT) towards the worker.
import { RT } from "../protocol.js";

export const STATES = Object.freeze({ IDLE: "idle", LISTENING: "listening", THINKING: "thinking", SPEAKING: "speaking" });
export const TAIL_MS = 300;

export class VoiceController {
  constructor({ createStt, speaker, mic, chime, agent, emit, setTimer = setTimeout, resumeAudio = () => {}, log = () => {} }) {
    Object.assign(this, { createStt, speaker, mic, chime, agent, emit, setTimer, resumeAudio, log });
    this.listening = false;
    this.session = null;
    this.awaitingReply = false;
    this.speaking = false;
    this.state = STATES.IDLE;
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

  async start() {
    if (this.listening) return;
    this.listening = true;
    this.speaker.stop(); // barge-in
    this.resumeAudio();
    this.chime("start");
    this.#setState(STATES.LISTENING);

    const s = this.createStt({
      onTurnStart: () => this.speaker.stop(),
      onPartial: (text) => {
        this.emit({ type: RT.VOICE_PARTIAL, text });
        this.emit({ type: RT.SUBTITLE, speaker: "user", text, final: false });
      },
      onFinal: (text) => {
        this.awaitingReply = true;
        this.agent.send({ type: "user_text", text });
        this.emit({ type: RT.VOICE_FINAL, text });
        this.emit({ type: RT.SUBTITLE, speaker: "user", text, final: true });
        this.#settle();
      },
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
      this.listening = false;
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

  stop() {
    if (!this.listening) return;
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
        this.awaitingReply = false;
        this.emit({ type: RT.SUBTITLE, speaker: "agent", text: m.text, final: true });
        this.speaker.speak(m.text);
        this.#settle();
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
