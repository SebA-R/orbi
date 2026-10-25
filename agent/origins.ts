// Which sites Orbi may drive, and the much smaller set where it may
// pay. Shared by the session guard, the tab sweep, pay_now and the button
// lock's unlock gate.
//
// CLEARCART_BROWSE_MODE:
//   open (default)  any http(s) site except the blocked sites
//                   (blocklist.ts: fixed rules such as localhost ports,
//                   plus the extension's list in ext mode or the suggested
//                   list otherwise) and CLEARCART_BLOCKED_ORIGINS.
//                   Best effort.
//   allowlist       only CLEARCART_ALLOWED_ORIGINS.
// Pay sites never follow the browse mode: CLEARCART_PAY_ORIGINS (default
// none) is the only place the unlock gate issues grants.
//
// These are read at import, so set them on the command line rather than in
// .env.

import { blocklistReason, SUGGESTED_ENTRIES, type BlockEntry } from "./blocklist.ts";

export function parseOrigins(list: string): string[] {
  return list
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return null;
      }
    })
    .filter((o): o is string => !!o && o !== "null");
}

// CLEARCART_ALLOWED_ORIGINS: comma-separated origins navigate and the tab
// sweep always accept, in both modes (default: none). In allowlist mode
// they are the only sites. Local addresses get through only when listed.
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(parseOrigins(process.env.CLEARCART_ALLOWED_ORIGINS || ""));
export const EXTRA_SITES = [...ALLOWED_ORIGINS];

export type BrowseMode = "open" | "allowlist";
export const BROWSE_MODE: BrowseMode = process.env.CLEARCART_BROWSE_MODE?.trim().toLowerCase() === "allowlist" ? "allowlist" : "open";

// CLEARCART_BLOCKED_ORIGINS: comma-separated origins never opened, in
// either mode (exact origins, so list www. and other hosts separately).
export const BLOCKED_ORIGINS: ReadonlySet<string> = new Set(parseOrigins(process.env.CLEARCART_BLOCKED_ORIGINS || ""));

// CLEARCART_PAY_ORIGINS: comma-separated origins where pay flows may get an
// unlock grant. Default: none.
export const PAY_ORIGINS: ReadonlySet<string> = new Set(parseOrigins(process.env.CLEARCART_PAY_ORIGINS || ""));

export type SitePolicy = {
  mode: BrowseMode;
  allowed: ReadonlySet<string>;
  blocked: ReadonlySet<string>;
  // The blocked sites list (blocklist.ts entries).
  entries: readonly BlockEntry[];
};

// Why `href` may not be browsed under `policy`, or null when it may.
// Allowlisted origins get past the localhost rule (a local test page opens
// that way), not past CLEARCART_BLOCKED_ORIGINS or the blocked sites list.
export function siteBlockReason(href: string | null | undefined, policy: SitePolicy): string | null {
  const o = originOf(href);
  const listed = !!o && policy.allowed.has(o);
  if (policy.mode === "allowlist") return listed ? null : "not on the allowlist";
  if (o && policy.blocked.has(o)) return "on the blocklist";
  return blocklistReason(href, policy.entries, policy.allowed);
}

export const SITE_POLICY: SitePolicy = { mode: BROWSE_MODE, allowed: ALLOWED_ORIGINS, blocked: BLOCKED_ORIGINS, entries: SUGGESTED_ENTRIES };

export function originOf(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const o = new URL(href).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

export function browseBlockReason(href: string | null | undefined): string | null {
  return siteBlockReason(href, SITE_POLICY);
}

export function allowedSite(href: string | null | undefined): boolean {
  return !browseBlockReason(href);
}

// The unlock gate's check. Independent of the browse mode.
export function paySite(href: string | null | undefined): boolean {
  const o = originOf(href);
  return !!o && PAY_ORIGINS.has(o);
}

// Checkout and payment pages by path. Used to keep Claude from navigating
// straight into checkout, and by the tab sweep on the URL a tab actually
// landed on. The path is percent-decoded
// (repeatedly, so %2563 is caught too) and split into segments; a segment
// matches with or without a file extension or ;params ("checkout.html",
// "pay.php", "checkout;jsessionid=1"). Amazon's /gp/buy/ is two segments.
const CHECKOUT_SEGMENT = /^(checkouts?|payments?|pay|billing|purchase|place-?order|one-?click|express-?checkout)$/i;

function decodedPath(pathname: string): string {
  let p = pathname;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(p);
    } catch {
      next = p.replace(/%([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    }
    if (next === p) break;
    p = next;
  }
  return p.replace(/\\/g, "/");
}

// Stripe's hosted test checkout, by host and path. Test mode only, so a
// live Stripe page is never treated as a checkout Orbi can pay on:
//   https://checkout.stripe.com/c/pay/cs_test_...   a Checkout Session
//   https://buy.stripe.com/test_...                  a test Payment Link
//   https://js.stripe.com/v3/embedded-checkout-inner.html?checkoutSessionId=cs_test_...
//                                                    the embedded checkout
//                                                    (checkout.stripe.dev's
//                                                    preview) opened as a page
// The card fields on these pages are in the page itself, not in iframes.
const STRIPE_CHECKOUT_HOSTS = new Set(["checkout.stripe.com", "buy.stripe.com", "js.stripe.com"]);

// A page on one of the hosts above, test mode or not.
export function onStripeCheckoutHost(href: string | null | undefined): boolean {
  try {
    return STRIPE_CHECKOUT_HOSTS.has(new URL(String(href)).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isStripeCheckoutUrl(href: string | null | undefined): boolean {
  if (!href) return false;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host === "checkout.stripe.com") return /^\/(c\/)?pay\/cs_test_[A-Za-z0-9]+\/?$/.test(u.pathname);
  if (host === "buy.stripe.com") return /^\/test_[A-Za-z0-9]+\/?$/.test(u.pathname);
  if (host === "js.stripe.com") {
    const ids = u.searchParams.getAll("checkoutSessionId");
    return u.pathname === "/v3/embedded-checkout-inner.html" && ids.length === 1 && /^cs_test_[A-Za-z0-9]+$/.test(ids[0]) &&
      !/(cs|pk)_live_/i.test(decodeURIComponent(u.search + u.hash).replace(/%/g, ""));
  }
  return false;
}

export function isCheckoutUrl(href: string | null | undefined): boolean {
  if (!href) return false;
  if (isStripeCheckoutUrl(href)) return true;
  let pathname: string;
  try {
    pathname = new URL(href).pathname;
  } catch {
    return false;
  }
  const segs = decodedPath(pathname)
    .split("/")
    .map((s) => s.split(";")[0].replace(/\.[a-z0-9]{1,5}$/i, "").trim())
    .filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    if (CHECKOUT_SEGMENT.test(segs[i])) return true;
    if (/^gp$/i.test(segs[i]) && /^buy$/i.test(segs[i + 1] || "")) return true;
  }
  return false;
}
