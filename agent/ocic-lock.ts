// Button lock for the Open Claude in Chrome path (CLEARCART_BROWSER unset).
//
// That extension is third-party, so the lock runs in our PreToolUse hook
// before each of Claude's browser calls. It uses the same classifier as our
// own extension (extension/content/protect.js), run two ways:
//   - by name, in Node, on the role and name the tab reports for a ref
//     (read_page with ref_id over our own bridge client), and
//   - in the page, through our own bridge client's javascript_tool, for
//     coordinate hit tests, the focused element on Enter/Space, and the
//     page's list of locked controls (so a ref whose name matches a locked
//     control is locked too).
// Every check fails closed: if it cannot run, the call is denied.
//
// Claude itself no longer has javascript_tool on this path (session.ts), so
// it cannot run page script around these checks. The page script runs in
// the page's main world, so a hostile page could tamper with DOM prototypes
// to fool it; our own extension runs the same checks in an isolated world.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callBrowserTool, evalInTab, resultText } from "./bridge.ts";

const require = createRequire(import.meta.url);
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "content");

// cls: Protect.unlockClass worked out in the page, next to the element.
export type Lock = { kind: string; label: string; optin: boolean; checked: boolean; cls?: string | null };
type ProtectApi = {
  classifyLabel(label: string, opts?: { checkable?: boolean }): string | null;
  normalize(s: string): string;
  isActivationKey(k: string): boolean;
  message(l: Lock, ref?: string | null): string;
  blocks(l: Lock): boolean;
  unlockClass(l: Lock | null, el?: unknown): string | null;
  sameLabel(a: string, b: string): boolean;
  dangerLifts(l: Lock | null): boolean;
  isCheckoutNav(label: string): boolean;
};
export const Protect: ProtectApi = require(path.join(EXT, "protect.js"));
const Mask: { maskCardRuns(s: string): string; CARD_MASK: string } = require(path.join(EXT, "mask.js"));

// True when text holds a Luhn-valid 13 to 19 digit run (mask.js finds them).
export function hasCardNumber(text: string): boolean {
  return Mask.maskCardRuns(String(text)) !== String(text);
}

export const CARD = "Not sent: that looks like a card number, or the focus is in a card field. Orbi never types card details; the user types them here (saved cards are filled by pay_with_saved_card only with the Orbi extension).";

const MASK_SRC = fs.readFileSync(path.join(EXT, "mask.js"), "utf8");
const PROTECT_SRC = fs.readFileSync(path.join(EXT, "protect.js"), "utf8");

// Danger mode on this path. Open Claude in Chrome has no Orbi
// settings, so it comes from the server's own config, like
// CLEARCART_BROWSE_MODE: CLEARCART_DANGER_MODE=1. Off unless set. While on,
// the button lock is off (every click, key and form_input goes through);
// password typing is still refused, and masking and the blocklist do not
// change.
export function ocicDangerMode(): boolean {
  return /^(1|true|on|yes)$/i.test(process.env.CLEARCART_DANGER_MODE?.trim() || "");
}

// The classifier inside the page, on a private global object so the page's
// own scripts cannot swap ClearcartProtect for a fake. `body` sees P.
export function pageScript(body: string, danger: boolean = ocicDangerMode()): string {
  return `(function (globalThis) {
var module = undefined;
${MASK_SRC}
${PROTECT_SRC}
var P = globalThis.ClearcartProtect;
P.setDangerMode(${danger === true ? "true" : "false"});
${body}
})({})`;
}

export type Deps = {
  evalInTab: <T = unknown>(tabId: number, code: string) => Promise<T>;
  readRef: (tabId: number, ref: string) => Promise<string>;
  // Danger mode (default: ocicDangerMode()).
  danger?: () => boolean;
};

const dangerOf = (deps: Deps) => (deps.danger ? deps.danger() === true : ocicDangerMode());

const defaultDeps: Deps = {
  evalInTab,
  readRef: async (tabId, ref) => resultText(await callBrowserTool("read_page", { tabId, ref_id: ref, filter: "all" })),
};

const LOCK_JSON = "function J(l){ return l ? { kind: l.kind, label: l.label, optin: !!l.optin, checked: !!l.checked, cls: l.cls !== undefined ? l.cls : P.unlockClass(l, l.el) } : null; }";

const CLICKS = new Set(["left_click", "right_click", "double_click", "triple_click", "left_click_drag", "left_mouse_down", "left_mouse_up", "diag_input"]);

export const PASSWORD = "Not sent: that is a password field. Orbi never types passwords; ask the user to type it themselves.";

// True when the focused element (through open shadow roots) is a password input.
const FOCUS_PASSWORD = `(function () { var el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
return !!el && el.tagName === "INPUT" && String(el.type || "").toLowerCase() === "password"; })()`;

// What the focused element is, through open shadow roots and same-origin
// frames: "card" (a card field, by mask.js), "frame" (a cross-origin frame,
// often hosted card fields, which cannot be checked) or null.
const FOCUS_CARD = `var el = document.activeElement, M = globalThis.ClearcartMask;
for (var g = 0; el && g < 20; g++) {
  if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
  if (!/^(IFRAME|FRAME|OBJECT|EMBED|FENCEDFRAME)$/.test(el.tagName)) break;
  var d = null; try { d = el.contentDocument || null; } catch (e) { d = null; }
  if (!d) return "frame";
  el = d.activeElement;
}
if (!el || el.nodeType !== 1) return null;
var ac = String(el.getAttribute("autocomplete") || "").toLowerCase();
return (M && M.isPaymentField(el)) || /(^|\\s)cc-/.test(ac) ? "card" : null;`;

const UNCHECKED = "Locked: Orbi could not check what this action would press, so it was not sent.";

// OCIC clicks a ref at the centre of its rect, after scrolling it into view,
// in its own isolated world. Our check runs in the main world and cannot
// map a ref to its element or that point, so a name check on the ref would
// miss a locked control under or inside it ("Continue" wrapping Place
// order, an overlay over the centre). Ref-only clicks are refused; a click
// at coordinates gets the full hit test.
export const REF_CLICK = "Not sent: on this browser Orbi checks clicks only at coordinates, not by ref. Click the same element by its coordinate instead (find reports where it is).";

function xy(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n)) ? [v[0], v[1]] : null;
}

// First line of OCIC's read_page for one ref: `role "name" [ref_N] ... type="checkbox"`.
export function parseRefLine(text: string): { role: string; name: string; type: string } | null {
  const line = text.split("\n").find((l) => /\[ref_\d+\]/.test(l));
  if (!line) return null;
  const m = /^\s*(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?\s+\[ref_\d+\]/.exec(line);
  if (!m) return null;
  const type = /\stype="([^"]*)"/.exec(line)?.[1] || "";
  return { role: m[1], name: m[2] || "", type };
}

const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio", "option", "tab"]);

// name: the full accessible name, for matching refs; label: the lock's
// clipped, masked label; hidden: not shown on the page.
type PageLock = { name: string; label?: string; hidden?: boolean; kind: string; optin: boolean; checked: boolean; cls?: string | null };

// The page's locked controls with their full accessible names.
async function pageLocks(deps: Deps, tabId: number): Promise<PageLock[]> {
  const r = await deps.evalInTab<PageLock[]>(
    tabId,
    pageScript(`return P.listLocks(document, 300).map(function (x) {
  var el = x.el, cs = null;
  try { cs = getComputedStyle(el); } catch (e) {}
  var hidden = !!(el.hidden || (el.closest && el.closest("[hidden],[aria-hidden=true]")) || (cs && (cs.display === "none" || cs.visibility === "hidden")));
  return { name: P.labelOf(el), label: x.lock.label, hidden: hidden, kind: x.lock.kind, optin: !!x.lock.optin, checked: !!x.lock.checked, cls: P.unlockClass(x.lock, el) };
});`, dangerOf(deps))
  );
  if (!Array.isArray(r)) throw new Error("no lock list");
  return r;
}

function sameName(a: string, b: string): boolean {
  const x = Protect.normalize(a).trim();
  const y = Protect.normalize(b).trim();
  return !!x && !!y && (x === y || (x.length >= 12 && y.startsWith(x)) || (y.length >= 12 && x.startsWith(y)));
}

// Lock for a ref, by its name and by matching the page's locked controls.
async function refLock(deps: Deps, tabId: number, ref: string, out?: { role?: string; type?: string }): Promise<Lock | null> {
  const text = await deps.readRef(tabId, ref);
  if (/^Error/i.test(text.trim())) throw new Error("ref not found");
  const info = parseRefLine(text);
  if (!info) throw new Error("ref line not understood");
  if (out) {
    out.role = info.role;
    out.type = info.type;
  }
  const checkable = CHECKABLE_ROLES.has(info.role) || info.type === "checkbox" || info.type === "radio";
  const kind = Protect.classifyLabel(info.name, { checkable });
  const label = info.name.slice(0, 60);
  const byName: Lock | null = kind ? { kind, label, optin: checkable, checked: false } : null;
  // Danger mode: no lock by name; the page's list (same mode) is empty.
  if (byName && !dangerOf(deps)) {
    // Locked by name whatever the page says; the page, which sees the
    // element, says whether it unlocks on request (a card form's submit or
    // a marked control never does). Unknown: judge by name alone.
    const seen = await pageLocks(deps, tabId).catch(() => null);
    const same = seen?.find((l) => sameName(l.name, info.name));
    byName.cls = same ? same.cls ?? null : Protect.unlockClass(byName);
    return byName;
  }
  const hit = (await pageLocks(deps, tabId)).find((l) => sameName(l.name, info.name));
  return hit ? { kind: hit.kind, label: hit.name.slice(0, 60), optin: hit.optin, checked: hit.checked, cls: hit.cls } : null;
}

// Runs a P.lockAt or P.lockForKey call in the page.
function pageLock(deps: Deps, tabId: number, call: string): Promise<Lock | null> {
  return deps.evalInTab<Lock | null>(tabId, pageScript(`${LOCK_JSON} return J(${call});`, dangerOf(deps)));
}

function tabIdOf(args: Record<string, unknown>): number {
  return typeof args.tabId === "number" ? args.tabId : Number(args.tabId);
}

function falsy(v: unknown): boolean {
  if (typeof v === "boolean") return !v;
  return /^(false|off|no|0|unchecked)$/i.test(String(v).trim());
}

// The deny reason for one of Claude's OCIC browser calls, or null to let it
// through. tool is the bare tool name (no mcp__browser__ prefix).
export async function ocicLockReason(tool: string, args: Record<string, unknown>, deps: Deps = defaultDeps): Promise<string | null> {
  const tabId = tabIdOf(args);
  // Danger mode: no button lock. Only the password checks below still run.
  const danger = dangerOf(deps);
  try {
    if (tool === "computer") {
      const action = String(args.action || "");
      if (CLICKS.has(action)) {
        if (danger) return null;
        const points = [xy(args.start_coordinate), xy(args.coordinate)].filter((p): p is [number, number] => !!p);
        if (!Number.isFinite(tabId)) return points.length || args.ref ? UNCHECKED : null;
        for (const [x, y] of points) {
          const l = await pageLock(deps, tabId, `P.lockAt(document, ${x}, ${y})`);
          if (l) return Protect.message(l);
        }
        if (!points.length && args.ref != null) {
          // Name it if it is locked, so Claude stops trying; else ask for a coordinate.
          const ref = typeof args.ref === "string" ? args.ref : null;
          const l = ref ? await refLock(deps, tabId, ref).catch(() => null) : null;
          return l && Protect.blocks(l) ? Protect.message(l, ref) : REF_CLICK;
        }
        return null;
      }
      if (action === "type" && String(args.text || "")) {
        // Passwords are typed by the user, never by Orbi.
        if (!Number.isFinite(tabId)) return UNCHECKED;
        if ((await deps.evalInTab<boolean>(tabId, FOCUS_PASSWORD)) === true) return PASSWORD;
        // Card details are never typed, in either mode.
        if (hasCardNumber(String(args.text))) return CARD;
        const focus = await deps.evalInTab<unknown>(tabId, pageScript(FOCUS_CARD, false));
        if (focus === "card" || focus === "frame") return CARD;
      }
      if (action === "key" || action === "type") {
        const keys = action === "key" ? String(args.text || "").split(" ").filter(Boolean) : /[\r\n]/.test(String(args.text || "")) ? ["Enter"] : [];
        // A control character in a key name ("\r") may be sent as Enter.
        const act = keys.map((k) => (/[\u0000-\u001f\u007f]/.test(k) ? "Enter" : k)).filter((k) => Protect.isActivationKey(k));
        if (!act.length || danger) return null;
        if (!Number.isFinite(tabId)) return UNCHECKED;
        for (const k of act) {
          const l = await pageLock(deps, tabId, `P.lockForKey(document, ${JSON.stringify(k)})`);
          if (l) return Protect.message(l);
        }
        return null;
      }
      return null;
    }
    if (tool === "form_input") {
      if (typeof args.ref !== "string" || !Number.isFinite(tabId)) return UNCHECKED;
      if (typeof args.value === "string" && hasCardNumber(args.value)) return CARD;
      const seen: { role?: string; type?: string } = {};
      const l = await refLock(deps, tabId, args.ref, seen);
      if (/^password$/i.test(seen.type || "")) return PASSWORD;
      if (danger) return null;
      // Unchecking an opt-in is fine; anything else on a locked control is not.
      if (l && !(l.optin && falsy(args.value))) return Protect.message(l, args.ref);
      // A dropdown is uncheck-only too: never choose an opt-in option.
      const value = String(args.value ?? "");
      const opt = /^(combobox|listbox|select)$/i.test(seen.role || "") ? Protect.classifyLabel(value, { checkable: true }) : null;
      if (opt) return `Locked: '${value.slice(0, 60)}' turns on a subscription, saved card, account or one-tap payment, so nothing was changed. Only the user can choose it; tell them if they want it.`;
      return null;
    }
    return null;
  } catch {
    return UNCHECKED;
  }
}

// After read_page, find or get_page_text: a note naming the locked
// controls (by ref where the output has refs), what to do about them, and
// the lock badges drawn in the tab.
export async function ocicLockNote(tool: string, args: Record<string, unknown>, output: string, deps: Deps = defaultDeps): Promise<string | null> {
  if ((tool !== "read_page" && tool !== "find" && tool !== "get_page_text") || dangerOf(deps)) return null;
  const tabId = tabIdOf(args);
  let page: PageLock[] = [];
  if (Number.isFinite(tabId)) {
    try {
      page = await pageLocks(deps, tabId);
      await deps.evalInTab(tabId, pageScript("return P.showBadges(document);", dangerOf(deps))).catch(() => {});
    } catch {}
  }
  const locked: string[] = [];
  const uncheck: string[] = [];
  if (tool === "get_page_text") {
    // No refs in page text: name the page's own locked controls.
    for (const l of page) {
      if (locked.length + uncheck.length >= 40) break;
      const label = typeof l.label === "string" ? l.label : "";
      if (l.hidden !== false || !label || !Protect.blocks({ kind: l.kind, label, optin: l.optin, checked: l.checked })) continue;
      (l.optin ? uncheck : locked).push(JSON.stringify(label.slice(0, 60)) + (l.cls ? "" : " (only the user can press it)"));
    }
  } else {
    const re = /(?:^|\s)(?:\[(ref_\d+)\]\s+)?(\S+)\s+"((?:[^"\\]|\\.)*)"(?:\s+\[(ref_\d+)\])?/;
    for (const line of output.split("\n")) {
      const m = re.exec(line);
      const ref = m && (m[1] || m[4]);
      if (!m || !ref) continue;
      const role = m[2];
      const name = m[3];
      const checkable = CHECKABLE_ROLES.has(role) || /type="(checkbox|radio)"/.test(line);
      const kind = Protect.classifyLabel(name, { checkable });
      const hit = kind ? { optin: checkable } : page.find((l) => sameName(l.name, name));
      if (!hit) continue;
      (hit.optin ? uncheck : locked).push(`${ref} "${name.slice(0, 60)}"`);
    }
  }
  if (!locked.length && !uncheck.length) return null;
  const parts: string[] = [];
  if (locked.length) parts.push(`Locked controls, your click tools cannot press or submit them: ${locked.join(", ")}.`);
  if (uncheck.length) parts.push(`Uncheck only (you may turn these off; turning one on needs the user's permission): ${uncheck.join(", ")}.`);
  return `Button lock: ${parts.join(" ")} ${LOCK_NEXT}`;
}

// What to do about a locked control, after the list.
export const LOCK_NEXT =
  "If the user wants one of them (go to checkout, sign in, sign up, subscribe, save a card), call request_unlock with its label; it asks the user itself when needed. Never call request_unlock for Place order, Buy now, Pay or wallet buttons: paying goes only through request_checkout and pay_with_saved_card.";
