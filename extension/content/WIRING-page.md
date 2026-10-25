# Wiring: page content script (module B)

## Injection

Both files are classic scripts (no `import`). Inject them **in this order**, on demand, before every page call (it is idempotent, so injecting every time is fine and survives navigations):

```js
await chrome.scripting.executeScript({
  target: { tabId },
  files: ["content/mask.js", "content/page.js"],
});
```

- `mask.js` sets `globalThis.ClearcartMask` (`isPaymentField`, `luhn`, `maskValue`, `maskCardRuns`).
- `page.js` installs `globalThis.__clearcartPage` once; re-runs return early, so refs (`ref_N`) stay stable for the document's life. A new document (navigation) starts again at `ref_1`.
- Both run in the extension's isolated world, so the page's own scripts cannot see the registry or call it.
- If `page.js` runs without `mask.js`, every call fails with `internal: mask.js was not injected before page.js`.

Manifest needs (integrator): `"permissions": ["scripting"]` plus host permissions for the allowed origins (default `http://localhost:4000/*`). No `content_scripts` entry and no `web_accessible_resources` are needed.

## Calling

```js
const reply = await chrome.tabs.sendMessage(tabId, { type: RT.PAGE_CALL, method, params });
// { ok: true, result } | { ok: false, error: { code, message } }  (codes from ERR)
if (!reply.ok) throw new BridgeError(reply.error.code, reply.error.message);
```

If `sendMessage` rejects with "Receiving end does not exist", inject and retry once. The listener ignores messages from other extensions (`sender.id !== chrome.runtime.id`).

Methods: `read_page`, `find`, `get_page_text`, `form_input`, `rect`, `click_ref`, `read_fields`, `fill_payment`, `clear_payment` (params and results as in CONTRACT.md section B). Extras:

- `get_page_text` also returns `truncated: boolean`.
- `read_page` lines carry states: `checked`/`unchecked`, `disabled`, `required`, `level=N`, `href="/path"`, `value="..."`, and `payment` plus `value="[masked]"` or `empty` on payment fields.
- `form_input` takes booleans or `"true"/"on"/"false"` for checkboxes and option value or visible text for selects; it refuses payment fields **and** any Luhn-valid card number as a value (both `payment_field`).
- `fill_payment` `address` may be a string or `{ line1, line2, city, region, postal, country }`; it only fills an empty address field. Split `cc-exp-month`/`cc-exp-year` fields are handled. It returns `{ ok, last4 }` and never the card.

## Worker usage

- Tool `click` with `{ ref }`: `rect` → `cdp.click({ tabId, x: x + width/2, y: y + height/2 })`. Fall back to `click_ref` when the debugger can't attach.
- `pay_now`: `read_fields` (check a `cc-number` field exists) → `fill_payment` → `rect`/`click` (or `click_ref`) on `find({query:"place order"})` / `#place-order`; call `clear_payment` if the flow aborts.
- Only `read_page`, `find`, `get_page_text`, `form_input` are Claude tools; route `read_fields`, `fill_payment`, `clear_payment`, `rect`, `click_ref` from server code only.
- Never log `fill_payment` params; `lib/log.js` redaction should cover `card`.

## Tests

`cd extension/test/page && npm install && npm test` runs node:test against real store HTML (it spawns `store/server.js` on a random 42xx port) with jsdom, plus `chromium.test.js` in Playwright's bundled headless Chromium for real layout (rect hits `#place-order`, order placed with last4 1111).
