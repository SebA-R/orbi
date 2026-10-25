// Routes one bridge request from the agent server to module A (tabs, CDP) or
// module B (the on-demand page script). Every call that touches a page first
// resolves its tab with tabs.resolveAllowedTab, so it must be a tab in the
// Clearcart group whose current page is on the allowlist.

import * as tabsModule from "./tabs.js";
import * as cdpModule from "./cdp.js";
import { BridgeError, ERR, RT } from "../lib/protocol.js";
import { luhnValid } from "../lib/log.js";

export const PAGE_FILES = ["content/mask.js", "content/page.js"];

// Page-script methods the bridge may call. focused_field is used by the type
// guard below and is not a bridge method.
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
const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g;

// True when the text holds a Luhn-valid run of 13 to 19 digits (optionally
// grouped by single spaces or dashes), checked at every window so a card
// number glued to other digits is still caught.
export function containsCardNumber(text) {
  for (const run of String(text).match(DIGIT_RUN) || []) {
    const d = run.replace(/[ -]/g, "");
    for (let len = 13; len <= Math.min(19, d.length); len++) {
      for (let i = 0; i + len <= d.length; i++) {
        if (luhnValid(d.slice(i, i + len))) return true;
      }
    }
  }
  return false;
}

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

  // CDP typing goes around the page script, so check here that it is not
  // aimed at a card field and does not carry a card number.
  async function guardType(tabId, text) {
    if (containsCardNumber(text)) {
      throw new BridgeError(ERR.PAYMENT_FIELD, "refusing to type a card number; pay_now fills payment fields");
    }
    const focus = await pageCall(tabId, "focused_field");
    if (focus && focus.payment) {
      throw new BridgeError(ERR.PAYMENT_FIELD, "refusing to type into a payment field; pay_now fills payment fields");
    }
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
        await guardType(tabId, params.text);
        await cdp.type({ tabId, text: params.text });
        return { ok: true };
      case "key":
        // A single printable key is typing too.
        if (typeof params.key === "string" && params.key.length === 1) await guardType(tabId, params.key);
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
