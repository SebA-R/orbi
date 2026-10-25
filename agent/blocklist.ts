// Open web browsing: sites Clearcart never opens, even when browseMode is
// "open". Best effort. It catches the common sensitive sites (email,
// password managers, banks and brokerages, government and tax, health
// portals, big account settings pages) and anything that is not a normal
// web page; it is not a complete list. The button lock and the Clearcart
// tab group still apply on every site this lets through.
//
// This is the agent server's copy; the extension's is
// extension/lib/blocklist.js. test/blocklist.test.ts checks they match.

// Matched as the hostname itself or any subdomain of it.
export const BLOCKED_DOMAINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  email: [
    "gmail.com", "mail.google.com", "inbox.google.com", "outlook.com", "outlook.live.com", "outlook.office.com",
    "outlook.office365.com", "hotmail.com", "live.com", "mail.yahoo.com", "proton.me", "protonmail.com",
    "mail.aol.com", "icloud.com", "fastmail.com", "zoho.com", "tutanota.com", "tuta.com", "gmx.com", "mail.com",
  ],
  passwords: [
    "bitwarden.com", "bitwarden.eu", "1password.com", "1password.ca", "1password.eu", "lastpass.com",
    "dashlane.com", "keepersecurity.com", "nordpass.com", "roboform.com", "passwords.google.com",
  ],
  money: [
    // US banks, cards and payments
    "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com", "usbank.com", "pnc.com",
    "capitalone.com", "tdbank.com", "truist.com", "ally.com", "discover.com", "americanexpress.com",
    "synchrony.com", "mysynchrony.com", "marcus.com", "goldmansachs.com", "usaa.com", "navyfederal.org",
    "penfed.org", "regions.com", "key.com", "huntington.com", "citizensbank.com", "fifththird.com", "53.com",
    "mtb.com", "santanderbank.com", "bmoharris.com", "sofi.com", "chime.com", "varo.com", "paypal.com",
    "venmo.com", "cash.app", "zellepay.com", "wise.com", "stripe.com", "pay.google.com", "payments.google.com",
    // US brokerages
    "schwab.com", "fidelity.com", "vanguard.com", "etrade.com", "robinhood.com", "merrilledge.com", "ml.com",
    "morganstanley.com", "interactivebrokers.com", "webull.com", "tastytrade.com", "betterment.com",
    "wealthfront.com", "empower.com", "troweprice.com",
    // Canadian banks and brokerages
    "rbc.com", "rbcroyalbank.com", "td.com", "tdcanadatrust.com", "scotiabank.com", "bmo.com", "cibc.com",
    "desjardins.com", "nbc.ca", "bnc.ca", "tangerine.ca", "simplii.com", "eqbank.ca", "koho.ca", "atb.com",
    "pcfinancial.ca", "questrade.com", "wealthsimple.com", "qtrade.ca", "hsbc.ca", "meridiancu.ca",
    // Crypto exchanges
    "coinbase.com", "kraken.com", "binance.com", "binance.us", "gemini.com", "crypto.com", "bitstamp.net",
    "okx.com", "bybit.com", "kucoin.com", "blockchain.com", "metamask.io", "shakepay.com", "newton.co",
  ],
  government: [
    "canada.ca", "gc.ca", "irs.gov", "ssa.gov", "login.gov", "id.me", "ontario.ca", "quebec.ca",
    "turbotax.com", "turbotax.intuit.com", "intuit.com", "hrblock.com", "taxact.com", "freetaxusa.com",
    "ufile.ca", "wealthsimple.tax",
  ],
  health: [
    "mychart.com", "mychart.org", "followmyhealth.com", "athenahealth.com", "kp.org", "myuhc.com", "uhc.com",
    "anthem.com", "aetna.com", "cigna.com", "bcbs.com", "humana.com", "onemedical.com", "teladoc.com",
    "zocdoc.com", "healthequity.com", "sunlife.ca", "manulife.ca", "canadalife.com", "greatwestlife.com",
    "medicare.gov", "healthcare.gov", "labcorp.com", "questdiagnostics.com",
  ],
  accounts: [
    "accounts.google.com", "myaccount.google.com", "appleid.apple.com", "account.apple.com", "idmsa.apple.com",
    "iforgot.apple.com", "account.microsoft.com", "login.microsoftonline.com", "login.live.com",
    "account.live.com", "signup.live.com",
  ],
});

// Any label of the hostname (TLD excluded) containing one of these, e.g.
// "mybank.example" or "firstcreditunion.org".
export const BLOCKED_KEYWORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  money: ["bank", "creditunion", "credit-union"],
  health: ["mychart", "patientportal"],
});

// Government: any of these as a whole label, e.g. "tax.gov", "gov.uk",
// "gov.bc.ca", "service.gouv.qc.ca", "army.mil".
export const BLOCKED_LABELS = Object.freeze(["gov", "gouv", "mil"]);

// Amazon sign-in and account pages, by path, on any amazon.* store.
export const AMAZON_ACCOUNT_PATH = /^\/(ap|gp\/css|gp\/your-account|gp\/yourpayments|cpe\/yourpayments|a\/addresses|ax\/account|hz\/mycd)(\/|$)/i;

const LABELS: Record<string, string> = { email: "email", passwords: "a password manager", money: "a bank or money site", government: "a government or tax site", health: "a health site", accounts: "an account settings page" };

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|\[::\])$/;
const PRIVATE = /^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2}|\[f[cd][0-9a-f:]*\]|\[fe80:[0-9a-f:]*\])$/i;

function underDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

// Why the built-in list blocks this URL, or null when it does not.
// `local` is the set of loopback origins that are allowed anyway (the demo
// store); every other localhost or private network address is blocked.
export function builtinBlockReason(href: string | null | undefined, local: ReadonlySet<string> = new Set()): string | null {
  let u: URL;
  try {
    u = new URL(String(href ?? "").trim());
  } catch {
    return "not a web address";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "not a web page";
  if (u.username || u.password) return "the address has a login in it";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (LOOPBACK.test(host) || host.endsWith(".localhost") || PRIVATE.test(host)) {
    return local.has(u.origin) ? null : "a local address on this computer or network";
  }
  for (const [kind, domains] of Object.entries(BLOCKED_DOMAINS)) {
    if (domains.some((d) => underDomain(host, d))) return LABELS[kind];
  }
  const labels = host.split(".").slice(0, -1);
  for (const [kind, words] of Object.entries(BLOCKED_KEYWORDS)) {
    if (labels.some((l) => words.some((w) => l.includes(w)))) return LABELS[kind];
  }
  if (host.split(".").some((l) => (BLOCKED_LABELS as readonly string[]).includes(l))) return LABELS.government;
  if (/(^|\.)amazon\.[a-z.]+$/.test(host) && AMAZON_ACCOUNT_PATH.test(u.pathname)) return LABELS.accounts;
  return null;
}
