// pay_now: our code, not Claude, fills the card and places the order.
//
// The card is read from the vault and written into the checkout inputs with a
// javascript_tool call over our own bridge client (bridge.ts). Claude only
// ever sees { ok, last4 } or an error string. While the inputs hold card
// values the session's guard flag is up, and the PreToolUse hook in session.ts
// blocks every page-reading browser tool.

import { callBrowserTool, evalInTab, resultText } from "./bridge.ts";
import { getCard, last4, type Card } from "../vault/index.ts";
import { extBridge, extMode, type ExtBridge } from "./extbridge.ts";
import { clickRef } from "./exttools.ts";

// CLEARCART_STORE_ORIGIN moves the demo store (tests run one on a spare port).
// Read at import, so set it on the command line rather than in .env.
export const STORE_ORIGIN = new URL(process.env.CLEARCART_STORE_ORIGIN || "http://localhost:4000").origin;
const CHECKOUT_PREFIX = `${STORE_ORIGIN}/checkout`;

// Parsed comparison, so tricks like http://localhost:4000@evil.example/ fail.
export function onStore(href: string | null | undefined, pathPrefix = "/"): boolean {
  if (!href) return false;
  try {
    const u = new URL(href);
    return u.origin === STORE_ORIGIN && u.pathname.startsWith(pathPrefix);
  } catch {
    return false;
  }
}
const DEFAULT_ADDRESS = process.env.CLEARCART_SHIP_ADDRESS || "2150 Shattuck Ave, Berkeley, CA 94704";

export type Confirmation = { item: string; quantity: number; total: string; state: "pending" | "confirmed" | "declined" | "used" };

export type PayState = {
  lastTabId: number | null;
  confirmation: Confirmation | null;
  cardFieldsLive: boolean;
};

export type Receipt = { item: string; total: string; last4: string };

export type PayResult = { ok: true; last4: string; receipt: Receipt } | { ok: false; error: string };

// argSummary() in the extension's debug log keeps the first 60 characters of
// each string argument. This prefix pushes everything secret past that cut.
const PAD = "/* clearcart vault fill: values below are never logged or returned to the model */\n";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function money(s: string): number {
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

async function tabHref(tabId: number): Promise<string | null> {
  try {
    const href = await evalInTab<string>(tabId, "location.href");
    return typeof href === "string" ? href : null;
  } catch {
    return null;
  }
}

async function findCheckoutTab(preferred: number | null): Promise<number | null> {
  if (preferred != null) {
    const href = await tabHref(preferred);
    if (onStore(href, "/checkout")) return preferred;
  }
  // Fall back to the MCP tab group: tabs_context_mcp starts with a JSON line.
  try {
    const text = resultText(await callBrowserTool("tabs_context_mcp", {}));
    const first = text.split("\n")[0];
    const tabs: Array<{ tabId?: number; id?: number; url?: string }> = JSON.parse(first).availableTabs || [];
    const hits = tabs.filter((t) => onStore(t.url, "/checkout"));
    if (hits.length === 1) return (hits[0].tabId ?? hits[0].id) as number;
  } catch {}
  return null;
}

const CLEAR_FIELDS = `(() => {
  for (const n of ["cc-name", "cc-number", "cc-exp", "cc-csc"]) {
    const el = document.querySelector('[name="' + n + '"]');
    if (el) { el.value = ""; el.removeAttribute("value"); }
  }
  return true;
})()`;

export async function payNow(state: PayState): Promise<PayResult> {
  if (extMode()) return payNowExt(state);
  const c = state.confirmation;
  if (!c || c.state !== "confirmed") {
    return { ok: false, error: "No confirmed checkout. Call request_checkout and get an explicit yes first." };
  }

  const tabId = await findCheckoutTab(state.lastTabId);
  if (tabId == null) {
    return { ok: false, error: `The current tab is not the checkout page. Navigate to ${CHECKOUT_PREFIX} first.` };
  }

  // The amount on the page must match what the user said yes to.
  let pageTotal = "";
  try {
    pageTotal = String(await evalInTab<string>(tabId, `(document.getElementById("order-total")||{}).textContent||""`));
  } catch {}
  if (Math.abs(money(pageTotal) - money(c.total)) > 0.005) {
    c.state = "used";
    return {
      ok: false,
      error: `The checkout total is ${pageTotal || "unknown"}, but the user confirmed ${c.total}. Call request_checkout again with the page total.`,
    };
  }

  // The extension's "audit" mode records each tab's DOM with rrweb, inputs
  // unmasked, to ~/.config/open-claude-in-chrome/audits. Card values would land
  // on disk, so refuse rather than fill.
  if (!process.env.CLEARCART_ALLOW_AUDIT) {
    try {
      const cfg = JSON.parse(resultText(await callBrowserTool("get_config", { tabId })));
      const mode = cfg?.effectiveForTab?.config?.audit_mode ?? cfg?.default?.audit_mode;
      // Extensions that mask payment fields in recordings say so; older ones don't.
      if (mode && mode !== "off" && cfg?.auditMasksPayment !== true) {
        return {
          ok: false,
          error: "Payment is paused because the browser extension's audit recording is on, and it would record the card. Ask the user to turn audit mode off in the Open Claude in Chrome options.",
        };
      }
    } catch {}
  }

  let card;
  try {
    card = await getCard();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const four = last4(card.number);
  c.state = "used";

  const values = JSON.stringify({ name: card.name, number: card.number, exp: card.exp, csc: card.csc, address: DEFAULT_ADDRESS });
  const fill =
    PAD +
    `(() => {
  const v = ${values};
  const set = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  const addr = document.querySelector('[name="address"]');
  if (addr && !addr.value.trim()) set('[name="address"]', v.address);
  const ok = set('[name="cc-name"]', v.name) && set('[name="cc-number"]', v.number) &&
    set('[name="cc-exp"]', v.exp) && set('[name="cc-csc"]', v.csc);
  const btn = document.getElementById("place-order");
  if (!ok || !btn) return "missing";
  setTimeout(() => btn.click(), 50);
  return "submitted";
})()`;

  state.cardFieldsLive = true;
  try {
    let status: string;
    try {
      status = String(await evalInTab<string>(tabId, fill));
    } catch {
      status = "failed";
    }
    if (status !== "submitted") {
      return { ok: false, error: "Could not find the checkout fields on the page." };
    }

    // Wait for the order page (or the checkout page re-rendered with an error).
    const deadline = Date.now() + 20_000;
    await sleep(600);
    while (Date.now() < deadline) {
      const href = await tabHref(tabId);
      if (onStore(href, "/order/")) {
        const r = await evalInTab<{ items: string; total: string; last4: string; ready: boolean }>(
          tabId,
          `(() => {
  const t = (id) => (document.getElementById(id) || {}).textContent || "";
  const items = Array.from(document.querySelectorAll("#order-items li")).map((li) => li.textContent.trim()).join("; ");
  return { items, total: t("order-total").trim(), last4: t("card-last4").trim(), ready: !!document.getElementById("order-total") };
})()`
        ).catch(() => null);
        if (r && r.ready) {
          state.cardFieldsLive = false;
          const receipt = { item: r.items || c.item, total: r.total || c.total, last4: r.last4 || four };
          return { ok: true, last4: receipt.last4, receipt };
        }
      } else if (onStore(href, "/checkout")) {
        const err = await evalInTab<string>(
          tabId,
          `document.readyState === "complete" ? ((document.getElementById("checkout-error") || {}).textContent || "") : ""`
        ).catch(() => "");
        if (err) {
          return { ok: false, error: `The store rejected the payment: ${String(err).trim()}` };
        }
      }
      await sleep(400);
    }
    return { ok: false, error: "The order page did not load in time. Check the page before trying again." };
  } finally {
    if (state.cardFieldsLive) {
      // Not on the order page: wipe whatever card values are still in the form.
      const cleared = await evalInTab(tabId, CLEAR_FIELDS).then(() => true, () => false);
      if (cleared) state.cardFieldsLive = false;
    }
  }
}

// ---------------------------------------------------------------------------
// CLEARCART_BROWSER=ext: the same pay_now over the Clearcart extension.
//
// The card goes to the page in one fill_payment call over our own bridge
// socket; the extension sets the fields by autocomplete kind and answers
// { ok, last4 } without echoing anything. Our code then clicks #place-order
// (find + rect + CDP click, or a DOM click_ref) and waits for /order/:id.
// Errors from fill_payment are reduced to their code so nothing the page or
// extension says about the card can reach Claude.

export type ExtPayDeps = {
  bridge?: Pick<ExtBridge, "call">;
  getCard?: () => Promise<Card>;
  orderTimeoutMs?: number;
  pollMs?: number;
};

const CARD_KINDS = ["cc-name", "cc-number", "cc-exp", "cc-csc"];

function pageMoney(text: string, label: RegExp): string {
  const m = label.exec(text);
  return m ? `$${m[1]}` : "";
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
  if (preferred != null && onStore(await extTabUrl(bridge, preferred), "/checkout")) return preferred;
  try {
    const ctx = await bridge.call<{ tabs?: Array<{ tabId: number; url?: string }> }>("tabs_context", {}, 10_000);
    const hits = (ctx?.tabs || []).filter((t) => onStore(t.url, "/checkout"));
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

async function clickPlaceOrder(bridge: Pick<ExtBridge, "call">, tabId: number): Promise<void> {
  const r = await bridge.call<{ matches?: Array<{ ref: string; role?: string; name?: string }> }>("find", { tabId, query: "Place order", limit: 10 });
  const matches = (r?.matches || []).filter((m) => /place order/i.test(m.name || ""));
  const btn = matches.find((m) => m.role === "button") || matches[0];
  if (!btn) throw new Error("no place-order button");
  await clickRef(bridge, btn.ref, tabId);
}

export async function payNowExt(state: PayState, deps: ExtPayDeps = {}): Promise<PayResult> {
  const bridge = deps.bridge ?? extBridge;
  const readCard = deps.getCard ?? getCard;
  const pollMs = deps.pollMs ?? 400;

  const c = state.confirmation;
  if (!c || c.state !== "confirmed") {
    return { ok: false, error: "No confirmed checkout. Call request_checkout and get an explicit yes first." };
  }

  const tabId = await findCheckoutTabExt(bridge, state.lastTabId);
  if (tabId == null) {
    return { ok: false, error: `The current tab is not the checkout page. Navigate to ${CHECKOUT_PREFIX} first.` };
  }

  // The amount on the page must match what the user said yes to.
  const pageTotal = pageMoney(await pageText(bridge, tabId), /Order total\s*:?\s*\$?\s*([0-9][0-9,]*\.[0-9]{2})/i);
  if (Math.abs(money(pageTotal) - money(c.total)) > 0.005) {
    c.state = "used";
    return {
      ok: false,
      error: `The checkout total is ${pageTotal || "unknown"}, but the user confirmed ${c.total}. Call request_checkout again with the page total.`,
    };
  }

  let fields: Array<{ kind?: string; filled?: boolean }> = [];
  try {
    fields = (await bridge.call<{ fields?: typeof fields }>("read_fields", { tabId }, 10_000))?.fields || [];
  } catch {}
  const kinds = new Set(fields.map((f) => f.kind));
  if (!CARD_KINDS.every((k) => kinds.has(k))) {
    return { ok: false, error: "Could not find the checkout fields on the page." };
  }
  // Like the default path: only fill the address when it is empty.
  const addressFilled = fields.some((f) => f.kind === "address" && f.filled);

  let card: Card;
  try {
    card = await readCard();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const four = last4(card.number);
  c.state = "used";

  state.cardFieldsLive = true;
  try {
    let filled: { ok?: boolean; last4?: string } | null = null;
    try {
      filled = await bridge.call("fill_payment", {
        tabId,
        card: { name: card.name, number: card.number, exp: card.exp, csc: card.csc },
        ...(addressFilled ? {} : { address: DEFAULT_ADDRESS }),
      });
    } catch (e) {
      const code = (e as { code?: string }).code || "error";
      return { ok: false, error: `Could not fill the checkout fields (${code}).` };
    }
    if (!filled || filled.ok !== true) {
      return { ok: false, error: "Could not fill the checkout fields on the page." };
    }

    try {
      await clickPlaceOrder(bridge, tabId);
    } catch {
      return { ok: false, error: "Could not press Place order on the checkout page." };
    }

    const deadline = Date.now() + (deps.orderTimeoutMs ?? 20_000);
    await sleep(Math.min(600, pollMs));
    while (Date.now() < deadline) {
      const href = await extTabUrl(bridge, tabId);
      if (onStore(href, "/order/")) {
        state.cardFieldsLive = false;
        const text = await pageText(bridge, tabId);
        const total = pageMoney(text, /Total charged\s*:?\s*\$?\s*([0-9][0-9,]*\.[0-9]{2})/i) || c.total;
        const shown = /ending in\s*(\d{4})/i.exec(text)?.[1];
        const receipt = { item: c.item, total, last4: shown || filled.last4 || four };
        return { ok: true, last4: receipt.last4, receipt };
      } else if (onStore(href, "/checkout")) {
        // A rejected payment re-renders checkout with a role="alert" banner.
        try {
          const page = await bridge.call<{ tree?: string }>("read_page", { tabId, filter: "all", maxNodes: 400 }, 10_000);
          const err = /^\s*-\s*alert\s+"([^"]+)"/m.exec(String(page?.tree || ""))?.[1];
          if (err) return { ok: false, error: `The store rejected the payment: ${err.trim()}` };
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
