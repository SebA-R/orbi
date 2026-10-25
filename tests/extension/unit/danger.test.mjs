// Danger mode: the stored setting, what the classifier lifts (only sign in
// and sign up), how the worker's router passes it to the page, the confirm
// step in the switch, and the limits that never move with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { DANGER_MODE_COPY, DEFAULTS, normalize, saveSettings, loadSettings } from "../../../extension/lib/settings.js";
import { createRouter } from "../../../extension/background/router.js";
import { bindDangerToggle } from "../../../extension/lib/danger-toggle.js";
import { MSG } from "../../../extension/lib/protocol.js";

const require = createRequire(import.meta.url);
const P = require("../../../extension/content/protect.js");

test("setting: off by default, and only a stored true turns it on", async () => {
  assert.equal(DEFAULTS.dangerMode, false);
  assert.equal(normalize({}).dangerMode, false);
  for (const v of ["true", 1, "on", {}, null]) assert.equal(normalize({ dangerMode: v }).dangerMode, false, JSON.stringify(v));
  assert.equal(normalize({ dangerMode: true }).dangerMode, true);
  const data = {};
  const storage = { get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])), set: async (o) => Object.assign(data, o) };
  assert.equal((await loadSettings(storage)).dangerMode, false);
  assert.equal((await saveSettings({ dangerMode: true }, storage)).dangerMode, true);
  assert.equal(data.dangerMode, true, "stored under the dangerMode key with the other settings");
  assert.equal(MSG.DANGER_MODE, "danger_mode");
});

test("settings copy: the exact wording, no em dashes", () => {
  assert.equal(DANGER_MODE_COPY, "Danger mode. Clearcart can press any button without asking first. You still say yes out loud before anything is bought.");
  assert.doesNotMatch(DANGER_MODE_COPY, /—/);
});

const lock = (kind, label, optin = false) => ({ kind, label, optin, checked: false });

test("classifier: Danger mode lifts sign in and sign up only", () => {
  for (const l of [lock("account", "Sign in"), lock("account", "Create account"), lock("account", "Log in with Google")]) {
    assert.equal(P.dangerLifts(l), true, l.label);
  }
  for (const l of [
    lock("order", "Place order · $14.27"),
    lock("order", "Buy now"),
    lock("order", "Pay now"),
    lock("order", "Proceed to checkout"),
    lock("order", "Checkout"),
    lock("express", "Apple Pay"),
    lock("express", "PayPal"),
    lock("subscription", "Subscribe & Save"),
    lock("subscription", "Start free trial"),
    lock("subscription", "Auto deliver every 30 days", true),
    lock("payment-method", "Save card"),
    lock("payment-form", "Continue"),
    lock("marked", "Confirm"),
    lock("frame", "embedded frame"),
    lock("shadow", "hidden component"),
    // Read as account first, but they also buy, pay or save a card.
    lock("account", "Sign in and place order"),
    lock("account", "Log in with PayPal"),
    lock("account", "Sign in to check out"),
    lock("account", "Create an account and save my card", true),
    lock("account", "Sign up and subscribe"),
    lock("account", "Sign in and pay"),
    lock("account", "Sign in with PayPal"),
    lock("account", "Log in with Apple Pay"),
    lock("account", "Register and buy now"),
    lock("account", "Sign in to confirm"),
    lock("account", "Log in to finish your order"),
    lock("account", "Sign up for Prime"),
    lock("account", "Sign up for Walmart+", true),
    lock("account", "Sign up for Subscribe & Save autoship", true),
    lock("account", "Register to bid"),
    lock("account", "Register and reserve"),
    // A password form's plain submit (formKind): not a sign in by name.
    lock("account", "Continue"),
    lock("account", "Confirm"),
  ]) assert.equal(P.dangerLifts(l), false, `${l.kind} ${l.label}`);
  for (const l of [lock("account", "Sign in now"), lock("account", "Continue with Google"), lock("account", "Create an account", true)]) {
    assert.equal(P.dangerLifts(l), true, l.label);
  }
  assert.equal(P.dangerLifts(null), false);
});

test("classifier: setDangerMode only takes true, and pressable never widens", () => {
  try {
    for (const v of ["true", 1, {}, undefined]) assert.equal(P.setDangerMode(v), false, JSON.stringify(v));
    assert.equal(P.setDangerMode(true), true);
    assert.equal(P.dangerMode(), true);
    // The pay flow's press: still only order buttons, never an account control.
    assert.equal(P.pressable(lock("account", "Sign in")), false);
    assert.equal(P.pressable(lock("order", "Place order")), true);
    // unlockClass (request_unlock) is unchanged: paying never unlocks.
    assert.equal(P.unlockClass(lock("order", "Place order")), null);
    assert.equal(P.unlockClass(lock("express", "Apple Pay")), null);
  } finally {
    P.setDangerMode(false);
  }
});

function routerFakes(dangerMode, url = "https://shop.example/cart") {
  const msgs = [];
  const chromeApi = {
    scripting: { executeScript: async () => [{ documentId: "d1" }] },
    tabs: {
      sendMessage: async (tabId, msg) => {
        msgs.push(msg);
        if (msg.method === "guard_ref") return { ok: true, result: { x: 1, y: 2, width: 10, height: 10 }, href: url };
        return { ok: true, result: { ok: true }, href: url };
      },
    },
  };
  const tabs = {
    resolveAllowedTab: async (id) => id ?? 7,
    tabInfo: async ({ tabId }) => ({ tabId, url, title: "t" }),
    isPaySite: async (u) => new URL(u).origin === "http://localhost:4000",
    assertPageAllowed: async () => {},
  };
  const cdp = { click: async () => {}, type: async () => {}, key: async () => {}, send: async () => {} };
  const router = createRouter({ chromeApi, tabs, cdp, dangerMode });
  return { router, msgs };
}

test("router: every page call carries Danger mode from the settings, never from the agent's params", async () => {
  const on = routerFakes(async () => true);
  await on.router.route("read_page", { tabId: 7, dangerMode: false });
  assert.equal(on.msgs.at(-1).dangerMode, true);
  for (const dm of [async () => false, async () => "true", async () => { throw new Error("storage"); }, undefined]) {
    const f = routerFakes(dm);
    await f.router.route("click", { tabId: 7, ref: "ref_1", dangerMode: true });
    assert.equal(f.msgs[0].dangerMode, false, String(dm));
  }
});

test("router: Danger mode never arms the pay unlock off a pay site, nor presses without a nonce", async () => {
  const f = routerFakes(async () => true);
  await assert.rejects(f.router.route("lock_arm", { tabId: 7 }), { code: "locked" });
  await assert.rejects(f.router.route("press_protected", { tabId: 7, ref: "ref_1", nonce: "guess" }), { code: "locked" });
  await assert.rejects(f.router.route("press_unlocked", { tabId: 7, ref: "ref_1", label: "Sign in", cls: "account", nonce: "guess" }), { code: "locked" });
});

function fakeEl() {
  const handlers = {};
  return {
    checked: false,
    hidden: true,
    focused: false,
    addEventListener: (t, fn) => { handlers[t] = fn; },
    focus() { this.focused = true; },
    fire: (t) => handlers[t](),
  };
}

test("switch: turning on takes a second press; turning off saves at once; no alert", async () => {
  const saves = [];
  const save = async (patch) => { saves.push(patch); return { dangerMode: patch.dangerMode }; };
  const els = { box: fakeEl(), confirm: fakeEl(), yes: fakeEl(), no: fakeEl(), chip: fakeEl() };
  const t = bindDangerToggle(els, save);
  t.fill({ dangerMode: false });
  assert.equal(els.chip.hidden, true);
  const alerts = [];
  globalThis.alert = (m) => alerts.push(m);
  globalThis.confirm = (m) => { alerts.push(m); return true; };
  try {
    els.box.checked = true;
    await els.box.fire("change");
    assert.deepEqual(saves, [], "first press saves nothing");
    assert.equal(els.box.checked, false);
    assert.equal(els.confirm.hidden, false);
    // Cancel: still off.
    els.no.fire("click");
    assert.equal(els.confirm.hidden, true);
    assert.deepEqual(saves, []);
    // Second press on the confirm button.
    els.box.checked = true;
    await els.box.fire("change");
    await els.yes.fire("click");
    assert.deepEqual(saves, [{ dangerMode: true }]);
    assert.equal(els.box.checked, true);
    assert.equal(els.chip.hidden, false, "the header chip shows while it is on");
    els.box.checked = false;
    await els.box.fire("change");
    assert.deepEqual(saves.at(-1), { dangerMode: false });
    assert.equal(els.chip.hidden, true);
    assert.deepEqual(alerts, []);
  } finally {
    delete globalThis.alert;
    delete globalThis.confirm;
  }
});

test("popup and options show the same copy, a confirm button, and the popup chip", async () => {
  const { readFile } = await import("node:fs/promises");
  const popup = await readFile(new URL("../../../extension/popup/popup.html", import.meta.url), "utf8");
  const options = await readFile(new URL("../../../extension/options/options.html", import.meta.url), "utf8");
  for (const html of [popup, options]) {
    assert.ok(html.includes(DANGER_MODE_COPY));
    assert.match(html, /id="danger-confirm"[^>]*hidden/);
    assert.match(html, /id="danger-yes"/);
  }
  assert.match(popup, /<span id="danger-chip" class="danger-chip" hidden>Danger mode<\/span>/);
});
