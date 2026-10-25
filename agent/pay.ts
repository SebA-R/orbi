// pay_now: our code, not Claude, fills the card and places the order.
//
// The card is read from the vault and written into the checkout inputs with a
// javascript_tool call over our own bridge client (bridge.ts). Claude only
// ever sees { ok, last4 } or an error string. While the inputs hold card
// values the session's guard flag is up, and the PreToolUse hook in session.ts
// blocks every page-reading browser tool.

import { callBrowserTool, evalInTab, resultText } from "./bridge.ts";
import { getCard, last4 } from "../vault/index.ts";

export const STORE_ORIGIN = "http://localhost:4000";
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
      const mode = cfg?.effectiveForTab?.audit_mode ?? cfg?.default?.audit_mode;
      if (mode && mode !== "off") {
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
