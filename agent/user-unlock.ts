// User-directed unlock: a locked control the user asked Clearcart to press.
//
// The button lock (extension/content/protect.js) keeps Claude's tools off
// checkout, sign in, subscribe, saved card and marked controls. When the
// user's own words ask for that action ("sign me in", "go to checkout"),
// request_unlock presses the control once; otherwise the agent asks one
// short question and needs an explicit yes (isExplicitYes).
//
// What never unlocks here: placing an order, buy now, pay, wallets, and the
// submit of a card form. Those go only through request_checkout and pay_now
// (unlock.ts). Passwords and card numbers are never typed by Claude: fields
// stay masked and refused, and a sign in is pressed only after the user has
// filled the password themselves.
//
// The direct match reads only the user's transcribed words, never page
// text. A grant is single use, bound to the tab, its origin, the control's
// ref and label, and expires after GRANT_TTL_MS. On the extension path the
// press also needs a lock_arm nonce with scope "user", and the extension
// re-checks the control's class and label (press_unlocked).

import { randomBytes } from "node:crypto";

import type { ExtBridge } from "./extbridge.ts";
import { Protect } from "./ocic-lock.ts";
import { originOf } from "./origins.ts";
import { LockedError } from "./unlock.ts";

export const USER_GRANT_TTL_MS = 60_000;

// Unlock classes (Protect.unlockClass).
export type UnlockClass = "checkout" | "account" | "subscription" | "payment-method" | "marked";

// Finer intents, so "sign up" never unlocks "Sign in".
type Intent = "checkout" | "signin" | "signup" | "subscribe" | "save-card";

const norm = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;

// What the user's words ask for. Each pattern runs on norm() text.
const USER_INTENTS: Array<[Intent, RegExp]> = [
  // "check out" is everyday English ("check out the reviews"), so only
  // bare, or followed by a word that is not a thing to look at.
  ["checkout", / (go|proceed|continue|head|move|take me|bring me|get me|get) (on |over |straight )?to (the )?check ?out /],
  ["checkout", / check ?out( (now|please|for me|then|and|so|thanks|thank you|already|with|on|at|here|right now))* $/],
  ["checkout", / check ?out (and|then|with|on|at|now|please|for me) /],
  ["checkout", / (start|begin|open) (the )?check ?out /],
  ["signin", / (sign|log) (me |us )?(back )?in(to)? /],
  ["signin", / (signin|login) /],
  ["signup", / sign (me |us )?up( for (an |a )?account| for the site| on (the )?site| here| now| please)* $/],
  ["signup", / (create|make|open|set up|register) (me )?(an |a |my )?(new )?account /],
  ["signup", / register( me)? /],
  ["signup", / signup /],
  ["subscribe", / subscribe /],
  ["subscribe", / sign (me |us )?up for (the |a |an )?(subscription|membership|trial|free trial|plan|newsletter)/],
  ["subscribe", / (start|begin|try) (the |a |my )?(free )?trial /],
  ["subscribe", / (join|become a member|enroll|upgrade)/],
  ["save-card", / (save|remember|store|add) (my |the |this |a |new )*(card|credit card|debit card|payment method|payment) /],
];

// What a control's label is for.
const LABEL_INTENTS: Array<[Intent, RegExp]> = [
  ["checkout", / check ?out /],
  ["signin", / (sign in|signin|log in|login|sign in with|log in with|continue with) /],
  ["signup", / (sign up|signup|create (an |my )?account|register) /],
  ["subscribe", / (subscribe|trial|try free|try it free|join|member|membership|enroll|upgrade|auto ?deliver|auto ?ship|autoship) /],
  ["save-card", / (card|payment method|payment details|payment) /],
];

const INTENT_CLASS: Record<Intent, UnlockClass> = {
  checkout: "checkout",
  signin: "account",
  signup: "account",
  subscribe: "subscription",
  "save-card": "payment-method",
};

// Words that turn a request into a question, a condition, a refusal or
// something for later. Any of them means "ask first".
const HEDGE = / (dont|do not|not|never|no|nope|stop|wait|hold on|without|instead|unless|if|whether|should|shouldnt|maybe|might|perhaps|probably|wonder|wondering|thinking|think|considering|not sure|later|tomorrow|eventually|before|what|why|how|which|where|when|who|is there|are there|is it|does|do i|did|can i|could i|tell me|explain|describe|read|cancel|undo|pretend|imagine|hypothetically|say|says|said|asks?|asked|page|website|site says)( |$)/;

// A question that is really a request: "can you sign me in?".
const POLITE = /^ (please |ok |okay |yes |yeah |now |great |cool )*(can you|could you|would you|will you|can we|could we) /;

function userIntents(text: string): Set<Intent> {
  const out = new Set<Intent>();
  const n = norm(text);
  if (!n.trim()) return out;
  for (const [intent, re] of USER_INTENTS) if (re.test(n)) out.add(intent);
  return out;
}

function labelIntents(label: string): Set<Intent> {
  const out = new Set<Intent>();
  const n = norm(label);
  for (const [intent, re] of LABEL_INTENTS) if (re.test(n)) out.add(intent);
  return out;
}

// True when the user's most recent words directly ask for pressing this
// control: an unhedged request whose intent matches both the control's
// unlock class and its label, or "press <label>" naming it outright.
// Only ever pass the user's transcribed words here, never page text.
export function isDirectAsk(userText: string, cls: UnlockClass | null, label: string): boolean {
  if (!cls || !userText || !label) return false;
  const raw = String(userText);
  // A long ramble is not a direct ask; a question that is not a polite
  // request ("is there a sign in button?") is not either.
  const n = norm(raw);
  if (n.trim().split(" ").length > 24) return false;
  if (/\?/.test(raw) && !POLITE.test(n)) return false;
  if (HEDGE.test(n)) return false;
  // "press Create account", "click the Subscribe button".
  const name = norm(label).trim();
  const named = new RegExp(` (press|click|tap|hit|select|choose|push) (the |on )?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( button| link)? `);
  if (name && named.test(n)) return true;
  if (cls === "marked") return false;
  const want = userIntents(raw);
  for (const intent of labelIntents(label)) if (want.has(intent) && INTENT_CLASS[intent] === cls) return true;
  return false;
}

// ------------------------------------------------------------------ grant

export type UserGrant = { token: string };
type Live = { tabId: number; origin: string; ref: string; label: string; cls: UnlockClass; expires: number };
export type GrantTarget = { tabId: number; href: string | null; ref: string; label: string; cls: UnlockClass };

export class UserUnlockGate {
  private live = new Map<string, Live>();
  private now: () => number;
  private ttlMs: number;

  constructor(opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? USER_GRANT_TTL_MS;
  }

  issue(t: GrantTarget): { ok: true; grant: UserGrant } | { ok: false; error: string } {
    const origin = originOf(t.href);
    if (!origin) return { ok: false, error: "That tab has no page to unlock a control on." };
    if (!t.cls) return { ok: false, error: "That control never unlocks on request." };
    for (const [k, l] of this.live) if (l.expires <= this.now()) this.live.delete(k);
    const token = randomBytes(16).toString("hex");
    this.live.set(token, { tabId: t.tabId, origin, ref: t.ref, label: t.label, cls: t.cls, expires: this.now() + this.ttlMs });
    return { ok: true, grant: { token } };
  }

  // Spends the grant: true only once, for the same tab, origin, control and
  // class, before it expires.
  consume(grant: UserGrant | null | undefined, at: GrantTarget): boolean {
    const l = grant && this.live.get(grant.token);
    if (!grant || !l) return false;
    this.live.delete(grant.token);
    return (
      l.tabId === at.tabId &&
      l.origin === originOf(at.href) &&
      l.ref === at.ref &&
      l.cls === at.cls &&
      Protect.sameLabel(l.label, at.label) &&
      l.expires > this.now()
    );
  }
}

export const userUnlockGate = new UserUnlockGate();

// ------------------------------------------------------------------ press

// What a ref is locked as, from the page.
export type LockInfo = {
  locked: boolean;
  kind?: string;
  label?: string;
  optin?: boolean;
  cls?: UnlockClass | null;
  password?: boolean;
  passwordFilled?: boolean;
};

type Bridge = Pick<ExtBridge, "call">;

export async function lockInfoExt(bridge: Bridge, tabId: number, ref: string): Promise<LockInfo> {
  return (await bridge.call<LockInfo>("lock_info", { tabId, ref }, 10_000)) || { locked: false };
}

// One press over the extension: spend the grant, then lock_arm (scope user)
// and press_unlocked, where the extension re-checks class and label.
export async function pressUnlockedExt(
  bridge: Bridge,
  grant: UserGrant,
  target: { tabId: number; ref: string; label: string; cls: UnlockClass },
  gate: UserUnlockGate = userUnlockGate
): Promise<{ via?: string }> {
  let href: string | null = null;
  try {
    href = (await bridge.call<{ url?: string }>("tab_info", { tabId: target.tabId }, 10_000))?.url ?? null;
  } catch {}
  if (!gate.consume(grant, { ...target, href })) throw new LockedError("the unlock is missing, used, expired or for another control");
  const armed = await bridge.call<{ nonce?: string }>("lock_arm", { tabId: target.tabId, scope: "user" }, 10_000);
  if (!armed || typeof armed.nonce !== "string") throw new LockedError("the extension did not arm the unlock");
  return (await bridge.call<{ via?: string }>("press_unlocked", { ...target, nonce: armed.nonce }, 15_000)) || {};
}

// Open Claude in Chrome path: refs live in that extension's own world, so
// the control is found by its label among the page's locked controls. The
// page script runs on a private copy of protect.js (ocic-lock pageScript).
export function ocicLockInfoScript(label: string): string {
  return `var want = ${JSON.stringify(String(label))};
var hits = P.listLocks(document, 300).filter(function (x) { return P.sameLabel(P.labelOf(x.el), want) || P.sameLabel(x.lock.label, want); });
if (!hits.length) return { locked: false };
var x = hits[0], pw = P.passwordState(x.el);
return { locked: P.blocks(x.lock), kind: x.lock.kind, label: x.lock.label, optin: !!x.lock.optin, cls: P.unlockClass(x.lock, x.el), password: pw.password, passwordFilled: pw.filled, count: hits.length };`;
}

export function ocicPressScript(label: string, cls: UnlockClass): string {
  return `var want = ${JSON.stringify(String(label))}, cls = ${JSON.stringify(cls)};
var hits = P.listLocks(document, 300).filter(function (x) { return P.unlockClass(x.lock, x.el) === cls && (P.sameLabel(P.labelOf(x.el), want) || P.sameLabel(x.lock.label, want)); });
if (!hits.length) return "missing";
var el = hits[0].el;
if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "instant" });
var r = el.getBoundingClientRect();
if (!(r.width > 0 && r.height > 0)) return "hidden";
var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
if (!hit || !(hit === el || el.contains(hit))) return "covered";
P.release(el);
setTimeout(function () { el.click(); }, 30);
return "pressed";`;
}

// ---------------------------------------------------------------- decision

export type Decision =
  | { kind: "refuse"; message: string }
  | { kind: "needs_password"; message: string }
  | { kind: "grant"; cls: UnlockClass; label: string; direct: true }
  | { kind: "ask"; cls: UnlockClass; label: string; question: string };

// "done" after the user typed their own password.
const DONE = /^ (ok |okay |yes |yeah |alright |all right )*(done|im done|i am done|finished|ready|typed it|i typed it|entered it|i entered it|its in|go ahead|go|yes|yeah|ok|okay)( now| thanks| thank you)? $/;

export const NOT_LOCKED = "That control is not locked. Press it with click as usual.";

// What request_unlock does for a control: refuse it, wait for the user's
// own password, press it at once (the user's latest words asked for it), or
// ask one short question first. spent: unlock classes already granted
// directly for this utterance (one press per ask). passwordAsk: the user
// asked for this sign in before their password was typed.
export function decideUnlock(
  info: LockInfo,
  opts: { userText: string; spent?: Set<string>; passwordAsk?: boolean }
): Decision {
  if (!info || !info.locked) return { kind: "refuse", message: NOT_LOCKED };
  const label = String(info.label || "this control");
  const cls = (info.cls || null) as UnlockClass | null;
  if (!cls) {
    switch (info.kind) {
      case "express":
        return { kind: "refuse", message: `'${label}' is a one-tap wallet or pay later button. Only the user can press it. Tell them where it is if they want to use it.` };
      case "frame":
      case "shadow":
        return { kind: "refuse", message: "Clearcart cannot see inside that part of the page, so only the user can press it there." };
      default:
        return {
          kind: "refuse",
          message: `'${label}' places the order or pays. Only request_checkout and pay_now can do that, after the user's yes, and only on the demo store. Elsewhere, tell the user they can finish it themselves.`,
        };
    }
  }
  if (cls === "account" && info.password && !info.passwordFilled) {
    return {
      kind: "needs_password",
      message: "The password field is empty. Clearcart never types or reads passwords. Ask the user to type their password into the page themselves and to tell you when they are done, then call request_unlock again for this control.",
    };
  }
  const spent = opts.spent?.has(cls);
  const direct = !spent && (isDirectAsk(opts.userText, cls, label) || (!!opts.passwordAsk && cls === "account" && DONE.test(norm(opts.userText))));
  if (direct) return { kind: "grant", cls, label, direct: true };
  const question = cls === "checkout" ? "Do you want me to go to checkout?" : `Do you want me to press ${label}?`;
  return { kind: "ask", cls, label, question };
}
