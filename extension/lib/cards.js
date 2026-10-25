// Saved cards on the agent server, for the options page's Payment cards
// section.
//
// The agent keeps them encrypted on this computer (vault/index.ts) and
// serves them to this extension's origin only (agent/cards.ts):
//   POST /cards/list, POST /cards, DELETE /cards/<id>, POST /cards/<id>/default
// (the list is a POST too: Chrome sends no Origin with an extension page's
// GET, and the agent answers this extension's Origin only)
// A list holds ids, nicknames, brands and last 4 digits, never a number,
// expiry or security code. addCard sends what the user typed once, and
// nothing here keeps or logs it.

import { endpoints } from "./settings.js";

const ID = /^c[0-9a-f]{8}$/;

async function call(agentUrl, method, path, fetchImpl, body) {
  const init = { method, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const r = await fetchImpl(`${endpoints(agentUrl).http}${path}`, init);
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error(typeof data?.error === "string" && r.status < 500 ? data.error : `the agent server answered ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

const clean = (c) => ({ id: c.id, nickname: String(c.nickname), brand: String(c.brand), last4: String(c.last4) });

// { cards: [{ id, nickname, brand, last4 }], defaultId }. Throws when the
// server can't be reached.
export async function listCards(agentUrl, fetchImpl = globalThis.fetch) {
  const body = await call(agentUrl, "POST", "/cards/list", fetchImpl);
  const cards = Array.isArray(body?.cards)
    ? body.cards.filter((c) => c && ID.test(c.id) && typeof c.nickname === "string" && typeof c.brand === "string" && /^\d{4}$/.test(c.last4)).map(clean)
    : [];
  const defaultId = cards.some((c) => c.id === body?.defaultId) ? body.defaultId : null;
  return { cards, defaultId };
}

// card: { nickname, name, number, exp, csc, zip }. Answers the saved card's
// { id, nickname, brand, last4 }; throws with the server's reason when it
// was refused (a bad number, an expired card).
export async function addCard(agentUrl, card, fetchImpl = globalThis.fetch) {
  const body = await call(agentUrl, "POST", "/cards", fetchImpl, card);
  return clean(body.card);
}

export async function removeCard(agentUrl, id, fetchImpl = globalThis.fetch) {
  if (!ID.test(String(id))) throw new Error("not a saved card id");
  return call(agentUrl, "DELETE", `/cards/${id}`, fetchImpl);
}

export async function setDefaultCard(agentUrl, id, fetchImpl = globalThis.fetch) {
  if (!ID.test(String(id))) throw new Error("not a saved card id");
  return call(agentUrl, "POST", `/cards/${id}/default`, fetchImpl);
}

// The same checks the agent makes, so a typo is caught before anything is
// sent. Answers the reason, or "" when the card looks right.
export function checkCard({ name, number, exp, csc }, now = new Date()) {
  const digits = String(number || "").replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(digits) || !luhn(digits)) return "That card number is not valid.";
  if (!String(name || "").trim()) return "Enter the name on the card.";
  const m = /^\s*(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})\s*$/.exec(String(exp || "")) || /^\s*(\d{2})(\d{2})\s*$/.exec(String(exp || ""));
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return "Enter the expiry as MM/YY.";
  const year = m[2].length === 4 ? Number(m[2]) : 2000 + Number(m[2]);
  if (year < now.getFullYear() || (year === now.getFullYear() && Number(m[1]) < now.getMonth() + 1)) return "That card has expired.";
  const amex = /^3[47]/.test(digits);
  if (!new RegExp(`^\\d{${amex ? 4 : 3}}$`).test(String(csc || "").trim())) {
    return `The security code is ${amex ? 4 : 3} digits${amex ? "" : " (4 for American Express)"}.`;
  }
  return "";
}

function luhn(d) {
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (dbl && (n *= 2) > 9) n -= 9;
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// "Visa ending 1111".
export const cardLabel = (c) => `${c.brand} ending ${c.last4}`;
