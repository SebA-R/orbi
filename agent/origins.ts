// Which sites Clearcart may drive. Shared by the session guard, the tab
// sweep, pay_now and the button lock's unlock gate.

// CLEARCART_STORE_ORIGIN moves the demo store (tests run one on a spare port).
// Read at import, so set it on the command line rather than in .env.
export const STORE_ORIGIN = new URL(process.env.CLEARCART_STORE_ORIGIN || "http://localhost:4000").origin;

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
// sweep accept (default: the store only).
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([STORE_ORIGIN, ...parseOrigins(process.env.CLEARCART_ALLOWED_ORIGINS || "")]);
export const EXTRA_SITES = [...ALLOWED_ORIGINS].filter((o) => o !== STORE_ORIGIN);

export function originOf(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const o = new URL(href).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

export function allowedSite(href: string | null | undefined): boolean {
  const o = originOf(href);
  return !!o && ALLOWED_ORIGINS.has(o);
}

// Checkout and payment pages by path. Used to keep Claude from navigating
// straight into checkout on sites where no pay flow exists yet, and by the
// tab sweep on the URL a tab actually landed on. The path is percent-decoded
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

export function isCheckoutUrl(href: string | null | undefined): boolean {
  if (!href) return false;
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
