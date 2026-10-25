// Routes one bridge request from the agent server to module A (tabs, CDP) or
// module B (the on-demand page script). Every call that touches a page first
// resolves its tab with tabs.resolveAllowedTab, which checks that tab's
// current page again (see allowlist.js: the allowlist, or in open mode any
// site off the blocklist, and netguard.js), so a tab that moved to a blocked
// site since tabs_context is refused. The tab being acted on gets the
// active-tab frame (background/frame.js).
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
// Saved cards: fill_card (pay_with_saved_card on the agent server) puts the
// card into the checkout's card fields in every frame of the tab, the
// cross-origin payment frames (Stripe, Adyen, Braintree) included, through
// content/cardfill.js in each frame's isolated world. Like the other
// INTERNAL methods Claude never sees it, and it answers kinds and counts,
// never a value.
//
// Follow: a call that acts on a tab (follow.js ACT_METHODS, and tabs_create)
// brings that tab to the front first, unless the setting is off or the user
// switched away themselves this turn. Reads never switch.
//
// Typing always goes through background/actor.js, a key at a time at a
// typist's cadence, with the payment, password and document checks for
// every character. Watchable pace (setting watchablePace) does the same
// for clicks and scrolls: the pointer moves along a path and the wheel
// turns in steps, and the lock and hit-test checks run again at press time
// (after the pointer arrives). Off, clicks and scrolls go to CDP at once.
// Tab work, reads and screenshots are never slowed.
//
// Canvas editors: Google Docs, Sheets and Slides draw the file on a canvas,
// so get_page_text gets the file's text from its export link (gdocs.js),
// and read_page and get_page_text say how to edit there. Typing with
// nothing focused is refused with a message to click into the editor first,
// instead of answering ok for text that went nowhere.

import * as tabsModule from "./tabs.js";
import * as cdpModule from "./cdp.js";
import { ACT_METHODS, createFollower } from "./follow.js";
import { assertInViewport, parseKey } from "./cdp.js";
import { createActor } from "./actor.js";
import { BridgeError, ERR, RT } from "../lib/protocol.js";
import "../content/mask.js";
import { luhnValid } from "../lib/log.js";
import { APPS, editNote, exportText, googleFileOf } from "./gdocs.js";

export const PAGE_FILES = ["content/mask.js", "content/protect.js", "content/page.js"];
// page_context also loads the pointer tracker, for tabs that were open
// before the extension (it is a declared content script for new pages).
export const CONTEXT_FILES = ["content/context.js", ...PAGE_FILES];

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
  "order_buttons",
]);

// The card fill's own script, injected into every frame after mask.js.
export const CARD_FILES = ["content/mask.js", "content/cardfill.js"];
export const NO_CARD_FIELDS = "couldn't find the card fields on this page";
const NOT_FILLED = "couldn't fill the card fields on this page";

const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/i;

// True when the text holds a card number: a Luhn-valid 13 to 19 digit
// window in any digit run (optionally grouped by single spaces or dashes),
// by content/mask.js, so a card number glued to other digits is still caught.
export function containsCardNumber(text) {
  return globalThis.ClearcartMask.hasCardNumber(String(text));
}

// A coordinate from the bridge, checked like cdp.js does.
function point(v, name) {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) throw new BridgeError(ERR.BAD_REQUEST, `${name} must be a finite number`);
  return n;
}

// How long a pop-up gets to animate away before dismiss_overlay looks again.
export const OVERLAY_SETTLE_MS = 450;

const msgOf = (e) => String((e && e.message) || e || "failed");

// "12/30" or "12/2030" -> { mm: "12", yy: "30", yyyy: "2030" }, or null.
export function expParts(exp) {
  const m = /^\s*(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})\s*$/.exec(String(exp || ""));
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return null;
  const mm = ("0" + m[1]).slice(-2);
  const yy = m[2].slice(-2);
  return { mm, yy, yyyy: m[2].length === 4 ? m[2] : "20" + yy };
}

// Which frame gets which value: exactly one card number, one security code
// and one expiry (one field, or a month and a year) across all the frames,
// and a name or postal code only where there is exactly one. Only fields a
// person can use now count. Anything else fills nothing (never a guess).
// frames: [{ frameId, documentId, fields: [{ kind, usable }] }].
export function planCard(frames) {
  const all = [];
  for (const fr of frames) for (const f of fr.fields) if (f.usable !== false) all.push({ fr, kind: f.kind });
  const where = (k) => all.filter((x) => x.kind === k);
  const one = (k) => {
    const w = where(k);
    return w.length === 1 ? w[0].fr : null;
  };
  const number = one("cc-number");
  const csc = one("cc-csc");
  const exp = where("cc-exp");
  const mm = where("cc-exp-month");
  const yy = where("cc-exp-year");
  const expOk = (exp.length === 1 && !mm.length && !yy.length) || (!exp.length && mm.length === 1 && yy.length === 1);
  if (!number || !csc || !expOk) throw new BridgeError(ERR.NO_ELEMENT, NO_CARD_FIELDS);
  const plan = new Map();
  const put = (fr, kind) => {
    if (!plan.has(fr)) plan.set(fr, []);
    plan.get(fr).push(kind);
  };
  put(number, "cc-number");
  if (exp.length) put(exp[0].fr, "cc-exp");
  else {
    put(mm[0].fr, "cc-exp-month");
    put(yy[0].fr, "cc-exp-year");
  }
  put(csc, "cc-csc");
  const name = one("cc-name");
  if (name) put(name, "cc-name");
  const zip = one("postal-code");
  if (zip) put(zip, "postal-code");
  return { plan, name: !!name, zip: !!zip };
}

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
  settle = (ms) => new Promise((r) => setTimeout(r, ms)),
  actor = createActor({ cdp, tabWindow: async (id) => (await chromeApi.tabs.get(id)).windowId }),
  // Fetches a Google file's export (gdocs.js).
  fetchImpl = (...a) => globalThis.fetch(...a),
} = {}) {
  // lock_arm nonces: nonce -> { tabId, origin, expires }. Single use.
  const armed = new Map();
  // tabId -> { doc, href }: the documentId and address of the last page
  // call's answer.
  const docs = new Map();

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

  // The active-tab frame (background/frame.js) follows every call.
  function indicate(tabId) {
    try { onAgentTab(tabId); } catch {}
  }

  // What the user is looking at (bridge method page_context): the active
  // tab's id, title and origin+path, their selection and what they point
  // at (content/page.js page_context). A blocked active tab gives only
  // { active: { blocked: true } }; nothing is read from it.
  async function collectContext() {
    const tab = typeof tabs.activeTab === "function" ? await tabs.activeTab() : null;
    if (!tab) return { active: null };
    // An empty new tab page: nothing to read, but the agent may navigate it.
    if (typeof tabs.onNewTab === "function" && tabs.onNewTab(tab)) {
      return { active: { tabId: tab.id, title: "New Tab", url: "chrome://newtab/", newTab: true } };
    }
    // Orbi's "Can't reach this site" page: nothing to read either. The
    // address that failed only when it is allowed (tabs.failedAddress).
    // newTab too, so an agent server that predates errorPage still says
    // the tab may be navigated.
    if (typeof tabs.onErrorPage === "function" && tabs.onErrorPage(tab)) {
      // Hidden (a user's error page for a blocked site): a blocked tab.
      try {
        await tabs.resolveTab(tab.id);
      } catch {
        return { active: { blocked: true } };
      }
      const failed = typeof tabs.failedAddress === "function" ? await tabs.failedAddress(tab).catch(() => null) : null;
      const active = { tabId: tab.id, title: "Can't reach this site", url: "chrome-error://chromewebdata/", newTab: true, errorPage: true };
      if (failed) active.failedUrl = failed;
      return { active };
    }
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
    // The document that answered, for the watchable-pace checks.
    docs.set(tabId, { doc: doc || null, href: typeof reply.href === "string" ? reply.href.split("#")[0] : null });
    // reply.href is the address of the document that answered.
    await recheck(tabId, typeof reply.href === "string" ? reply.href : undefined);
    if (!reply.ok) throw new BridgeError(reply.error?.code || ERR.INTERNAL, reply.error?.message || `${method} failed`);
    return reply.result;
  }

  // get_page_text, with a Google Docs, Sheets or Slides file's own text in
  // place of the menus the page script sees (gdocs.js). The full address
  // (a sheet's gid is in its hash) is used only while it is the page that
  // answered.
  async function pageText(tabId, params) {
    const r = await pageCall(tabId, "get_page_text", params);
    let file = r && googleFileOf(r.url);
    if (!file) return r;
    const full = await Promise.resolve(chromeApi.tabs.get(tabId)).then((t) => t && t.url, () => null);
    if (typeof full === "string" && full.split(/[?#]/)[0] === r.url) file = googleFileOf(full) || file;
    const text = await exportText(file, { fetchImpl });
    // The tab may have moved to a blocked site during the download.
    await recheck(tabId);
    const app = APPS[file.app];
    if (text == null) {
      return { ...r, note: `${app.name} draws the ${app.what} on a canvas and its text could not be downloaded (not signed in, no access, or the owner turned off downloads), so this text is only the page's menus. Take a screenshot to read the ${app.what}.` };
    }
    const max = Math.max(100, Math.min(Number(params.maxChars) || 20000, 200000));
    let all = r.text ? `${text}\n\n---\n\n${r.text}` : text;
    const truncated = all.length > max;
    if (truncated) all = all.slice(0, max) + "\n… (truncated)";
    return { ...r, text: all, truncated, source: `${app.name} file text`, note: editNote(file.app) };
  }

  const paced = () => Promise.resolve().then(watchable).then((v) => v === true, () => false);

  // CDP typing goes around the page script, so check here that it is not
  // aimed at a card field and does not carry a card number. Answers the
  // focused field.
  async function guardType(tabId, text) {
    if (containsCardNumber(text)) {
      throw new BridgeError(ERR.PAYMENT_FIELD, "refusing to type a card number; only pay_with_saved_card fills card fields");
    }
    const focus = await pageCall(tabId, "focused_field");
    if (focus && focus.payment) {
      throw new BridgeError(ERR.PAYMENT_FIELD, "refusing to type into a payment field; only pay_with_saved_card fills card fields");
    }
    if (focus && focus.password) {
      throw new BridgeError(ERR.PAYMENT_FIELD, "refusing to type into a password field; the user types passwords themselves");
    }
    return focus;
  }

  // A paced check that ran in a different document than the one the action
  // started in: the page changed under it, so stop.
  function sameDoc(tabId, start) {
    const now = docs.get(tabId);
    // The same document when Chrome names both; without a documentId, the
    // same address (the page script always sends its href).
    if (!start || !now) return;
    const same = start.doc && now.doc ? start.doc === now.doc : start.href == null || now.href == null || start.href === now.href;
    if (!same) {
      throw Object.assign(new BridgeError(ERR.INTERRUPTED, "stopped: the page changed"), { noFallback: true });
    }
  }

  // Key events only go into a plain text field; anywhere else (a button, a
  // select, the page) a key press could act on its own. A space in a hidden
  // field (a canvas editor's, such as Google Docs') goes in without a Space
  // key, which content/hotkey.js would take for the user holding Space.
  const keysFor = (focus, ch) => ({ keys: !!(focus && focus.text === true) && !(focus.hidden === true && ch === " ") });

  // Typing: the check for every character. The focus may have moved to a
  // card or password field since the last one, a newline may now land in a
  // form whose submit is locked, or the page may have changed.
  async function guardChar(tabId, ch, start) {
    const focus = await guardType(tabId, "");
    sameDoc(tabId, start);
    if (/[\r\n]/.test(ch)) await pageCall(tabId, "guard_key", { key: "Enter" });
    return keysFor(focus, ch);
  }

  // The element's exact centre, unrounded: the same point the page hit-tests
  // (guard_ref, press_check), so the press lands where the check looked.
  const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const boxOf = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

  function visibleRect(r, ref) {
    if (!r || !(r.width > 0) || !(r.height > 0)) throw new BridgeError(ERR.NO_ELEMENT, `${ref} is not visible`);
    return r;
  }

  // Clicks the centre of rect r with CDP, or asks the page to .click() the
  // ref (domMethod) when CDP can't attach. At watchable pace, recheck runs
  // right before the press and answers the point to press; a failed check
  // or an interrupt never falls back to the DOM click.
  // recheck answers a rect, checked in the same document as the start.
  // beforeFallback runs before a paced click falls back to the DOM, for
  // checks the DOM method does not make itself.
  async function clickCentre(tabId, r, ref, domMethod, recheck, beforeFallback, epoch) {
    const p = centre(r);
    const watch = await paced();
    const start = docs.get(tabId);
    try {
      if (watch) {
        await actor.click(tabId, p, {
          epoch,
          size: Math.min(r.width, r.height),
          rect: boxOf(r),
          recheck: recheck && (async () => {
            const fresh = await recheck();
            sameDoc(tabId, start);
            return { ...centre(fresh), rect: boxOf(fresh) };
          }),
        });
      } else {
        await cdp.click({ tabId, x: p.x, y: p.y });
        actor.notePointer(tabId, p.x, p.y);
      }
      return { ok: true, via: "cdp" };
    } catch (e) {
      if (e && e.noFallback) throw e;
      if (watch && beforeFallback) await beforeFallback();
      await pageCall(tabId, domMethod, { ref });
      return { ok: true, via: "dom" };
    }
  }

  async function clickAt(tabId, params, epoch) {
    // Attach first: on a tab's first CDP call Chrome's debugging bar opens
    // and shrinks the viewport, so a centred page moves under the pointer.
    // A ref's rect is read after this; a point the model read off the page
    // before it is stale.
    const barOpened = typeof cdp.attach === "function" ? await cdp.attach(tabId).catch(() => false) : false;
    if (params.ref != null && (params.x == null || params.y == null)) {
      // guard_ref checks the element and whatever covers its centre, and
      // answers its rect like "rect" does.
      const r = visibleRect(await pageCall(tabId, "guard_ref", { ref: params.ref }), params.ref);
      const recheck = async () => visibleRect(await pageCall(tabId, "guard_ref", { ref: params.ref }), params.ref);
      return clickCentre(tabId, r, params.ref, "click_ref", recheck, undefined, epoch);
    }
    // One point for the guard and the press, exactly as asked, and inside
    // the viewport (a device-pixel coordinate from a 2x screenshot is not).
    const at = { x: point(params.x, "x"), y: point(params.y, "y") };
    if (barOpened) {
      throw new BridgeError(ERR.BAD_REQUEST, "Not clicked: Chrome's debugging bar just opened and the page moved, so that point is out of date. Take a new screenshot, or click by ref.");
    }
    await inViewport(tabId, at);
    const guard = () => pageCall(tabId, "guard_point", at);
    await guard();
    if (await paced()) {
      const start = docs.get(tabId);
      await actor.click(tabId, at, {
        epoch,
        recheck: async () => {
          await guard();
          sameDoc(tabId, start);
        },
      });
    } else {
      await cdp.click({ tabId, x: at.x, y: at.y });
      actor.notePointer(tabId, at.x, at.y);
    }
    return { ok: true, via: "cdp" };
  }

  // Refuses a point outside the tab's viewport (cdp.assertInViewport).
  // Answers the viewport, or null when this cdp cannot tell.
  async function inViewport(tabId, at) {
    if (typeof cdp.viewport !== "function") return null;
    const vp = await cdp.viewport(tabId);
    if (at) assertInViewport(vp, at.x, at.y);
    return vp;
  }

  // dismiss_overlay: closes the marketing pop-up on top of the page the way
  // a person would, stopping at the first step that works: its close or
  // decline control (by name: close, dismiss, no thanks, X), Escape, a
  // click on the backdrop, and only then hiding it from the page script.
  // The clicks go through the guarded click path, so a locked control is
  // never pressed. Sign-in, checkout, payment and cookie dialogs are refused
  // (content/page.js overlay_find), and blocked sites never get here.
  async function dismissOverlay(tabId, epoch) {
    const find = () => pageCall(tabId, "overlay_find", {});
    const first = await find();
    if (!first.found) return { dismissed: false, message: "No pop-up is covering the page." };
    if (first.sensitive) throw new BridgeError(ERR.LOCKED, `Locked: not dismissing "${first.name}", ${first.sensitive}. Ask the user if it is in the way.`);
    const name = first.name;
    let now = first;
    // Gone, or replaced by a different pop-up (the next call handles that).
    const gone = async () => {
      await settle(OVERLAY_SETTLE_MS);
      now = await find();
      // A re-rendered copy of the same pop-up (new ref, same name) is not gone.
      return !now.found || (now.ref !== first.ref && now.name !== first.name);
    };
    // An interrupt or turn end stops the ladder between steps.
    const live = () => {
      if (actor.epoch() !== epoch) throw Object.assign(new BridgeError(ERR.INTERRUPTED, "stopped: the turn ended"), { noFallback: true });
    };
    const steps = [
      ["close button", async () => now.closeRef && (await clickAt(tabId, { ref: now.closeRef }, epoch), true)],
      ["Escape", async () => (await cdp.key({ tabId, key: "Escape" }), true)],
      ["backdrop", async () => now.backdrop && (await clickAt(tabId, { x: now.backdrop.x, y: now.backdrop.y }, epoch), true)],
    ];
    for (const [via, step] of steps) {
      if (now.sensitive) break;
      let tried = false;
      live();
      try {
        tried = await step();
      } catch (e) {
        if (e && (e.code === ERR.INTERRUPTED || e.noFallback)) throw e;
        tried = false; // a locked or failed step: on to the next one
      }
      if (tried && (await gone())) return { dismissed: true, via, name };
    }
    if (now.sensitive) throw new BridgeError(ERR.LOCKED, `Locked: not hiding "${now.name}", ${now.sensitive}.`);
    live();
    await pageCall(tabId, "overlay_hide", { ref: first.ref });
    return { dismissed: true, via: "hidden", name };
  }

  async function tabOrigin(tabId) {
    const info = await tabs.tabInfo({ tabId });
    return originOf(info && info.url);
  }

  // The pay flow's half of the unlock: a nonce bound to this tab and its
  // current origin, on a site the user's settings let Orbi use (the
  // tab was resolved that way already; checked again here, failing
  // closed). The agent server asks for one only after the user's spoken
  // yes to the exact total (agent/unlock.ts), and its nonce only works with
  // press_protected, which presses one order button.
  //
  // scope "user" is the user-directed unlock (request_unlock on the server):
  // any allowed site, but its nonce only works with press_unlocked, which
  // never presses an order, wallet or card form control.
  async function lockArm(tabId, scope = "order") {
    if (scope !== "order" && scope !== "user") throw new BridgeError(ERR.BAD_REQUEST, "unknown unlock scope");
    const info = await tabs.tabInfo({ tabId });
    const origin = originOf(info && info.url);
    if (!origin) throw new BridgeError(ERR.NOT_ALLOWED, "tab has no origin to unlock");
    if (scope === "order" && (typeof tabs.isAllowed !== "function" || !(await tabs.isAllowed(info.url)))) {
      throw new BridgeError(ERR.LOCKED, "Locked: this page is on a site Orbi does not use");
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
  async function pressProtected(tabId, params, epoch) {
    await spend(tabId, params.nonce, "order");
    const check = () => pageCall(tabId, "press_check", { ref: params.ref });
    if (!(await paced())) return clickCentre(tabId, await check(), params.ref, "press_ref");
    const r = visibleRect(await pageCall(tabId, "rect", { ref: params.ref }), params.ref);
    // press_ref does not check visibility or cover itself: a fallback after
    // a CDP failure runs press_check first, as the unpaced press does.
    return clickCentre(tabId, r, params.ref, "press_ref", check, check, epoch);
  }

  // The card fields in every frame of the tab, by kind ([{ frameId,
  // documentId, fields: [{ kind, filled, usable }] }]). The page itself must
  // still pass the full site check and, when the pay flow names one
  // (origin), be on the origin the user said yes on. Another frame counts
  // only when it may get card values (tabs.frameAllowed: the page's own
  // origin, a payment provider's hosted fields or an allowed site).
  async function cardFrames(tabId, origin = null) {
    let found;
    try {
      await chromeApi.scripting.executeScript({ target: { tabId, allFrames: true }, files: CARD_FILES });
      found = await chromeApi.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => (globalThis.__clearcartCardFill ? globalThis.__clearcartCardFill.scan() : null),
      });
    } catch {
      throw new BridgeError(ERR.INTERNAL, "could not reach the page's card fields");
    }
    const results = (found || []).filter((r) => r && r.result && Array.isArray(r.result.fields));
    const top = results.find((r) => r.frameId === 0);
    const topHref = top && typeof top.result.href === "string" ? top.result.href : undefined;
    await recheck(tabId, topHref);
    const topOrigin = originOf(topHref);
    if (origin != null && topOrigin !== origin) throw new BridgeError(ERR.NOT_ALLOWED, "the page is not the checkout the user said yes on");
    const frames = [];
    for (const r of results) {
      if (r.frameId !== 0 && !(typeof tabs.frameAllowed === "function" && (await tabs.frameAllowed(r.result.href, topOrigin)))) continue;
      const fields = r.result.fields.filter((f) => f && typeof f.kind === "string").map((f) => ({ kind: f.kind, filled: f.filled === true, usable: f.usable !== false }));
      frames.push({ frameId: r.frameId, documentId: r.documentId || null, fields });
    }
    return frames;
  }

  // fill_card: params.card is { name, number, exp, csc, zip }, from the
  // agent server's vault, and params.origin the checkout's origin the user
  // said yes on. Each frame gets only its own fields' values, in the
  // document that was scanned. params.email (Stripe's test checkout only)
  // goes into the page's one empty email field. Any frame that does not
  // take its values clears every card field again and fails the call.
  async function fillCard(tabId, params) {
    const c = params && params.card;
    if (!c || typeof c !== "object") throw new BridgeError(ERR.BAD_REQUEST, "card is required");
    const number = String(c.number || "").replace(/[\s-]/g, "");
    const exp = expParts(c.exp);
    const csc = String(c.csc || "");
    if (!/^\d{12,19}$/.test(number) || !luhnValid(number) || !exp || !/^\d{3,4}$/.test(csc)) {
      throw new BridgeError(ERR.BAD_REQUEST, "the saved card is not complete");
    }
    if (typeof params.origin !== "string" || !params.origin) throw new BridgeError(ERR.BAD_REQUEST, "origin is required");
    const frames = await cardFrames(tabId, params.origin);
    const { plan, name, zip } = planCard(frames);
    const email = typeof params.email === "string" && params.email.length <= 254 ? params.email : "";
    const topFrame = frames.find((fr) => fr.frameId === 0);
    if (email && topFrame && !plan.has(topFrame)) plan.set(topFrame, []);
    const values = { "cc-number": number, "cc-exp": exp, "cc-exp-month": exp, "cc-exp-year": exp, "cc-csc": csc, "cc-name": String(c.name || ""), "postal-code": String(c.zip || "") };
    try {
      for (const [fr, kinds] of plan) {
        const mine = {};
        for (const k of kinds) if (values[k]) mine[k] = values[k];
        if (email && fr.frameId === 0) mine.email = email;
        const target = fr.documentId ? { tabId, documentIds: [fr.documentId] } : { tabId, frameIds: [fr.frameId] };
        let r = null;
        try {
          [r] = await chromeApi.scripting.executeScript({
            target,
            func: (v) => (globalThis.__clearcartCardFill ? globalThis.__clearcartCardFill.fill(v) : { ok: false }),
            args: [mine],
          });
        } catch {}
        if (!r || !r.result || r.result.ok !== true) throw new BridgeError(ERR.NO_ELEMENT, NOT_FILLED);
      }
    } catch (e) {
      await clearCard(tabId).catch(() => {});
      throw e instanceof BridgeError ? e : new BridgeError(ERR.INTERNAL, NOT_FILLED);
    }
    return { ok: true, last4: number.slice(-4), name, zip, frames: plan.size };
  }

  // clear_card: empties every card field in every frame.
  async function clearCard(tabId) {
    let results;
    try {
      await chromeApi.scripting.executeScript({ target: { tabId, allFrames: true }, files: CARD_FILES });
      results = await chromeApi.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => (globalThis.__clearcartCardFill ? globalThis.__clearcartCardFill.clear() : { ok: true, cleared: 0 }),
      });
    } catch {
      throw new BridgeError(ERR.INTERNAL, "could not clear the card fields");
    }
    const cleared = (results || []).reduce((n, r) => n + (Number(r && r.result && r.result.cleared) || 0), 0);
    return { ok: true, cleared };
  }

  // card_state: how many usable card fields the tab has and of which kinds
  // (in the frames fill_card would use), and how many card fields hold
  // something, usable or not. Counts only. origin, when given, must be the
  // page's origin.
  async function cardState(tabId, origin = null) {
    const frames = await cardFrames(tabId, origin);
    const kinds = {};
    let fields = 0;
    let filled = 0;
    for (const fr of frames) {
      for (const f of fr.fields) {
        if (f.filled) filled++;
        if (!f.usable) continue;
        kinds[f.kind] = (kinds[f.kind] || 0) + 1;
        fields++;
      }
    }
    return { fields, filled, kinds, frames: frames.filter((fr) => fr.fields.some((f) => f.usable)).length };
  }

  // Brings the tab a navigate call will use to the front, when it is one
  // Orbi may use now. A tab on a blocked page (the agent server's sweep
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
  async function pressUnlocked(tabId, params, epoch) {
    await spend(tabId, params.nonce, "user");
    const target = { ref: params.ref, label: params.label, cls: params.cls };
    const r = await pageCall(tabId, "press_check_user", target);
    const { x, y } = centre(r);
    const watch = await paced();
    if (!watch) await pageCall(tabId, "press_hit_user", { ...target, x, y });
    const start = docs.get(tabId);
    try {
      if (watch) {
        // Checked again on arrival: the control and the point it is at now.
        await actor.click(tabId, { x, y }, {
          epoch,
          size: Math.min(r.width, r.height),
          rect: boxOf(r),
          recheck: async () => {
            const fresh = await pageCall(tabId, "press_check_user", target);
            const p = centre(fresh);
            await pageCall(tabId, "press_hit_user", { ...target, ...p });
            sameDoc(tabId, start);
            return { ...p, rect: boxOf(fresh) };
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
    // An interrupt or turn end from here on stops this call's paced action,
    // even one that arrives during the checks before the actor starts it.
    const epoch = actor.epoch();
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
      case "actions_stop":
        // The turn ended or was interrupted: nothing paced keeps playing.
        actor.abortAll("the turn ended");
        return { ok: true };
    }
    const tabId = await tabs.resolveAllowedTab(params.tabId);
    indicate(tabId);
    if (ACT_METHODS.has(method)) await follow.to(tabId);
    switch (method) {
      case "click":
        return clickAt(tabId, params, epoch);
      case "type": {
        const focus = await guardType(tabId, params.text);
        if (focus && focus.nothing && params.text) {
          throw new BridgeError(ERR.NO_ELEMENT, "Nothing that takes text has focus. Click the field or editor first (in Google Docs or another canvas editor, click in the document where the text goes), then type.");
        }
        const start = docs.get(tabId);
        // A typed newline can submit the focused field's form.
        if (/[\r\n]/.test(String(params.text ?? ""))) await pageCall(tabId, "guard_key", { key: "Enter" });
        if (typeof params.text !== "string") throw new BridgeError(ERR.BAD_REQUEST, "text must be a string");
        // Always key by key at a typist's cadence, whatever the setting.
        if (params.text) await actor.type(tabId, params.text, { epoch, check: (ch) => guardChar(tabId, ch, start) });
        return { ok: true };
      }
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
        return pressUnlocked(tabId, params, epoch);
      case "lock_info":
        return pageCall(tabId, "lock_info", { ref: params.ref });
      case "press_protected":
        return pressProtected(tabId, params, epoch);
      case "fill_card":
        return fillCard(tabId, params);
      case "clear_card":
        return clearCard(tabId);
      case "card_state":
        return cardState(tabId, typeof params.origin === "string" && params.origin ? params.origin : null);
      case "scroll": {
        // No point given: the centre of the viewport.
        let { x, y } = params;
        if (x == null && y == null) {
          const vp = await inViewport(tabId);
          if (vp) [x, y] = [Math.round(vp.width / 2), Math.round(vp.height / 2)];
        } else if (x != null && y != null) {
          await inViewport(tabId, { x: point(x, "x"), y: point(y, "y") });
        }
        if (await paced()) {
          const at = { x: point(x, "x"), y: point(y, "y"), dx: point(params.dx ?? 0, "dx"), dy: point(params.dy ?? 0, "dy") };
          await actor.scroll(tabId, at, { epoch });
        } else {
          await cdp.scroll({ tabId, x, y, dx: params.dx, dy: params.dy });
          actor.notePointer(tabId, Number(x), Number(y));
        }
        return { ok: true };
      }
      case "dismiss_overlay":
        return dismissOverlay(tabId, epoch);
      case "screenshot": {
        const shot = await cdp.screenshot({ tabId });
        // The tab may have moved to a blocked site while it was captured.
        await recheck(tabId);
        return shot;
      }
    }
    if (method === "get_page_text") return pageText(tabId, params);
    if (method === "read_page") {
      const r = await pageCall(tabId, method, params);
      const file = r && googleFileOf(r.url);
      return file ? { ...r, note: editNote(file.app) } : r;
    }
    if (PAGE_METHODS.has(method)) return pageCall(tabId, method, params);
    throw new BridgeError(ERR.UNKNOWN_METHOD, `unknown method: ${method}`);
  }

  return { route, pageCall, inject, noteTalkStart, actor };
}
