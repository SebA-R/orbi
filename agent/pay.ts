// pay_now: our code, not Claude, fills the card and places the order, on a
// pay site (CLEARCART_PAY_ORIGINS, none by default) and only over the
// Clearcart extension (CLEARCART_BROWSER=ext).
//
// The card is read from the vault and written into the checkout inputs with
// one fill_payment call over our own bridge socket. Claude only ever sees
// { ok, last4 } or an error string. While the inputs hold card values the
// session's guard flag is up, and the PreToolUse hook in session.ts blocks
// every page-reading browser tool.

import { getCard, last4, type Card } from "../vault/index.ts";
import { extBridge, extMode, type ExtBridge } from "./extbridge.ts";
import { isCheckoutUrl, paySite } from "./origins.ts";
import { pressProtectedExt, unlockGate, type Grant, type UnlockGate } from "./unlock.ts";

// A checkout page on a pay site. Parsed, so tricks like
// https://pay.example@evil.example/ fail.
export function onPayCheckout(href: string | null | undefined): boolean {
  return paySite(href) && isCheckoutUrl(href);
}

// An order confirmation page on a pay site (/order/<id>, /orders/<id>).
export function onPayOrder(href: string | null | undefined): boolean {
  if (!paySite(href)) return false;
  try {
    return /\/orders?\/[^/]/i.test(new URL(String(href)).pathname);
  } catch {
    return false;
  }
}

// What the user said yes to. confirmedAt, tabId and cart pin the yes to a
// moment, a tab and a cart: pay_now refuses a yes older than
// CONFIRM_TTL_MS, on another tab, or for a cart that has changed since.
export type Confirmation = {
  item: string;
  quantity: number;
  total: string;
  state: "pending" | "confirmed" | "declined" | "used";
  confirmedAt?: number;
  tabId?: number | null;
  cart?: string;
};

export const CONFIRM_TTL_MS = 60_000;

const NO_CONFIRMATION = "No confirmed checkout. Call request_checkout and get an explicit yes first.";

// The priced lines of a checkout page's text (line items, subtotal,
// add-ons, tax, total), whitespace squashed: the cart the user heard.
export function cartLines(text: string): string {
  return String(text || "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => /[$\u00a3\u20ac]\s?\d/.test(l))
    .join("\n");
}

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
  if (typeof c.tabId !== "number") {
    return { ok: false, error: "No checkout tab was open when the user said yes. Open the checkout page and call request_checkout again." };
  }
  return { ok: true, c };
}

// The yes the unlock gate checks, for a claimed confirmation.
function claimedYes(c: Confirmation) {
  return { total: c.total, state: "confirmed" };
}

const TAB_CHANGED = "The checkout tab is not the one the user said yes on. Call request_checkout again.";
const CART_CHANGED = "The cart changed since the user said yes. Call request_checkout again with the page as it is now.";

// The checkout tab and its priced lines, for request_checkout to pin the
// yes to. Either may be null or "" when there is no checkout tab (always on
// the Open Claude in Chrome path, where pay_now does not run).
export async function checkoutSnapshot(preferred: number | null): Promise<{ tabId: number | null; cart: string }> {
  if (!extMode()) return { tabId: null, cart: "" };
  try {
    const tabId = await findCheckoutTabExt(extBridge, preferred);
    return { tabId, cart: tabId == null ? "" : cartLines(await pageText(extBridge, tabId)) };
  } catch {
    return { tabId: null, cart: "" };
  }
}

export type PayState = {
  lastTabId: number | null;
  confirmation: Confirmation | null;
  cardFieldsLive: boolean;
};

export type Receipt = { item: string; total: string; last4: string };

export type PayResult = { ok: true; last4: string; receipt: Receipt } | { ok: false; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function money(s: string): number {
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

// The Open Claude in Chrome path has no extension-side lock_arm nonce and
// runs its checks in the page's main world, so it never pays. The yes is
// spent all the same.
export async function payNow(state: PayState): Promise<PayResult> {
  if (extMode()) return payNowExt(state);
  const claim = claimConfirmation(state);
  if (!claim.ok) return claim;
  return { ok: false, error: "Paying needs the Clearcart extension. Tell the user they can finish checkout on the page themselves." };
}

// ---------------------------------------------------------------------------
// pay_now over the Clearcart extension (CLEARCART_BROWSER=ext).
//
// The card goes to the page in one fill_payment call over our own bridge
// socket; the extension sets the fields by autocomplete kind and answers
// { ok, last4 } without echoing anything. Our code then presses Place order
// (find, then press_protected with the unlock) and waits for an order page.
// Errors from fill_payment are reduced to their code so nothing the page or
// extension says about the card can reach Claude.

export type ExtPayDeps = {
  bridge?: Pick<ExtBridge, "call">;
  gate?: UnlockGate;
  getCard?: () => Promise<Card>;
  orderTimeoutMs?: number;
  pollMs?: number;
};

const CARD_KINDS = ["cc-name", "cc-number", "cc-exp", "cc-csc"];

function pageMoney(text: string, label: RegExp): string {
  const m = label.exec(text);
  return m ? `$${m[1]}` : "";
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

async function extTabUrl(bridge: Pick<ExtBridge, "call">, tabId: number): Promise<string | null> {
  try {
    const info = await bridge.call<{ url?: string }>("tab_info", { tabId }, 10_000);
    return typeof info?.url === "string" ? info.url : null;
  } catch {
    return null;
  }
}

async function findCheckoutTabExt(bridge: Pick<ExtBridge, "call">, preferred: number | null): Promise<number | null> {
  if (preferred != null && onPayCheckout(await extTabUrl(bridge, preferred))) return preferred;
  try {
    const ctx = await bridge.call<{ tabs?: Array<{ tabId: number; url?: string }> }>("tabs_context", {}, 10_000);
    const hits = (ctx?.tabs || []).filter((t) => onPayCheckout(t.url));
    if (hits.length === 1) return hits[0].tabId;
  } catch {}
  return null;
}

async function pageText(bridge: Pick<ExtBridge, "call">, tabId: number): Promise<string> {
  try {
    const r = await bridge.call<{ text?: string }>("get_page_text", { tabId, maxChars: 20_000 }, 15_000);
    return String(r?.text || "");
  } catch {
    return "";
  }
}

// True only when the page answers and none of its card fields holds a
// value.
async function formEmpty(bridge: Pick<ExtBridge, "call">, tabId: number): Promise<boolean> {
  try {
    const fields = (await bridge.call<{ fields?: Array<{ kind?: string; filled?: boolean }> }>("read_fields", { tabId }, 10_000))?.fields;
    return Array.isArray(fields) && !fields.some((f) => String(f.kind || "").startsWith("cc-") && f.filled);
  } catch {
    return false;
  }
}

// Place order is locked for every agent tool; only the grant plus the
// extension's lock_arm nonce gets one press through press_protected.
async function clickPlaceOrder(bridge: Pick<ExtBridge, "call">, tabId: number, grant: Grant, gate: UnlockGate): Promise<void> {
  const r = await bridge.call<{ matches?: Array<{ ref: string; role?: string; name?: string }> }>("find", { tabId, query: "Place order", limit: 10 });
  const matches = (r?.matches || []).filter((m) => /place order/i.test(m.name || ""));
  const btn = matches.find((m) => m.role === "button") || matches[0];
  if (!btn) throw new Error("no place-order button");
  await pressProtectedExt(bridge, grant, { tabId, ref: btn.ref }, gate);
}

export async function payNowExt(state: PayState, deps: ExtPayDeps = {}): Promise<PayResult> {
  const bridge = deps.bridge ?? extBridge;
  const gate = deps.gate ?? unlockGate;
  const readCard = deps.getCard ?? getCard;
  const pollMs = deps.pollMs ?? 400;

  const claim = claimConfirmation(state);
  if (!claim.ok) return claim;
  const c = claim.c;

  const tabId = await findCheckoutTabExt(bridge, c.tabId!);
  if (tabId == null) {
    return { ok: false, error: "The current tab is not the checkout page of a pay site. Open the checkout page first." };
  }
  if (tabId !== c.tabId) return { ok: false, error: TAB_CHANGED };

  // The amount on the page must match what the user said yes to.
  const checkoutText = await pageText(bridge, tabId);
  const pageTotal = pageMoney(checkoutText, /Order total\s*:?\s*\$?\s*([0-9][0-9,]*\.[0-9]{2})/i);
  if (Math.abs(money(pageTotal) - money(c.total)) > 0.005) {
    return {
      ok: false,
      error: `The checkout total is ${pageTotal || "unknown"}, but the user confirmed ${c.total}. Call request_checkout again with the page total.`,
    };
  }

  if (c.cart && cartLines(checkoutText) !== c.cart) return { ok: false, error: CART_CHANGED };

  let fields: Array<{ kind?: string; filled?: boolean }> = [];
  try {
    fields = (await bridge.call<{ fields?: typeof fields }>("read_fields", { tabId }, 10_000))?.fields || [];
  } catch {}
  const kinds = new Set(fields.map((f) => f.kind));
  if (!CARD_KINDS.every((k) => kinds.has(k))) {
    return { ok: false, error: "Could not find the checkout fields on the page." };
  }

  // Button lock: issue the grant while the yes is fresh (see unlock.ts).
  // startHref: where the press happens, so only a move to another page
  // counts as the order page.
  const startHref = await extTabUrl(bridge, tabId);
  const issued = gate.issue({ confirmation: claimedYes(c), tabId, href: startHref, pageTotal });
  if (!issued.ok) return { ok: false, error: issued.error };

  let card: Card;
  try {
    card = await readCard();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const four = last4(card.number);

  state.cardFieldsLive = true;
  try {
    let filled: { ok?: boolean; last4?: string } | null = null;
    try {
      filled = await bridge.call("fill_payment", {
        tabId,
        card: { name: card.name, number: card.number, exp: card.exp, csc: card.csc },
      });
    } catch (e) {
      const code = (e as { code?: string }).code || "error";
      return { ok: false, error: `Could not fill the checkout fields (${code}).` };
    }
    if (!filled || filled.ok !== true) {
      return { ok: false, error: "Could not fill the checkout fields on the page." };
    }

    try {
      await clickPlaceOrder(bridge, tabId, issued.grant, gate);
    } catch {
      return { ok: false, error: "Could not press Place order on the checkout page." };
    }

    const deadline = Date.now() + (deps.orderTimeoutMs ?? 20_000);
    await sleep(Math.min(600, pollMs));
    while (Date.now() < deadline) {
      const href = await extTabUrl(bridge, tabId);
      // The order page: a different address, an order path, and not a
      // checkout page ("/order/checkout" is still checkout).
      if (href && href !== startHref && onPayOrder(href) && !onPayCheckout(href)) {
        // The guard stays up (and finally clears the form) unless the page
        // shows no filled card field any more.
        state.cardFieldsLive = !(await formEmpty(bridge, tabId));
        const text = await pageText(bridge, tabId);
        const total = pageMoney(text, /Total charged\s*:?\s*\$?\s*([0-9][0-9,]*\.[0-9]{2})/i) || c.total;
        const shown = /ending in\s*(\d{4})/i.exec(text)?.[1];
        const receipt = { item: c.item, total, last4: shown || filled.last4 || four };
        return { ok: true, last4: receipt.last4, receipt };
      } else if (onPayCheckout(href)) {
        // A rejected payment re-renders checkout with a role="alert" banner.
        try {
          const page = await bridge.call<{ tree?: string }>("read_page", { tabId, filter: "all", maxNodes: 400 }, 10_000);
          const err = alertText(String(page?.tree || ""));
          if (err) return { ok: false, error: `The site rejected the payment: ${err.trim()}` };
        } catch {}
      }
      await sleep(pollMs);
    }
    return { ok: false, error: "The order page did not load in time. Check the page before trying again." };
  } finally {
    if (state.cardFieldsLive) {
      // Not on the order page: wipe whatever card values are still in the form.
      const cleared = await bridge.call("clear_payment", { tabId }, 10_000).then(() => true, () => false);
      if (cleared) state.cardFieldsLive = false;
    }
  }
}
