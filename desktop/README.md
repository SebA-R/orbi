# Orbi Desktop

A native macOS menu-bar helper that lets Orbi see and act on the whole Mac,
not just Chrome. It connects to the Orbi server at
`ws://localhost:5050/desktop` (the server side lives in `agent/desktop/`)
and answers its requests: read the frontmost app and its Accessibility tree,
click, type, press keys, scroll, take redacted screenshots, and draw Orbi's
overlay. Hold Right Option to talk; double-tap it to keep listening.

## Build and run

```sh
cd desktop
swift build              # debug build
swift test               # unit tests
scripts/bundle.sh        # build/Orbi Desktop.app, signed ad hoc
open "build/Orbi Desktop.app"
node scripts/smoke.mjs   # protocol smoke test (dry run, touches nothing)
```

Requires macOS 14 or later.

## Permissions

The helper never changes a setting. On first launch it opens its
Permissions window (also in the menu bar under Permissions…), where each
button shows the system prompt and opens the right pane in System Settings,
where you switch Orbi Desktop on:

| Permission | Used for |
| --- | --- |
| Accessibility | Reading the screen, mouse and keyboard, the talk key |
| Screen Recording | Screenshots of the main display |
| Microphone | Push-to-talk |

The bundle is signed ad hoc, so macOS treats every rebuild as a new app: grant
again after rebuilding (or remove the old entry first).

## Safety

- Never acts in Keychain Access, Passwords, 1Password, Bitwarden, System
  Settings, Terminal, iTerm2 or Chrome (Chrome stays the extension's job, so
  its DOM locks hold). The server can add more apps; it cannot remove these.
  Clicks and scrolls check the app under the pointer, keys and typing check
  the frontmost app, again right before every press and key. Blocked apps'
  windows are left out of screenshots.
- Typing refuses a focused password field and secure keyboard entry.
- `ax_tree` and `element_at` return `"[hidden]"` for a secure field's value
  and never read it.
- Screenshots are redacted in the helper before encoding: secure fields'
  frames, card numbers (13 to 19 digits passing Luhn) and 6-digit codes near
  "code" or "verification" are blacked out. If redaction fails the request
  fails; the unredacted image is never sent.
- Nothing acts while the screen is locked (`locked`).

## Protocol notes (v1)

Coordinates are global screen points, top-left origin of the main display.
`screenshot` returns `scale` as PNG pixels per point. `welcome` and `config`
may carry `blockedApps`. Element fields `subrole`, `title`, `label`, `value`
are omitted when empty. `scroll`: positive `dy` scrolls down, positive `dx`
scrolls right. Talk key: `ptt_down` once held 200 ms (with the audio from the
first moment), `ptt_up` on release; a tap sends nothing; a second press
within 350 ms latches (`latch_toggle`), the next press unlatches, and a latch
ends by itself after 5 minutes.

## Development switches

`ORBI_DESKTOP_URL`, `ORBI_DESKTOP_LOG=1`, `ORBI_DESKTOP_NO_MIC=1`,
`ORBI_DESKTOP_NO_SCREEN=1`, and `ORBI_DESKTOP_DRY_RUN=1` (no UI, no input,
no capture, all permissions reported off).
