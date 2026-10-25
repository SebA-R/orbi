# agent

The voice agent server, built with the Claude Agent SDK (TypeScript, model `claude-sonnet-5-5`). It takes transcribed turns from `voice/`, drives the browser through Open Claude in Chrome and sends replies back to be spoken.

## Run

```bash
cd agent && npm install && npm start      # http://localhost:5050
```

Needs `ANTHROPIC_API_KEY` and `CARTESIA_API_KEY` in the repo-root `.env`, the store on :4000, and a browser running the Open Claude in Chrome extension. Before the first payment, run `vault/setup-test-card.sh` once.

| Env | Default | Purpose |
| --- | --- | --- |
| `AGENT_MODE=echo` | off | answer every `user_text` with an echo, no Claude (voice console testing) |
| `AGENT_PORT` | 5050 | |
| `OCIC_SERVER` | `~/code/open-claude-in-chrome/host/mcp-server.js` | browser MCP server to spawn (plain server: no wrangler sidecar, no `execute_code`) |
| `CLEARCART_SHIP_ADDRESS` | a demo Berkeley address | used by `pay_now` when the address field is empty |
| `CLEARCART_DEBUG=1` | off | print the Claude Code subprocess stderr |
| `CLEARCART_ALLOW_ANY_SITE=1` | off | turn off the browse check and the tab sweep entirely (the checkout page block and button lock stay) |
| `CLEARCART_BROWSE_MODE` | `open` | `open`: `navigate` and the tab sweep accept any http(s) site except the blocked sites (`blocklist.ts`: fixed rules for non-web schemes, logins in the address, and localhost and private network addresses other than the store in any spelling, so the agent console too, plus the extension's list in ext mode or the suggested list otherwise) and `CLEARCART_BLOCKED_ORIGINS`. `allowlist`: only the store and `CLEARCART_ALLOWED_ORIGINS`. The tab sweep sends a tab on a blocked site back a page (open) or to the store home page (allowlist, or when back fails) |
| `CLEARCART_GUIDED` | `1` | Guided mode outside ext mode (`0`: off). In ext mode the extension's Guided mode setting decides. On: the agent describes pages and lets the user choose |
| `CLEARCART_ALLOWED_ORIGINS` | store only | comma-separated origins always accepted, in both modes (parsed-origin match; set on the command line, it is read before `.env` loads). The agent is told to stop at the cart on every site but the store; `pay_now` stays store-only |
| `CLEARCART_BLOCKED_ORIGINS` | none | comma-separated origins never opened, in both modes (exact origins) |
| `CLEARCART_PAY_ORIGINS` | store only | the only origins where the unlock gate issues grants. Independent of the browse mode, so open browsing never makes a site payable |
| `CLEARCART_STORE_ORIGIN` | `http://localhost:4000` | where the demo store runs (`pay_now`, the prompt and the tab sweep use it); set on the command line, e.g. for a test store on a spare port |
| `CLEARCART_MEMORY` | `1` | Memory outside ext mode (`0`: off). In ext mode the extension's Memory setting decides. Off: saved facts are not used or saved and the conversation is not kept for a restart |
| `CLEARCART_DATA_DIR` | `agent/.data` | where `memory.json` (saved facts) and `transcript.json` (the last 2 hours of what was said) live; gitignored, files 0600 |
| `CLEARCART_EXT_IDS` | from `extension/manifest.json`'s key | comma-separated extension ids allowed at `/memory` |
| `CLEARCART_BROWSER=ext` | off | drive the browser through the Clearcart extension instead of Open Claude in Chrome: adds the `/ext` WebSocket (`extbridge.ts`), gives Claude the extension tools as the in-process `browser` MCP server (`exttools.ts`), and `pay_now` fills the card with one `fill_payment` bridge call then clicks `#place-order`. Unset, nothing changes |

Tests: `npm test` (fake extension over a real socket; the server test uses ports 5170 to 5176).

## Files

- `server.ts`: static `voice/public` at `/`, `GET /cartesia-token` (POST `https://api.cartesia.ai/access-token`, `Cartesia-Version: 2026-08-14`, TTS and STT grants, returns `{ token, expires_in: 300 }`), `GET /healthz`, WebSocket `/session`; requests must carry a local `Host` header, and WebSocket upgrades an `Origin` that is the Clearcart extension or this server's own page (or none, for clients that are not browsers), so a web page cannot open `/session` and speak as the user.
- `hub.ts`: one voice session for every `/session` socket. The socket the user last talked into owns it (`interrupt` claims it; `user_text` does too, unless that socket lost the session since, then it gets `{ type: "standby", reason: "stale" }` and the words are dropped). Output goes to the owner only. On a change of owner the old one gets `{ type: "standby", reason: "moved" }`, a read-back or unlock question still waiting is declined (never confirmed) and the turn in progress is muted. The session ends with the last socket or when its agent stops.
- `session.ts`: one `query()` for that session with streamed user turns, the `request_checkout` and `pay_now` tools, and the PreToolUse guard.
- `pay.ts`: the `pay_now` logic. `bridge.ts`: our own client for the extension's bridge socket.
- `hostcheck.ts`: the `Host` header check (DNS rebinding defense).
- `unlock.ts`: the button lock's unlock gate. `ocic-lock.ts`: the button lock checks for the Open Claude in Chrome path. `origins.ts`: the browse mode, allowed, blocked and pay origins. `blocklist.ts`: the blocked sites check, imported from `extension/lib/blocklist.js`.
- `prompt.ts`: the system prompt.
- `memory.ts`: saved facts and the recent conversation, on this computer only. Facts are saved only by the `remember` tool, at once when the user's own last words asked to remember it and the fact is made of their words, otherwise after a spoken yes; `forget` works the same way and `recall` lists them. A filter refuses card numbers, security codes, passwords, government IDs, bank details, emails, long numbers and anything that reads like an instruction. The conversation keeps only the user's words and Clearcart's spoken replies (never page text or the context block, long numbers removed) and is put in front of the next session's first turn as quoted data, so a restart picks up where it left off. Facts about shipping, addresses, paying or pressing buttons are refused too, at most one fact per spoken ask saves without a question, and a memory question is never asked while a checkout read-back or unlock question waits. In ext mode Memory is off until the extension says it is on. `GET /memory`, `DELETE /memory/<id>` and `DELETE /memory` serve the extension's settings page: loopback peers with the Clearcart extension's `Origin` only.

## How the browser is wired

The extension's native host owns a unix socket (`$TMPDIR/open-claude-in-chrome-<uid>/bridge.sock`) and multiplexes any number of clients onto the one native-messaging link. A second server does not conflict with the one Claude Code runs: several were attached at once while this was built. Each session spawns its own `host/mcp-server.js` as the SDK's stdio MCP server (`mcp__browser__*`). `pay_now` connects to the same socket directly from our process, so card values never pass through Claude.

All clients share one "MCP" tab group in the browser, so a Claude Code session driving the browser at the same time sees the same tabs. Don't run both at once during the demo.

## Guardrails

- Built-in Claude Code tools are off (`tools: []`), and settings, CLAUDE.md files and user MCP servers are not loaded (`settingSources: []`, `strictMcpConfig`). `permissionMode: "dontAsk"` denies anything not in the allow list.
- Never available: `execute_code` (its sandbox could call every browser tool and get around the guard), `javascript_tool` (page script could press a locked button; `pay_now` still uses it over our own client), `gif_creator`, `read_network_requests`, `debug`, `get_config` and `set_config`, uploads, shortcuts and the recording tools.
- `navigate`, `tabs_create` and `tabs_create_mcp` follow the browse mode (`CLEARCART_BROWSE_MODE`, above), checked by parsed origin, so `http://localhost:4000@evil.example/` is refused. Localhost and private network addresses other than the store are blocked in any spelling (`[::ffff:127.0.0.1]`, `[::7f00:1]`, `[fec0::]`, `2130706433`), under loopback DNS names (`localtest.me`, `127.0.0.1.nip.io`), and when a name resolves to one (a DNS lookup before opening).
- On the Open Claude in Chrome path, page tools (`computer`, `get_page_text`, `read_page`, `find`, `form_input`, `read_console_messages`, `set_tab_focus`) first check the target tab's current URL with `tabs_context_mcp`, so a page script redirect is caught before Claude reads the page; an unknown tab or URL is denied. Our extension does the same check itself and also checks the IP each page actually came from.
- After every browser call, a PostToolUse sweep sends any agent tab on a blocked site (a clicked link, a redirect) back a page, or to the store home page, and tells Claude. It fails closed: if the sweep cannot run or a tab will not move, Claude is told and every browser call is refused until a sweep succeeds.
- `server.ts` refuses any HTTP request or WebSocket upgrade whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` with its own port (`hostcheck.ts`), so a DNS rebinding page cannot read `/cartesia-token` or open `/session`.
- While card values are in the form, the guard blocks `computer` (screenshots included), `read_page`, `get_page_text`, `find`, `form_input`, `javascript_tool` and `read_console_messages`.
- `request_checkout` reads the order back and treats the next `user_text` as the answer. Only an explicit yes ("yes", "yeah", "yep", "confirm", "go ahead", and no "no", "wait" or "change") confirms it. Each confirmation pays once.
- Button lock (see below): clicks, Enter and Space, typed newlines and `form_input` on protected controls are denied, and `navigate` refuses checkout and payment URLs on every site except the store.
- `pay_now` checks for a confirmation, a tab on `http://localhost:4000/checkout`, and a page total that matches the confirmed total. It refuses if the extension's audit recording is on, because that recording keeps unmasked input values on disk. It fills the form with one `javascript_tool` call, padded so the extension's debug log (which keeps the first 60 characters of each argument) never holds the values. Then it presses `#place-order` through the unlock gate, waits for `/order/:id`, emits `receipt` and returns `{ ok, last4 }`. If the order page doesn't load, it clears the card fields.

## Button lock

Claude's browser tools can never press a protected control (order commits, wallets, subscriptions, saved cards, sign in, the submit of a card or password form, anything inside `data-clearcart-protected`); opt-in boxes are uncheck only. The rules live in `extension/content/protect.js`, shared by both browser paths; the full list is in [`extension/README.md`](../extension/README.md#button-lock).

- **Our extension (`CLEARCART_BROWSER=ext`)**: enforced inside the extension, so no agent-side bug can skip it. See `extension/README.md`.
- **Open Claude in Chrome**: enforced in the PreToolUse hook by `ocic-lock.ts`. `computer` clicks by coordinate are hit-tested in the page. Clicks by ref only are refused with a note to use a coordinate, because OCIC clicks the ref's centre in its own world, which the check cannot see. `key` Enter or Space (and a control character key) and `type` with a newline are checked against the focused element and its form, and `form_input` against the ref (a dropdown never moves onto an opt-in option); any check that cannot run denies the call. Without `chrome.dom` in the main world, a click on a host that may hide a closed shadow root is denied. After `read_page` and `find`, a PostToolUse note names the locked refs and the badges are drawn. The page checks run in the page's main world, so a hostile page could tamper with DOM prototypes to fool them; our extension does not have that gap.
- **Unlock**: only our pay code, through `unlock.ts`. A grant needs a confirmed spoken yes, a page on a pay site (`CLEARCART_PAY_ORIGINS`, default the store; not the browse policy) and a page total that matches the yes. It is single use, bound to the tab and origin, and expires after 60 s. The yes itself is pinned too: `request_checkout` records the checkout tab, its priced cart lines and the time, and `pay_now` spends the yes synchronously before any await, then refuses one older than 60 s, from another tab, or for a changed cart. On the ext path the press also needs a single-use `lock_arm` nonce from the extension, and `press_protected` only presses an order button. The gate is not tied to the demo store, but `pay_now` only knows how to fill the store's checkout form, so in practice only the store unlocks today.
- **Prompt**: `prompt.ts` tells Claude what `[locked]` and `[uncheck only]` mean. The prompt is a courtesy; the lock does not depend on it.
