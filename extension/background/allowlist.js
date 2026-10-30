// Which sites agent-driven tabs may be on. Everything comes from user
// settings (chrome.storage.local, writable only by extension pages), so the
// agent server cannot widen it.
//
// browseMode "allowlist": only the allowlist origins (none by default).
// browseMode "open": any http(s) site except the fixed rules and the user's
// blocked sites (lib/blocklist.js). Allowlist origins get past the
// localhost rule (that is how a local test page opens), not past the
// user's blocked sites.
//
// The pay flow may arm its unlock on any page Orbi may use, and only
// after the user's spoken yes to the exact total (agent/unlock.ts, router.js
// lockArm). A frame inside that page gets card values (frameAllowed) only
// when it is the page's own origin, a payment provider's hosted fields or a
// site the user allowed: never an ad or other third-party frame. Providers
// such as js.stripe.com are on the suggested blocked list, so that list is
// not applied to them.

import { loadSettings, normalizeOrigin } from "../lib/settings.js";
import { blocklistReason, parseBlockLines } from "../lib/blocklist.js";
import { BridgeError, ERR } from "../lib/protocol.js";

export async function allowedOrigins() {
  const { allowlist } = await loadSettings();
  return [...allowlist];
}

// The blocked list parsed once per distinct list, not once per url checked
// (tabsContext checks every open tab).
let parsed = { key: null, entries: [] };
function blockEntries(lines) {
  if (!Array.isArray(lines)) return parseBlockLines(lines).entries;
  const key = lines.join("\n");
  if (parsed.key !== key) parsed = { key, entries: parseBlockLines(lines).entries };
  return parsed.entries;
}

// Pure policy: why `url` is not allowed under `settings`, or null.
export function blockReason(url, settings) {
  const origin = normalizeOrigin(url);
  const listed = !!origin && settings.allowlist.includes(origin);
  if (settings.browseMode !== "open") return listed ? null : "not on the allowlist";
  return blocklistReason(url, blockEntries(settings.blocklist), new Set(settings.allowlist));
}

export async function isAllowed(url) {
  return !blockReason(url, await loadSettings());
}

// Hosts (and their subdomains) that serve payment providers' hosted card
// fields. A provider missing here can be added as an allowed site.
export const PAYMENT_FRAME_HOSTS = Object.freeze([
  "stripe.com", "stripe.network", "adyen.com", "adyenpayments.com", "braintreegateway.com", "braintree-api.com",
  "paypal.com", "paypalobjects.com", "squareup.com", "squarecdn.com", "checkout.com", "shopifycs.com",
  "authorize.net", "cybersource.com", "worldpay.com", "recurly.com", "spreedly.com", "paymentech.com",
  "chasepaymentech.com", "mollie.com", "bluesnap.com", "nmi.com", "moneris.com", "razorpay.com",
  "mercadopago.com", "verygoodvault.com", "basistheory.com", "evervault.com", "paysafe.com", "globalpay.com",
  "heartlandportico.com", "convergepay.com", "2checkout.com", "payu.com", "pci-proxy.com", "clover.com",
  "payeezy.com", "bolt.com", "dlocal.com", "rapyd.net",
]);

export function isPaymentFrameHost(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return u.protocol === "https:" && PAYMENT_FRAME_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

// A frame inside the checkout page (topOrigin) that saved-card fill may put
// values in: the page's own origin, a payment provider's hosted fields, or
// a site the user allowed. Always a web page with no login in its address,
// and never a local address the user did not allow.
export async function frameAllowed(url, topOrigin) {
  const settings = await loadSettings();
  if (blocklistReason(url, [], new Set(settings.allowlist))) return false;
  const origin = normalizeOrigin(url);
  if (!origin) return false;
  if (topOrigin && origin === topOrigin) return true;
  if (settings.allowlist.includes(origin)) return true;
  return isPaymentFrameHost(url);
}

// The url's origin, or null for an invalid url or one with no origin
// (data:, about:, file:).
export function originOf(url) {
  try {
    const o = new URL(String(url)).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

// Throws BridgeError(ERR.NOT_ALLOWED) unless the settings allow this url.
export async function assertAllowed(url) {
  const settings = await loadSettings();
  const why = blockReason(url, settings);
  if (!why) return;
  let shown = "invalid url";
  try {
    shown = new URL(String(url)).origin;
  } catch {}
  if (shown === "null") shown = String(url).split(":")[0] + ":";
  throw new BridgeError(ERR.NOT_ALLOWED, settings.browseMode === "open" ? `site blocked (${why}): ${shown}` : `origin not allowlisted: ${shown}`);
}
