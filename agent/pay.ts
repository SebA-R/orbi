// pay_with_saved_card: Orbi's own code, never Claude, fills a card the
// user saved in Orbi settings (vault/index.ts) into the checkout page
// and places the order, once, right after the user's spoken yes. Any page
// Orbi may use (origins.ts usableSite: the blocked sites stay
// blocked), over the Orbi extension (CLEARCART_BROWSER=ext) only.
//
// The yes (request_checkout, session.ts) is pinned to a moment, a tab, that
// tab's origin, the total read back and the page's priced lines. Paying
// spends it before anything else, checks all of that again on the page,
// finds the card fields (in any frame, cross-origin payment frames too) and
// the one order button, gets a grant from the unlock gate, and only then
// decrypts the card: one fill_card call over our own bridge socket, then
// one press through the extension's single-use nonce. Claude gets back
// { ok, last4, nickname } or a short error, never a card field. While the
// card is in the page the session's guard keeps every page-reading tool
// off (cardFieldsLive), and the card fields are emptied again unless the
// page shows none any more.
//
// Danger mode (session.ts): request_checkout announces the order instead of
// waiting for a yes, and that confirmation counts here only while Danger
// mode is still on (autoOk).

import { NO_CARD, VaultError, type CardMeta, type CardVault } from "../vault/index.ts";
import { cardVault } from "./cards.ts";
import { extBridge, extMode, type ExtBridge } from "./extbridge.ts";
import { orderTotal, parseMoney, sameMoney, type Money } from "./money.ts";
import { isStripeCheckoutUrl, originOf, usableSite } from "./origins.ts";
import { pressProtectedExt, unlockGate, type UnlockGate } from "./unlock.ts";

// What the user said yes to. confirmedAt, tabId, origin and cart pin the
// yes to a moment, a tab, a site and a cart: paying refuses a yes older
// than CONFIRM_TTL_MS, on another tab or site, or for a cart that has
// changed since.
export type Confirmation = {
  item: string;
  quantity: number;
  total: string;
  // The size or variant, for the purchase history only (history.ts).
  variant?: string;
  state: "pending" | "confirmed" | "declined" | "used";
  confirmedAt?: number;
  // Confirmed by Danger mode without a spoken yes (session.ts).
  auto?: boolean;
  tabId?: number | null;
  origin?: string | null;
  cart?: string;
  // The saved card the read-back named (request_checkout): the only card
  // this yes pays with.
  card?: CardMeta | null;
};

export const CONFIRM_TTL_MS = 60_000;

const NO_CONFIRMATION = "No confirmed checkout. Call request_checkout and get an explicit yes first.";
export const NEEDS_EXTENSION = "Paying needs the Orbi extension. Tell the user they can finish checkout on the page themselves.";
export const NO_FIELDS = "Couldn't find the card fields on this page, so nothing was filled or pressed. Ask the user what to do.";
const NOT_FILLED = "Couldn't fill the card fields on this page, so nothing was pressed. Ask the user what to do.";
const TAB_CHANGED = "The checkout tab is not on the page the user said yes on. Call request_checkout again.";
const CART_CHANGED = "The cart changed since the user said yes. Call request_checkout again with the page as it is now.";
const DANGER_OFF = "Danger mode was turned off. Call request_checkout again; the user now says yes first.";

// The priced lines of a checkout page's text (line items, subtotal,
// add-ons, tax, total), whitespace squashed: the cart the user heard.
export function cartLines(text: string): string {
  return String(text || "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => /[$£€¥₹]\s?\d|\d\s?[€£]|\b(?:USD|CAD|EUR|GBP)\s?\d/.test(l))
    .join("\n");
}

export type PayState = {
  lastTabId: number | null;
  confirmation: Confirmation | null;
  // A saved card is (or may be) in a page's card fields: the session guard
  // blocks every page-reading tool until it is cleared.
  cardFieldsLive: boolean;
  // The tab whose fields that is.
  cardTabId?: number | null;
  // Whether a Danger mode confirmation (auto) still counts: Danger mode is
  // still on. Read right before the order button is unlocked. Missing: no.
  autoOk?: () => boolean;
};

// Takes the confirmation for one payment, synchronously, before any await:
// it is "used" from here on whatever happens next, so a second call (or a
// retry after an early return) needs a new yes. Refuses a yes that is
// missing, stale, or not tied to a tab and its site.
export function claimConfirmation(state: PayState, now = Date.now()): { ok: true; c: Confirmation } | { ok: false; error: string } {
  const c = state.confirmation;
  if (!c || c.state !== "confirmed") return { ok: false, error: NO_CONFIRMATION };
  c.state = "used";
  if (typeof c.confirmedAt !== "number" || now - c.confirmedAt > CONFIRM_TTL_MS || now < c.confirmedAt) {
    return { ok: false, error: "The user's yes is more than a minute old. Call request_checkout again before paying." };
  }
  if (typeof c.tabId !== "number" || !c.origin) {
    return { ok: false, error: "No checkout tab was open when the user said yes. Open the checkout page and call request_checkout again." };
  }
  return { ok: true, c };
}

// A Danger mode confirmation counts only while Danger mode is still on.
function autoRevoked(state: PayState, c: Confirmation): boolean {
  return c.auto === true && !(state.autoOk?.() === true);
}

export type Receipt = { item: string; total: string; last4: string };

export type PayResult = { ok: true; last4: string; nickname: string; receipt: Receipt } | { ok: false; error: string };

type Bridge = Pick<ExtBridge, "call">;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tabUrlExt(bridge: Bridge, tabId: number): Promise<string | null> {
  try {
    const info = await bridge.call<{ url?: string }>("tab_info", { tabId }, 10_000);
    return typeof info?.url === "string" ? info.url : null;
  } catch {
    return null;
  }
}

export async function pageTextExt(bridge: Bridge, tabId: number): Promise<string> {
  try {
    const r = await bridge.call<{ text?: string }>("get_page_text", { tabId, maxChars: 60_000 }, 15_000);
    return String(r?.text || "");
  } catch {
    return "";
  }
}

// The checkout tab and its site and priced lines, for request_checkout to
// pin the yes to: the tab Claude last used, when it is on a page Orbi
// may use. All empty when there is none (always on the Open Claude in
// Chrome path, which never pays).
export async function checkoutSnapshot(preferred: number | null, bridge: Bridge = extBridge): Promise<{ tabId: number | null; origin: string | null; cart: string }> {
  const none = { tabId: null, origin: null, cart: "" };
  if (!extMode() || preferred == null) return none;
  const href = await tabUrlExt(bridge, preferred);
  if (!href || !usableSite(href)) return none;
  return { tabId: preferred, origin: originOf(href), cart: cartLines(await pageTextExt(bridge, preferred)) };
}

// What card_state answers: counts of card fields by kind, in every frame.
export type CardFields = { fields: number; filled: number; kinds: Record<string, number>; frames: number };

async function cardFieldsExt(bridge: Bridge, tabId: number, origin?: string): Promise<CardFields | null> {
  try {
    const s = await bridge.call<CardFields>("card_state", origin ? { tabId, origin } : { tabId }, 15_000);
    return s && typeof s === "object" && s.kinds && typeof s.kinds === "object" ? s : null;
  } catch {
    return null;
  }
}

// One card number, one security code and one expiry (a field, or a month
// and a year): the same rule fill_card fills by (router.js planCard).
export function hasCardFields(s: CardFields | null): boolean {
  if (!s) return false;
  const n = (k: string) => Number(s.kinds[k]) || 0;
  const exp = (n("cc-exp") === 1 && !n("cc-exp-month") && !n("cc-exp-year")) || (!n("cc-exp") && n("cc-exp-month") === 1 && n("cc-exp-year") === 1);
  return n("cc-number") === 1 && n("cc-csc") === 1 && exp;
}

// The total on a Stripe Checkout page: its "Total due" line, else the one
// amount the page shows (a single item: "$14.00" under the product and as
// the big summary amount). Several different amounts and no "Total due":
// unknown, so pay_with_saved_card refuses.
// Any other currency ("CA$", "€", "£") or a whole-dollar amount: unknown.
export function stripeTotal(text: string): string {
  const t = String(text);
  if (/(^|[^A-Za-z])(?!US\$)[A-Z]{1,3}\$|[€£¥₹]|\$\s*[0-9][0-9,]*(?![0-9,]|\.[0-9]{2})/.test(t)) return "";
  // Every "Total due" on the page must agree (a product name can say it too).
  const dues = new Set([...t.matchAll(/Total due\s*:?\s*(?:US)?\$\s*([0-9][0-9,]*\.[0-9]{2})/gi)].map((m) => m[1].replace(/,/g, "")));
  if (dues.size > 1) return "";
  if (dues.size === 1) return `$${[...dues][0]}`;
  const amounts = new Set([...String(text).matchAll(/\$\s*([0-9][0-9,]*\.[0-9]{2})\b/g)].map((m) => m[1].replace(/,/g, "")));
  return amounts.size === 1 ? `$${[...amounts][0]}` : "";
}

// Stripe Checkout's confirmation, shown in place of the form on the same
// page ("Thanks for your payment", "Payment successful").
const STRIPE_PAID = /thanks? (you )?for your (payment|order|purchase)|payment (successful|succeeded)/i;
export function stripePaid(text: string): boolean {
  return STRIPE_PAID.test(String(text));
}

// Stripe's pay button reads "Pay" (with a hidden "Processing" label, and on
// some pages the amount). "Pay with card" and wallet buttons do not count.
const STRIPE_PAY_BUTTON = /^\s*pay(\s+now)?(\s+\$?\s*[0-9][0-9,]*(\.[0-9]{2})?)?(\s+processing)?\s*$/i;

// The text of the first role="alert" in a read_page tree. The page script
// prints an alert without a name (alerts don't take their name from content)
// and its text as indented `- text "..."` children:
//   - alert [ref_3]
//     - text "That card number is not valid."
// A named alert (`- alert "..." [ref_3]`) is accepted too.
export function alertText(tree: string): string {
  const lines = tree.split("\n");
  const i = lines.findIndex((l) => /^\s*-\s*alert\b/.test(l));
  if (i < 0) return "";
  const named = /^\s*-\s*alert\s+"([^"]+)"/.exec(lines[i])?.[1];
  if (named) return named;
  const indent = /^\s*/.exec(lines[i])![0].length;
  const parts: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (/^\s*/.exec(l)![0].length <= indent) break;
    const t = /^\s*-\s*text\s+"([^"]*)"/.exec(l)?.[1];
    if (t) parts.push(t);
  }
  return parts.join(" ").trim();
}

async function alertOn(bridge: Bridge, tabId: number): Promise<string> {
  try {
    const page = await bridge.call<{ tree?: string }>("read_page", { tabId, filter: "all", maxNodes: 400 }, 10_000);
    return alertText(String(page?.tree || ""));
  } catch {
    return "";
  }
}

// Page text that goes back to Claude after the card was in the page: every
// digit is masked, so no part of a card number, expiry or code can ride
// along, and it is kept short.
export function safeAlert(text: string): string {
  return String(text || "").replace(/\d/g, "#").replace(/#[#\s/-]*#|#/g, "#").replace(/\s+/g, " ").trim().slice(0, 140);
}

// Words a page shows once an order is placed.
const PLACED = /\b(?:thank you for (?:your )?(?:order|purchase|payment)|thanks for (?:your )?(?:order|purchase|payment)|(?:your )?order (?:is |has been |was )?(?:confirmed|placed|received|complete)|order confirmation|confirmation (?:number|code|#)|we(?:'ve| have) received your order|payment (?:successful|succeeded|received|complete))\b/i;

type OrderButton = { ref: string; label: string; kind: string; disabled?: boolean };

// Labels that place the order, for choosing among several order controls.
const PLACES = /\b(?:place (?:your |my )?order|pay(?: now)?|complete (?:my )?(?:order|purchase|payment)|submit (?:my )?(?:order|payment)|confirm (?:my )?(?:order|purchase|payment)|confirm and pay|buy(?: it)? now|purchase|order now|finish order|make (?:a )?payment)\b/i;
const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// The one order control to press: the only one, or the one that says it
// places the order (the same control shown twice counts once). Anything
// less clear is refused.
export function chooseOrderButton(buttons: OrderButton[]): { ok: true; button: OrderButton } | { ok: false; error: string } {
  const one = (list: OrderButton[]) => (list.length && list.every((b) => sameLabel(b.label, list[0].label)) ? list[0] : null);
  if (!buttons.length) return { ok: false, error: "Could not find the button that places the order on this page, so nothing was filled or pressed. Tell the user they can finish it themselves." };
  const pick = one(buttons) || one(buttons.filter((b) => PLACES.test(b.label)));
  if (!pick) return { ok: false, error: "The page has more than one button that could place the order, so nothing was filled or pressed. Tell the user they can finish it themselves." };
  if (pick.disabled) return { ok: false, error: `'${pick.label}' is not active yet: the page may still need details from the user. Nothing was filled or pressed.` };
  return { ok: true, button: pick };
}

export type PayDeps = {
  bridge?: Bridge;
  gate?: UnlockGate;
  vault?: CardVault;
  orderTimeoutMs?: number;
  pollMs?: number;
  // How long the page gets after the fill before its total is read again.
  settleMs?: number;
  // Aborted when the user speaks or moves on (session.ts): nothing more is
  // filled or pressed.
  signal?: AbortSignal;
};

// Stripe's hosted test checkout takes any ZIP and email. Used there only,
// when the saved card has no ZIP, and only in empty fields.
export const STRIPE_TEST_ZIP = "42424";
export const STRIPE_TEST_EMAIL = "demo@example.com";

const STOPPED = "The user spoke before the card went in, so nothing was filled or pressed. Answer what they said.";
const STOPPED_FILLED = "The user spoke before the order was placed, so nothing was pressed and the card fields were emptied. Answer what they said.";

// How a card is named to the user: "Work Visa ending 1111", or "your Visa
// ending 1111" when it has no nickname of its own.
export function cardPhrase(c: { nickname: string; brand: string; last4: string }): string {
  return `${c.nickname === c.brand ? `your ${c.brand}` : c.nickname} ending ${c.last4}`;
}

// The page's total: a Stripe test checkout's own reading, else orderTotal.
function totalOn(text: string, stripe: boolean): Money | null {
  return stripe ? parseMoney(stripeTotal(text)) : orderTotal(text);
}

// The Open Claude in Chrome path has no extension-side lock_arm nonce and
// no card fill, so it never pays. The yes is spent all the same.
export async function payNow(state: PayState, args: { cardNickname?: string | null } = {}, deps: PayDeps = {}): Promise<PayResult> {
  if (extMode()) return payWithSavedCardExt(state, args, deps);
  const claim = claimConfirmation(state);
  if (!claim.ok && claim.error === NO_CONFIRMATION) return claim;
  return { ok: false, error: NEEDS_EXTENSION };
}

export async function payWithSavedCardExt(state: PayState, args: { cardNickname?: string | null } = {}, deps: PayDeps = {}): Promise<PayResult> {
  const bridge = deps.bridge ?? extBridge;
  const gate = deps.gate ?? unlockGate;
  const pollMs = deps.pollMs ?? 400;
  const stopped = () => deps.signal?.aborted === true;

  const yes = state.confirmation;
  if (yes?.state !== "confirmed") return { ok: false, error: NO_CONFIRMATION };
  // The card first, before the yes is spent: only the one the read-back
  // named, and still saved. Card trouble is for the user to sort out, and
  // nothing on the page has been touched.
  const vault = deps.vault ?? cardVault();
  let card: CardMeta;
  try {
    const saved = vault.list().cards;
    const named = yes.card ? saved.find((x) => x.id === yes.card!.id) : null;
    if (!named) {
      if (!saved.length) return { ok: false, error: NO_CARD };
      return {
        ok: false,
        error: yes.card
          ? "The card the user said yes to is not saved any more. Call request_checkout again so they hear which card pays."
          : "The read-back did not name a saved card. Call request_checkout again so the user hears which card pays.",
      };
    }
    if (args.cardNickname) {
      const asked = vault.pick(args.cardNickname);
      if (!asked.ok || asked.card.id !== named.id) {
        return { ok: false, error: `The user said yes to paying with ${cardPhrase(named)}. To pay with another card, call request_checkout again with that cardNickname.` };
      }
    }
    card = named;
  } catch (e) {
    return { ok: false, error: e instanceof VaultError ? e.message : "The saved cards could not be read." };
  }

  const claim = claimConfirmation(state);
  if (!claim.ok) return claim;
  const c = claim.c;
  if (autoRevoked(state, c)) return { ok: false, error: DANGER_OFF };
  if (stopped()) return { ok: false, error: STOPPED };
  const tabId = c.tabId!;

  // The same tab, still on the site the user said yes on.
  const startHref = await tabUrlExt(bridge, tabId);
  if (!startHref || originOf(startHref) !== c.origin) return { ok: false, error: TAB_CHANGED };
  if (!usableSite(startHref)) return { ok: false, error: "This page is on a site Orbi does not use, so nothing was filled or pressed." };
  // Stripe's hosted test checkout (origins.ts): its own total, Pay button
  // and confirmation on the same page. Its hosts serve every merchant's
  // sessions, so the exact page is pinned, not only the origin.
  const stripe = isStripeCheckoutUrl(startHref);

  // The amount on the page must still be the one the user said yes to, and
  // the cart the one they heard.
  const text = await pageTextExt(bridge, tabId);
  const confirmedTotal = parseMoney(c.total);
  const total = totalOn(text, stripe);
  if (!total || !sameMoney(total, confirmedTotal)) {
    return { ok: false, error: `The page total is now ${total?.text || "unclear"}, but the user said yes to ${c.total}, so nothing was filled or pressed. Call request_checkout again.` };
  }
  if (c.cart && cartLines(text) !== c.cart) return { ok: false, error: CART_CHANGED };
  const placedBefore = PLACED.test(text);
  // A page that already says thanks cannot be told apart from a paid one.
  if (stripe && placedBefore) return { ok: false, error: "The checkout page already shows a payment confirmation, so nothing was filled or pressed. Check the page before trying again." };

  // The card fields (any frame, on the origin of the yes) and the one order
  // button, before any card value moves.
  if (!hasCardFields(await cardFieldsExt(bridge, tabId, c.origin!))) return { ok: false, error: NO_FIELDS };
  let buttons: OrderButton[] = [];
  try {
    buttons = (await bridge.call<{ buttons?: OrderButton[] }>("order_buttons", { tabId }, 10_000))?.buttons || [];
  } catch {
    return { ok: false, error: "Could not read the page's order button, so nothing was filled or pressed." };
  }
  // On Stripe only its Pay button counts, never Pay with card or a wallet.
  const chosen = chooseOrderButton(stripe ? buttons.filter((b) => STRIPE_PAY_BUTTON.test(b.label)) : buttons);
  if (!chosen.ok) return chosen;
  const button = chosen.button;

  // Button lock: the grant needs the yes, a usable site and the matching
  // total (unlock.ts), then the extension's nonce for one press.
  if (autoRevoked(state, c)) return { ok: false, error: DANGER_OFF };
  if (stopped()) return { ok: false, error: STOPPED };
  const issued = gate.issue({ confirmation: { total: c.total, state: "confirmed" }, tabId, href: startHref, pageTotal: total.text });
  if (!issued.ok) return { ok: false, error: issued.error };

  const alertBefore = await alertOn(bridge, tabId);
  state.cardFieldsLive = true;
  state.cardTabId = tabId;
  try {
    if (autoRevoked(state, c)) return { ok: false, error: DANGER_OFF };
    if (stopped()) return { ok: false, error: STOPPED };
    if (stripe && (await tabUrlExt(bridge, tabId)) !== startHref) return { ok: false, error: TAB_CHANGED };
    // The card is decrypted for this one call and dropped when it returns.
    let filled: { ok?: boolean } | null = null;
    try {
      filled = await vault.withCard(card.id, (s) =>
        bridge.call<{ ok?: boolean }>("fill_card", {
          tabId,
          origin: c.origin,
          card: { name: s.name, number: s.number, exp: s.exp, csc: s.csc, zip: s.zip || (stripe ? STRIPE_TEST_ZIP : "") },
          ...(stripe ? { email: STRIPE_TEST_EMAIL } : {}),
        }, 30_000)
      );
    } catch (e) {
      if (e instanceof VaultError) return { ok: false, error: `${e.message} Nothing was filled or pressed.` };
      return { ok: false, error: (e as { code?: string }).code === "no_element" ? NO_FIELDS : NOT_FILLED };
    }
    if (!filled || filled.ok !== true) return { ok: false, error: NOT_FILLED };

    // The page may change its total once it has the card (a surcharge, tax
    // by billing ZIP): read it again, and press only on the amount and cart
    // the user said yes to.
    await sleep(deps.settleMs ?? 500);
    const after = await pageTextExt(bridge, tabId);
    const totalAfter = totalOn(after, stripe);
    if (!totalAfter || !sameMoney(totalAfter, confirmedTotal) || (c.cart && cartLines(after) !== c.cart)) {
      return { ok: false, error: `The page total changed to ${totalAfter?.text || "something unclear"} once the card went in, so nothing was pressed and the card fields were emptied. Tell the user and call request_checkout again if they still want it.` };
    }
    if (autoRevoked(state, c)) return { ok: false, error: DANGER_OFF };
    if (stopped()) return { ok: false, error: STOPPED_FILLED };

    try {
      await pressProtectedExt(bridge, issued.grant, { tabId, ref: button.ref, ...(stripe ? { href: startHref } : {}) }, gate);
    } catch {
      return { ok: false, error: `Could not press '${button.label}', so nothing was ordered. Do not try again; tell the user they can press it themselves.` };
    }

    // Pressed once. From here on nothing is pressed again: only the outcome
    // is read.
    const deadline = Date.now() + (deps.orderTimeoutMs ?? 20_000);
    let moved = false;
    await sleep(Math.min(600, pollMs));
    while (Date.now() < deadline) {
      const href = await tabUrlExt(bridge, tabId);
      moved ||= !!href && href !== startHref;
      const now = await pageTextExt(bridge, tabId);
      // Placed: the page says so, and either moved on or did not say it
      // before the press. Stripe confirms in place of the form, so there
      // the card number field must be gone too.
      const formGone = !stripe || (await cardFieldsExt(bridge, tabId))?.kinds?.["cc-number"] === undefined;
      if (PLACED.test(now) && (moved || !placedBefore) && formGone) {
        const receipt = { item: c.item, total: c.total, last4: card.last4 };
        return { ok: true, last4: card.last4, nickname: card.nickname, receipt };
      }
      if (!moved) {
        const err = await alertOn(bridge, tabId);
        if (err && err !== alertBefore) return { ok: false, error: `The site did not take the payment: ${safeAlert(err)}` };
      }
      await sleep(pollMs);
    }
    return {
      ok: false,
      error: moved
        ? `Orbi pressed '${button.label}' once. The page moved on but does not say the order is placed; it may need another step. Do not press it again. Read the page to the user; to place the order, call request_checkout again so they can say yes.`
        : `Orbi pressed '${button.label}' once, but the page does not show the order as placed. Do not press it again; read the page to the user.`,
    };
  } finally {
    // The guard comes down only once the page holds no card value: the
    // fields are gone (an order page) or empty, or were emptied and then
    // counted empty. Hidden, disabled and read-only fields count too.
    const left = await cardFieldsExt(bridge, tabId);
    if (left && left.filled === 0) state.cardFieldsLive = false;
    else {
      await bridge.call("clear_card", { tabId }, 10_000).catch(() => {});
      const again = await cardFieldsExt(bridge, tabId);
      if (again && again.filled === 0) state.cardFieldsLive = false;
    }
  }
}
