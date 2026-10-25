# Wiring for module D (voice)

Everything below goes into shared files that module D does not own. The worker side is one import; all routing logic lives in `lib/voice/relay.js` and is unit-tested (`extension/test/voice/relay.test.mjs`).

## manifest.json additions

```jsonc
{
  "permissions": ["storage", "offscreen"],          // add "offscreen" (keep the others' additions, e.g. tabs/debugger/scripting)
  "options_page": "options/options.html",
  "commands": {
    "toggle-listening": {
      "suggested_key": { "default": "Ctrl+Shift+Space", "mac": "MacCtrl+Shift+Space" },
      "description": "Start or stop listening (toggle, for when holding a key is hard)"
    }
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/hotkey.js"],
      "run_at": "document_start",
      "all_frames": true,
      "match_about_blank": true
    }
    // module E's subtitles.js entry sits alongside this one
  ]
}
```

- No `web_accessible_resources` are needed: `hotkey.js` is self-contained (classic script), and the offscreen/options pages load `lib/*` as extension pages.
- `host_permissions` already has `http://localhost/*`, which covers `GET http://localhost:5050/cartesia-token` from the offscreen document. WebSockets (`ws://localhost:5050/session`, `wss://api.cartesia.ai/...`) need no host permission, and the default extension CSP doesn't restrict `connect-src`.
- The suggested `MacCtrl+Shift+Space` is Control (not Command) on a Mac. If the user also picks `Ctrl+Shift+Space` as the hold key in options, Chrome's command takes the keys first and the hold key never sees them. Either drop the command's `suggested_key` or keep the hold-key default at Alt+Space (the default).

## background/worker.js snippet (ready to paste, top level)

```js
import { installVoiceRelay } from "../lib/voice/relay.js";

// Hold-to-talk: content/hotkey.js PTT_START/PTT_STOP -> offscreen VOICE_START/VOICE_STOP,
// "toggle-listening" command -> PTT_TOGGLE, offscreen SUBTITLE/VOICE_STATE/VOICE_ERROR/STATUS
// -> the tab that started talking (or the active tab). Must run synchronously at top level.
const voice = installVoiceRelay();
```

`installVoiceRelay()` registers `runtime.onMessage`, `commands.onCommand`, `storage.onChanged` and `tabs.onActivated` listeners. Its `onMessage` listener never returns `true` and never calls `sendResponse`, so it coexists with other modules' listeners (e.g. the PAGE_CALL handler). The returned object exposes `ensureOffscreen()`, `closeOffscreen()` and `toggle()` if the integrator wants a popup/action button to toggle listening (`voice.toggle()`), or to close the document on suspend.

### What the relay does

| From | Message | Relay action |
| --- | --- | --- |
| content (`hotkey.js`) | `PTT_START` | create offscreen if missing (`reasons: ["USER_MEDIA","AUDIO_PLAYBACK"]`), send `VOICE_START {settings, target:"offscreen"}`; remember `sender.tab.id` |
| content | `PTT_STOP` | `VOICE_STOP` (never creates the document) |
| any | `PTT_TOGGLE` / command `toggle-listening` | `PTT_TOGGLE {settings}` |
| any | `TTS_STOP` | `TTS_STOP` (barge-in without talking) |
| `chrome.storage` (local) | change | `SETTINGS_CHANGED {settings}` if the document exists |
| offscreen (`from:"offscreen"`) | `SUBTITLE`, `VOICE_STATE`, `VOICE_ERROR`, `STATUS`, `VOICE_PARTIAL`, `VOICE_FINAL` | `chrome.tabs.sendMessage(tabId, msg)` with `from`/`target` stripped, to the talking tab (falls back to the active tab; follows `tabs.onActivated`) |
| offscreen | `VOICE_ERROR {code:"mic_blocked"}` | also `runtime.openOptionsPage()` once, so the user can press Grant microphone |

Messages to the offscreen document are serialized, so a quick release can't overtake the press that is still creating the document.

Why `target`/`from`: `runtime.sendMessage` from a content script reaches every extension page, including the offscreen document. The offscreen document only acts on messages with `target: "offscreen"` (sent by the relay), and marks its own with `from: "offscreen"`.

## Messages the offscreen document emits (for module E and the popup)

- `{type: RT.SUBTITLE, speaker: "user", text, final:false}` for each Ink `turn.update`/`turn.eager_end` (text is the whole open turn so far, growing), then `final:true` on `turn.end`.
- `{type: RT.SUBTITLE, speaker: "agent", text, final:true}` per `agent_text` (the agent sends whole replies, not streamed).
- `{type: RT.VOICE_STATE, state}` on every change: `listening` on press, `thinking` after a final user turn until Sonic starts, `speaking` while audio plays, else `idle`.
- `{type: RT.VOICE_PARTIAL|VOICE_FINAL, text}`, `{type: RT.VOICE_ERROR, code?, message}`.
- `{type: RT.STATUS, kind: "status", text}` for agent `status`, `{type: RT.STATUS, kind: "receipt", receipt: {item,total,last4}}`, `{type: RT.STATUS, kind: "agent", state: "open"|"closed"}` for the session socket.

## First run

The offscreen document can't show a permission prompt. Open the options page (`chrome.runtime.openOptionsPage()`, also done automatically on the first `mic_blocked`) and press **Grant microphone**; the offscreen document shares the extension origin and inherits the grant. The integrator may want `chrome.runtime.onInstalled` with `reason === "install"` to open the options page.

## Known limits

- Chrome may close an `AUDIO_PLAYBACK` offscreen document after about 30 s with no audio. The relay recreates it on the next press, and the agent session socket reconnects, but an `agent_text` that arrives while the document is closed is lost. If that shows up in testing, keep it alive from the worker (e.g. recreate on `VOICE_STATE thinking`) or ask C to buffer per session.
- The offscreen document opens its own `ws://localhost:5050/session`. If the server allows only one session client, close the standalone voice console while using the extension.
- The toggle command flips listening on/off; it doesn't use hold semantics.
