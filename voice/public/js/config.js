// Cartesia settings, checked against docs.cartesia.ai on 2026-10-24. See voice/README.md.
export const CARTESIA_VERSION = '2026-08-14';

export const STT_URL = 'wss://api.cartesia.ai/stt/turns/websocket';
export const STT_MODEL = 'ink-2';
// Browser mic samples are 32-bit float; we send them at the AudioContext rate.
export const STT_ENCODING = 'pcm_f32le';
// "Patient" profile from the turn detection docs: blind users often pause to think,
// and holding Space already tells us when they are done.
export const STT_TURN_PARAMS = {
  turn_start_threshold: '0.8',
  turn_eager_end_threshold: '0.3',
  turn_end_threshold: '0.1',
  turn_end_timeout_ms: '8000',
};

export const TTS_URL = 'wss://api.cartesia.ai/tts/websocket';
export const TTS_MODEL = 'sonic-3.6';
// Voice used in Cartesia's own Sonic 3.6 examples. Override with ?voice=<id>.
export const DEFAULT_VOICE_ID = '6ccbfb76-1fc6-48f7-b71d-91ac6298247b';
export const TTS_SAMPLE_RATE = 44100;
export const TTS_OUTPUT_FORMAT = { container: 'raw', encoding: 'pcm_f32le', sample_rate: TTS_SAMPLE_RATE };

// Sonic accepts generation_config.speed in [0.6, 1.5]. Above 1.5 we also raise the
// playback rate locally (pitch goes up a little), since screen reader users often listen fast.
export const SONIC_MAX_SPEED = 1.5;
export const SPEED_MIN = 0.6;
export const SPEED_MAX = 2.0;
export const SPEED_DEFAULT = 1.0;
