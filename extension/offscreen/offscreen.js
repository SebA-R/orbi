// Orbi offscreen document (reasons USER_MEDIA + AUDIO_PLAYBACK).
//
// Offscreen documents only get chrome.runtime, so settings arrive from the
// worker inside messages ({settings} on VOICE_START and SETTINGS_CHANGED)
// rather than from chrome.storage.
//
// In:  runtime messages with target "offscreen":
//        VOICE_START {settings?, silent?, latch?}, VOICE_CONFIRM, VOICE_CANCEL, VOICE_HUSH, VOICE_STOP, PTT_TOGGLE, TTS_STOP,
//        TTS_SPEAK {text} (ignored with Speak replies off), SETTINGS_CHANGED {settings},
//        VOICE_TYPED {text} (typed in the popup or new tab page),
//        BASIC_TTS_EVENT (chrome.tts events from the worker, basic voice)
//      Anything else (including PTT_* that content scripts broadcast to every
//      extension page) is ignored; the worker is the only router. The one
//      exception: a page's own PTT_* broadcast (pageKey) goes to
//      controller.onPageKey, so a press ducks our speech at once, ahead of
//      the worker's VOICE_START.
// Out: runtime messages with from "offscreen": VOICE_STATE, VOICE_PARTIAL,
//      VOICE_FINAL, VOICE_ERROR, SUBTITLE, SUBTITLE_WORD, STATUS, and
//      BASIC_TTS (to the worker's chrome.tts, basic voice).
//
// Basic voice: when the agent server's /healthz says it has no Cartesia key
// (checked on load, whenever the agent socket opens and when the server
// address changes), replies are spoken by Chrome (BasicSpeaker) and the user
// is heard by Chrome's speech recognition (WebSpeechSttSession) instead of
// Sonic and Ink 2 (lib/voice/engine.js). The choice is read when a turn
// starts and when a line is spoken; a switch while speaking stops the old
// voice and shows the rest of its words.
import { RT } from "../lib/protocol.js";
import { DEFAULTS, endpoints, normalize } from "../lib/settings.js";
import { createLogger } from "../lib/log.js";
import { DEFAULT_VOICE_ID } from "../lib/voice/config.js";
import { SttSession } from "../lib/voice/stt.js";
import { Speaker } from "../lib/voice/tts.js";
import { Mic } from "../lib/voice/mic.js";
import { createChime, linkCues } from "../lib/voice/chime.js";
import { createTokenSource } from "../lib/voice/token.js";
import { AgentSession } from "../lib/voice/agent-session.js";
import { VoiceController, pageKey } from "../lib/voice/controller.js";
import { BasicSpeaker } from "../lib/voice/basic-tts.js";
import { WebSpeechSttSession, recognitionClass } from "../lib/voice/webspeech-stt.js";
import { chooseVoice } from "../lib/voice/engine.js";
import { agentHealth } from "../lib/setup.js";

const log = createLogger("offscreen");
const say = (msg) => log.info(msg);

let settings = normalize({ ...DEFAULTS });

function emit(msg) {
  try {
    const p = chrome.runtime.sendMessage({ ...msg, from: "offscreen" });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

const ctx = new AudioContext();
const resumeAudio = () => { if (ctx.state === "suspended") ctx.resume().catch(() => {}); };

// Every earcon goes through here; "Play sounds" off means silence.
const chime = createChime({ ctx, sounds: () => settings.sounds });
// The agent link: closed once it has stayed down 2 s, listen at 0.6 when back.
const linkCue = linkCues({ play: chime });

const getToken = createTokenSource({ url: () => endpoints(settings.agentUrl).token });
// The voice in use (lib/voice/engine.js); cartesia null until /healthz says.
let cartesia = null;
let serverVoice = null;
const voice = () => chooseVoice({ cartesia, voice: serverVoice, recognition: !!recognitionClass() });
const prefetchToken = () => {
  if (voice().mode !== "cartesia") return;
  getToken().catch((err) => say(`token prefetch failed: ${err.message}`));
};

let controller;
const sonic = new Speaker({
  ctx,
  getToken,
  getSpeed: () => settings.speed,
  voiceId: DEFAULT_VOICE_ID,
  log: say,
  onSpeakingChange: (on) => controller && controller.onSpeakingChange(on),
  onCaption: (c) => controller && controller.onCaption(c),
  onFirstAudio: (at) => controller && controller.onFirstAudio(at),
});
// Basic voice: chrome.tts in the worker (background/basic-tts-host.js).
const basicEngine = {
  speak: ({ id, text, rate }) => emit({ type: RT.BASIC_TTS, op: "speak", id, text, rate }),
  stop: () => emit({ type: RT.BASIC_TTS, op: "stop" }),
  pause: () => emit({ type: RT.BASIC_TTS, op: "pause" }),
  resume: () => emit({ type: RT.BASIC_TTS, op: "resume" }),
};
const basic = new BasicSpeaker({
  engine: basicEngine,
  getSpeed: () => settings.speed,
  log: say,
  onSpeakingChange: (on) => controller && controller.onSpeakingChange(on),
  onCaption: (c) => controller && controller.onCaption(c),
});
// The controller sees one speaker; it speaks with the voice in use.
const current = () => (voice().mode === "basic" ? basic : sonic);
const speaker = {
  captions: true,
  speak: (text) => current().speak(text),
  stop: (opts) => current().stop(opts),
  duck: () => current().duck(),
  unduck: () => current().unduck(),
  // Opens Sonic's socket ahead of the reply; only when Cartesia is the voice.
  warm: () => { if (voice().mode === "cartesia") sonic.warm(); },
};

// /healthz decides the voice. A change mid-reply stops the old voice (its
// words stay on screen) so two voices never talk at once.
let healthRun = 0;
async function checkVoice() {
  const run = ++healthRun;
  const h = await agentHealth(settings.agentUrl);
  if (run !== healthRun || !h.connected) return;
  const before = current();
  const was = voice().mode;
  cartesia = h.cartesia;
  serverVoice = h.voice;
  const now = voice();
  if (now.mode === was) return;
  if (before.speaking) before.stop({ release: true });
  say(`voice: ${now.mode === "basic" ? `basic (no Cartesia key; ${now.stt === "webspeech" ? "Chrome speech recognition" : "typing only"})` : "Cartesia"}`);
  prefetchToken();
}
const mic = new Mic(ctx);

const agent = new AgentSession({
  url: () => endpoints(settings.agentUrl).session,
  onMessage: (m) => controller.onAgentMessage(m),
  onState: (s) => {
    linkCue(s);
    if (s === "open") void checkVoice(); // a restarted server may have a new key, or none
    emit({ type: RT.STATUS, kind: "agent", state: s });
  },
  log: say,
});

controller = new VoiceController({
  createStt: (handlers) => voice().mode === "basic"
    ? new WebSpeechSttSession({ handlers, log: say, onUnavailable: (code) => say(`speech recognition unavailable here: ${code}`) })
    : new SttSession({
      getToken,
      sampleRate: ctx.sampleRate,
      log: say,
      handlers: { ...handlers, onClosed: () => { handlers.onClosed(); prefetchToken(); } },
    }),
  speaker,
  mic,
  chime,
  agent,
  emit,
  resumeAudio,
  log: say,
  // Speak replies off: no speech is ever requested (no Cartesia credits).
  speakReplies: () => settings.speakReplies !== false,
  // Turn timing for the agent's ORBI_TIMING log (agent/timing.ts).
  wallClock: () => Date.now(),
});

function applySettings(next) {
  if (!next) return;
  const prev = settings;
  settings = normalize(next);
  // Turned off mid-reply: stop the speech now, keep its words on screen.
  // Turned on: the next reply is spoken.
  if (prev.speakReplies && !settings.speakReplies) controller.releaseSpeech();
  if (settings.agentUrl !== prev.agentUrl) {
    getToken.clear();
    agent.reconnect();
    void checkVoice();
  }
}

// The worker, not a tab: typed words and chrome.tts events must come from it.
const WORKER_URL = chrome.runtime.getURL("background/worker.js");
const fromWorker = (sender) => !!sender && !sender.tab && sender.id === chrome.runtime.id && sender.url === WORKER_URL;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  // A page's own hotkey broadcast (not the worker's copy): duck our speech
  // now, without waiting for VOICE_START to come round through the worker.
  const key = pageKey(msg);
  if (key) return void controller.onPageKey(key);
  if (msg.target !== "offscreen") return;
  switch (msg.type) {
    case RT.VOICE_START:
      applySettings(msg.settings);
      controller.start({ silent: !!msg.silent, latch: !!msg.latch });
      break;
    case RT.VOICE_CONFIRM:
      controller.confirm();
      break;
    case RT.VOICE_CANCEL:
      controller.cancel();
      break;
    case RT.VOICE_HUSH:
      controller.hush();
      break;
    case RT.VOICE_STOP:
      controller.stop();
      break;
    case RT.PTT_TOGGLE:
      applySettings(msg.settings);
      controller.toggle();
      break;
    case RT.TTS_STOP:
      controller.stopSpeaking();
      break;
    case RT.TTS_SPEAK:
      if (msg.text && settings.speakReplies) speaker.speak(String(msg.text));
      break;
    case RT.VOICE_TYPED:
      if (!fromWorker(sender) || typeof msg.text !== "string") break;
      applySettings(msg.settings);
      controller.typed(msg.text);
      break;
    case RT.BASIC_TTS_EVENT:
      if (fromWorker(sender)) basic.onEvent(msg);
      break;
    case RT.SETTINGS_CHANGED:
      applySettings(msg.settings);
      break;
    // A restarted worker knows nothing of a turn in progress; tell it.
    case RT.VOICE_SYNC:
      controller.announce();
      break;
  }
});

agent.connect();
void checkVoice().finally(prefetchToken);
emit({ type: RT.VOICE_STATE, state: controller.state });

// Test hook (Playwright drives this page without a mic or the agent server).
globalThis.__clearcartVoice = { controller, speaker, mic, agent, ctx, get settings() { return settings; } };
