# Manifest

AI-to-AI simulation (see README.md). All three sites worked; none showed a CAPTCHA, bot check or access-denied page.

| Site | Task | Outcome | Run length | Lines (aside / tail) | Frames | Sequential audio |
| --- | --- | --- | --- | --- | --- | --- |
| `aritzia/` | Black Babaton contour bodysuit, size small | Pursue style sold out in small; switched to Original Contour Float Cami Bodysuit, black, S, $48; in bag; estimated total $58.28 | 141 s | 25 (5 / 4) | 173 | 163.1 s |
| `nordstrom/` | Women's white Nike Air Force 1 '07, size 8 | $115, about 4.5 stars from 799 reviews; size 8 in bag; estimated total $124.92 | 106 s | 13 (2 / 2) | 119 | 94.2 s |
| `ssense/` | Black Acne Studios crewneck sweater, size medium | First pick (Black Metallic Knit Sweater, $468) sold out in M; Black Printed Logo Sweatshirt, M, $500, 85% cotton / 15% polyester; in bag | 84 s | 14 (1 / 2) | 105 | 139.7 s |

Each site was run once, with no retries.

## Files per site

| File | What it is |
| --- | --- |
| `transcript.json` | One entry per spoken line: `speaker` (`shopper` or `clearcart`), `text`, `t_start` (seconds since the session opened, on the same clock as the frames), `audio`, `audio_duration_s`, `seq_start` (position in `conversation_sequential.wav`), and the flags `aside` and `tail` |
| `audio/NN_<speaker>.wav` | Cartesia Sonic `sonic-3.6`, 44.1 kHz mono 16-bit, one file per line |
| `conversation_sequential.wav` | All lines back to back with 0.45 s gaps |
| `frames/f_<ms>.jpg` | Screenshots of the tab Clearcart drove, 1512x746, about 1.2 fps, named by milliseconds since the session opened |
| `frames.json` | Frame list with `t` and the tab URL at that moment |
| `footage_realtime.mp4` | The frames as a 30 fps H.264 video in real time (each frame held until the next one; the first frame also covers t=0 up to the first capture), so video time equals `t_start` |
| `events.json` | The raw log: every speech line plus Clearcart's tool-call status messages (`navigate ...`, `computer left_click`, `get_page_text`, ...), useful for on-screen captions |
| `notes.md` | What happened on that run |

## Voices

- Shopper: Cartesia "Gareth" (`3a01612e-07da-4a85-bba8-ce10481df477`), a warm, approachable male voice.
- Clearcart: Cartesia "Tessa" (`6ccbfb76-1fc6-48f7-b71d-91ac6298247b`), the same voice the voice console uses, so it matches the live product.

To use other voices, re-synthesize each line from `transcript.json` (`POST https://api.cartesia.ai/tts/bytes`, `Cartesia-Version: 2026-08-14`, `model_id: sonic-3.6`, WAV pcm_s16le 44.1 kHz). Cartesia's streamed WAV header has a placeholder length, so rewrite the header before trusting the duration.

## Notes for the editor

- **The timing does not line up 1:1.** `t_start` is when each line was sent in the real run. The real gaps include agent thinking and browsing, while the synthesized lines are often longer than the gap to the next line (for example, Clearcart's long product read-outs run 15 to 26 s). Laying the WAVs at `t_start` would overlap them. Use `conversation_sequential.wav` with `seq_start` as the audio spine, and retime or speed-ramp `footage_realtime.mp4` so the moment for each line (from `t_start`) sits under its `seq_start`. Speeding up the browsing between lines looks natural.
- **Frame rate:** the captures are about 1.2 fps (one screenshot every ~0.8 s), so motion is steppy. Crossfades or slow pans hide this better than playing it as live video.
- `aside: true` marks short lines where Clearcart narrates to itself ("Color 1274 was black before.", "Those tabs are existing ones, so I'll open a new one."). The live app speaks these too, but they are safe to cut.
- `tail: true` marks a goodbye loop after the shopper's thank-you. Cut from the first `tail` line.
- The frames start about 6 to 8 s in, when the tab first reaches the retail site. The MP4 holds the first frame before that point.
- The screenshots are of the page only (no browser chrome). Pop-ups such as cookie, email-signup and app banners show in the frames as they appeared; Clearcart closed them without accepting.
