import { test } from "node:test";
import assert from "node:assert/strict";

import { containsCardNumber, createRouter } from "../../../extension/background/router.js";

function fakes({ focus = { kind: "other", payment: false }, failFirstSend = false, cdpClickFails = false } = {}) {
  const calls = [];
  let sends = 0;
  const chromeApi = {
    scripting: { executeScript: async (o) => calls.push(["inject", o.target.tabId, o.files]) },
    tabs: {
      sendMessage: async (tabId, msg) => {
        sends++;
        if (failFirstSend && sends === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
        calls.push(["page", tabId, msg.method, msg.params]);
        if (msg.method === "focused_field") return { ok: true, result: focus };
        if (msg.method === "rect" || msg.method === "guard_ref") return { ok: true, result: { x: 10, y: 20, width: 100, height: 40 } };
        if (msg.method === "form_input") return { ok: false, error: { code: "payment_field", message: "no" } };
        return { ok: true, result: { ok: true } };
      },
    },
  };
  const tabs = {
    resolveAllowedTab: async (id) => (calls.push(["resolve", id]), id ?? 7),
    tabsContext: async () => ({ tabs: [], groupId: 1 }),
  };
  const cdp = {
    click: async (o) => {
      if (cdpClickFails) throw Object.assign(new Error("attach failed"), { code: "internal" });
      calls.push(["cdp.click", o]);
    },
    type: async (o) => calls.push(["cdp.type", o]),
    key: async (o) => calls.push(["cdp.key", o]),
  };
  return { calls, router: createRouter({ chromeApi, tabs, cdp }) };
}

test("containsCardNumber finds Luhn-valid 13-19 digit runs only", () => {
  assert.ok(containsCardNumber("4111 1111 1111 1111"));
  assert.ok(containsCardNumber("pay 4111-1111-1111-1111 now"));
  assert.ok(containsCardNumber("x94111111111111111"));
  assert.ok(!containsCardNumber("4111 1111 1111 2"));
  assert.ok(!containsCardNumber("order 12345 qty 2"));
  assert.ok(!containsCardNumber("blue wool sweater"));
});

test("page methods inject mask.js, protect.js, then page.js and pass params without tabId", async () => {
  const { calls, router } = fakes();
  await router.route("find", { tabId: 3, query: "sweater" });
  assert.deepEqual(calls[0], ["resolve", 3]);
  assert.deepEqual(calls[1], ["inject", 3, ["content/mask.js", "content/protect.js", "content/page.js"]]);
  assert.deepEqual(calls[2], ["page", 3, "find", { query: "sweater" }]);
});

test("retries once after Receiving end does not exist", async () => {
  const { calls, router } = fakes({ failFirstSend: true });
  await router.route("read_page", {});
  assert.equal(calls.filter((c) => c[0] === "inject").length, 2);
  assert.equal(calls.filter((c) => c[0] === "page").length, 1);
});

test("page errors keep their code", async () => {
  const { router } = fakes();
  await assert.rejects(router.route("form_input", { ref: "ref_1", value: "x" }), { code: "payment_field" });
});

test("click by ref clicks the rect centre over CDP, and falls back to click_ref", async () => {
  const a = fakes();
  await a.router.route("click", { ref: "ref_4" });
  assert.deepEqual(a.calls.find((c) => c[0] === "cdp.click")[1], { tabId: 7, x: 60, y: 40 });
  const b = fakes({ cdpClickFails: true });
  assert.deepEqual(await b.router.route("click", { ref: "ref_4" }), { ok: true, via: "dom" });
  assert.ok(b.calls.some((c) => c[0] === "page" && c[2] === "click_ref"));
});

test("type refuses card numbers and payment fields, and allows normal text", async () => {
  const ok = fakes();
  await ok.router.route("type", { text: "wool sweater" });
  assert.ok(ok.calls.some((c) => c[0] === "cdp.type"));

  const num = fakes();
  await assert.rejects(num.router.route("type", { text: "4111111111111111" }), { code: "payment_field" });
  assert.ok(!num.calls.some((c) => c[0] === "cdp.type"));

  const field = fakes({ focus: { kind: "cc-csc", payment: true } });
  await assert.rejects(field.router.route("type", { text: "123" }), { code: "payment_field" });
  await assert.rejects(field.router.route("key", { key: "1" }), { code: "payment_field" });
  await field.router.route("key", { key: "Tab" });
  assert.ok(field.calls.some((c) => c[0] === "cdp.key"));
});

test("unknown methods are refused", async () => {
  const { router } = fakes();
  await assert.rejects(router.route("javascript_tool", {}), { code: "unknown_method" });
});
