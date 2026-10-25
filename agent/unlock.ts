// The button lock's unlock: the only way a protected control (place order,
// pay, checkout...) gets pressed by Clearcart instead of the user.
//
// Claude has no tool that reaches this module. A pay flow asks the gate for
// a grant; the gate issues one only when all of these hold:
//   - the user said an explicit yes to request_checkout's read-back
//     (confirmation.state === "confirmed"),
//   - the tab's page is on an allowlisted origin (CLEARCART_ALLOWED_ORIGINS
//     plus the store; the gate itself is not tied to the demo store),
//   - the total on the page matches the total the user said yes to.
// A grant is a random token bound to that tab and origin, good for one press
// within GRANT_TTL_MS. On the extension path, pressing also needs a
// single-use nonce from the extension (lock_arm) and the extension checks
// the target is an order button (press_protected), so the model cannot
// unlock anything by any tool call.
//
// Today only pay_now's demo store flow asks for grants, because it is the
// only flow that knows how to fill a checkout form. A later generic pay flow
// for real sites calls issue() and pressProtectedExt() the same way.

import { randomBytes } from "node:crypto";

import { allowedSite, originOf } from "./origins.ts";
import type { ExtBridge } from "./extbridge.ts";

export const GRANT_TTL_MS = 60_000;

export type UnlockConfirmation = { total: string; state: string };

export type UnlockRequest = {
  confirmation: UnlockConfirmation | null;
  tabId: number;
  href: string | null;
  pageTotal: string;
};

export type Grant = { token: string };

type Live = { tabId: number; origin: string; expires: number };

export function money(s: string): number {
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && String(s).match(/\d/) ? n : NaN;
}

export class UnlockGate {
  private live = new Map<string, Live>();
  private isAllowed: (href: string | null) => boolean;
  private now: () => number;
  private ttlMs: number;

  constructor(opts: { isAllowed?: (href: string | null) => boolean; now?: () => number; ttlMs?: number } = {}) {
    this.isAllowed = opts.isAllowed ?? allowedSite;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? GRANT_TTL_MS;
  }

  issue(req: UnlockRequest): { ok: true; grant: Grant } | { ok: false; error: string } {
    if (!req.confirmation || req.confirmation.state !== "confirmed") {
      return { ok: false, error: "No confirmed checkout. Call request_checkout and get an explicit yes first." };
    }
    const origin = originOf(req.href);
    if (!origin || !this.isAllowed(req.href)) {
      return { ok: false, error: "This site is not on Clearcart's allowlist, so its order button stays locked." };
    }
    const page = money(req.pageTotal);
    if (!Number.isFinite(page) || Math.abs(page - money(req.confirmation.total)) > 0.005) {
      return { ok: false, error: `The page total ${req.pageTotal || "is unknown and"} does not match the ${req.confirmation.total} the user said yes to.` };
    }
    for (const [t, l] of this.live) if (l.expires <= this.now()) this.live.delete(t);
    const token = randomBytes(16).toString("hex");
    this.live.set(token, { tabId: req.tabId, origin, expires: this.now() + this.ttlMs });
    return { ok: true, grant: { token } };
  }

  // Spends the grant. True only once, for the same tab, on the same origin,
  // before it expires.
  consume(grant: Grant | null | undefined, at: { tabId: number; href: string | null }): boolean {
    const l = grant && this.live.get(grant.token);
    if (!grant || !l) return false;
    this.live.delete(grant.token);
    return l.tabId === at.tabId && l.origin === originOf(at.href) && l.expires > this.now();
  }
}

export const unlockGate = new UnlockGate();

export class LockedError extends Error {
  code = "locked";
}

type Bridge = Pick<ExtBridge, "call">;

// Presses one protected order button over the extension: spend the grant
// here, then lock_arm (the extension's nonce for this tab and origin) and
// press_protected (the extension re-checks the target is an order button
// and not covered, then clicks it).
export async function pressProtectedExt(
  bridge: Bridge,
  grant: Grant,
  target: { tabId: number; ref: string },
  gate: UnlockGate = unlockGate
): Promise<{ via?: string }> {
  let href: string | null = null;
  try {
    href = (await bridge.call<{ url?: string }>("tab_info", { tabId: target.tabId }, 10_000))?.url ?? null;
  } catch {}
  if (!gate.consume(grant, { tabId: target.tabId, href })) throw new LockedError("the unlock is missing, used, expired or for another page");
  const armed = await bridge.call<{ nonce?: string }>("lock_arm", { tabId: target.tabId }, 10_000);
  if (!armed || typeof armed.nonce !== "string") throw new LockedError("the extension did not arm the unlock");
  return (await bridge.call<{ via?: string }>("press_protected", { tabId: target.tabId, ref: target.ref, nonce: armed.nonce }, 15_000)) || {};
}
