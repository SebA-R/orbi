# Wiring: module A (tabs and CDP)

Files: `background/allowlist.js`, `background/tabs.js`, `background/cdp.js`. Tests: `extension/test/tabs-cdp/` (`node --test extension/test/tabs-cdp/`; `browser.test.mjs` needs `npm install` in `tests/extension` and skips without it).

## manifest.json

Add to `permissions`:

```json
"permissions": ["storage", "tabs", "tabGroups", "debugger"]
```

- `tabs`: read `url`/`title` of agent tabs.
- `tabGroups`: the "Clearcart" group (`chrome.tabGroups.get/query/update`, `onRemoved`).
- `debugger`: CDP input and screenshots. Chrome shows the "Clearcart started debugging this browser" banner while attached; that is expected.

No new host permissions are needed for this module.

## worker.js

Register these at the top level (so Chrome can wake the worker for them):

```js
import * as tabs from "./tabs.js";
import * as cdp from "./cdp.js";

chrome.tabs.onRemoved.addListener((tabId) => cdp.onTabRemoved(tabId));
chrome.debugger.onDetach.addListener((source) => cdp.onDetach(source));
chrome.tabGroups.onRemoved.addListener((group) => tabs.onGroupRemoved(group));
```

Dispatch for bridge requests (params come from the server request):

| method | call |
| --- | --- |
| `tabs_context` | `tabs.tabsContext()` |
| `tabs_create` | `tabs.tabsCreate({ url })` |
| `navigate` | `tabs.navigate({ tabId, url })` (`url` may be `"back"`/`"forward"`) |
| `tab_info` | `tabs.tabInfo({ tabId })` |
| `click` (x, y) | `cdp.click({ tabId: await tabs.resolveAllowedTab(tabId), x, y })` |
| `type` | `cdp.type({ tabId: await tabs.resolveAllowedTab(tabId), text })` |
| `key` | `cdp.key({ tabId: await tabs.resolveAllowedTab(tabId), key })` |
| `scroll` | `cdp.scroll({ tabId: await tabs.resolveAllowedTab(tabId), x, y, dx, dy })` |
| `screenshot` | `cdp.screenshot({ tabId: await tabs.resolveAllowedTab(tabId) })` |

- Always pass a CDP call the id from `tabs.resolveAllowedTab(tabId)` (the tab must be in the Clearcart group and its current page must be on the allowlist). `cdp.*` itself only checks that `tabId` is an integer. Use the same resolver before `chrome.scripting.executeScript` / `chrome.tabs.sendMessage` for page calls (module B).
- `click` with `{ ref }`: the server calls `rect` and then `click` with the centre; the worker does not need to do anything extra. If CDP attach fails (e.g. the user cancelled the debugger banner), fall back to the page's `click_ref`.
- Every function throws `BridgeError` with an `ERR` code (`not_allowed`, `no_tab`, `bad_request`, `timeout`, `internal`). Map it straight to `errorResponse(id, e.code, e.message)`.
- `navigate` throws `not_allowed` if back/forward lands on a non-allowlisted origin; the tab has already moved, so the agent should navigate it back to the store.

## Notes

- Group id lives in `chrome.storage.session` under `clearcartGroupId`. If it is missing (browser restart), the group is recovered by its title "Clearcart".
- `key` accepts names (`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, arrows, `Home`, `End`, `PageUp`, `PageDown`), single characters, and modifiers joined with `+` (`Shift+Tab`, `Ctrl+A`, `Alt`, `Meta`/`Cmd`).
- Chrome's history intervention skips entries created without a user gesture, so `navigate("back")` after only programmatic `navigate` calls may report `bad_request` ("no page to go back to").
- The debugger is attached lazily on the first CDP call and stays attached until the tab closes. `cdp.detachAll()` exists if the worker wants to drop all sessions (e.g. when the bridge disconnects) to hide the banner.
