// Saved-card fill in the worker's router (fill_card, clear_card,
// card_state): which frame gets which value (planCard), the page and frame
// checks, and that no answer holds a card value. chrome.scripting is a fake
// that runs the router's own frame functions against one stand-in
// content/cardfill.js per frame. Test numbers only.
import { test } from "node:test";
import assert from "node:assert/strict";

import { CARD_FILES, NO_CARD_FIELDS, createRouter, expParts, planCard } from "../../../extension/background/router.js";
import { BridgeError, ERR, INTERNAL, TOOLS } from "../../../extension/lib/protocol.js";

const SHOP = "https://shop.example";
const CARD = { name: "Ada Lovelace", number: "4111 1111 1111 1111", exp: "12/30", csc: "737", zip: "94704" };
const SECRETS = ["4111111111111111", "4111 1111", "Ada Lovelace", "12/30", "737", "94704"];
const noSecrets = (v, what) => {
  const s = JSON.stringify(v);
  for (const x of SECRETS) assert.ok(!s.includes(x), `${what} holds ${x}`);
};

// A checkout page with the name on the page, the rest in a Stripe-style
// frame, and a frame on a local address nobody allowed. A frame's `hidden`
// kinds are fields a person cannot use (scan reports them unusable).
function frames() {
  return [
    { frameId: 0, documentId: "top", href: "https://shop.example/checkout", kinds: ["cc-name"] },
    { frameId: 3, documentId: "stripe", href: "https://js.stripe.com/v3/elements-inner-card.html", kinds: ["cc-number", "cc-exp", "cc-csc", "postal-code"] },
    { frameId: 5, documentId: "stray", href: "http://localhost:9999/fields", kinds: ["cc-number", "cc-csc"] },
  ];
}

function fakes({ list = frames(), refuse = new Set(), topBlocked = false } = {}) {
  const got = new Map(); // documentId -> values handed to that frame
  const held = new Map(list.map((f) => [f.documentId, {}])); // what is in each frame's fields
  const injected = [];
  const checked = [];
  const tops = [];
  const apiFor = (f) => ({
    scan: () => ({
      href: f.href,
      fields: [
        ...f.kinds.map((k) => ({ kind: k, filled: !!held.get(f.documentId)[k], usable: true })),
        ...(f.hidden || []).map((k) => ({ kind: k, filled: !!held.get(f.documentId)["hidden " + k], usable: false })),
      ],
    }),
    fill: (v) => {
      got.set(f.documentId, v);
      if (refuse.has(f.documentId)) return { ok: false, filled: {} };
      Object.assign(held.get(f.documentId), v);
      return { ok: true, filled: Object.fromEntries(Object.keys(v).map((k) => [k, true])) };
    },
    clear: () => {
      const n = Object.keys(held.get(f.documentId)).length;
      held.set(f.documentId, {});
      return { ok: true, cleared: n };
    },
  });
  const chromeApi = {
    scripting: {
      executeScript: async ({ target, files, func, args = [] }) => {
        const targets = target.allFrames ? list : list.filter((f) => (target.documentIds || []).includes(f.documentId) || (target.frameIds || []).includes(f.frameId));
        if (files) {
          injected.push({ allFrames: !!target.allFrames, files });
          return targets.map((f) => ({ frameId: f.frameId, documentId: f.documentId, result: null }));
        }
        // The router's own function, run in each frame against that
        // frame's stand-in cardfill.js.
        return targets.map((f) => {
          globalThis.__clearcartCardFill = apiFor(f);
          try {
            return { frameId: f.frameId, documentId: f.documentId, result: JSON.parse(JSON.stringify(func(...args))) };
          } finally {
            delete globalThis.__clearcartCardFill;
          }
        });
      },
    },
    tabs: { sendMessage: async () => ({ ok: true, result: {} }) },
  };
  const tabs = {
    resolveAllowedTab: async (id) => id ?? 7,
    tabInfo: async ({ tabId }) => ({ tabId, url: list[0].href }),
    isAllowed: async () => true,
    assertPageAllowed: async (tabId, url) => {
      checked.push([tabId, url]);
      if (topBlocked) throw new BridgeError(ERR.NOT_ALLOWED, "site blocked");
    },
    frameAllowed: async (url, topOrigin) => {
      tops.push(topOrigin);
      return !/^http:\/\/localhost[:/]/.test(url);
    },
  };
  const follow = { to: async () => {}, own: (fn) => fn(), forget() {}, claim() {}, newTurn() {} };
  const router = createRouter({ chromeApi, tabs, cdp: {}, follow });
  return { router, got, held, injected, checked, tops };
}

const kinds = (...k) => k.map((kind) => ({ kind }));

test("fill_card, clear_card and card_state are internal, never tools", () => {
  for (const m of ["fill_card", "clear_card", "card_state"]) {
    assert.ok(INTERNAL.includes(m), m);
    assert.ok(!TOOLS.includes(m), m);
  }
  assert.deepEqual(CARD_FILES, ["content/mask.js", "content/cardfill.js"]);
});

test("planCard: one number, code and expiry across the frames; a name or ZIP only when there is exactly one", () => {
  const top = { frameId: 0, fields: kinds("cc-name") };
  const card = { frameId: 3, fields: kinds("cc-number", "cc-exp", "cc-csc", "postal-code") };
  const p = planCard([top, card]);
  assert.deepEqual([...p.plan].map(([fr, k]) => [fr.frameId, k]), [[3, ["cc-number", "cc-exp", "cc-csc", "postal-code"]], [0, ["cc-name"]]]);
  assert.deepEqual([p.name, p.zip], [true, true]);
  // One frame per field (Braintree, Adyen).
  const split = planCard([top, { frameId: 1, fields: kinds("cc-number") }, { frameId: 2, fields: kinds("cc-exp-month", "cc-exp-year") }, { frameId: 4, fields: kinds("cc-csc") }]);
  assert.deepEqual([...split.plan].map(([fr, k]) => [fr.frameId, k]), [[1, ["cc-number"]], [2, ["cc-exp-month", "cc-exp-year"]], [4, ["cc-csc"]], [0, ["cc-name"]]]);
  // Two names: the name is left for the user, the card still goes in.
  const twoNames = planCard([top, { frameId: 3, fields: kinds("cc-name", "cc-number", "cc-exp", "cc-csc") }]);
  assert.deepEqual([twoNames.name, twoNames.zip], [false, false]);
  // Anything unclear fills nothing.
  for (const bad of [
    [{ frameId: 0, fields: kinds("cc-number", "cc-exp") }],
    [{ frameId: 0, fields: kinds("cc-number", "cc-exp", "cc-csc") }, { frameId: 1, fields: kinds("cc-number") }],
    [{ frameId: 0, fields: kinds("cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc") }],
    [{ frameId: 0, fields: kinds("cc-number", "cc-exp-month", "cc-csc") }],
    [{ frameId: 0, fields: kinds("cc-name") }],
    [],
  ]) {
    assert.throws(() => planCard(bad), (e) => e.code === ERR.NO_ELEMENT && e.message === NO_CARD_FIELDS, JSON.stringify(bad));
  }
  assert.deepEqual(expParts("7/2031"), { mm: "07", yy: "31", yyyy: "2031" });
  for (const bad of ["1230", "13/30", "00/30", "12/3"]) assert.equal(expParts(bad), null, bad);
});

test("fill_card: each frame gets only its own values, a frame Orbi may not use gets nothing, and the answer holds no card value", async () => {
  const f = fakes();
  const r = await f.router.route("fill_card", { tabId: 7, origin: SHOP, card: CARD });
  assert.deepEqual(r, { ok: true, last4: "1111", name: true, zip: true, frames: 2 });
  noSecrets(r, "the answer");
  assert.deepEqual(f.got.get("top"), { "cc-name": "Ada Lovelace" });
  assert.deepEqual(f.got.get("stripe"), { "cc-number": "4111111111111111", "cc-exp": { mm: "12", yy: "30", yyyy: "2030" }, "cc-csc": "737", "postal-code": "94704" });
  assert.equal(f.got.has("stray"), false, "the local frame nobody allowed");
  assert.deepEqual(f.checked, [[7, "https://shop.example/checkout"]], "the page itself passes the full site check");
  assert.deepEqual([...new Set(f.tops)], [SHOP], "frames are judged against the page's own origin");
  assert.deepEqual(f.injected[0], { allFrames: true, files: CARD_FILES });
});

test("fill_card: only on the origin the user said yes on; an email goes to the page's frame only", async () => {
  const f = fakes();
  await assert.rejects(f.router.route("fill_card", { tabId: 7, card: CARD }), { code: ERR.BAD_REQUEST, message: "origin is required" });
  await assert.rejects(f.router.route("fill_card", { tabId: 7, origin: "https://other.example", card: CARD }), { code: ERR.NOT_ALLOWED });
  assert.equal(f.got.size, 0);
  await assert.rejects(f.router.route("card_state", { tabId: 7, origin: "https://other.example" }), { code: ERR.NOT_ALLOWED });
  const e = fakes();
  await e.router.route("fill_card", { tabId: 7, origin: SHOP, card: CARD, email: "demo@example.com" });
  assert.equal(e.got.get("top").email, "demo@example.com");
  assert.equal("email" in e.got.get("stripe"), false);
});

test("fields a person cannot use never get a value or count toward the plan, but a value left in one keeps the card counted", async () => {
  const list = frames();
  list[0].hidden = ["cc-number", "cc-csc"];
  const f = fakes({ list });
  const s = await f.router.route("card_state", { tabId: 7, origin: SHOP });
  assert.deepEqual([s.fields, s.kinds["cc-number"], s.kinds["cc-csc"]], [5, 1, 1], "the hidden ones are not counted as fields");
  const r = await f.router.route("fill_card", { tabId: 7, origin: SHOP, card: CARD });
  assert.equal(r.ok, true);
  assert.deepEqual(f.got.get("top"), { "cc-name": "Ada Lovelace" }, "nothing for the hidden fields");
  f.held.get("top")["hidden cc-number"] = "left behind";
  assert.equal((await f.router.route("card_state", { tabId: 7 })).filled, 6);
});

test("fill_card: when a frame does not take its values, every card field is emptied again and nothing is reported filled", async () => {
  const f = fakes({ refuse: new Set(["top"]) });
  await assert.rejects(f.router.route("fill_card", { tabId: 7, origin: SHOP, card: CARD }), (e) => e.code === ERR.NO_ELEMENT && e.message === "couldn't fill the card fields on this page");
  assert.deepEqual(Object.fromEntries(f.held), { top: {}, stripe: {}, stray: {} }, "the card frame was emptied again");
});

test("fill_card refuses an incomplete card, a blocked page and a page without card fields before any value moves", async () => {
  for (const card of [{ ...CARD, number: "4111 1111 1111 1112" }, { ...CARD, exp: "13/30x" }, { ...CARD, csc: "7" }, null]) {
    const f = fakes();
    await assert.rejects(f.router.route("fill_card", { tabId: 7, origin: SHOP, card }), (e) => {
      noSecrets({ m: e.message }, "the error");
      return e.code === ERR.BAD_REQUEST;
    });
    assert.equal(f.got.size, 0);
  }
  const blocked = fakes({ topBlocked: true });
  await assert.rejects(blocked.router.route("fill_card", { tabId: 7, origin: SHOP, card: CARD }), { code: ERR.NOT_ALLOWED });
  assert.equal(blocked.got.size, 0);
  const none = fakes({ list: [{ frameId: 0, documentId: "top", href: "https://shop.example/checkout", kinds: ["cc-name"] }, frames()[2]] });
  await assert.rejects(none.router.route("fill_card", { tabId: 7, origin: SHOP, card: CARD }), { code: ERR.NO_ELEMENT, message: NO_CARD_FIELDS });
  assert.equal(none.got.size, 0);
});

test("card_state counts card fields by kind in the frames Orbi may use; clear_card empties them all", async () => {
  const f = fakes();
  assert.deepEqual(await f.router.route("card_state", { tabId: 7 }), { fields: 5, filled: 0, kinds: { "cc-name": 1, "cc-number": 1, "cc-exp": 1, "cc-csc": 1, "postal-code": 1 }, frames: 2 });
  await f.router.route("fill_card", { tabId: 7, origin: SHOP, card: CARD });
  const s = await f.router.route("card_state", { tabId: 7 });
  assert.equal(s.filled, 5);
  noSecrets(s, "card_state");
  assert.deepEqual(await f.router.route("clear_card", { tabId: 7 }), { ok: true, cleared: 5 });
  assert.equal((await f.router.route("card_state", { tabId: 7 })).filled, 0);
});
