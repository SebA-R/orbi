// Paying on any site, over the Clearcart extension (CLEARCART_BROWSER=ext).
// Clearcart never has the card: the user picks a saved card in Chrome's own
// list, and our code, not Claude, presses the order button once after the
// user's spoken yes to the exact total.
//
//   pick_card         (session.ts) opens Chrome's saved cards on the page's
//                     card number field: one real click there (bridge
//                     card_autofill). Chrome takes the pick only from the
//                     user. The extension answers counts and states, never
//                     a card value.
//   request_checkout  (session.ts) reads the order total from the page
//                     itself (orderTotal) and reads item, quantity and that
//                     total back. Only an explicit spoken yes confirms, and
//                     it is pinned to the tab, its origin, the total and the
//                     priced lines of the page (Confirmation).
//   pay_now           spends that yes at once, checks tab, origin, total and
//                     cart again, finds the one order button, gets a grant
//                     from the unlock gate and presses it once through the
//                     extension's lock_arm nonce. Never a second press, and
//                     never again without a new yes.
//
// The Open Claude in Chrome path never pays.

import { extBridge, extMode, type ExtBridge } from "./extbridge.ts";
import { orderTotal, parseMoney, sameMoney, type Money } from "./money.ts";
import { originOf } from "./origins.ts";
import { pressProtectedExt, unlockGate, type UnlockGate } from "./unlock.ts";

// What the user said yes to. total is the page's own total as read back.
// confirmedAt, tabId, origin and cart pin the yes to a moment, a tab, a
// site and a cart: pay_now refuses a yes older than CONFIRM_TTL_MS, on
// another tab or site, or for a cart that has changed since.
export type Confirmation = {
  item: string;
  quantity: number;
  total: string;
  state: "pending" | "confirmed" | "declined" | "used";
  confirmedAt?: number;
  tabId?: number | null;
  origin?: string | null;
  cart?: string;
};

export const CONFIRM_TTL_MS = 60_000;

const NO_CONFIRMATION = "No confirmed checkout. Call request_checkout and get an explicit yes first.";
export const NEEDS_EXTENSION = "Paying needs the Clearcart extension. Tell the user they can finish checkout on the page themselves.";

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
  // A pay step is running (pick_card waiting for the user, pay_now
  // pressing): the session guard keeps Claude's browser tools off.
  payBusy: boolean;
};

// Takes the confirmation for one pay_now, synchronously, before any await:
// it is "used" from here on whatever happens next, so a second pay_now (or
// a retry after an early return) needs a new yes. Refuses a yes that is
// missing, stale or not tied to a tab.
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

const TAB_CHANGED = "The checkout tab is not on the page the user said yes on. Call request_checkout again.";
const CART_CHANGED = "The cart changed since the user said yes. Call request_checkout again with the page as it is now.";

export type Receipt = { item: string; total: string; last4: string };

export type PayResult = { ok: true; last4: string; receipt: Receipt } | { ok: false; error: string };

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

// The checkout page as request_checkout pins it: where it is, its order
// total (null when unclear) and its priced lines.
export type CheckoutPage = { href: string | null; origin: string | null; total: Money | null; cart: string };

export async function readCheckoutExt(bridge: Bridge, tabId: number): Promise<CheckoutPage> {
  const href = await tabUrlExt(bridge, tabId);
  const text = href ? await pageTextExt(bridge, tabId) : "";
  return { href, origin: originOf(href), total: orderTotal(text), cart: cartLines(text) };
}

// What card_state answers: counts and states, never a value.
export type CardState = {
  fields: number;
  filled: number;
  autofilled: number;
  number: { filled: boolean; autofilled: boolean } | null;
  frames: number;
  live: boolean;
};

export async function cardStateExt(bridge: Bridge, tabId: number): Promise<CardState | null> {
  try {
    return (await bridge.call<CardState>("card_state", { tabId }, 10_000)) || null;
  } catch {
    return null;
  }
}

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

// Words a page shows once an order is placed.
const PLACED = /\b(?:thank you for (?:your )?(?:order|purchase)|thanks for (?:your )?(?:order|purchase)|(?:your )?order (?:is |has been |was )?(?:confirmed|placed|received|complete)|order confirmation|confirmation (?:number|code|#)|we(?:'ve| have) received your order|payment (?:successful|received|complete))\b/i;

type OrderButton = { ref: string; label: string; kind: string; disabled?: boolean };

// Labels that place the order, for choosing among several order controls.
const PLACES = /\b(?:place (?:your |my )?order|pay(?: now)?|complete (?:my )?(?:order|purchase|payment)|submit (?:my )?(?:order|payment)|confirm (?:my )?(?:order|purchase|payment)|confirm and pay|buy(?: it)? now|purchase|order now|finish order|make (?:a )?payment)\b/i;
const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// The one order control to press: the only one, or the one that says it
// places the order (the same control shown twice counts once). Anything
// less clear is refused.
export function chooseOrderButton(buttons: OrderButton[]): { ok: true; button: OrderButton } | { ok: false; error: string } {
  const one = (list: OrderButton[]) => (list.length && list.every((b) => sameLabel(b.label, list[0].label)) ? list[0] : null);
  if (!buttons.length) return { ok: false, error: "Could not find the button that places the order on this page. Tell the user they can press it themselves." };
  const pick = one(buttons) || one(buttons.filter((b) => PLACES.test(b.label)));
  if (!pick) return { ok: false, error: "The page has more than one button that could place the order, so Clearcart pressed none. Tell the user they can press the right one themselves." };
  if (pick.disabled) return { ok: false, error: `'${pick.label}' is not active yet: the page may still need details from the user. Read the page to them.` };
  return { ok: true, button: pick };
}

export type ExtPayDeps = {
  bridge?: Bridge;
  gate?: UnlockGate;
  orderTimeoutMs?: number;
  pollMs?: number;
};

// The Open Claude in Chrome path has no extension-side lock_arm nonce and
// runs its checks in the page's main world, so it never pays. The yes is
// spent all the same.
export async function payNow(state: PayState): Promise<PayResult> {
  if (extMode()) return payNowExt(state);
  const claim = claimConfirmation(state);
  if (!claim.ok && claim.error === NO_CONFIRMATION) return claim;
  return { ok: false, error: NEEDS_EXTENSION };
}

export async function payNowExt(state: PayState, deps: ExtPayDeps = {}): Promise<PayResult> {
  const bridge = deps.bridge ?? extBridge;
  const gate = deps.gate ?? unlockGate;
  const pollMs = deps.pollMs ?? 400;

  const claim = claimConfirmation(state);
  if (!claim.ok) return claim;
  const c = claim.c;
  const tabId = c.tabId!;

  // The same tab, still on the site the user said yes on.
  const startHref = await tabUrlExt(bridge, tabId);
  if (!startHref || originOf(startHref) !== c.origin) return { ok: false, error: TAB_CHANGED };

  // The amount on the page must still be the one the user said yes to, and
  // the cart the one they heard.
  const text = await pageTextExt(bridge, tabId);
  const total = orderTotal(text);
  if (!total || !sameMoney(total, parseMoney(c.total))) {
    return { ok: false, error: `The page total is now ${total?.text || "unclear"}, but the user said yes to ${c.total}. Call request_checkout again.` };
  }
  if (c.cart && cartLines(text) !== c.cart) return { ok: false, error: CART_CHANGED };

  // A card number field the page shows must hold the card the user picked.
  const card = await cardStateExt(bridge, tabId);
  if (!card) return { ok: false, error: "Could not check the card field on the page. Nothing was pressed." };
  if (card.number && !card.number.filled) {
    return { ok: false, error: "The card number is empty. Call pick_card so the user can pick a card, then request_checkout again." };
  }

  let buttons: OrderButton[] = [];
  try {
    buttons = (await bridge.call<{ buttons?: OrderButton[] }>("order_buttons", { tabId }, 10_000))?.buttons || [];
  } catch {
    return { ok: false, error: "Could not read the page's order button. Nothing was pressed." };
  }
  const chosen = chooseOrderButton(buttons);
  if (!chosen.ok) return chosen;
  const button = chosen.button;

  // Button lock: the grant needs the yes, an allowed site and the matching
  // total (unlock.ts), then the extension's nonce for one press.
  const issued = gate.issue({ confirmation: { total: c.total, state: "confirmed" }, tabId, href: startHref, pageTotal: total.text });
  if (!issued.ok) return { ok: false, error: issued.error };

  const alertBefore = await alertOn(bridge, tabId);
  const placedBefore = PLACED.test(text);
  state.payBusy = true;
  try {
    try {
      await pressProtectedExt(bridge, issued.grant, { tabId, ref: button.ref }, gate);
    } catch {
      return { ok: false, error: `Could not press '${button.label}'. Do not try again; tell the user they can press it themselves.` };
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
      if (PLACED.test(now) && (moved || !placedBefore)) {
        const shown = /ending in\s*(\d{4})\b/i.exec(now)?.[1] || "";
        const receipt = { item: c.item, total: c.total, last4: shown };
        return { ok: true, last4: shown, receipt };
      }
      if (!moved) {
        const err = await alertOn(bridge, tabId);
        if (err && err !== alertBefore) return { ok: false, error: `The site did not take the payment: ${err.trim()}` };
      }
      await sleep(pollMs);
    }
    return {
      ok: false,
      error: moved
        ? `Clearcart pressed '${button.label}' once. The page moved on but does not say the order is placed; it may need another step. Read the page to the user. To place the order, call request_checkout again so they can say yes.`
        : `Clearcart pressed '${button.label}' once, but the page does not show the order as placed. Do not press it again; read the page to the user.`,
    };
  } finally {
    state.payBusy = false;
  }
}
