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
// straight into checkout on sites where no pay flow exists yet.
const CHECKOUT_PATH = /(^|\/)(checkouts?|payments?|pay|billing|purchase|place-?order|one-?click|express-?checkout)(\/|$)/i;

export function isCheckoutUrl(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    return CHECKOUT_PATH.test(new URL(href).pathname);
  } catch {
    return false;
  }
}
