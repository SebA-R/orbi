// The options page's saved-cards client (extension/lib/cards.js): the
// endpoints it calls (every one a request Chrome sends with the extension's
// Origin, so the list is a POST), that a list keeps only id, nickname,
// brand and last 4, that a card goes out once as JSON and errors never
// repeat it, and the checks made before anything is sent. Test numbers only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { addCard, cardLabel, checkCard, listCards, removeCard, setDefaultCard } from "../../../extension/lib/cards.js";

const CARD = { nickname: "Work Visa", name: "Ada Lovelace", number: "4111 1111 1111 1111", exp: "12/30", csc: "123", zip: "94704" };

function fakeFetch(reply) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body, credentials: init.credentials, type: init.headers?.["Content-Type"] });
    const r = typeof reply === "function" ? reply(url, init) : reply;
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.body };
  };
  f.calls = calls;
  return f;
}

test("listCards posts to /cards/list and keeps only id, nickname, brand and last 4", async () => {
  const f = fakeFetch({
    body: {
      cards: [
        { id: "c0000000a", nickname: "Work Visa", brand: "Visa", last4: "1111", number: "4111111111111111", exp: "12/30" },
        { id: "../x", nickname: "bad", brand: "Visa", last4: "1111" },
        { id: "c0000000b", nickname: "Odd", brand: "Visa", last4: "11111" },
      ],
      defaultId: "c0000000a",
    },
  });
  const r = await listCards("ws://localhost:5050", f);
  assert.deepEqual(f.calls.map((c) => [c.url, c.method]), [["http://localhost:5050/cards/list", "POST"]]);
  assert.deepEqual(r, { cards: [{ id: "c0000000a", nickname: "Work Visa", brand: "Visa", last4: "1111" }], defaultId: "c0000000a" });
  // A default that is not in the list is dropped.
  assert.equal((await listCards("ws://localhost:5050", fakeFetch({ body: { cards: [], defaultId: "c0000000a" } }))).defaultId, null);
  await assert.rejects(listCards("ws://localhost:5050", fakeFetch({ status: 403, body: { error: "forbidden" } })));
});

test("addCard sends the card once as JSON, without cookies, and answers the saved card's label fields", async () => {
  const f = fakeFetch({ status: 201, body: { ok: true, card: { id: "c0000000a", nickname: "Work Visa", brand: "Visa", last4: "1111" } } });
  const saved = await addCard("ws://127.0.0.1:5050", CARD, f);
  assert.deepEqual(saved, { id: "c0000000a", nickname: "Work Visa", brand: "Visa", last4: "1111" });
  assert.equal(f.calls.length, 1);
  assert.deepEqual([f.calls[0].url, f.calls[0].method, f.calls[0].type, f.calls[0].credentials], ["http://127.0.0.1:5050/cards", "POST", "application/json", "omit"]);
  assert.deepEqual(JSON.parse(f.calls[0].body), CARD);
  // A refusal comes back as the server's reason, never the card.
  const bad = fakeFetch({ status: 400, body: { error: "That card has expired." } });
  await assert.rejects(addCard("ws://localhost:5050", CARD, bad), (e) => e.message === "That card has expired." && e.status === 400);
  const down = fakeFetch({ status: 500, body: { error: "4111 1111 1111 1111" } });
  await assert.rejects(addCard("ws://localhost:5050", CARD, down), (e) => e.message === "the agent server answered 500");
});

test("delete and default reach only well-formed ids", async () => {
  const f = fakeFetch({ body: { ok: true } });
  await removeCard("ws://localhost:5050", "c0000000a", f);
  await setDefaultCard("ws://localhost:5050", "c0000000a", f);
  assert.deepEqual(f.calls.map((c) => [c.url, c.method]), [["http://localhost:5050/cards/c0000000a", "DELETE"], ["http://localhost:5050/cards/c0000000a/default", "POST"]]);
  for (const id of ["../memory", "c0000000a/x", "", "C0000000A"]) {
    await assert.rejects(removeCard("ws://localhost:5050", id, f));
    await assert.rejects(setDefaultCard("ws://localhost:5050", id, f));
  }
  assert.equal(f.calls.length, 2);
});

test("checkCard: Luhn, name, expiry and security code, the way the agent checks them", () => {
  const now = new Date("2026-10-25T12:00:00Z");
  assert.equal(checkCard(CARD, now), "");
  assert.equal(checkCard({ ...CARD, number: "4242 4242 4242 4242" }, now), "");
  assert.match(checkCard({ ...CARD, number: "4111 1111 1111 1112" }, now), /not valid/);
  assert.match(checkCard({ ...CARD, name: " " }, now), /name on the card/);
  assert.match(checkCard({ ...CARD, exp: "09/26" }, now), /expired/);
  assert.match(checkCard({ ...CARD, exp: "13/30" }, now), /MM\/YY/);
  assert.match(checkCard({ ...CARD, csc: "12" }, now), /3 digits/);
  // American Express takes 4 (378282246310005 is its published test number).
  assert.equal(checkCard({ ...CARD, number: "378282246310005", csc: "1234" }, now), "");
  assert.match(checkCard({ ...CARD, number: "378282246310005", csc: "123" }, now), /4 digits/);
  for (const c of [{ ...CARD, number: "4111 1111 1111 1112" }, { ...CARD, csc: "12" }]) assert.ok(!/4111|123/.test(checkCard(c, now)));
  assert.equal(cardLabel({ brand: "Visa", last4: "1111" }), "Visa ending 1111");
});

test("the add-card fields are never settings: no data-setting, no autocomplete, outside the settings form", () => {
  const html = readFileSync(new URL("../../../extension/options/options.html", import.meta.url), "utf8");
  const fields = [...html.matchAll(/<input id="card-[a-z]+"[^>]*>/g)].map((m) => m[0]);
  assert.equal(fields.length, 6);
  for (const f of fields) {
    assert.match(f, /form="card-form"/);
    assert.match(f, /autocomplete="off"/);
    assert.doesNotMatch(f, /data-setting/);
  }
  assert.match(html, /<form id="card-form" autocomplete="off" novalidate hidden><\/form>/);
  assert.match(html, /Cards are encrypted on this computer\. Orbi's AI never sees them; only Orbi's own code fills them in at checkout\./);
});
