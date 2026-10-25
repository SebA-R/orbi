# Orbi Desktop protocol (version 1)

The contract between the Orbi agent server (`agent/desktop/`) and the Orbi Desktop helper (`desktop/`, a native macOS menu-bar app). The server is the authority on safety. It checks every target before it asks the helper to act, and the helper refuses on its own as well. Both sides fail closed.

## Connection

- Transport: a Unix domain socket at `~/Library/Application Support/Orbi/desktop.sock` (`ORBI_DESKTOP_SOCKET` overrides). It is only available when `CLEARCART_BROWSER=ext`. There is no TCP endpoint for the helper: `/desktop` on the HTTP port answers 400 like any unknown path. With no port, nothing can shadow it, take it first or relay through it.
- The directory is mode `0700` and the socket `0600`, so only this user (and root) can connect. Node has no `getpeereid`, so that file mode is the server's uid check. The helper refuses a socket that isn't this user's, in a directory that isn't this user's and private, and after connecting it requires `getpeereid` to report the same uid.
- On start, the server clears a stale socket only if it is this user's socket and nothing answers on it. A live socket, or a path that isn't this user's socket, is left alone, and the desktop link doesn't start. The path must be under 104 bytes, the macOS limit.
- Frames: a 4-byte big-endian length, then that many bytes: one type byte (`1` = JSON text, `2` = binary audio) and the payload, at most 32 MB. A frame of length 0, too large, or of an unknown type ends the link.
- The server closes a link with a JSON frame `{"type":"close","code","reason"}` and then ends the stream. The codes are the ones below.
- Keepalive: the helper sends `{type:"ping", t}` every 15 s, and the server answers `{type:"pong", t}`. No pong within 10 s counts as a drop.
- Only one helper is connected at a time, and the newest one wins: when a new helper authenticates, the older socket is closed with `4002 replaced`.

## Auth

On startup the server creates `~/Library/Application Support/Orbi/desktop.token` if it is missing or malformed (`ORBI_DESKTOP_TOKEN_FILE` overrides the path, for tests):

- The token is 32 random bytes as 64 lowercase hex characters, followed by a newline.
- The file is mode `0600` and the directory is mode `0700`. The server enforces both on every start.

The token keeps out other users, sandboxed apps and web pages. A program running unsandboxed as the same user can read the file, so it is not a defense against that (such a program can already reach `/session` as well).

The helper reads the file fresh on each connect. If the file does not exist yet, the helper retries with backoff. The token itself never crosses the socket. Both sides prove they know it, so a program squatting on the port can't pose as the server, and nothing else can pose as the helper. The token is never logged.

## Handshake

1. The helper sends a hello with a fresh nonce (32 random bytes, 64 lowercase hex characters):

```json
{"type":"hello","name":"orbi-desktop","version":1,"nonce":"<64 hex>",
 "features":["element","focused","expectRef","exclude"],
 "permissions":{"accessibility":true,"screen":true,"mic":true}}
```

2. The server answers with its own nonce and proof:

```json
{"type":"challenge","nonce":"<64 hex>","proof":"<64 hex>"}
```

Here `proof = hex(HMAC-SHA256(key = token, "orbi-desktop server " + helperNonce + " " + serverNonce))`.

3. The helper checks that proof in constant time. On a mismatch it closes the socket and sends nothing else. On a match it replies:

```json
{"type":"auth","proof":"<64 hex>"}
```

Here `proof = hex(HMAC-SHA256(key = token, "orbi-desktop helper " + serverNonce + " " + helperNonce))`.

4. The server checks that proof in constant time and answers:

```json
{"type":"welcome","version":1,"blockedApps":["com.apple.keychainaccess", "..."]}
```

The key is the token's 64 hex characters as UTF-8.

The handshake runs on the private socket. The socket keeps out other users, and the proofs show that each side holds the token.

- A missing nonce, a wrong proof, or any other message before auth closes with `4004 unauthorized`, and no welcome is sent. Until an authenticated helper is connected, every desktop tool fails with `not_connected`.
- A wrong `name` or `version` closes with `4003`. No completed handshake within 5 s closes with `4001`.
- The helper answers no request, and sends no event or audio, before welcome.
- `features` lists the additions below that the helper supports. Without `expectRef`, the server refuses point clicks on unlabeled spots. Without `exclude`, it refuses screenshots.
- `blockedApps` holds the server's well-known blocked bundle ids plus the user's own list (`~/.config/orbi/desktop-blocked-apps.txt`). The helper refuses these apps in addition to its own hardcoded list, comparing ids case-insensitively.

## Requests

The server sends `{"type":"req","id","method","params"}`. The helper answers `{"type":"res","id","result"}` on success, or `{"type":"res","id","error":{"code","message"}}` on failure. The server never logs params or results, only method names and error codes.

All coordinates are in global screen **points** with the origin at the top left of the main display (the Quartz/AX space).

An **element** has this shape:

```
{ ref, role, subrole?, title?, label?, value?, frame:{x,y,w,h}, enabled, secure }
```

Empty optional fields are left out. A secure value comes back as `"[hidden]"`. A ref stays valid until the next `ax_tree` call for that app.

A **target** has this shape:

```
{ bundleId, appName, windowTitle, element: element|null, defaultButton?: element }
```

| method | params | result |
|---|---|---|
| `frontmost` | | `{bundleId, appName, windowTitle, browserUrl?, blocked?}` |
| `apps_list` | | `{apps:[{bundleId, appName, pid, active, hidden, blocked?}]}` |
| `app_activate` | `{bundleId}` | `{}` |
| `ax_tree` | `{bundleId?, maxNodes 1..1500}` | `{bundleId, appName, windowTitle, elements:[element]}` |
| `element` | `{ref}` | target, re-resolved live (`stale_ref` if gone) |
| `element_at` | `{x,y}` | target (`element` is null when nothing is there) |
| `focused` | | target for the system-wide focus. `defaultButton` is the focused window's AXDefaultButton |
| `click` | `{ref}` or `{x,y, expectRef?}`, plus `button?`, `count?` | `{}` |
| `type` | `{text, ref}` | `{}` |
| `key` | `{combo}` | `{}` |
| `scroll` | `{x,y,dx,dy}` (dy > 0 scrolls down) | `{}` |
| `screenshot` | `{maxWidth, exclude:[bundleId]}` | `{png, width, height, scale, redacted:true, excluded:[bundleId]}` |
| `overlay` | `{state, subtitle?, cursor?:{x,y}, ring?: bool or frame}` | `{}` |

Details:

- `click {x,y,expectRef}`: the server always sends a ref here, and never clicks a point where the hit test found nothing. Right before pressing, the helper hit-tests the point again. If the element there is not `expectRef` (or a descendant of it), it fails with `target_changed` and nothing is pressed.
- `type {text, ref}`: the helper focuses `ref` and checks that the focused element is that element, re-checking before each key. A secure field or secure keyboard entry fails with `secure_field`.
- `key {combo}`: lowercase modifiers `cmd`, `shift`, `alt`, `ctrl` and `fn`, joined with `+`, then one key: `a`-`z`, `0`-`9`, `return`/`enter`, `tab`, `space`, `escape`/`esc`, `delete`/`backspace`, `forwarddelete`, the arrows `up`/`down`/`left`/`right`, `home`, `end`, `pageup`, `pagedown`, `f1`-`f12`, and punctuation. An unknown key is a `bad_request`.
- `screenshot`: `scale` is PNG pixels per point (point = px / scale), and the capture covers the main display only. Every window of an app in `exclude`, in `blockedApps` or in the helper's own list is left out of the capture, and secure fields are blacked out. `excluded` lists the ids the helper left out, and an app that isn't running counts as excluded. The server refuses the image unless `redacted` is `true` and `excluded` contains every id it sent in `exclude`.
- `overlay.state` is one of `idle`, `listening`, `thinking` or `speaking`. With a frame, `ring` shows the edge ring plus a highlight box around that frame.

**Error codes:**

| code | meaning |
|---|---|
| `bad_request` | the request was malformed |
| `unknown_method` | the method doesn't exist |
| `no_element` | there is no such element |
| `stale_ref` | the ref is unknown or out of date |
| `target_changed` | the target changed before the action |
| `secure_field` | the action targets a secure field |
| `blocked_app` | the target or frontmost app is blocked, for any action or read |
| `no_permission` | a macOS permission is missing |
| `internal` | anything else |

`not_connected` and `timeout` are produced by the server only.

## Events (helper to server)

The helper sends `{"type":"event","name":"ptt_down"|"ptt_up"|"latch_toggle"}`.

- `ptt_down` is sent once the talk key (Right Option) has been held for 200 ms. The helper buffers audio from the moment the key goes down, so nothing is lost. A tap shorter than that sends nothing.
- `ptt_up` is sent on release.
- `latch_toggle` is sent for a second press within 350 ms of a tap. While latched, audio streams until the next `latch_toggle`. The helper auto-unlatches after 5 minutes.
- On `ptt_down` (and on latch on), the helper stops its own playback locally.

The server joins the conversation on the first `ptt_down`. Every press barges in: the server sends `audio_stop`, cancels speech, and claims the session from other Orbi windows.

## Audio

- **Helper to server:** binary frames of mic PCM, s16le, 16 kHz mono, about 20 to 40 ms each, sent only between `ptt_down` and `ptt_up` or while latched. The server transcribes them with Ink 2 and sends the words to the agent as the user's turn.
- **Server to helper:** binary frames of speech PCM, s16le, 24 kHz mono (Sonic). `{"type":"audio_stop"}` means stop playback now (barge-in).
- With `CLEARCART_VOICE=false`, or no Cartesia key, no audio flows. Replies show as overlay subtitles only, and a press shows that voice is off.

## What the server enforces

The full rules are in `agent/desktop/safety.ts`. In short:

- **Blocked apps:** password managers and Keychain, banking, System Settings and security prompts, terminals and IDEs, browsers other than Chrome, and Chrome itself (use the extension), plus the user's list.
- **The lock** on clicks and on Enter, Return, Space, Cmd+Return and Delete. It uses the extension's protect.js word lists plus send, delete and install/allow. A locked control is pressed only on the user's direct ask or a spoken yes. Pay and order controls always need the yes, and wallets never unlock.
- **Point clicks:** a click on an unlabeled spot needs a yes, and a failed hit test refuses.
- **Masking** of every AX string.
- **Typing:** only into text fields, and never secure or card fields or card numbers.
- **Danger mode** lifts only the lock.
