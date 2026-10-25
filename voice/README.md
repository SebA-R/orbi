# voice

The Clearcart voice console: Ink 2 speech-to-text over `/stt/turns/websocket` and Sonic text-to-speech over
`/tts/websocket`, talking to the agent over `ws://<host>/session`. Plain static files in `public/`, no build step.
The agent server serves `public/` at http://localhost:5050/ and provides `GET /cartesia-token`
(snippet in [cartesia-token.md](cartesia-token.md)).

## Using it

- **Hold Space** to talk, let go to send. Works when focus is on the page or the big Talk button
  (Space keeps its normal meaning on the other controls).
- **Enter / click / screen reader activate** on the Talk button toggles listening on and off
  (screen readers in browse mode swallow Space-hold, so this is the fallback).
- **Escape** stops Clearcart talking. Starting to talk also stops it (barge-in), as does Ink's `turn.start`.
- Short rising tone = listening, falling tone = sent. Nothing is announced to the screen reader while you
  talk, because the screen reader's own speech would get picked up by the mic.
- Speaking speed slider (0.6 to 2.0, saved in localStorage as `clearcart.speed`). Sonic's own range is
  0.6 to 1.5; above that the console also speeds up playback, which raises the pitch slightly.
- "Also send replies to my screen reader" (on by default, saved as `clearcart.announce`) puts each
  `agent_text` in an `aria-live="polite"` region. Turn it off if hearing both Sonic and the screen reader is too much.
- "Repeat last reply", a receipt panel for `{type:"receipt"}`, the conversation, and an event log
  (`{type:"status"}` messages, socket and Cartesia errors).
- Query params: `?agent=ws://host:port/session` to point at another agent socket, `?voice=<voice id>`.

## Testing without the agent server

```sh
cd voice && npm install && npm start   # http://localhost:5051/
```

`dev-server.mjs` serves `public/`, mints `/cartesia-token` from `CARTESIA_API_KEY` in the repo-root `.env`,
and runs an echo `/session`: it greets you, answers every turn with "You said: ...", and if you say
"receipt" it sends a fake receipt. Open http://localhost:5051/, press and hold Space, allow the microphone,
say something, let go. You should see your words, then hear and see "You said: ...".

## Cartesia versions and ids (from docs.cartesia.ai, 2026-10-24)

| What | Value |
| --- | --- |
| API version | `2026-08-14` (`Cartesia-Version` header for `/access-token`; `cartesia_version` query param on both websockets) |
| Browser auth | `access_token` query param, token from `POST /access-token` with `grants: {tts: true, stt: true}` |
| STT | `wss://api.cartesia.ai/stt/turns/websocket`, `model=ink-2`, `encoding=pcm_f32le`, `sample_rate=<AudioContext.sampleRate>`, binary 100 ms chunks, `{"type":"close"}` to finish |
| Turn detection | "Patient" profile: `turn_start_threshold=0.8`, `turn_eager_end_threshold=0.3`, `turn_end_threshold=0.1`, `turn_end_timeout_ms=8000` |
| STT events used | `connected`, `turn.start`, `turn.update`, `turn.eager_end`, `turn.resume`, `turn.end`, `error` |
| TTS | `wss://api.cartesia.ai/tts/websocket`, `model_id=sonic-3.6`, `language=en`, `output_format={container: raw, encoding: pcm_f32le, sample_rate: 44100}`, `generation_config.speed`, one `context_id` per reply, `{context_id, cancel: true}` on barge-in |
| Voice | `6ccbfb76-1fc6-48f7-b71d-91ac6298247b` (the voice in Cartesia's Sonic 3.6 examples) |

## How a turn flows

1. Space down: stop any playback, open a new STT socket (token cached until 15 s before expiry), stream mic audio.
   Audio captured before the socket opens is buffered and sent on open.
2. Each `turn.end` is sent to the agent as `{type:"user_text", text}`. Space up: 300 ms more audio, then
   `{"type":"close"}`; the server flushes and closes. A turn that never got `turn.end` is still sent.
3. Each `agent_text` is spoken: requests go out immediately, audio plays strictly in arrival order.
