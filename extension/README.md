# Clearcart extension

Our own Chrome extension (Manifest V3) for Clearcart. It replaces the third-party browser extension the agent used before, and adds hold-to-talk voice and subtitles on any tab.

## What it does

- Connects to the Clearcart agent server over a WebSocket (`ws://localhost:5050/ext`) and runs browser tools for it: tabs, navigation, page reading, form input, clicks, keys, scrolling and screenshots.
- Only acts on allowlisted origins (by default the demo store at `http://localhost:4000`), and only in tabs of its own "Clearcart" tab group.
- Never returns card numbers: page-reading tools mask payment fields and card-like digit runs, `form_input` and typing refuse payment fields and card numbers, and the card is filled by `pay_now` in one `fill_payment` call that answers only `last4`.
- Hold **Option+Space** (Alt+Space) on any page to talk to the agent; the reply is spoken and shown as subtitles at the bottom of the tab.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick this `extension/` folder. The extension id is fixed by the manifest key (`dhgknfenfoidnchmjfaicafhieepefoc`).
2. The options page opens on first install (or right-click the toolbar icon → Options). Press **Grant microphone** and allow it. The offscreen voice document can't ask for the mic itself; it inherits this grant.
3. In the repo's `.env`, set `CLEARCART_BROWSER=ext`, then restart the agent server (`npm --prefix agent start`). The server log should say `ext: extension connected`.
4. Start the store as usual (`node store/server.js`) and hold Option+Space to talk.

Chrome shows a "Clearcart started debugging this browser" bar while the agent clicks or types (CDP input). That's expected; if you cancel it, clicks fall back to DOM clicks.

To switch back to Open Claude in Chrome, remove `CLEARCART_BROWSER=ext` and restart the agent server.

### Options

| Setting | Default | |
| --- | --- | --- |
| Agent URL | `ws://localhost:5050` | loopback only; the worker connects to `<url>/ext`, voice to `<url>/session` |
| Allowlist | `http://localhost:4000` | origins the agent may open and drive |
| Hold-to-talk key | Option+Space | also Ctrl+Shift+Space or F9 |
| Speech speed | 1 | 0.6 to 2 |
| Subtitles | on | |

`chrome://extensions/shortcuts` sets the **toggle-listening** command (suggested Control+Shift+Space) for people who can't hold a key. Don't pick the same keys as the hold key.

## How it fits together

| Path | Contents |
| --- | --- |
| `manifest.json` | Manifest V3: `storage`, `tabs`, `tabGroups`, `debugger`, `scripting`, `offscreen`; host `http://localhost/*` |
| `background/worker.js` | Service worker: starts the bridge, routes requests, tab and debugger lifecycle, the voice relay |
| `background/router.js` | Maps each bridge method to tabs/CDP or the page script, with the card guard on `type`/`key` |
| `background/tabs.js`, `cdp.js`, `allowlist.js` | The Clearcart tab group, navigation, `chrome.debugger` input and screenshots, the origin allowlist |
| `content/mask.js`, `content/page.js` | Injected on demand into agent tabs: refs, `read_page`, `find`, `get_page_text`, `form_input`, `rect`, `click_ref`, `read_fields`, `fill_payment`, `clear_payment`, `focused_field` |
| `content/hotkey.js` | Declared content script (all frames, `document_start`): hold-to-talk key → `PTT_START`/`PTT_STOP` |
| `content/subtitles.js` | Declared content script (top frame, `document_idle`): the caption overlay |
| `offscreen/` | Offscreen document: mic, Cartesia Ink STT and Sonic TTS, chimes, its own `/session` socket |
| `options/` | Options page and the microphone grant |
| `lib/` | Protocol, bridge client, settings, redacting logger, voice modules |

### Bridge requests

The agent server sends `{ type: "request", id, method, params }` and the worker answers with `okResponse`/`errorResponse` codes from `lib/protocol.js`. Every tab-bound call resolves its tab with `tabs.resolveAllowedTab` (in the Clearcart group and on the allowlist).

- `tabs_context`, `tabs_create`, `navigate` (`"back"`/`"forward"` too), `tab_info` → `tabs.js`.
- `click`, `type`, `key`, `scroll`, `screenshot` → `cdp.js`. `click` with a `ref` clicks the centre of the page's `rect` and falls back to `click_ref` if CDP can't attach. `type` and single-character `key` are refused (`payment_field`) when the text holds a Luhn-valid 13-19 digit run or the focused element is a card field.
- Page methods inject `content/mask.js` then `content/page.js` with `chrome.scripting` (idempotent; refs stay stable for the document's life), send `PAGE_CALL` to the top frame and retry once on "Receiving end does not exist".
- Only the 12 `TOOLS` are exposed to Claude. `INTERNAL` methods (`tab_info`, `read_fields`, `fill_payment`, `clear_payment`, `rect`, `click_ref`) are called only by the server's own code.

### Voice and subtitles

`installVoiceRelay()` (`lib/voice/relay.js`) creates the offscreen document on the first press (`USER_MEDIA`, `AUDIO_PLAYBACK`), relays `PTT_START`/`PTT_STOP` and the toggle command to it in order, and sends its `SUBTITLE`, `VOICE_STATE`, `VOICE_ERROR` and `STATUS` messages to the tab that started talking (or the active tab), where `subtitles.js` shows them. A first `mic_blocked` error opens the options page. The offscreen document opens its own `/session` socket; the server accepts any number of session clients.

## Tests

Tests stay outside the shipped code paths, and every browser test uses Playwright's bundled Chromium with a temporary profile, never your Chrome.

```
npm --prefix tests/extension install           # Playwright + ws, needed by the browser tests below
npm --prefix tests/extension test              # protocol, bridge, settings, log, router + load test
node --test --test-concurrency=1 extension/test/tabs-cdp/ extension/test/voice/
(cd extension/test/page && npm install && npm test)        # jsdom against real store HTML + Chromium layout
(cd extension/test/subtitles && npm install && npm test && npm run screenshots)
npm --prefix agent test                        # bridge, tools and pay_now with a fake extension
npm --prefix agent run test:e2e:ext            # full flow: store on 4300, agent on 5300, the real extension
```

## Known gaps

- Host permissions cover `http://localhost/*` only. Allowlisting a real site in options isn't enough on its own: page calls need host access to that origin too (an optional host permission request is not wired yet).
- Typing guard: a card field inside a cross-origin iframe (hosted payment forms) reports as "none" from the top frame, so only the Luhn check protects it there.
- Subtitles show in the top frame only, and not over fullscreen (top-layer) elements.
- Chrome may close the `AUDIO_PLAYBACK` offscreen document after about 30 s of silence; the next press recreates it, but an `agent_text` that arrives while it is closed is lost.
- `navigate("back")` after only programmatic navigations may report `bad_request` (Chrome's history intervention skips entries without a user gesture).
