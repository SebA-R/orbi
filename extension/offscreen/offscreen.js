// Clearcart offscreen document (reasons USER_MEDIA + AUDIO_PLAYBACK).
//
// Offscreen documents only get chrome.runtime, so settings arrive from the
// worker inside messages ({settings} on VOICE_START and SETTINGS_CHANGED)
// rather than from chrome.storage.
//
// In:  runtime messages with target "offscreen":
//        VOICE_START {settings?, silent?}, VOICE_CONFIRM, VOICE_CANCEL, VOICE_STOP, PTT_TOGGLE, TTS_STOP,
//        TTS_SPEAK {text}, CHIME {kind}, SETTINGS_CHANGED {settings}
//      Anything else (including PTT_* that content scripts broadcast to every
//      extension page) is ignored; the worker is the only router.
// Out: runtime messages with from "offscreen": VOICE_STATE, VOICE_PARTIAL,
//      VOICE_FINAL, VOICE_ERROR, SUBTITLE, STATUS.
import { RT } from "../lib/protocol.js";
import { DEFAULTS, endpoints, normalize } from "../lib/settings.js";
import { createLogger } from "../lib/log.js";
import { DEFAULT_VOICE_ID } from "../lib/voice/config.js";
import { SttSession } from "../lib/voice/stt.js";
import { Speaker } from "../lib/voice/tts.js";
import { Mic } from "../lib/voice/mic.js";
import { earcon } from "../lib/voice/chime.js";
import { createTokenSource } from "../lib/voice/token.js";
import { AgentSession } from "../lib/voice/agent-session.js";
import { VoiceController } from "../lib/voice/controller.js";

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

const getToken = createTokenSource({ url: () => endpoints(settings.agentUrl).token });
const prefetchToken = () => getToken().catch((err) => say(`token prefetch failed: ${err.message}`));

let controller;
const speaker = new Speaker({
  ctx,
  getToken,
  getSpeed: () => settings.speed,
  voiceId: DEFAULT_VOICE_ID,
  log: say,
  onSpeakingChange: (on) => controller && controller.onSpeakingChange(on),
});
const mic = new Mic(ctx);

const agent = new AgentSession({
  url: () => endpoints(settings.agentUrl).session,
  onMessage: (m) => controller.onAgentMessage(m),
  onState: (s) => emit({ type: RT.STATUS, kind: "agent", state: s }),
  log: say,
});

controller = new VoiceController({
  createStt: (handlers) => new SttSession({
    getToken,
    sampleRate: ctx.sampleRate,
    log: say,
    handlers: { ...handlers, onClosed: () => { handlers.onClosed(); prefetchToken(); } },
  }),
  speaker,
  mic,
  chime: (kind) => { resumeAudio(); earcon(ctx, kind); },
  agent,
  emit,
  resumeAudio,
  log: say,
});

function applySettings(next) {
  if (!next) return;
  const prev = settings;
  settings = normalize(next);
  if (settings.agentUrl !== prev.agentUrl) {
    getToken.clear();
    agent.reconnect();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;
  switch (msg.type) {
    case RT.VOICE_START:
      applySettings(msg.settings);
      controller.start({ silent: !!msg.silent });
      break;
    case RT.VOICE_CONFIRM:
      controller.confirm();
      break;
    case RT.VOICE_CANCEL:
      controller.cancel();
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
      if (msg.text) speaker.speak(String(msg.text));
      break;
    case RT.CHIME:
      resumeAudio();
      earcon(ctx, msg.kind === "stop" ? "stop" : "start");
      break;
    case RT.SETTINGS_CHANGED:
      applySettings(msg.settings);
      break;
  }
});

agent.connect();
prefetchToken();
emit({ type: RT.VOICE_STATE, state: controller.state });

// Test hook (Playwright drives this page without a mic or the agent server).
globalThis.__clearcartVoice = { controller, speaker, mic, agent, ctx, get settings() { return settings; } };
