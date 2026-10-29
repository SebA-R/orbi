# Parallel build contract

Five modules are built at the same time on separate branches off `feat/clearcart-extension`, then an integrator rebases them in and wires them up. To avoid conflicts, **each module only creates files in its own paths** and never edits shared files (`manifest.json`, `background/worker.js`, `lib/*`). Anything a module needs in a shared file goes in its `WIRING.md` for the integrator.

Clean-room rule: write from Chrome docs and this repo only. Never read `open-claude-in-chrome` or `vendor/`.

Existing base (read it, don't change it): `lib/protocol.js` (MSG, TOOLS, INTERNAL, ERR, RT, BridgeError, okResponse/errorResponse/parseMessage), `lib/bridge.js` (WebSocket client to `ws://localhost:5050/ext`, hello/welcome, heartbeat, backoff), `lib/settings.js`, `lib/log.js` (redacting logger), `background/worker.js`.

## Module ownership

| Module | Branch | Owns paths |
| --- | --- | --- |
| A. Tabs and CDP | `feat/ext-tabs-cdp` | `extension/background/tabs.js`, `extension/background/cdp.js`, `extension/background/allowlist.js`, tests under `extension/test/tabs-cdp/` |
| B. Page | `feat/ext-page` | `extension/content/page.js`, `extension/content/mask.js`, tests under `extension/test/page/` |
| C. Server bridge | `feat/ext-server` | `agent/extbridge.ts`, `agent/exttools.ts`, minimal edits in `agent/server.ts`, `agent/session.ts`, `agent/pay.ts` behind `CLEARCART_BROWSER=ext`, tests under `agent/test/` |
| D. Voice | `feat/ext-voice` | `extension/offscreen/*`, `extension/content/hotkey.js`, `extension/options/*`, `extension/lib/voice/*` (new files only), tests under `extension/test/voice/` |
| E. Subtitles | `feat/ext-subtitles` | `extension/content/subtitles.js`, `extension/content/subtitles.css` (or inline), tests under `extension/test/subtitles/` |

## Interfaces

### A. Tabs and CDP (service-worker modules, ES exports)

```js
// allowlist.js
export async function allowedOrigins(): Promise<string[]>   // from settings, default [] (none until the user adds some)
export async function assertAllowed(url: string): Promise<void> // throws BridgeError(ERR.NOT_ALLOWED) unless new URL(url).origin is allowed
export function blockReason(url, settings): string | null      // browseMode "open": lib/blocklist.js fixed rules + settings.blocklist entries; "allowlist": origin in settings.allowlist
export async function isAllowed(url: string): Promise<boolean>  // !blockReason(url, settings); lock_arm needs it
export async function frameAllowed(url: string): Promise<boolean> // a frame fill_card may fill: fixed rules only (web page, no login, local only if allowed)

// tabs.js  (no tab group: the user's open tabs plus tabs Orbi opens; which ones it opened is kept in chrome.storage.session)
export async function tabsContext(): Promise<{ tabs: {tabId,title,url,active,openedByClearcart}[] }> // url = origin+path; tabs on blocked pages left out
export async function tabsCreate({ url? }): Promise<{ tabId }>                     // background tab (active: false) next to the user's tab
export async function tabsClose({ tabId }), tabsActivate({ tabId })                // close: only tabs Orbi opened; activate: when the user asks
export async function navigate({ tabId, url }): Promise<{ tabId, url, title }>      // "back"/"forward" allowed; waits for status "complete" (timeout 20 s); assertAllowed first
export async function tabInfo({ tabId }), agentTabs()                               // INTERNAL: full URLs for the pay flow and the tab sweep
export { isAllowed, frameAllowed }                                                  // from allowlist.js, for the router
export async function resolveAllowedTab(tabId?): Promise<number>                   // re-checks the tab's page on every call; default = tab used last, else the active tab

// cdp.js  (chrome.debugger, protocol 1.3; attach lazily per tab, detach on tab close)
export async function click({ tabId, x, y }): Promise<void>         // Input.dispatchMouseEvent moved/pressed/released, button left
export async function type({ tabId, text }): Promise<void>          // Input.insertText
export async function key({ tabId, key }): Promise<void>            // e.g. "Enter", "Tab", "Escape", "ArrowDown"
export async function scroll({ tabId, x, y, dx, dy }): Promise<void> // Input.dispatchMouseEvent mouseWheel
export async function screenshot({ tabId }): Promise<{ data: string, mimeType: "image/jpeg", width, height, scale }> // Page.captureScreenshot jpeg q70, clipped to the viewport at CSS size (width x height CSS px; scale = image px per CSS px, 1 unless the viewport is past the model's 2576 px / 3.75 MP image limit)
```

### B. Page content script (`content/page.js`, injected with `chrome.scripting.executeScript` on demand, idempotent)

The worker sends `chrome.tabs.sendMessage(tabId, { type: RT.PAGE_CALL, method, params })`; the script replies `{ ok: true, result }` or `{ ok: false, error: { code, message } }` using ERR codes.

| method | params | result |
| --- | --- | --- |
| `read_page` | `{ filter?: "interactive"\|"all", maxNodes?: 400 }` | `{ url, title, tree: string }` indented lines like `- button "Add to bag" [ref_12]`, payment field values always masked; on Google Docs, Sheets and Slides also `note`, how to edit the canvas |
| `find` | `{ query: string, limit?: 20 }` | `{ matches: [{ ref, role, name }] }` (text/role/label match) |
| `get_page_text` | `{ maxChars?: 20000 }` | `{ url, title, text, locked? }` (main content first, payment values masked; `locked`: the page's blocking locked controls as `[{ ref, name, uncheckOnly?, userOnly? }]`; `userOnly`: never unlocks on request; on a Google Docs, Sheets or Slides file, `text` is the file's own text from its export link, with `source` and `note`) |
| `form_input` | `{ ref, value }` | `{ ok: true }`; refuses payment fields with ERR.PAYMENT_FIELD |
| `rect` | `{ ref }` | `{ x, y, width, height }` viewport CSS px after `scrollIntoView({block:"center"})` (worker passes the centre to `cdp.click`) |
| `order_buttons` | `{}` | `{ buttons: [{ ref, label, kind, disabled }] }` the controls only the pay flow presses (labels masked; checkout navigation left out) |
| `click_ref` | `{ ref }` | `{ ok: true }` DOM `.click()` fallback when CDP is unavailable; refuses locked targets with `ERR.LOCKED` |
| `guard_ref` | `{ ref }` | like `rect`, but `ERR.LOCKED` when the element, an ancestor or what covers its centre is protected (worker only) |
| `guard_point` | `{ x, y }` | `{ ok: true }` or `ERR.LOCKED` after hit-testing the point (worker only) |
| `guard_key` | `{ key }` | `{ ok: true }` or `ERR.LOCKED` for Enter or Space on a protected focus or form (worker only) |
| `press_check` | `{ ref }` | `{ x, y, width, height, kind }` when the ref is an order button and not covered; else `ERR.LOCKED` or `ERR.NO_ELEMENT` (worker only, for `press_protected`) |
| `press_ref` | `{ ref }` | DOM `.click()` on an order button (worker only, `press_protected` fallback) |

`mask.js` exports `isPaymentField(el)`, `luhn(text)`, `maskValue(text, el)`; refs are `ref_N`, stable per element (WeakRef registry).

`content/cardfill.js` (saved-card fill) is injected after `mask.js` into every frame of the tab with `chrome.scripting.executeScript({ target: { tabId, allFrames: true } })`, in the isolated world, and sets `__clearcartCardFill`: `scan()` → `{ href, fields: [{ kind, filled }] }`, `fill(values)` → `{ ok, filled: { kind: boolean } }` (values by kind: `cc-number`, `cc-name`, `cc-exp` / `cc-exp-month` / `cc-exp-year` as `{ mm, yy, yyyy }`, `cc-csc`, `postal-code`), `clear()` → `{ ok, cleared }`. None returns or logs a value.

`protect.js` (button lock, injected between `mask.js` and `page.js`) exports `classifyLabel(label, { checkable })`, `lockOf(el)`, `lockInChain(el)`, `lockAt(doc, x, y)`, `lockForKey(doc, key)`, `listLocks(doc)`, `message(lock)`, `pressable(lock)` and `showBadges(doc)`. A lock is `{ kind, label, optin, checked }`, kinds `order`, `marked`, `payment-form`, `express`, `subscription`, `payment-method`, `account`, `frame`. `read_page` appends `[locked]` or `[uncheck only]` after a protected control's ref; `find` adds `locked: true` or `uncheckOnly: true`; `form_input` refuses locked controls (an uncheck-only box may be set to false). `showBadges` also sets `data-clearcart-locked` (visual only, styled by one injected stylesheet) on controls and fields the agent is locked out of; `release(el)` clears it for the single-use press.

Bridge `INTERNAL` methods for paying: `card_state { tabId }` → `{ fields, filled, kinds, frames }` (counts only), `fill_card { tabId, card: { name, number, exp, csc, zip } }` → `{ ok, last4, name, zip, frames }` (each frame gets only its own fields' values; anything unclear is `ERR.NO_ELEMENT` and fills nothing), `clear_card { tabId }` → `{ ok, cleared }`, `lock_arm { tabId }` → `{ nonce, expiresInMs }` (single use, bound to the tab and its origin, 30 s, on a page the settings allow) and `press_protected { tabId, ref, nonce }` → `{ ok, via }`. User-directed unlock (agent `request_unlock`, `agent/user-unlock.ts`): `lock_info { tabId, ref }` → `{ locked, kind, label, cls, password, passwordFilled }` (never values), `lock_arm { tabId, scope: "user" }` (any allowed site) and `press_unlocked { tabId, ref, label, cls, nonce }`, which takes only a "user" nonce and presses only a control whose `Protect.unlockClass` is `cls` (checkout navigation, account, subscription, payment-method; never a marked control) with that label. The worker hit-tests the click point right before the CDP click (`press_hit_user`) and clears the lock marker only after it (`press_done_user`). A "user" nonce never fits `press_protected`, and Place order, Buy now, wallets and card form submits never have an unlock class. Password fields (ever type=password, autocomplete current-password, new-password or one-time-code, or a name, id or label saying password, passcode or otp; `Protect.isPasswordField`) are masked in `read_page`, refused by `form_input`, and typing into one is refused. The worker checks every `click`, `key` (Enter, Space) and `type` (with a newline) with the page before CDP and refuses with `ERR.LOCKED`. Every `ERR.LOCKED` message for Claude (`Protect.message(lock, ref)`) names the control and its ref, says nothing was pressed, and gives the next step: `request_unlock` with that ref when the control has an unlock class, never for Place order, Buy now, Pay, wallets, card forms, frames or hidden components.

### C. Server bridge (agent, TypeScript)

- `agent/extbridge.ts`: attaches a WebSocket endpoint at `/ext` to the existing HTTP server; accepts one extension at a time (the first install keeps it until it goes away; a reconnect with the same hello `client` id replaces its old socket, another install is refused with 4004); handshake per `lib/protocol.js` (reply `welcome`); `call(method, params, timeoutMs?)` → result or throws; `connected()`; events for connect/disconnect.
- `agent/exttools.ts`: in-process MCP server (Agent SDK `createSdkMcpServer` + `tool`) named `browser` exposing the TOOLS with zod schemas; `click` takes `{ tabId?, ref }` (server calls `rect` then `click`) or `{ tabId?, x, y }`.
- `CLEARCART_BROWSER=ext` makes `session.ts` use `exttools` instead of the open-claude-in-chrome stdio MCP server, and `pay.ts` use `call("card_state")`, `call("order_buttons")`, `call("fill_card")` and `lock_arm` + `press_protected` on the order button; default (unset) keeps today's path untouched. Guard/sweep use `call("tab_info")` and `tabs_context`.
- Test with a fake extension (a ws client in the test) — no browser needed.

### D. Voice (offscreen document + hotkey + options)

- `offscreen/offscreen.html|js`: created by the worker with reasons `USER_MEDIA` and `AUDIO_PLAYBACK`. Owns the mic, Cartesia Ink 2 STT (`/stt/turns/websocket`, model ink-2, keyterms from `voice/public/js/config.js`), Cartesia Sonic TTS (`/tts/websocket`, sonic-3.6, voice `6ccbfb76-1fc6-48f7-b71d-91ac6298247b`), the earcons (`lib/voice/chime.js`: one cue table, silent when `settings.sounds` is off), and the agent session socket `ws://localhost:5050/session` (user_text out; agent_text, status, receipt in). Token from `GET http://localhost:5050/cartesia-token` → `{ token, expires_in }`. Port logic from `voice/public/js/{stt,tts,mic,config}.js`.
- Runtime messages (RT): content/worker → offscreen `VOICE_START`/`VOICE_STOP`; offscreen → worker `VOICE_PARTIAL {text}`, `VOICE_FINAL {text}`, `VOICE_STATE {state: idle|listening|thinking|speaking}`, `VOICE_ERROR {message}`, and for every agent_text/user turn a `SUBTITLE` broadcast (see E). `TTS_STOP` for barge-in.
- `content/hotkey.js`: default hold plain **Space**, configurable (`settings.hotkey`). Keydown (no repeat) → `PTT_START {silent: true}`; still held after 200 ms → `PTT_CONFIRM`; keyup → `PTT_STOP`, or `PTT_CANCEL` plus a replayed tap (press the focused control, else scroll) if it was never confirmed. Plain Space is left alone in text fields. With Space as the key, Option+Space latches (`PTT_START {latch: true}`, everywhere including text fields); the next Space or Option+Space sends `PTT_STOP` and is swallowed; the controller stops a latch after 60 s without speech, and `VOICE_STATE` carries `latched: true` while it lasts. Double-tap Space while speaking → `PTT_HUSH` (hard stop plus the cut-off sound). The other hotkeys (Alt+Space, Ctrl+Shift+Space, F9) are hold-to-talk, confirm at once and work in editable fields. `preventDefault` only for the hotkey.
- `options/options.html|js`: hotkey, speech speed, subtitles on/off, agent URL, and a "Grant microphone" button (getUserMedia on the extension page so the offscreen doc inherits the permission).
- Worker wiring (for WIRING.md): create/close offscreen, relay PTT → VOICE_START/STOP, `chrome.commands` "toggle-listening" (suggested Ctrl+Shift+Space) → toggle.

### E. Subtitles (`content/subtitles.js`, declared as a content script on all URLs)

- Listens for `{ type: RT.SUBTITLE, speaker: "user"|"agent", text, final: boolean }` and `{ type: RT.VOICE_STATE, state }`.
- Closed shadow root, fixed bottom-center, max-width 720px, pointer-events none, `aria-hidden="true"`, z-index max; user line small and muted, agent line large; word-by-word reveal; a small state dot (listening/thinking/speaking); hides 6 s after the last final line; honors `prefers-reduced-motion` and light/dark; respects `settings.subtitles === false`.

## Commit and branch rules (all modules)

- In your worktree run `git fetch origin && git checkout -b <your branch> origin/feat/clearcart-extension` before any work.
- Small real commits (one function, one test, one fix), conventional messages (`feat(ext-tabs): …`), each ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No backdating, no squashing, no force-push.
- Push your branch when done. Don't touch main or other branches.
