// Routes one bridge request from the agent server to module A (tabs, CDP) or
// module B (the on-demand page script). Every call that touches a page first
// resolves its tab with tabs.resolveAllowedTab, so it must be a tab in the
// Clearcart group whose current page is on the allowlist.

import * as tabsModule from "./tabs.js";
import * as cdpModule from "./cdp.js";
import { BridgeError, ERR, RT } from "../lib/protocol.js";

export const PAGE_FILES = ["content/mask.js", "content/page.js"];

// Page-script methods the bridge may call.
export const PAGE_METHODS = new Set([
  "read_page",
  "find",
  "get_page_text",
  "form_input",
  "rect",
  "click_ref",
  "read_fields",
  "fill_payment",
  "clear_payment",
]);

const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/i;
const msgOf = (e) => String((e && e.message) || e || "failed");

export function createRouter({ chromeApi = globalThis.chrome, tabs = tabsModule, cdp = cdpModule } = {}) {
  async function inject(tabId) {
    try {
      await chromeApi.scripting.executeScript({ target: { tabId }, files: PAGE_FILES });
    } catch (e) {
      throw new BridgeError(ERR.INTERNAL, `could not load the page script: ${msgOf(e)}`);
    }
  }

  async function send(tabId, msg) {
    return chromeApi.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }

  async function pageCall(tabId, method, params = {}) {
    const { tabId: _drop, ...rest } = params || {};
    const msg = { type: RT.PAGE_CALL, method, params: rest };
    await inject(tabId);
    let reply;
    try {
      reply = await send(tabId, msg);
    } catch (e) {
      if (!NO_RECEIVER.test(msgOf(e))) throw new BridgeError(ERR.INTERNAL, `page call failed: ${msgOf(e)}`);
      // The document changed between inject and send: inject again, once.
      await inject(tabId);
      try {
        reply = await send(tabId, msg);
      } catch (e2) {
        throw new BridgeError(ERR.INTERNAL, `page call failed: ${msgOf(e2)}`);
      }
    }
    if (!reply || typeof reply !== "object") throw new BridgeError(ERR.INTERNAL, "no reply from the page script");
    if (!reply.ok) throw new BridgeError(reply.error?.code || ERR.INTERNAL, reply.error?.message || `${method} failed`);
    return reply.result;
  }

  async function clickAt(tabId, params) {
    if (params.ref != null && (params.x == null || params.y == null)) {
      const r = await pageCall(tabId, "rect", { ref: params.ref });
      if (!r || !(r.width > 0) || !(r.height > 0)) throw new BridgeError(ERR.NO_ELEMENT, `${params.ref} is not visible`);
      try {
        await cdp.click({ tabId, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
        return { ok: true, via: "cdp" };
      } catch {
        await pageCall(tabId, "click_ref", { ref: params.ref });
        return { ok: true, via: "dom" };
      }
    }
    await cdp.click({ tabId, x: params.x, y: params.y });
    return { ok: true, via: "cdp" };
  }

  async function route(method, params = {}) {
    params = params || {};
    switch (method) {
      case "tabs_context":
        return tabs.tabsContext();
      case "tabs_create":
        return tabs.tabsCreate({ url: params.url });
      case "navigate":
        return tabs.navigate({ tabId: params.tabId, url: params.url });
      case "tab_info":
        return tabs.tabInfo({ tabId: params.tabId });
    }
    const tabId = await tabs.resolveAllowedTab(params.tabId);
    switch (method) {
      case "click":
        return clickAt(tabId, params);
      case "type":
        await cdp.type({ tabId, text: params.text });
        return { ok: true };
      case "key":
        await cdp.key({ tabId, key: params.key });
        return { ok: true };
      case "scroll":
        await cdp.scroll({ tabId, x: params.x, y: params.y, dx: params.dx, dy: params.dy });
        return { ok: true };
      case "screenshot":
        return cdp.screenshot({ tabId });
    }
    if (PAGE_METHODS.has(method)) return pageCall(tabId, method, params);
    throw new BridgeError(ERR.UNKNOWN_METHOD, `unknown method: ${method}`);
  }

  return { route, pageCall, inject };
}
