// User-directed unlock: a locked control the user asked Orbi to press.
//
// The button lock (extension/content/protect.js) keeps Claude's tools off
// checkout, sign in, subscribe, saved card and marked controls. When the
// user's own words ask for that action ("sign me in", "go to checkout", "I
// want to check out"), request_unlock presses the control once; otherwise it
// asks one short question and needs a clear yes (isUnlockYes). Marked
// controls never unlock this way.
//
// What never unlocks here: placing an order, buy now, pay, wallets, marked
// controls, and the submit of a card form. Those go only through request_checkout and pay_with_saved_card
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

// Unlock classes (Protect.unlockClass). A marked control
// (data-clearcart-protected) never unlocks on request.
export type UnlockClass = "checkout" | "account" | "subscription" | "payment-method";

// Finer intents, so "sign up" never unlocks "Sign in".
type Intent = "checkout" | "signin" | "signout" | "signup" | "subscribe" | "save-card";

const norm = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;

// What the user's words ask for. Each pattern runs on one clause of norm()
// text with its polite filler stripped, and must start at the clause start:
// the action verb leads, as an imperative request ("sign me in", "go to
// checkout"). "uncheck subscribe", "close the login popup" or "I already
// joined" never match.
const USER_INTENTS: Array<[Intent, RegExp]> = [
  // "check out" is everyday English ("check out the reviews"), so only
  // bare, or with a few closing words.
  ["checkout", /^ (go|proceed|continue|head|move) (on |over |straight |right )?(to|into) (the )?check ?out /],
  ["checkout", /^ (take|bring|get) (me|us) (to|into) (the )?check ?out /],
  ["checkout", /^ check ?out( (now|please|for me|thanks|thank you|right now))* $/],
  ["checkout", /^ (start|begin|open) (the )?check ?out /],
  ["checkout", /^ (press|click|tap|hit|push) (on )?(the )?check ?out( button| link)?( (now|please|for me))* $/],
  ["signin", /^ (sign|log) (me |us )?(back )?in(to)? /],
  ["signin", /^ (signin|login)( me)? /],
  ["signout", /^ (sign|log) (me |us )?out /],
  ["signout", /^ (signout|logout)( me)? /],
  ["signup", /^ sign (me |us )?up( (for (an |a )?account|for the site|on (the )?site|here|now|please))* $/],
  ["signup", /^ (create|make|open|set up|register) (me )?(an |a |my )?(new )?account /],
  ["signup", /^ register( me)? /],
  ["signup", /^ signup /],
  ["subscribe", /^ subscribe /],
  ["subscribe", /^ sign (me |us )?up for (the |a |an )?(subscription|membership|trial|free trial|plan|newsletter) /],
  ["subscribe", /^ (start|begin|try) (the |a |my )?(free )?trial /],
  ["subscribe", /^ (join|become a member|enroll|upgrade) /],
  ["save-card", /^ (save|remember|store|add) (my |the |this |a |new )*(card|credit card|debit card|payment method|payment) /],
];

// What a control's label is for.
const LABEL_INTENTS: Array<[Intent, RegExp]> = [
  ["checkout", / check ?out /],
  ["signin", / (sign in|signin|log in|login|sign in with|log in with|continue with) /],
  ["signout", / (sign out|signout|log out|logout) /],
  ["signup", / (sign up|signup|create (an |my )?account|register) /],
  ["subscribe", / (subscribe|trial|try free|try it free|join|member|membership|enroll|upgrade|auto ?deliver|auto ?ship|autoship) /],
  ["save-card", / (card|payment method|payment details|payment) /],
];

const CLASSES = new Set<string>(["checkout", "account", "subscription", "payment-method"]);

const INTENT_CLASS: Record<Intent, UnlockClass> = {
  checkout: "checkout",
  signin: "account",
  signout: "account",
  signup: "account",
  subscribe: "subscription",
  "save-card": "payment-method",
};

// Delays, conditions, step orders and doubt: "check out, in a minute",
// "yes, after you add the socks", "I guess". Speech to text often puts a
// comma before them, so they count anywhere in the words.
const DELAY = [
  "but", "except", "first", "after(?! that)", "once", "soon", "sometime", "some point", "minute", "minutes", "sec", "second",
  "moment", "a bit", "guess", "dunno", "kidding", "joking", "yeah right", "i mean",
];

// Words that turn a request into a question, a refusal, a complaint, a
// condition or something for later. Any of them anywhere means "ask
// first" (the spoken confirmation), never a direct press.
const HEDGE = new RegExp(
  " (" +
    [
      ...DELAY,
      "dont", "do not", "not", "never", "no", "nope", "stop", "wait", "hold on", "without", "instead", "unless", "if", "whether",
      "should", "shouldnt", "maybe", "might", "perhaps", "probably", "wonder", "wondering", "thinking", "think", "considering",
      "later", "tomorrow", "eventually", "before", "what", "why", "how", "which", "where", "when", "who", "is there", "are there",
      "is it", "does", "do i", "did", "can i", "could i", "tell me", "explain", "describe", "read", "cancel", "undo", "pretend",
      "imagine", "hypothetically", "say", "says", "said", "asks?", "asked", "page", "website", "site says",
      "skip", "skipping", "close", "closing", "dismiss", "ignore", "avoid", "leave", "uncheck", "untick", "deselect",
      "turn off", "switch off", "remove", "broken", "already", "question", "questions", "problem", "error", "isnt", "wont", "cant",
    ].join("|") +
    ")(?= )"
);

// Polite lead-ins stripped from the start of a clause.
const FILLER = /^ (please|ok|okay|yes|yeah|yep|alright|all right|now|great|cool|sure|just|hey|so|and|then|uh|um|lets|can you|could you|would you|will you|can we|could we|go ahead and) /;

// How people state what they want: "I want to check out", "I'd like to
// subscribe", "I'm giving you permission to check out". Stricter than
// FILLER: the words must be one clause on their own, and after the action
// only closing words or the control's own label words may follow (so "I'd
// like to subscribe to fewer emails" or "I want to join the chat" ask).
// norm() drops apostrophes: "I'd" is "id", "I'm" is "im".
const LEAD = new RegExp(
  "^ (" +
    [
      "(i|we) (really )?(want|need|would like|wish)( you| us)? to", "(i|we) (really )?wanna", "(id|wed) (really )?like( you| us)? to",
      "(i am|im|we are) ready to", "(i am|im|i|we are|we) (giving|give) you (my |our )?(explicit |full )?permission to",
      "you have (my |our )?(explicit |full )?permission to", "you can", "you may", "feel free to",
    ].join("|") +
    ") "
);
const LEAD_TAIL = new Set("now please for me thanks thank you right here again back the a an my our this it to in into on".split(" "));

// A question that is really a request: "can you sign me in?".
const POLITE = /^ (please |ok |okay |yes |yeah |now |great |cool )*(can you|could you|would you|will you|can we|could we) /;

// The user's words as clauses, each " ... " with filler stripped. led: a
// LEAD was stripped from it.
type Clause = { c: string; led: boolean };
function clauses(raw: string): Clause[] {
  const out: Clause[] = [];
  for (const part of String(raw).split(/[,.;:!?]+/)) {
    for (const c of norm(part).split(/ (?:and then|and|then|after that) /)) {
      let s = ` ${c.trim()} `;
      let led = false;
      for (let prev = ""; prev !== s; ) {
        prev = s;
        s = s.replace(FILLER, " ");
        const t = s.replace(LEAD, " ");
        if (t !== s) led = true;
        s = t;
      }
      if (s.trim()) out.push({ c: s, led });
    }
  }
  return out;
}

// Intents of clauses; a led clause counts only when what follows the
// action is closing words or words of the label.
function userIntents(cs: Clause[], label: string): Set<Intent> {
  const out = new Set<Intent>();
  const mine = new Set(norm(label).trim().split(" "));
  for (const { c, led } of cs) {
    for (const [intent, re] of USER_INTENTS) {
      const m = re.exec(c);
      if (!m) continue;
      const rest = c.slice(m[0].length).trim();
      if (led && rest && !rest.split(" ").every((w) => LEAD_TAIL.has(w) || mine.has(w))) continue;
      out.add(intent);
    }
  }
  return out;
}

function labelIntents(label: string): Set<Intent> {
  const out = new Set<Intent>();
  const n = norm(label);
  for (const [intent, re] of LABEL_INTENTS) if (re.test(n)) out.add(intent);
  return out;
}

// True when the user's most recent words directly ask for pressing this
// control: an unhedged imperative whose action verb leads a clause and
// whose intent matches both the control's unlock class and its label, or
// "press <label>" naming it outright. Anything else goes through the
// spoken confirmation. Only ever pass the user's transcribed words here,
// never page text.
export function isDirectAsk(userText: string, cls: UnlockClass | null, label: string): boolean {
  if (!cls || !CLASSES.has(cls) || !userText || !label) return false;
  const raw = String(userText);
  // A long ramble is not a direct ask; a question that is not a polite
  // request ("is there a sign in button?") is not either.
  const n = norm(raw);
  if (n.trim().split(" ").length > 24) return false;
  if (/\?/.test(raw) && !POLITE.test(n)) return false;
  if (HEDGE.test(n)) return false;
  const cs = clauses(raw);
  // A stated wish must be the whole utterance: "I want to check out, once
  // the pants are in" asks.
  if (cs.some((x) => x.led) && cs.length > 1) return false;
  // "press Create account", "click the Subscribe button".
  const name = norm(label).trim();
  if (name) {
    const named = new RegExp(`^ (press|click|tap|hit|select|choose|push) (the |on )?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( button| link)? $`);
    if (cs.some((x) => named.test(x.c))) return true;
  }
  const want = userIntents(cs, label);
  for (const intent of labelIntents(label)) if (want.has(intent) && INTENT_CLASS[intent] === cls) return true;
  return false;
}

// Orbi Desktop's extra lock classes (desktop/safety.ts): sending a message
// or an email, deleting or moving to the trash, and installing or allowing
// (software, a permission). The same rule as isDirectAsk: the user's own
// unhedged imperative, its verb leading a clause, whose intent matches the
// control's label ("send it" for Send, "move it to the trash" for Move to
// Trash), or "press <label>". Placing an order never unlocks this way on
// the desktop either; it always gets the spoken question.
export type DesktopUnlockClass = "send" | "delete" | "install";

const DESKTOP_USER_INTENTS: Array<[DesktopUnlockClass, RegExp]> = [
  ["send", /^ send /],
  ["delete", /^ (delete|trash|erase|discard|throw (it |this |that |them )?away) /],
  ["delete", /^ (move|put|drag|throw) (it |this |that |them |these |those |the [a-z0-9]+ |my [a-z0-9]+ )*(in|into|to) (the )?(trash|bin) /],
  ["delete", /^ empty (the |my )?(trash|bin) /],
  ["install", /^ (install|allow|approve|authorize|authorise|trust|grant) /],
  ["install", /^ open (it |this |that )?anyway /],
];

const DESKTOP_LABEL_INTENTS: Record<DesktopUnlockClass, RegExp> = {
  send: / send /,
  delete: / (delete|trash|erase|discard|bin) /,
  install: / (install|allow|approve|authorize|authorise|trust|grant|open anyway) /,
};

export function isDesktopDirectAsk(userText: string, cls: DesktopUnlockClass | null, label: string): boolean {
  if (!cls || !DESKTOP_LABEL_INTENTS[cls] || !userText || !label) return false;
  const raw = String(userText);
  const n = norm(raw);
  if (n.trim().split(" ").length > 24) return false;
  if (/\?/.test(raw) && !POLITE.test(n)) return false;
  if (HEDGE.test(n)) return false;
  const cs = clauses(raw);
  if (cs.some((x) => x.led) && cs.length > 1) return false;
  const name = norm(label).trim();
  if (name) {
    const named = new RegExp(`^ (press|click|tap|hit|select|choose|push) (the |on )?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( button| link)? $`);
    if (cs.some((x) => named.test(x.c))) return true;
  }
  if (!DESKTOP_LABEL_INTENTS[cls].test(norm(label))) return false;
  const mine = new Set(norm(label).trim().split(" "));
  for (const { c, led } of cs) {
    for (const [intent, re] of DESKTOP_USER_INTENTS) {
      if (intent !== cls) continue;
      const m = re.exec(c);
      if (!m) continue;
      const rest = c.slice(m[0].length).trim();
      if (led && rest && !rest.split(" ").every((w) => LEAD_TAIL.has(w) || mine.has(w))) continue;
      return true;
    }
  }
  return false;
}

// The answer to request_unlock's own question ("Do you want me to go to
// checkout?"). Wider than the pay read-back's isExplicitYes (session.ts),
// which this never replaces. It must lead with a yes, and every later
// clause must be filler, a confirmation ("that's what I just said"), or
// about this control ("press checkout", "finish the order" for checkout)
// with no hedge, delay or question word and no other control's action. An
// answer that is itself a direct ask for this control counts too. Only
// ever pass the user's transcribed answer.
const YES_LEAD = /^ (yes|yeah|yep|yup|ya|yea|go ahead|do it|please do|absolutely|definitely|of course|correct|affirmative) /;
const YES_FILLER = /^ (ok|okay|alright|all right|sure|uh|um|oh|well|so|please|now|just) /;
const YES_TAIL = /^ (thats what i (just )?said|i (just |already )?said (so|yes|that)|i already (said|told you)( so| yes| that)?|i told you( so)?|like i said|you heard me|for sure|exactly|thats right|that is right|i do|i did|i want that|thanks|thank you|right now|go for it|lets go|lets do it) $/;
const NOT_YES = new RegExp(
  " (" +
    [
      ...DELAY,
      "no", "nope", "nah", "not", "dont", "do not", "never", "stop", "wait", "hold on", "hang on", "cancel", "nevermind", "never mind",
      "without", "instead", "unless", "if", "whether", "should", "shouldnt", "maybe", "might", "perhaps", "probably", "wonder", "think",
      "thinking", "considering", "later", "tomorrow", "eventually", "before", "what", "why", "how", "which", "where", "when", "who",
      "is it", "is there", "does", "do i", "did", "can i", "could i", "tell me", "explain", "rather", "else", "other", "actually", "hmm",
      "isnt", "wont", "cant", "too",
    ].join("|") +
    ")(?= )"
);
const ABOUT: Record<UnlockClass, RegExp> = {
  checkout: / (check ?out|check (it|them|this|that|these) out|order|purchase|buy|cart|bag) /,
  account: / (sign ?in|sign ?up|log ?in|login|account|password|register) /,
  subscription: / (subscribe|subscription|trial|member|membership|plan|join|enroll|upgrade) /,
  "payment-method": / (card|payment) /,
};

function stripAll(s: string, ...res: RegExp[]): string {
  for (let prev = ""; prev !== s; ) {
    prev = s;
    for (const re of res) s = s.replace(re, " ");
  }
  return s;
}

export function isUnlockYes(answer: string, cls: UnlockClass | null, label: string): boolean {
  if (!cls || !CLASSES.has(cls) || !label) return false;
  const raw = String(answer ?? "");
  const n = norm(raw);
  if (!n.trim() || n.trim().split(" ").length > 30 || /\?/.test(raw)) return false;
  if (isDirectAsk(raw, cls, label)) return true;
  const mine = labelIntents(label);
  let led = false;
  for (const part of raw.split(/[,.;:!]+/)) {
    for (const piece of norm(part).split(/ (?:and then|and|then|so) /)) {
      let c = stripAll(` ${piece.trim()} `, YES_FILLER);
      if (!c.trim()) continue;
      if (!led) {
        if (!YES_LEAD.test(c)) return false;
        led = true;
      }
      c = stripAll(c, YES_LEAD, YES_FILLER);
      if (!c.trim() || YES_TAIL.test(c)) continue;
      if (NOT_YES.test(c)) return false;
      if ([...userIntents(clauses(c), "")].some((i) => !mine.has(i))) return false;
      if (!ABOUT[cls].test(c)) return false;
    }
  }
  return led;
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
  // 30 s: the extension answers once the page the press opened has loaded
  // (up to 8 s on top of a paced press), and a timeout here would read as
  // not pressed when it was.
  return (await bridge.call<{ via?: string }>("press_unlocked", { ...target, nonce: armed.nonce }, 30_000)) || {};
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
el.click();
P.release(el);
return "pressed";`;
}

// ---------------------------------------------------------------- decision

export type Decision =
  | { kind: "refuse"; message: string }
  | { kind: "needs_password"; message: string }
  | { kind: "grant"; cls: UnlockClass; label: string; direct: true }
  | { kind: "ask"; cls: UnlockClass; label: string; question: string };

export const NOT_LOCKED = "That control is not locked. Press it with click as usual.";

// What request_unlock does for a control: refuse it, wait for the user's
// own password, press it at once (the user's latest words asked for it), or
// ask one short question first. spent: unlock classes already granted
// directly for this utterance (one press per ask). passwordYes: the user
// asked for this sign in before their password was typed, and these words,
// the very next ones, are an explicit yes (session.ts isExplicitYes).
export function decideUnlock(
  info: LockInfo,
  opts: { userText: string; spent?: Set<string>; passwordYes?: boolean }
): Decision {
  if (!info || !info.locked) return { kind: "refuse", message: NOT_LOCKED };
  const label = String(info.label || "this control");
  const cls = (info.cls && CLASSES.has(info.cls) ? info.cls : null) as UnlockClass | null;
  if (!cls) {
    switch (info.kind) {
      case "express":
        return { kind: "refuse", message: `'${label}' is a one-tap wallet or pay later button. Only the user can press it. Tell them where it is if they want to use it.` };
      case "frame":
      case "shadow":
        return { kind: "refuse", message: "Orbi cannot see inside that part of the page, so only the user can press it there." };
      default:
        return {
          kind: "refuse",
          message: `'${label}' places the order or pays. Only request_checkout and pay_with_saved_card can do that, after the user's yes.`,
        };
    }
  }
  if (cls === "account" && info.password && !info.passwordFilled) {
    return {
      kind: "needs_password",
      message: "The password field is empty. Orbi never types or reads passwords. Ask the user to type their password into the page themselves and to say yes when they are done, then call request_unlock again for this control.",
    };
  }
  const spent = opts.spent?.has(cls);
  const direct = !spent && (isDirectAsk(opts.userText, cls, label) || (!!opts.passwordYes && cls === "account"));
  if (direct) return { kind: "grant", cls, label, direct: true };
  const question = cls === "checkout" ? "Do you want me to go to checkout?" : `Do you want me to press ${label}?`;
  return { kind: "ask", cls, label, question };
}
