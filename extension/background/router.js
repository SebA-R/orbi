// Routes one bridge request from the agent server to module A (tabs, CDP) or
// module B (the on-demand page script). Every call that touches a page first
// resolves its tab with tabs.resolveAllowedTab, so it must be a tab in the
// Clearcart group whose current page is allowed (see allowlist.js: the
// allowlist, or in open mode any site off the blocklist).
//
// Button lock: every click, key press and typed newline is checked by the
// page script (content/protect.js) before it reaches CDP, and is refused
// with ERR.LOCKED when it would press a protected control (place order,
// checkout, pay, wallets, subscribe, sign in...). Fails closed: if the check
// cannot run, the input is not sent. The only way to press a protected
// control is press_protected with a single-use nonce from lock_arm, two
// INTERNAL methods the agent server's pay flow calls and Claude never sees.

import * as tabsModule from "./tabs.js";
import * as cdpModule from "./cdp.js";
import { parseKey } from "./cdp.js";
import { BridgeError, ERR, RT } from "../lib/protocol.js";
import { luhnValid } from "../lib/log.js";

export const PAGE_FILES = ["content/mask.js", "content/protect.js", "content/page.js"];

// How long a lock_arm nonce stays good. The pay flow arms right before it
// presses, so this only needs to cover one round trip.
export const UNLOCK_TTL_MS = 30_000;

const ENTER_KEY = /^(enter|return|numpadenter|kp_enter)$/i;
const SPACE_KEY = /^( |space|spacebar)$/i;

// True for keys that activate the focused control: Enter, Space, with or
// without modifiers ("ctrl+Enter").
export function isActivationKey(spec) {
  return activationOf(spec) !== null;
}

// "Enter" or " " when pressing spec would activate the focused control,
// else null. Decided on what parseKey (and so CDP) will actually send, not
// on the spelling: "Shift+ " sends a space. A spec parseKey refuses ("\r"
// and other control characters) is not sent, so it activates nothing; the
// key route parses first and throws.
export function activationOf(spec) {
  let k;
  try {
    k = parseKey(spec);
  } catch {
    const s = String(spec ?? "");
    const last = s === " " ? " " : s.split("+").pop().trim();
    return ENTER_KEY.test(last) || /[\r\n]/.test(s) ? "Enter" : SPACE_KEY.test(last) ? " " : null;
  }
  const text = String(k.text ?? "");
  if (k.key === "Enter" || k.code === "Enter" || k.code === "NumpadEnter" || k.windowsVirtualKeyCode === 13 || /[\r\n]/.test(text)) return "Enter";
  if (k.key === " " || k.code === "Space" || k.windowsVirtualKeyCode === 32 || /\s/.test(text)) return " ";
  return null;
}

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

function originOf(url) {
  try {
    const o = new URL(String(url)).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

export function createRouter({
  chromeApi = globalThis.chrome,
  tabs = tabsModule,
  cdp = cdpModule,
  now = () => Date.now(),
  newNonce = () => globalThis.crypto.randomUUID(),
} = {}) {
  // lock_arm nonces: nonce -> { tabId, origin, expires }. Single use.
  const armed = new Map();

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

  // Clicks the centre of rect r with CDP, or asks the page to .click() the
  // ref (domMethod) when CDP can't attach.
  async function clickCentre(tabId, r, ref, domMethod) {
    try {
      await cdp.click({ tabId, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      return { ok: true, via: "cdp" };
    } catch {
      await pageCall(tabId, domMethod, { ref });
      return { ok: true, via: "dom" };
    }
  }

  async function clickAt(tabId, params) {
    if (params.ref != null && (params.x == null || params.y == null)) {
      // guard_ref checks the element and whatever covers its centre, and
      // answers its rect like "rect" does.
      const r = await pageCall(tabId, "guard_ref", { ref: params.ref });
      if (!r || !(r.width > 0) || !(r.height > 0)) throw new BridgeError(ERR.NO_ELEMENT, `${params.ref} is not visible`);
      return clickCentre(tabId, r, params.ref, "click_ref");
    }
    await pageCall(tabId, "guard_point", { x: params.x, y: params.y });
    await cdp.click({ tabId, x: params.x, y: params.y });
    return { ok: true, via: "cdp" };
  }

  async function tabOrigin(tabId) {
    const info = await tabs.tabInfo({ tabId });
    return originOf(info && info.url);
  }

  // The pay flow's half of the unlock: a nonce bound to this tab and its
  // current origin, which must be a pay site (the allowlist setting). Open
  // web browsing lets Claude read many more sites, never unlock on them.
  async function lockArm(tabId) {
    const info = await tabs.tabInfo({ tabId });
    const origin = originOf(info && info.url);
    if (!origin) throw new BridgeError(ERR.NOT_ALLOWED, "tab has no origin to unlock");
    if (typeof tabs.isPaySite !== "function" || !(await tabs.isPaySite(info.url))) {
      throw new BridgeError(ERR.LOCKED, "Locked: this site is not a Clearcart pay site");
    }
    for (const [n, a] of armed) if (a.expires <= now()) armed.delete(n);
    const nonce = newNonce();
    armed.set(nonce, { tabId, origin, expires: now() + UNLOCK_TTL_MS });
    return { nonce, expiresInMs: UNLOCK_TTL_MS };
  }

  // Presses one order button. The nonce is spent before anything else, so
  // a failed press cannot be retried with it.
  async function pressProtected(tabId, params) {
    const a = typeof params.nonce === "string" ? armed.get(params.nonce) : undefined;
    if (a) armed.delete(params.nonce);
    if (!a || a.tabId !== tabId || a.expires <= now()) {
      throw new BridgeError(ERR.LOCKED, "Locked: no valid unlock for this press");
    }
    if ((await tabOrigin(tabId)) !== a.origin) {
      throw new BridgeError(ERR.LOCKED, "Locked: the page changed origin after the unlock");
    }
    const r = await pageCall(tabId, "press_check", { ref: params.ref });
    return clickCentre(tabId, r, params.ref, "press_ref");
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
        // A typed newline can submit the focused field's form.
        if (/[\r\n]/.test(String(params.text ?? ""))) await pageCall(tabId, "guard_key", { key: "Enter" });
        await cdp.type({ tabId, text: params.text });
        return { ok: true };
      case "key": {
        // Parse first: a spec CDP would not send is refused before any check.
        const parsed = parseKey(params.key);
        // A single printable key is typing too.
        if (parsed.text && !/[\r\n]/.test(parsed.text)) await guardType(tabId, parsed.text);
        const act = activationOf(params.key);
        if (act) await pageCall(tabId, "guard_key", { key: act === "Enter" ? "Enter" : "Space" });
        await cdp.key({ tabId, key: params.key });
        return { ok: true };
      }
      case "lock_arm":
        return lockArm(tabId);
      case "press_protected":
        return pressProtected(tabId, params);
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
