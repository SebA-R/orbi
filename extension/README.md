# Clearcart extension

Our own Chrome extension (Manifest V3) for Clearcart. It replaces the third-party browser extension the agent used before, and adds hold-to-talk voice and subtitles on any tab.

Status: in progress on `feat/clearcart-extension`.

## What it does

- Connects to the Clearcart agent server over a WebSocket and runs browser tools for it (tabs, navigation, page reading, form input, clicks and keys).
- Only acts on allowlisted origins (by default the demo store at `http://localhost:4000`).
- Never returns card numbers: page-reading tools mask payment fields and card-like digit runs.

## Layout

No build step. Everything is plain JavaScript loaded by Chrome as-is.

| Path | Contents |
| --- | --- |
| `manifest.json` | Manifest V3 |
| `background/` | Service worker (ES modules) |
| `lib/` | Shared modules (protocol, logging, settings) |
| `content/` | Content scripts |
| `icons/` | Toolbar icons |

Tests live outside this folder, in `tests/extension/`, so `node_modules` never ends up inside the unpacked extension.
