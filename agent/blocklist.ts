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

// Host names that point at this computer or the local network by design
// (wildcard DNS services such as localtest.me and 127.0.0.1.nip.io), and
// names that only resolve on a local network. Matched as the name or any
// subdomain of it.
export const LOCAL_DNS: readonly string[] = Object.freeze([
  "localhost", "localtest.me", "lvh.me", "vcap.me", "lacolhost.com", "localhost.direct", "local.gd",
  "nip.io", "sslip.io", "xip.io", "traefik.me", "nip.direct", "home.arpa", "local", "localdomain", "internal", "lan",
]);

function privateV4(o: number[]): boolean {
  const [a, b] = o;
  return a === 0 || a === 127 || a === 10 || a >= 224 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && o[2] === 0) || (a === 198 && (b === 18 || b === 19));
}

function v4Octets(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

// Eight 16-bit groups, or null when `s` is not an IPv6 address.
function v6Groups(s: string): number[] | null {
  let t = s.toLowerCase();
  const dotted = /(\d{1,3}(\.\d{1,3}){3})$/.exec(t);
  if (dotted) {
    const o = v4Octets(dotted[1]);
    if (!o) return null;
    t = t.slice(0, -dotted[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(":") : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 2 && fill < 1)) return null;
  const all = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

// True when `ip` (IPv4, or IPv6 with or without brackets) is loopback,
// private, link-local, site-local, unspecified or multicast, including IPv4
// addresses carried inside IPv6 (::ffff:127.0.0.1, ::7f00:1, 64:ff9b::,
// 2002::). Anything it cannot parse counts as local, so callers fail closed.
export function isLocalIp(ip: string | null | undefined): boolean {
  const s = String(ip ?? "").trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const o = v4Octets(s);
  if (o) return privateV4(o);
  const g = v6Groups(s);
  if (!g) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0) return true; // ::, ::1, IPv4-compatible
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4(embedded(g[6], g[7]));
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) return privateV4(embedded(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(embedded(g[6], g[7]));
  if (g[0] === 0x2002) return privateV4(embedded(g[1], g[2]));
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xff80) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
}

// True when a URL hostname names this computer or the local network: an IP
// literal isLocalIp accepts, a LOCAL_DNS name, or a bare name with no dot
// (resolved through the local network's search domains).
export function isLocalHost(hostname: string | null | undefined): boolean {
  const host = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host.startsWith("[") || v4Octets(host)) return isLocalIp(host);
  if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) return true;
  if (!host.includes(".")) return true;
  return LOCAL_DNS.some((d) => host === d || host.endsWith("." + d));
}


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
  if (isLocalHost(host)) {
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
