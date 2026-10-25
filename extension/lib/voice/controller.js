// The voice loop that runs in the offscreen document, with every browser
// dependency injected so it can be tested in node.
//
//   start()  PTT_START: barge-in (stop TTS), listen cue, open an STT session,
//            route mic audio to it. state -> listening
//   start({ silent: true }) the key was just touched: record into the STT
//            session right away and duck our own speech to near silence, but
//            show nothing (no sound, no state, transcripts held back).
//            confirm() once the key is held makes it a normal start, keeping
//            the audio from the first moment; cancel() on a quick tap throws
//            it all away and brings the speech back up.
//   onPageKey(type) the page's own PTT_* broadcast (pageKey(msg)), heard
//            before the worker's VOICE_* copy, which waits on the worker
//            waking, the document check and a settings read. PTT_START ducks
//            our speech at once; start() takes the duck over. Until then
//            PTT_CONFIRM keeps it down for as long as the key is held, and
//            PTT_STOP / CANCEL / HUSH give the start PREDUCK_MS to arrive
//            before the speech comes back. A cancel() with a newer press on
//            its way keeps the duck too, so back-to-back presses never blip.
//   confirm() barge-in: hard-stop the speaker, send {type:"interrupt"} so the
//            agent stops the turn, and drop any agent_text that still arrives
//            from it until the next user_text goes out.
//   stop()   PTT_STOP: sent cue, 300 ms tail, then finish() so Ink flushes.
//            state -> thinking once something was said, else idle
//   start({ latch: true }) hands-free (Option+Space, or the toggle command):
//            listens until the next stop(). Finished phrases are held and sent
//            as one user_text after stop(). VOICE_STATE carries latched: true
//            so the page can say "Press Space to send" and end it on Space.
//            LATCH_IDLE_MS without speech stops it, so the mic never stays open.
//   hush()   double-tap Space while speaking: drop the first tap's silent
//            start, hard-stop the speech like a barge-in (the cut cue).
//            Never listens or sends user_text (can't answer a read-back).
//   each STT turn.end -> {type:"user_text"} to the agent + VOICE_FINAL + SUBTITLE
//   agent_text -> Sonic; status/receipt -> STATUS
//   speakReplies() false (the Speak replies setting): agent_text is never
//            sent to Sonic. Its SUBTITLE(agent) goes out whole at once, with
//            no utteranceId (no karaoke: no word timestamps without TTS), and
//            the state goes thinking -> idle, never speaking.
//   releaseSpeech() Speak replies turned off mid-reply: the speech stops and
//            what was left of it shows in full. Not a barge-in: no cut cue,
//            no interrupt, the agent's turn goes on.
//   onCaption (from the speaker, as the audio plays) -> SUBTITLE(agent) with
//            its utteranceId when a line starts to be heard, then
//            SUBTITLE_WORD {utteranceId, index, done?, frozen?, fallback?}
//            as each word is heard. A speaker without captions (a test fake)
//            gets SUBTITLE(agent) as soon as agent_text arrives.
//   confirm_done -> the placed cue (paid) or the failed cue (failed)
//   standby  the agent server gave the conversation to another Clearcart
//            window (agent/hub.ts): stop speaking and stop waiting for a
//            reply; "moved" also drops a turn still listening, unsent
//
// chime(name, opts) plays a cue from lib/voice/chime.js: listen, sent, cut,
// placed, failed, error (closed is played by the offscreen document).
//
// emit(msg) sends a runtime message (type from RT) towards the worker.
import { RT } from "../protocol.js";
import { cueLength } from "./chime.js";

export const STATES = Object.freeze({ IDLE: "idle", LISTENING: "listening", THINKING: "thinking", SPEAKING: "speaking" });
export const TAIL_MS = 300;
export const LATCH_IDLE_MS = 60_000;
export const PREDUCK_MS = 4000;
const PAGE_KEYS = new Set([RT.PTT_START, RT.PTT_CONFIRM, RT.PTT_CANCEL, RT.PTT_STOP, RT.PTT_HUSH]);

// The type of a page's own hotkey broadcast, or null. The worker's copies
// carry target "offscreen" and the offscreen document's own carry from.
export function pageKey(msg) {
  if (!msg || typeof msg !== "object" || msg.target != null || msg.from != null) return null;
  return PAGE_KEYS.has(msg.type) ? msg.type : null;
}
const join = (parts) => parts.join(" ").replace(/\s+/g, " ").trim();

export class VoiceController {
  constructor({
    createStt, speaker, mic, chime, agent, emit,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
    resumeAudio = () => {}, log = () => {}, now = () => Date.now(), speakReplies = () => true,
  }) {
    Object.assign(this, { createStt, speaker, mic, chime, agent, emit, setTimer, clearTimer, resumeAudio, log, now, speakReplies });
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
    this.errorPending = false; // the mic failed before a silent start was confirmed
    this.listenUntil = 0; // now() when the last listen cue ends; the error buzz waits for it
    this.preDuckTimer = null;
    this.preDucked = false; // ducked by a page press whose start hasn't come yet
    this.pagePresses = 0; // page PTT_START broadcasts heard
    this.starts = 0; // of those, how many the worker's VOICE_START has caught up with
  }

  // A page's own hotkey broadcast; the worker's copy is still on its way.
  onPageKey(type) {
    if (type === RT.PTT_START) {
      this.pagePresses++;
      if (this.listening || !this.speaking) return;
      this.speaker.duck?.();
      this.preDucked = true;
      this.#armPreDuck();
    } else if (type === RT.PTT_CONFIRM) {
      // Held: stay down however long the worker takes.
      if (this.preDucked && !this.listening) this.#clearPreDuck();
    } else if (this.preDucked && !this.listening) {
      this.#armPreDuck(); // let go: the start still gets its chance
    }
  }

  // No start within PREDUCK_MS (the worker never passed it on): speech comes back.
  #armPreDuck() {
    this.#clearPreDuck();
    const timer = this.setTimer(() => {
      if (this.preDuckTimer !== timer) return;
      this.preDuckTimer = null;
      // A press whose copy never came is not waited for again.
      this.starts = this.pagePresses;
      if (!this.preDucked || this.listening) return;
      this.preDucked = false;
      this.speaker.unduck?.();
    }, PREDUCK_MS);
    this.preDuckTimer = timer;
  }

  #clearPreDuck() {
    if (this.preDuckTimer != null) this.clearTimer(this.preDuckTimer);
    this.preDuckTimer = null;
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
    this.errorPending = false;
    // This start is the worker's copy of the oldest page press not yet caught up.
    this.starts = Math.min(this.starts + 1, this.pagePresses);
    this.preDucked = false;
    this.#clearPreDuck();
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
      onError: (message) => {
        this.emit({ type: RT.VOICE_ERROR, message });
        gate(() => this.#errorCue())();
      },
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
          this.chime("sent");
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
      const confirmed = this.confirmed;
      this.confirmed = false;
      this.held = [];
      turn.dropped = true;
      this.#endLatch();
      this.#setState(this.speaking ? STATES.SPEAKING : this.awaitingReply ? STATES.THINKING : STATES.IDLE, true); // the page may think it latched
      const blocked = err && err.name === "NotAllowedError";
      // A tap's silent start stays quiet; the buzz waits for the hold. A
      // late failure from an older, dropped press makes no sound at all.
      if (this.turn === turn) {
        if (confirmed) this.#errorCue();
        else this.errorPending = true;
      }
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
    if (!this.listening && this.errorPending) {
      // The mic failed while the key was only touched: buzz now it's held.
      this.errorPending = false;
      this.chime("error");
      return;
    }
    if (!this.listening || this.confirmed) return;
    this.confirmed = true;
    const cut = this.#bargeIn();
    const when = cut ? cueLength("cut") : 0;
    this.chime("listen", when ? { when } : undefined);
    this.listenUntil = this.now() + (when + cueLength("listen")) * 1000;
    this.#setState(STATES.LISTENING);
    const held = this.held;
    this.held = [];
    for (const replay of held) replay();
  }

  // The error buzz, after any listen cue still playing so they don't overlap.
  #errorCue() {
    const wait = Math.max(0, this.listenUntil - this.now()) / 1000;
    this.chime("error", wait ? { when: wait } : undefined);
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
    if (this.pagePresses > this.starts && this.speaking) {
      // A newer press already ducked and its start is on its way: stay down.
      this.preDucked = true;
      this.#armPreDuck();
    } else this.speaker.unduck?.();
    this.#settle();
  }

  // Silence our speech now and tell the agent to drop the rest of its turn.
  // Plays the cut cue (and returns true) if it was speaking or thinking.
  #bargeIn() {
    const cut = this.speaking || this.awaitingReply;
    this.speaker.stop();
    if (cut) this.chime("cut");
    this.muted = true;
    this.awaitingReply = false;
    this.agent.send({ type: "interrupt" });
    return cut;
  }

  // Double-tap Space while speaking: the first tap's silent start is dropped
  // (it ducked the speech), then the speech is hard-stopped like a barge-in
  // and the cut cue says it's off. Never listens and never sends user_text,
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
    this.#bargeIn(); // the replaced output node starts at full level; plays the cut cue
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
    this.chime("sent"); // right on release, so the user knows we heard them let go
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

  releaseSpeech() {
    this.speaker.stop({ release: true });
    this.speaking = false;
    this.#settle();
  }

  // The speaker's caption events (tts.js), as the words are heard.
  onCaption(c) {
    if (!c || !c.utteranceId) return;
    if (c.kind === "line") {
      this.emit({ type: RT.SUBTITLE, speaker: "agent", text: c.text, final: true, utteranceId: c.utteranceId, karaoke: c.karaoke === true });
    } else if (c.kind === "word") {
      const { kind, ...word } = c;
      this.emit({ type: RT.SUBTITLE_WORD, ...word });
    }
  }

  // {type:"standby"} from the agent server: another Clearcart window (the
  // voice console, another browser profile) owns the conversation now.
  // reason "moved": it just took it, so a turn still listening here (a hold
  // or a latch) ends unsent, and nothing here keeps listening alongside it.
  // "stale": the words we sent were dropped; a newer press here (which takes
  // the conversation back) is left alone. Either way, words the user said
  // here that will never be answered get the error cue, so the loss is
  // heard, not silent.
  standby(reason) {
    const lost = reason === "moved" ? this.listening && this.confirmed : !this.listening;
    if (reason === "moved" && this.listening) {
      if (this.turn) this.turn.dropped = true;
      this.#endLatch();
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
    if (lost) this.#errorCue();
  }

  // Says the current state again (latched too): a restarted worker asks
  // (VOICE_SYNC), so ducking and captions pick up a turn in progress.
  announce() {
    this.#setState(this.state, true);
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
        if (!this.speakReplies()) {
          // Read, not heard: the whole line at once; subtitles.js gives it
          // its reading time. Nothing goes to Sonic.
          this.emit({ type: RT.SUBTITLE, speaker: "agent", text: m.text, final: true });
          this.awaitingReply = false;
          this.#settle();
          break;
        }
        // agent_text arrives whole (not streamed), so its subtitle is final at once.
        // Stay "thinking" until the speaker reports it started (onSpeakingChange clears it).
        // The real speaker captions the line itself, when it starts to be heard.
        if (!this.speaker.captions) this.emit({ type: RT.SUBTITLE, speaker: "agent", text: m.text, final: true });
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
      case "confirm_done":
        // Declined is the user's own no: no sound.
        if (m.outcome === "paid") this.chime("placed");
        else if (m.outcome === "failed") this.chime("failed");
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
