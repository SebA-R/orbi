# Clearcart

Clearcart is a voice shopping agent for blind and low-vision screen reader users. You say what you want, and Clearcart searches, compares and reads back products, fills the cart and checks out by driving a real browser for you. Payment details come from a local vault and are filled straight into the checkout form after a Touch ID prompt, so the AI model never sees your card.

## Stack

- **Voice:** Cartesia Ink 2 speech-to-text (`/stt/turns/websocket`) and Cartesia Sonic text-to-speech (`/tts/websocket`)
- **Agent:** Claude via the Claude Agent SDK (TypeScript), model `claude-sonnet-5-5`
- **Browser automation:** the third-party extension Open Claude in Chrome, plus our own add-ons
- **Payment vault:** a native messaging host with the macOS Keychain and Touch ID that fills card fields without the model ever seeing the card
- **Demo store and verifier:** the Visa Trusted Agent Protocol sample
- **Payments:** the Visa Acceptance sandbox

## Layout

| Path | Contents |
| --- | --- |
| `agent/` | Claude Agent SDK voice agent server |
| `voice/` | Cartesia STT/TTS client |
| `extension-addons/` | Our changes on top of Open Claude in Chrome (side panel, payment fill, redaction) |
| `vault/` | Native messaging host, Keychain and Touch ID helper |
| `store/` | Setup notes for the demo store (TAP sample) |
| `docs/` | Design notes and documentation |
| `vendor/open-claude-in-chrome/` | Git submodule for Open Claude in Chrome (third-party) |

## Third-party code and credits

- **Open Claude in Chrome** by Sebastian Sosa / noemica (https://github.com/noemica-io/open-claude-in-chrome). Its LICENSE file is the PolyForm Noncommercial License 1.0.0, even though its README says MIT. We use it as a dependency through a git submodule, and its code is not part of this project.
- **Visa Trusted Agent Protocol sample** (https://github.com/visa/trusted-agent-protocol). It is covered by the Visa Developer terms, not an open-source license, and we use it as the demo store and verifier.
- **Cartesia**, for the Ink 2 speech-to-text and Sonic text-to-speech APIs.
- **Anthropic Claude**, through the Claude Agent SDK.

## Hackathon

This project was started at Cal Hacks 13.0 (October 24-25, 2026). All of the code in this repository was written during the event.

## Secrets

Never commit API keys. Copy `.env.example` to `.env` and put your keys there. `.env` is gitignored.
