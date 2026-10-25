# Wiring: subtitles overlay (module E)

## manifest.json

Add this `content_scripts` entry. No new permissions are needed: content scripts declared with `matches` are injected without host permissions, and the script only reads `chrome.storage.local`, which `storage` already covers.

```json
"content_scripts": [
  {
    "matches": ["<all_urls>"],
    "js": ["content/subtitles.js"],
    "run_at": "document_idle",
    "all_frames": false
  }
]
```

`subtitles.js` is a classic script with no imports. It inlines `RT.SUBTITLE` ("subtitle"), `RT.VOICE_STATE` ("voice.state") and `RT.SETTINGS_CHANGED` ("settings.changed"). Keep them in sync if `lib/protocol.js` changes. All CSS is inside the script, so there is no `subtitles.css`.

## worker.js

Content scripts only get runtime messages sent to their tab, so the worker has to relay what the offscreen document sends:

```js
// On RT.SUBTITLE and RT.VOICE_STATE from the offscreen doc:
const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
if (tab?.id != null) chrome.tabs.sendMessage(tab.id, msg).catch(() => {}); // no receiver on chrome:// pages etc.
```

To keep the caption on screen when the user switches tabs, send to the active tab and, optionally, to the agent tab group as well. The overlay ignores anything it receives while hidden or disabled.

Message shapes:

- `{ type: "subtitle", speaker: "user" | "agent", text: string, final: boolean }`. `text` is the whole current line: partials grow cumulatively and `final: true` closes the line. The next agent message after a final one starts a new line, and a new user message clears the previous agent answer.
- `{ type: "voice.state", state: "idle" | "listening" | "thinking" | "speaking" }`. Any non-idle state shows the card and holds it up. `idle` starts the 6 s hide timer.
- Optional: `{ type: "settings.changed", settings: { subtitles: boolean } }`. The script also listens to `chrome.storage.onChanged` for `subtitles` directly, so this message isn't required.

## Behaviour notes

- Nothing is added to the page until the first message. The host is `<clearcart-subtitles>` with a closed shadow root, `aria-hidden="true"`, `inert`, `pointer-events: none` and `z-index: 2147483647`, all set with `!important`.
- Styles go through `adoptedStyleSheets`, which page `style-src` CSP does not block. There is a `<style>` fallback.
- Hides 6 s after the last final line or after `idle`. A partial line or an active state cancels the timer.
- `prefers-reduced-motion`: the card and words fade only, with no blur, stagger or dot animation. Light and dark follow `prefers-color-scheme`, and `forced-colors` gets system colours.

## Known gaps

- Not shown over fullscreen elements (the top layer). Using a popover host would fix that if it's ever needed.
- The top frame only (`all_frames: false`).
- If a message arrives before the stored `subtitles: false` setting loads, the card can flash briefly.

## Tests

```
cd extension/test/subtitles && npm install
npm test             # jsdom unit tests
npm run screenshots  # isolated Playwright Chromium; writes screenshots/*.png
```

The screenshot test loads a temp copy of `extension/` with the entry above added to the copy's manifest. It never touches the real manifest or the user's Chrome.
