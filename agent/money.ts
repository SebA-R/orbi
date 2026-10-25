// Money on a page, parsed to whole cents and a currency mark so totals
// compare exactly: "$17.95", "US$ 1,234.56", "€17,95", "17,95 €", "£5",
// "USD 18.36". And the order total of a checkout page's text.

export type Money = { text: string; cents: number; cur: string };

const SIGN = "[$£€¥₹]";
const CODE = "(?:USD|CAD|AUD|NZD|EUR|GBP|JPY|CHF|INR|MXN)";
const NUM = String.raw`\d(?:[\d,.  ]*\d)?`;
// prefix (letters, sign) or (code), then the number; or the number, then a sign or code.
const MONEY = new RegExp(
  String.raw`(?:(?:[A-Z]{1,3})?\s?(${SIGN})\s?(${NUM}))|(?:(${CODE})\s?(${NUM}))|(?:(${NUM})\s?(${SIGN}|${CODE})(?![A-Za-z]))`,
  "g"
);

// "1,234.56" -> 123456. A last separator with one or two digits after it
// is the decimal point; any other separator groups thousands.
function cents(num: string): number {
  const s = num.replace(/[\s ]/g, "");
  const m = /[.,](\d{1,2})$/.exec(s);
  const whole = (m ? s.slice(0, m.index) : s).replace(/[.,]/g, "");
  if (!/^\d+$/.test(whole)) return NaN;
  const frac = m ? m[1].padEnd(2, "0") : "00";
  return Number(whole) * 100 + Number(frac);
}

// A code counts as its sign, so "USD 18.36" and "$18.36" match.
const SIGN_OF: Record<string, string> = { USD: "$", CAD: "$", AUD: "$", NZD: "$", MXN: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹", CHF: "CHF" };

function fromMatch(m: RegExpExecArray): Money | null {
  const [text, s1, n1, c2, n2, n3, c3] = m;
  const raw = s1 || c2 || c3;
  const cur = raw && (SIGN_OF[raw] ?? raw);
  const n = cents(n1 || n2 || n3);
  if (!cur || !Number.isFinite(n)) return null;
  return { text: text.trim(), cents: n, cur };
}

// The amounts in a piece of text, in order. Negative ones (a discount:
// "-$5.00", "($5.00)") are left out.
export function amounts(text: string): Money[] {
  const out: Money[] = [];
  const s = String(text ?? "");
  MONEY.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = MONEY.exec(s)); ) {
    const before = s.slice(Math.max(0, m.index - 2), m.index);
    if (/[-−(]\s*$/.test(before)) continue;
    const v = fromMatch(m);
    if (v) out.push(v);
  }
  return out;
}

// One amount, the whole of what the agent passed ("$17.95", or a bare
// "17.95", whose cur is "").
export function parseMoney(text: string): Money | null {
  const all = amounts(text);
  if (all.length === 1) return all[0];
  const bare = /^\s*(\d[\d,.]*)\s*$/.exec(String(text ?? ""));
  const n = bare ? cents(bare[1]) : NaN;
  return !all.length && Number.isFinite(n) ? { text: bare![1], cents: n, cur: "" } : null;
}

// Same amount and currency. A claim with no currency (cur "") matches on
// the amount alone.
export function sameMoney(a: Money | null, b: Money | null): boolean {
  return !!a && !!b && a.cents === b.cents && (a.cur === b.cur || a.cur === "" || b.cur === "");
}

// Labels for the amount the user pays, most specific first. The first
// label found on the page decides; plain "Total" comes last.
const LABELS: RegExp[] = [
  /\border total\b/i,
  /\bgrand total\b/i,
  /\b(?:total due|amount due|balance due|total to pay|amount to pay|total payable|payment total|total amount)\b/i,
  /\bestimated total\b/i,
  /(?:^|[^a-z-])total\b/i,
];
// Lines that name a part of the total, not the total.
const NOT_TOTAL = /\b(?:sub-?total|savings?|saved|you save|discounts?|before (?:tax|taxes|shipping)|excl(?:\.|uding)?|items? total|merchandise total|product total|points|rewards|per (?:item|unit|month))\b/i;

// The order total of a checkout page's text: the amount right after the
// most specific total label, on its line or the next one or two. Null when
// there is none, or when that label shows different amounts (fail closed:
// nothing is read back or paid on an unclear total).
export function orderTotal(text: string): Money | null {
  const lines = String(text ?? "").split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  for (const label of LABELS) {
    const found: Money[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = label.exec(line);
      if (!m || NOT_TOTAL.test(line)) continue;
      const after = line.slice(m.index + m[0].length);
      let hit = amounts(after)[0] || null;
      // "Total" alone on its line, the amount below ("USD" may come first).
      if (!hit && !/[a-z]{3}/i.test(after.replace(new RegExp(CODE, "g"), ""))) {
        for (const next of lines.slice(i + 1, i + 3)) {
          const a = amounts(next)[0];
          if (a && next.replace(a.text, "").replace(new RegExp(CODE, "g"), "").replace(/[\s:]/g, "").length <= 2) {
            hit = a;
            break;
          }
          if (next.replace(new RegExp(CODE, "g"), "").trim()) break;
        }
      }
      if (hit) found.push(hit);
    }
    if (!found.length) continue;
    const distinct = new Map(found.map((f) => [`${f.cur}${f.cents}`, f]));
    return distinct.size === 1 ? found[0] : null;
  }
  return null;
}
