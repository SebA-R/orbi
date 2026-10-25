// Routes one bridge request from the agent server to module A (tabs, CDP) or
// module B (the on-demand page script). Every call that touches a page first
// resolves its tab with tabs.resolveAllowedTab, which checks that tab's
// current page again (see allowlist.js: the allowlist, or in open mode any
// site off the blocklist, and netguard.js), so a tab that moved to a blocked
// site since tabs_context is refused. The tab being acted on shows a small
// "Clearcart is using this tab" pill (content/indicator.js).
//
// Button lock: every click, key press and typed newline is checked by the
// page script (content/protect.js) before it reaches CDP, and is refused
// with ERR.LOCKED when it would press a protected control (place order,
// checkout, pay, wallets, subscribe, sign in...). Fails closed: if the check
// cannot run, the input is not sent. The only way to press a protected
// control is press_protected (pay flow) or press_unlocked (the user asked
// for that control) with a single-use nonce from lock_arm, INTERNAL methods
// the agent server calls and Claude never sees.
//
// Follow: a call that acts on a tab (follow.js ACT_METHODS, and tabs_create)
// brings that tab to the front first, unless the setting is off or the user
// switched away themselves this turn. Reads never switch.
//
// Watchable pace (setting watchablePace): clicks, typing and scrolls go
// through background/actor.js, which moves the pointer along a path, types
// a key at a time and scrolls in steps. The lock and hit-test checks then
// run again at press time (after the pointer arrives), and the payment and
// password check before every typed character. Tab work, reads and
// screenshots are never slowed. Off, input goes to CDP at once as before.

import * as tabsModule from "./tabs.js";
import * as cdpModule from "./cdp.js";
import { ACT_METHODS, createFollower } from "./follow.js";
import { parseKey } from "./cdp.js";
import { createActor } from "./actor.js";
import { BridgeError, ERR, RT } from "../lib/protocol.js";
import { luhnValid } from "../lib/log.js";

export const PAGE_FILES = ["content/mask.js", "content/protect.js", "content/page.js"];
// page_context also loads the pointer tracker, for tabs that were open
// before the extension (it is a declared content script for new pages).
export const CONTEXT_FILES = ["content/context.js", ...PAGE_FILES];
export const INDICATOR_FILES = ["content/indicator.js"];

// A context snapshot taken when the user starts talking is used for the
// user_text that follows, if it comes within this long.
export const CONTEXT_TTL_MS = 60_000;
const CONTEXT_PAGE_TIMEOUT_MS = 1_500;

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

// A coordinate from the bridge, checked like cdp.js does.
function point(v, name) {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) throw new BridgeError(ERR.BAD_REQUEST, `${name} must be a finite number`);
  return n;
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
  // Danger mode from the user's settings (worker.js). Read for every page
  // call; any failure or non-true answer is off.
  dangerMode = async () => false,
  follow = createFollower({ chromeApi }),
  onAgentTab = () => {},
  // The watchablePace setting (worker.js). Off unless it answers true.
  watchable = async () => false,
  actor = createActor({ cdp, tabWindow: async (id) => (await chromeApi.tabs.get(id)).windowId }),
} = {}) {
  // lock_arm nonces: nonce -> { tabId, origin, expires }. Single use.
  const armed = new Map();

  // Loads the page script into the tab's top frame. Answers the documentId
  // it went into (Chrome reports it), so the call that follows reaches that
  // document and no later one.
  async function inject(tabId, files = PAGE_FILES) {
    let results;
    try {
      results = await chromeApi.scripting.executeScript({ target: { tabId }, files });
    } catch (e) {
      throw new BridgeError(ERR.INTERNAL, `could not load the page script: ${msgOf(e)}`);
    }
    const top = Array.isArray(results) ? results.find((x) => x && x.frameId === 0) || results[0] : null;
    return (top && top.documentId) || null;
  }

  // After a read: the page that answered (or, without its address, the
  // tab's current one) must still be allowed, else the result is dropped.
  // Fails closed without the check.
  async function recheck(tabId, url) {
    if (typeof tabs.assertPageAllowed !== "function") throw new BridgeError(ERR.INTERNAL, "page check unavailable");
    await tabs.assertPageAllowed(tabId, url);
  }

  // Shows the "Clearcart is using this tab" pill. Best effort, at most once
  // a second per tab (each injection keeps it up a little longer).
  const shown = new Map();
  function indicate(tabId) {
    // The active-tab frame (background/frame.js) follows every call.
    try { onAgentTab(tabId); } catch {}
    const t = now();
    if (t - (shown.get(tabId) || 0) < 1_000) return;
    shown.set(tabId, t);
    Promise.resolve()
      .then(() => chromeApi.scripting.executeScript({ target: { tabId }, files: INDICATOR_FILES }))
      .catch(() => {});
  }

  // What the user is looking at (bridge method page_context): the active
  // tab's id, title and origin+path, their selection and what they point
  // at (content/page.js page_context). A blocked active tab gives only
  // { active: { blocked: true } }; nothing is read from it.
  async function collectContext() {
    const tab = typeof tabs.activeTab === "function" ? await tabs.activeTab() : null;
    if (!tab) return { active: null };
    try {
      await tabs.resolveAllowedTab(tab.id, { peek: true });
    } catch {
      return { active: { blocked: true } };
    }
    const active = { tabId: tab.id, title: String(tab.title || "").slice(0, 120), url: tabs.originPath(tab.url || "") };
    const page = await Promise.race([
      (async () => {
        const { tabId: _t, ...rest } = await pageCallWith(tab.id, "page_context", {}, CONTEXT_FILES);
        return rest;
      })().catch(() => ({})),
      new Promise((r) => setTimeout(() => r({}), CONTEXT_PAGE_TIMEOUT_MS)),
    ]);
    return { active, ...page };
  }

  // PTT_START: take the snapshot now, while the user is still pointing.
  let talkContext = null;
  function noteTalkStart() {
    follow.newTurn();
    const at = now();
    const p = collectContext().catch(() => null);
    talkContext = { at, p };
    return p;
  }

  async function pageContext() {
    const snap = talkContext;
    talkContext = null;
    if (snap && now() - snap.at < CONTEXT_TTL_MS) {
      const v = await snap.p;
      if (v) return v;
    }
    return collectContext();
  }

  async function send(tabId, msg, documentId) {
    return chromeApi.tabs.sendMessage(tabId, msg, documentId ? { documentId } : { frameId: 0 });
  }

  function pageCall(tabId, method, params = {}) {
    return pageCallWith(tabId, method, params, PAGE_FILES);
  }

  async function pageCallWith(tabId, method, params, files) {
    const { tabId: _drop, ...rest } = params || {};
    const danger = await Promise.resolve().then(dangerMode).then((v) => v === true, () => false);
    const msg = { type: RT.PAGE_CALL, method, params: rest, dangerMode: danger };
    let doc = await inject(tabId, files);
    let reply;
    try {
      reply = await send(tabId, msg, doc);
    } catch (e) {
      if (!NO_RECEIVER.test(msgOf(e))) throw new BridgeError(ERR.INTERNAL, `page call failed: ${msgOf(e)}`);
      // The document changed between inject and send. The new one may be
      // somewhere blocked: check the tab again before injecting, once.
      await tabs.resolveAllowedTab(tabId, { peek: true });
      doc = await inject(tabId, files);
      try {
        reply = await send(tabId, msg, doc);
      } catch (e2) {
        throw new BridgeError(ERR.INTERNAL, `page call failed: ${msgOf(e2)}`);
      }
    }
    if (!reply || typeof reply !== "object") throw new BridgeError(ERR.INTERNAL, "no reply from the page script");
    // reply.href is the address of the document that answered.
    await recheck(tabId, typeof reply.href === "string" ? reply.href : undefined);
    if (!reply.ok) throw new BridgeError(reply.error?.code || ERR.INTERNAL, reply.error?.message || `${method} failed`);
    return reply.result;
  }

  const paced = () => Promise.resolve().then(watchable).then((v) => v === true, () => false);

  // CDP typing goes around the page script, so check here that it is not
  // aimed at a card field and does not carry a card number. Answers the
  // focused field.
  async function guardType(tabId, text) {
    if (containsCardNumber(text)) {
      throw new BridgeError(ERR.PAYMENT_FIELD, "refusing to type a card number; pay_now fills payment fields");
    }
    const focus = await pageCall(tabId, "focused_field");
    if (focus && focus.payment) {
      throw new BridgeError(ERR.PAYMENT_FIELD, "refusing to type into a payment field; pay_now fills payment fields");
    }
    if (focus && focus.password) {
      throw new BridgeError(ERR.PAYMENT_FIELD, "refusing to type into a password field; the user types passwords themselves");
    }
    return focus;
  }

  // Watchable typing: the check before every character. The focus may have
  // moved to a card or password field since the last one, and a newline may
  // now land in a form whose submit is locked.
  async function guardChar(tabId, ch) {
    const focus = await guardType(tabId, "");
    if (/[\r\n]/.test(ch)) await pageCall(tabId, "guard_key", { key: "Enter" });
    // Key events only go with the text into a plain text field; anywhere
    // else (a button, a select, the page) a key press could act on its own.
    return { keys: !!(focus && focus.text === true) };
  }

  const centre = (r) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });

  function visibleRect(r, ref) {
    if (!r || !(r.width > 0) || !(r.height > 0)) throw new BridgeError(ERR.NO_ELEMENT, `${ref} is not visible`);
    return r;
  }

  // Clicks the centre of rect r with CDP, or asks the page to .click() the
  // ref (domMethod) when CDP can't attach. At watchable pace, recheck runs
  // right before the press and answers the point to press; a failed check
  // or an interrupt never falls back to the DOM click.
  async function clickCentre(tabId, r, ref, domMethod, recheck) {
    const p = centre(r);
    try {
      if (await paced()) {
        await actor.click(tabId, p, { size: Math.min(r.width, r.height), recheck });
      } else {
        await cdp.click({ tabId, x: p.x, y: p.y });
        actor.notePointer(tabId, p.x, p.y);
      }
      return { ok: true, via: "cdp" };
    } catch (e) {
      if (e && e.noFallback) throw e;
      await pageCall(tabId, domMethod, { ref });
      return { ok: true, via: "dom" };
    }
  }

  async function clickAt(tabId, params) {
    if (params.ref != null && (params.x == null || params.y == null)) {
      // guard_ref checks the element and whatever covers its centre, and
      // answers its rect like "rect" does.
      const r = visibleRect(await pageCall(tabId, "guard_ref", { ref: params.ref }), params.ref);
      const recheck = async () => centre(visibleRect(await pageCall(tabId, "guard_ref", { ref: params.ref }), params.ref));
      return clickCentre(tabId, r, params.ref, "click_ref", recheck);
    }
    const guard = () => pageCall(tabId, "guard_point", { x: params.x, y: params.y });
    await guard();
    if (await paced()) {
      await actor.click(tabId, { x: point(params.x, "x"), y: point(params.y, "y") }, { recheck: async () => void (await guard()) });
    } else {
      await cdp.click({ tabId, x: params.x, y: params.y });
      actor.notePointer(tabId, params.x, params.y);
    }
    return { ok: true, via: "cdp" };
  }

  async function tabOrigin(tabId) {
    const info = await tabs.tabInfo({ tabId });
    return originOf(info && info.url);
  }

  // The pay flow's half of the unlock: a nonce bound to this tab and its
  // current origin, which must be a pay site (the allowlist setting). Open
  // web browsing lets Claude read many more sites, never unlock on them.
  //
  // scope "user" is the user-directed unlock (request_unlock on the server):
  // any allowed site, but its nonce only works with press_unlocked, which
  // never presses an order, wallet or card form control.
  async function lockArm(tabId, scope = "order") {
    if (scope !== "order" && scope !== "user") throw new BridgeError(ERR.BAD_REQUEST, "unknown unlock scope");
    const info = await tabs.tabInfo({ tabId });
    const origin = originOf(info && info.url);
    if (!origin) throw new BridgeError(ERR.NOT_ALLOWED, "tab has no origin to unlock");
    if (scope === "order" && (typeof tabs.isPaySite !== "function" || !(await tabs.isPaySite(info.url)))) {
      throw new BridgeError(ERR.LOCKED, "Locked: this site is not a Clearcart pay site");
    }
    for (const [n, a] of armed) if (a.expires <= now()) armed.delete(n);
    const nonce = newNonce();
    armed.set(nonce, { tabId, origin, scope, expires: now() + UNLOCK_TTL_MS });
    return { nonce, expiresInMs: UNLOCK_TTL_MS };
  }

  // Spends a nonce of the given scope for this tab and its current origin.
  async function spend(tabId, nonce, scope) {
    const a = typeof nonce === "string" ? armed.get(nonce) : undefined;
    if (a) armed.delete(nonce);
    if (!a || a.tabId !== tabId || a.scope !== scope || a.expires <= now()) {
      throw new BridgeError(ERR.LOCKED, "Locked: no valid unlock for this press");
    }
    if ((await tabOrigin(tabId)) !== a.origin) {
      throw new BridgeError(ERR.LOCKED, "Locked: the page changed origin after the unlock");
    }
  }

  // Presses one order button. The nonce is spent before anything else, so
  // a failed press cannot be retried with it.
  // At watchable pace the pointer approaches the button's rect first and
  // press_check (which takes the lock marker off) runs on arrival, right
  // before the press.
  async function pressProtected(tabId, params) {
    await spend(tabId, params.nonce, "order");
    const check = () => pageCall(tabId, "press_check", { ref: params.ref });
    if (!(await paced())) return clickCentre(tabId, await check(), params.ref, "press_ref");
    const r = visibleRect(await pageCall(tabId, "rect", { ref: params.ref }), params.ref);
    return clickCentre(tabId, r, params.ref, "press_ref", async () => centre(await check()));
  }

  // Brings the tab a navigate call will use to the front, when it is one
  // Clearcart may use now. A tab on a blocked page (the agent server's sweep
  // sending a stray tab back) is not shown; navigate itself decides the rest.
  async function followBeforeNavigate(tabId) {
    if (typeof tabs.resolveTab !== "function") return;
    let id;
    try {
      id = await tabs.resolveTab(tabId);
    } catch {
      return;
    }
    await follow.to(id);
  }

  // Presses one control the user asked for: the page re-checks the ref is
  // of unlock class cls with that label (content/page.js press_check_user),
  // then re-resolves it and hit-tests the click point right before the CDP
  // click (press_hit_user). The lock marker comes off only after the press
  // (press_done_user), so the page gets no early signal to swap controls.
  async function pressUnlocked(tabId, params) {
    await spend(tabId, params.nonce, "user");
    const target = { ref: params.ref, label: params.label, cls: params.cls };
    const r = await pageCall(tabId, "press_check_user", target);
    const { x, y } = centre(r);
    const watch = await paced();
    if (!watch) await pageCall(tabId, "press_hit_user", { ...target, x, y });
    try {
      if (watch) {
        // Checked again on arrival: the control and the point it is at now.
        await actor.click(tabId, { x, y }, {
          size: Math.min(r.width, r.height),
          recheck: async () => {
            const p = centre(await pageCall(tabId, "press_check_user", target));
            await pageCall(tabId, "press_hit_user", { ...target, ...p });
            return p;
          },
        });
      } else {
        await cdp.click({ tabId, x, y });
        actor.notePointer(tabId, x, y);
      }
    } catch (e) {
      if (e && e.noFallback) throw e;
      // press_ref_user checks, clicks and releases in one page task.
      await pageCall(tabId, "press_ref_user", target);
      return { ok: true, via: "dom" };
    }
    await pageCall(tabId, "press_done_user", target).catch(() => null);
    return { ok: true, via: "cdp" };
  }

  async function route(method, params = {}) {
    params = params || {};
    switch (method) {
      case "tabs_context":
        return tabs.tabsContext();
      case "tabs_create": {
        // The new tab comes to the front as soon as it exists.
        const r = await tabs.tabsCreate({ url: params.url, onCreated: (id) => follow.to(id) });
        if (params.url != null) indicate(r.tabId);
        return r;
      }
      case "navigate": {
        await followBeforeNavigate(params.tabId);
        const r = await tabs.navigate({ tabId: params.tabId, url: params.url });
        indicate(r.tabId);
        return r;
      }
      case "tabs_close": {
        // Closing the front tab makes Chrome show another: not the user's doing.
        const r = await follow.own(() => tabs.tabsClose({ tabId: params.tabId }));
        follow.forget(params.tabId);
        return r;
      }
      case "tabs_activate": {
        const r = await follow.own(() => tabs.tabsActivate({ tabId: params.tabId }));
        const shown = r && Number.isInteger(r.tabId) ? await chromeApi.tabs.get(r.tabId).catch(() => null) : null;
        if (shown) follow.claim(shown.id, shown.windowId ?? null);
        return r;
      }
      case "tab_info":
        return tabs.tabInfo({ tabId: params.tabId });
      case "agent_tabs":
        return tabs.agentTabs();
      case "page_context":
        // Asked once per user turn: following starts again.
        follow.newTurn();
        return pageContext();
    }
    const tabId = await tabs.resolveAllowedTab(params.tabId);
    indicate(tabId);
    if (ACT_METHODS.has(method)) await follow.to(tabId);
    switch (method) {
      case "click":
        return clickAt(tabId, params);
      case "type":
        await guardType(tabId, params.text);
        // A typed newline can submit the focused field's form.
        if (/[\r\n]/.test(String(params.text ?? ""))) await pageCall(tabId, "guard_key", { key: "Enter" });
        if (typeof params.text === "string" && params.text && (await paced())) {
          await actor.type(tabId, params.text, { check: (ch) => guardChar(tabId, ch) });
        } else {
          await cdp.type({ tabId, text: params.text });
        }
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
        return lockArm(tabId, params.scope ?? "order");
      case "press_unlocked":
        return pressUnlocked(tabId, params);
      case "lock_info":
        return pageCall(tabId, "lock_info", { ref: params.ref });
      case "press_protected":
        return pressProtected(tabId, params);
      case "scroll":
        if (await paced()) {
          const at = { x: point(params.x, "x"), y: point(params.y, "y"), dx: point(params.dx ?? 0, "dx"), dy: point(params.dy ?? 0, "dy") };
          await actor.scroll(tabId, at);
        } else {
          await cdp.scroll({ tabId, x: params.x, y: params.y, dx: params.dx, dy: params.dy });
          actor.notePointer(tabId, Number(params.x), Number(params.y));
        }
        return { ok: true };
      case "screenshot": {
        const shot = await cdp.screenshot({ tabId });
        // The tab may have moved to a blocked site while it was captured.
        await recheck(tabId);
        return shot;
      }
    }
    if (PAGE_METHODS.has(method)) return pageCall(tabId, method, params);
    throw new BridgeError(ERR.UNKNOWN_METHOD, `unknown method: ${method}`);
  }

  return { route, pageCall, inject, noteTalkStart, actor };
}
