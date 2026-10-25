// Open web browsing: sites Clearcart never opens, even when browseMode is
// "open". Two parts:
//
//   Fixed rules, in code: anything that is not an http(s) page, an address
//   with a login in it, and localhost or private network addresses (except
//   the allowlisted ones, which is how the demo store gets through).
//
//   The user's blocked sites: settings `blocklist`, edited on the options
//   page, one entry per line. Seeded on install from SUGGESTED_BLOCKLIST.
//     chase.com     that host and every subdomain of it
//     amazon.*/ap   pages at or under /ap on that host; ".*" is any ending
//     *bank*        any part of the hostname (not the ending) containing it
//     *.gov         any part of the hostname that is exactly "gov"
//     # note        a comment, ignored
//
// Best effort: the suggested list catches common sensitive sites, it is not
// complete. The button lock and the Clearcart tab group still apply on every
// site this lets through.
//
// Plain JS with no imports, so the agent server (agent/blocklist.ts) loads
// this same file.

const AMAZON_ACCOUNT_PATHS = ["ap", "gp/css", "gp/your-account", "gp/yourpayments", "cpe/yourpayments", "a/addresses", "ax/account", "hz/mycd"];

export const SUGGESTED_BLOCKLIST = Object.freeze([
  "# Email",
  "gmail.com", "mail.google.com", "inbox.google.com", "outlook.com", "outlook.live.com", "outlook.office.com",
  "outlook.office365.com", "hotmail.com", "live.com", "mail.yahoo.com", "proton.me", "protonmail.com",
  "mail.aol.com", "icloud.com", "fastmail.com", "zoho.com", "tutanota.com", "tuta.com", "gmx.com", "mail.com",
  "",
  "# Password managers",
  "bitwarden.com", "bitwarden.eu", "1password.com", "1password.ca", "1password.eu", "lastpass.com",
  "dashlane.com", "keepersecurity.com", "nordpass.com", "roboform.com", "passwords.google.com",
  "",
  "# Banks and money: any address with these words in its name",
  "*bank*", "*creditunion*", "*credit-union*",
  "# US banks, cards and payments",
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com", "usbank.com", "pnc.com",
  "capitalone.com", "tdbank.com", "truist.com", "ally.com", "discover.com", "americanexpress.com",
  "synchrony.com", "mysynchrony.com", "marcus.com", "goldmansachs.com", "usaa.com", "navyfederal.org",
  "penfed.org", "regions.com", "key.com", "huntington.com", "citizensbank.com", "fifththird.com", "53.com",
  "mtb.com", "santanderbank.com", "bmoharris.com", "sofi.com", "chime.com", "varo.com", "paypal.com",
  "venmo.com", "cash.app", "zellepay.com", "wise.com", "stripe.com", "pay.google.com", "payments.google.com",
  "# US brokerages",
  "schwab.com", "fidelity.com", "vanguard.com", "etrade.com", "robinhood.com", "merrilledge.com", "ml.com",
  "morganstanley.com", "interactivebrokers.com", "webull.com", "tastytrade.com", "betterment.com",
  "wealthfront.com", "empower.com", "troweprice.com",
  "# Canadian banks and brokerages",
  "rbc.com", "rbcroyalbank.com", "td.com", "tdcanadatrust.com", "scotiabank.com", "bmo.com", "cibc.com",
  "desjardins.com", "nbc.ca", "bnc.ca", "tangerine.ca", "simplii.com", "eqbank.ca", "koho.ca", "atb.com",
  "pcfinancial.ca", "questrade.com", "wealthsimple.com", "qtrade.ca", "hsbc.ca", "meridiancu.ca",
  "# Crypto exchanges",
  "coinbase.com", "kraken.com", "binance.com", "binance.us", "gemini.com", "crypto.com", "bitstamp.net",
  "okx.com", "bybit.com", "kucoin.com", "blockchain.com", "metamask.io", "shakepay.com", "newton.co",
  "",
  "# Government and tax: gov.uk, irs.gov, gov.bc.ca, gouv.qc.ca, army.mil and the rest",
  "*.gov", "*.gouv", "*.mil",
  "canada.ca", "gc.ca", "irs.gov", "ssa.gov", "login.gov", "id.me", "ontario.ca", "quebec.ca",
  "turbotax.com", "turbotax.intuit.com", "intuit.com", "hrblock.com", "taxact.com", "freetaxusa.com",
  "ufile.ca", "wealthsimple.tax",
  "",
  "# Health",
  "*mychart*", "*patientportal*",
  "mychart.com", "mychart.org", "followmyhealth.com", "athenahealth.com", "kp.org", "myuhc.com", "uhc.com",
  "anthem.com", "aetna.com", "cigna.com", "bcbs.com", "humana.com", "onemedical.com", "teladoc.com",
  "zocdoc.com", "healthequity.com", "sunlife.ca", "manulife.ca", "canadalife.com", "greatwestlife.com",
  "medicare.gov", "healthcare.gov", "labcorp.com", "questdiagnostics.com",
  "",
  "# Account settings and sign in pages",
  "accounts.google.com", "myaccount.google.com", "appleid.apple.com", "account.apple.com", "idmsa.apple.com",
  "iforgot.apple.com", "account.microsoft.com", "login.microsoftonline.com", "login.live.com",
  "account.live.com", "signup.live.com",
  ...AMAZON_ACCOUNT_PATHS.map((p) => `amazon.*/${p}`),
]);

// One line to an entry, or null when it is not one of the forms above.
// Pasted addresses are accepted: the scheme, port, query and a leading
// "www." are dropped. `text` is the normalized line.
export function parseEntry(line) {
  const s = String(line ?? "").trim().toLowerCase();
  let m = /^\*([a-z0-9-]+)\*$/.exec(s);
  if (m) return { text: s, keyword: m[1] };
  if ((m = /^\*\.([a-z0-9-]+)$/.exec(s))) return { text: s, label: m[1] };
  m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(\.\*)?(?::\d+)?(\/[^\s?#]*)?(?:[?#]\S*)?$/.exec(s);
  if (!m || (!m[2] && !m[1].includes("."))) return null;
  const path = (m[3] || "").replace(/\/+$/, "");
  return { text: m[1] + (m[2] || "") + path, host: m[1], any: !!m[2], path };
}

// Normalizes the options page text (or a stored array of lines). Comments
// stay, runs of blank lines become one, duplicates go. `bad` holds the lines
// that are not an entry.
export function parseBlockLines(input) {
  const lines = [];
  const entries = [];
  const bad = [];
  for (const raw of Array.isArray(input) ? input : String(input ?? "").split("\n")) {
    const line = String(raw ?? "").trim();
    if (!line) {
      if (lines.length && lines.at(-1) !== "") lines.push("");
      continue;
    }
    if (line.startsWith("#")) {
      lines.push(line);
      continue;
    }
    const e = parseEntry(line);
    if (!e) bad.push(line);
    else if (!entries.some((x) => x.text === e.text)) {
      entries.push(e);
      lines.push(e.text);
    }
  }
  while (lines.at(-1) === "") lines.pop();
  return { lines, entries, bad };
}

export const SUGGESTED_ENTRIES = Object.freeze(parseBlockLines(SUGGESTED_BLOCKLIST).entries);

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|\[::\])$/;
const PRIVATE = /^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2}|\[f[cd][0-9a-f:]*\]|\[fe80:[0-9a-f:]*\])$/i;

function matches(e, host, labels, path) {
  if (e.keyword) return labels.slice(0, -1).some((l) => l.includes(e.keyword));
  if (e.label) return labels.includes(e.label);
  const onHost = e.any ? `.${host}`.includes(`.${e.host}.`) : host === e.host || host.endsWith("." + e.host);
  return onHost && (!e.path || path === e.path || path.startsWith(e.path + "/"));
}

// Why this URL is blocked, or null when it is not: the fixed rules first,
// then `entries` (from parseBlockLines). `local` is the set of loopback
// origins allowed anyway (the demo store).
export function blocklistReason(href, entries = [], local = new Set()) {
  let u;
  try {
    u = new URL(String(href ?? "").trim());
  } catch {
    return "not a web address";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "not a web page";
  if (u.username || u.password) return "the address has a login in it";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if ((LOOPBACK.test(host) || host.endsWith(".localhost") || PRIVATE.test(host)) && !local.has(u.origin)) {
    return "a local address on this computer or network";
  }
  const path = u.pathname.toLowerCase();
  const hit = entries.find((e) => matches(e, host, host.split("."), path));
  return hit ? `on the blocked sites list: ${hit.text}` : null;
}
