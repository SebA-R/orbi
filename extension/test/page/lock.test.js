// The button lock inside page.js, against the test shop's pages
// (tests/fixtures/shop.mjs): markers in read_page and find, form_input on
// locked controls, the guard_* checks the worker runs before clicks and
// keys, and press_check / press_ref.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, shopPages } from "./harness.js";

const BASE = "http://localhost:4100";
const pages = shopPages();

const load = (name, path) => loadPage(pages[name], { url: BASE + path });
const lineOf = (tree, re) => tree.split("\n").find((l) => re.test(l));
const refIn = (line) => /\[(ref_\d+)\]/.exec(line)[1];

test("read_page marks Place order [locked] and the add-on [uncheck only]; shopping controls stay plain", async () => {
  const checkout = (await load("checkout", "/checkout").call("read_page", { filter: "all" })).result.tree;
  assert.match(lineOf(checkout, /Place order/), /^\s*- button "Place order[^"]*" \[ref_\d+\] \[locked\]$/);
  const cart = (await load("cart", "/cart").call("read_page", {})).result.tree;
  assert.match(lineOf(cart, /Subscribe/), /checked \[ref_\d+\] \[uncheck only\]$/);
  assert.match(lineOf(cart, /Proceed to checkout/), /\[locked\]$/);
  assert.doesNotMatch(lineOf(cart, /"Remove"/), /locked|uncheck/);
  const product = (await load("product", "/product/mug").call("read_page", {})).result.tree;
  assert.doesNotMatch(lineOf(product, /Add to cart/), /locked/);
  assert.doesNotMatch(product, /\[locked\]/);
});

test("find flags locked matches", async () => {
  const p = load("checkout", "/checkout");
  const m = (await p.call("find", { query: "place order" })).result.matches.find((x) => x.role === "button");
  assert.equal(m.locked, true);
  const add = (await load("product", "/product/mug").call("find", { query: "add to cart" })).result.matches[0];
  assert.equal(add.locked, undefined);
});

test("form_input may uncheck the add-on but never check it again", async () => {
  const p = load("cart", "/cart");
  const ref = refIn(lineOf((await p.call("read_page", {})).result.tree, /Subscribe/));
  assert.deepEqual((await p.call("form_input", { ref, value: false })).result, { ok: true });
  assert.equal(p.document.getElementById("addon_subscription").checked, false);
  const again = await p.call("form_input", { ref, value: true });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, "locked");
  assert.match(again.error.message, /can only be unchecked/);
  assert.equal(p.document.getElementById("addon_subscription").checked, false);
});

test("guard_ref and guard_point refuse locked targets and pass normal ones", async () => {
  const p = load("checkout", "/checkout");
  const tree = (await p.call("read_page", { filter: "all" })).result.tree;
  const r = await p.call("guard_ref", { ref: refIn(lineOf(tree, /Place order/)) });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "locked");
  const placeRef = refIn(lineOf(tree, /Place order/));
  assert.equal(r.error.message, "Locked: 'Place order · $" + /Place order · \$([0-9.]+)/.exec(tree)[1] + "' (" + placeRef + ") places the order or pays, so nothing was pressed. Never call request_unlock for it: paying goes only through request_checkout and pay_now, on an Orbi pay site. Elsewhere, tell the user they can finish it themselves.");
  const ok = await p.call("guard_ref", { ref: refIn(lineOf(tree, /textbox "Name on card"/)) });
  assert.equal(ok.ok, true);

  // jsdom has no layout: point elementFromPoint at the button's text.
  const btn = p.document.getElementById("place-order");
  p.document.elementFromPoint = () => btn.firstChild.parentElement;
  assert.equal((await p.call("guard_point", { x: 5, y: 5 })).error.code, "locked");
  p.document.elementFromPoint = () => p.document.querySelector("h1") || p.document.body;
  assert.equal((await p.call("guard_point", { x: 5, y: 5 })).ok, true);
  assert.equal((await p.call("guard_point", { x: "a", y: 5 })).error.code, "bad_request");
});

test("guard_key refuses Enter on Place order and in the checkout form, allows Tab and search", async () => {
  const p = load("checkout", "/checkout");
  p.document.getElementById("place-order").focus();
  assert.equal((await p.call("guard_key", { key: "Enter" })).error.code, "locked");
  assert.equal((await p.call("guard_key", { key: " " })).error.code, "locked");
  assert.equal((await p.call("guard_key", { key: "Tab" })).ok, true);
  p.document.querySelector('[name="cc-name"]').focus();
  const enter = await p.call("guard_key", { key: "Enter" });
  assert.equal(enter.error.code, "locked", "Enter in a field would submit the payment form");
  p.document.querySelector('form[role=search] input').focus();
  assert.equal((await p.call("guard_key", { key: "Enter" })).ok, true);
});

test("press_check and press_ref accept only order buttons", async () => {
  const p = load("checkout", "/checkout");
  const tree = (await p.call("read_page", { filter: "all" })).result.tree;
  const place = refIn(lineOf(tree, /Place order/));
  const btn = p.document.getElementById("place-order");
  btn.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, width: 100, height: 40, right: 110, bottom: 60 });
  p.document.elementFromPoint = () => btn;
  const ok = await p.call("press_check", { ref: place });
  assert.deepEqual([ok.ok, ok.result], [true, { x: 10, y: 20, width: 100, height: 40, kind: "order" }]);
  // Covered by something else: refused.
  p.document.elementFromPoint = () => p.document.body;
  assert.equal((await p.call("press_check", { ref: place })).error.code, "no_element");
  // Not an order button: refused.
  const name = refIn(lineOf(tree, /textbox "Name on card"/));
  assert.equal((await p.call("press_check", { ref: name })).error.code, "locked");
  assert.equal((await p.call("press_ref", { ref: name })).error.code, "locked");
  let clicks = 0;
  btn.addEventListener("click", (e) => { clicks++; e.preventDefault(); });
  assert.equal((await p.call("press_ref", { ref: place })).ok, true);
  assert.equal(clicks, 1);
});

test("badges come up when the page script loads, outside what read_page and get_page_text see", async () => {
  const p = load("checkout", "/checkout");
  const host = p.document.getElementById("clearcart-lock-badges");
  assert.ok(host, "badge host");
  assert.equal(host.getAttribute("aria-hidden"), "true");
  const text = (await p.call("get_page_text", {})).result.text;
  assert.doesNotMatch(text, /Locked for AI/);
  assert.doesNotMatch((await p.call("read_page", { filter: "all" })).result.tree, /Locked for AI/);
});

test("page calls fail closed without protect.js", async () => {
  const p = loadPage(pages.checkout, { url: BASE + "/checkout", page: false });
  delete p.window.ClearcartProtect;
  p.inject = null;
  p.window.eval(await (await import("node:fs")).promises.readFile(new URL("../../content/page.js", import.meta.url), "utf8"));
  const r = await p.call("read_page", {});
  assert.equal(r.ok, false);
  assert.match(r.error.message, /protect\.js was not injected/);
});

// Security review: a dropdown is uncheck-only too. Switching to
// "Subscribe and save" was not checked at all.
test("form_input on a select may move away from an opt-in option, never onto one", async () => {
  const p = loadPage(`<form><label>Delivery <select id="plan" name="plan">
      <option value="once" selected>One-time purchase</option>
      <option value="sns">Subscribe and save 15%</option>
      <option value="x" label="Start free trial">Trial</option>
      <option value="2">2 items</option>
    </select></label></form>`);
  const ref = refIn(lineOf((await p.call("read_page", { filter: "all" })).result.tree, /combobox/));
  const sel = p.document.getElementById("plan");
  for (const value of ["sns", "Subscribe and save 15%", "x", "Trial"]) {
    const r = await p.call("form_input", { ref, value });
    assert.equal(r.ok, false, value);
    assert.equal(r.error.code, "locked");
    assert.match(r.error.message, /^Locked: '.+' turns on a subscription/);
    assert.equal(sel.value, "once");
  }
  assert.equal((await p.call("form_input", { ref, value: "2" })).ok, true);
  assert.equal(sel.value, "2");
  // Already on the opt-in (the page preselected it): moving away is fine.
  sel.value = "sns";
  assert.equal((await p.call("form_input", { ref, value: "sns" })).ok, true, "keeping the current choice changes nothing");
  assert.equal((await p.call("form_input", { ref, value: "once" })).ok, true);
  assert.equal(sel.value, "once");
});

// User-directed unlock (request_unlock): lock_info, press_check_user and
// press_ref_user press checkout, sign in, subscribe and saved card controls
// with the expected class and label, and never an order or card form submit.
const box = (el) => (el.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, width: 100, height: 40, right: 110, bottom: 60 }));

test("press_check_user presses Proceed to checkout with its class and label, never Place order", async () => {
  const cart = load("cart", "/cart");
  const tree = (await cart.call("read_page", {})).result.tree;
  const ref = refIn(lineOf(tree, /Proceed to checkout/));
  const info = (await cart.call("lock_info", { ref })).result;
  assert.equal(info.locked, true);
  assert.equal(info.cls, "checkout");
  const target = [...cart.document.querySelectorAll("a,button")].find((e) => /Proceed to checkout/i.test(e.textContent));
  box(target);
  cart.document.elementFromPoint = () => target;
  assert.equal((await cart.call("press_check_user", { ref, label: info.label, cls: "account" })).error.code, "locked", "wrong class");
  assert.equal((await cart.call("press_check_user", { ref, label: "Sign in", cls: "checkout" })).error.code, "locked", "wrong label");
  const ok = await cart.call("press_check_user", { ref, label: info.label, cls: "checkout" });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.cls, "checkout");

  const checkout = load("checkout", "/checkout");
  const ctree = (await checkout.call("read_page", { filter: "all" })).result.tree;
  const place = refIn(lineOf(ctree, /Place order/));
  const pinfo = (await checkout.call("lock_info", { ref: place })).result;
  assert.equal(pinfo.locked, true);
  assert.equal(pinfo.cls, null, "Place order never unlocks on request");
  const btn = checkout.document.getElementById("place-order");
  box(btn);
  checkout.document.elementFromPoint = () => btn;
  let clicks = 0;
  btn.addEventListener("click", (e) => { clicks++; e.preventDefault(); });
  for (const cls of ["checkout", "marked", "account"]) {
    assert.equal((await checkout.call("press_check_user", { ref: place, label: pinfo.label, cls })).error.code, "locked", cls);
    assert.equal((await checkout.call("press_ref_user", { ref: place, label: pinfo.label, cls })).error.code, "locked", cls);
  }
  assert.equal(clicks, 0);
});

const SIGNIN = `<!doctype html><body>
<form id="f" action="/session" method="post">
  <label>Email <input id="email" name="email" type="email"></label>
  <label>Password <input id="pw" name="password" type="password" value="hunter2"></label>
  <button id="go" type="submit">Sign in</button>
</form>
<button id="sub" type="button">Subscribe</button>
<form id="card"><input autocomplete="cc-number" name="cardnumber"><button id="cont" type="submit">Continue</button></form>
</body>`;

test("passwords stay masked and refused; Sign in unlocks only for its own class and label", async () => {
  const p = loadPage(SIGNIN, { url: "https://shop.example/signin" });
  const tree = (await p.call("read_page", { filter: "all" })).result.tree;
  const pwLine = lineOf(tree, /textbox "Password"/);
  assert.doesNotMatch(tree, /hunter2/);
  assert.match(pwLine, /password/);
  const fill = await p.call("form_input", { ref: refIn(pwLine), value: "secret" });
  assert.equal(fill.ok, false);
  assert.equal(fill.error.code, "payment_field");
  assert.equal(p.document.getElementById("pw").value, "hunter2");
  p.document.getElementById("pw").focus();
  assert.equal((await p.call("focused_field", {})).result.password, true);

  const go = refIn(lineOf(tree, /button "Sign in"/));
  const info = (await p.call("lock_info", { ref: go })).result;
  assert.deepEqual([info.cls, info.password, info.passwordFilled], ["account", true, true]);
  const btn = p.document.getElementById("go");
  box(btn);
  p.document.elementFromPoint = () => btn;
  let clicks = 0;
  btn.addEventListener("click", (e) => { clicks++; e.preventDefault(); });
  assert.equal((await p.call("press_ref_user", { ref: go, label: "Sign up", cls: "account" })).error.code, "locked");
  assert.equal((await p.call("press_ref_user", { ref: go, label: "Sign in", cls: "account" })).ok, true);
  assert.equal(clicks, 1);
  assert.doesNotMatch(JSON.stringify(info), /hunter2/);

  const sub = (await p.call("lock_info", { ref: refIn(lineOf(tree, /Subscribe/)) })).result;
  assert.equal(sub.cls, "subscription");
  const cont = (await p.call("lock_info", { ref: refIn(lineOf(tree, /Continue/)) })).result;
  assert.equal(cont.kind, "payment-form");
  assert.equal(cont.cls, null, "card form submit never unlocks");
});

const PW_TRICKS = `<!doctype html><body>
<form id="f" action="/session" method="post">
  <label>Email <input id="email" name="email" type="email" value="me@example.com"></label>
  <input id="pw" name="pw" type="password" value="hunter2" aria-label="Your secret">
  <button id="show" type="button">Show</button>
  <input id="ac" type="text" autocomplete="current-password" value="ac-secret" aria-label="Secret A">
  <input id="np" type="text" autocomplete="new-password" value="np-secret" aria-label="Secret B">
  <input id="otc" type="text" autocomplete="one-time-code" value="111111" aria-label="Code A">
  <input id="byname" type="text" name="user_passcode" value="pc-secret" aria-label="Secret C">
  <input id="otp" type="text" name="otp" value="222222" aria-label="Code B">
  <label>Password <input id="bylabel" type="text" value="lbl-secret"></label>
  <input id="note" type="text" name="note" value="gift note" aria-label="Note">
  <button id="go" type="submit">Sign in</button>
</form>
<div data-clearcart-protected><button id="neutral" type="button">Continue</button></div>
</body>`;

test("passwords: a show-password toggle, autocomplete, name, id or label all count; masked and refused", async () => {
  const p = loadPage(PW_TRICKS, { url: "https://shop.example/signin" });
  const d = p.document;
  // The page flips the password to text after Orbi first saw it.
  d.getElementById("pw").setAttribute("type", "text");
  await new Promise((r) => setTimeout(r, 0));
  const tree = (await p.call("read_page", { filter: "all" })).result.tree;
  for (const secret of ["hunter2", "ac-secret", "np-secret", "111111", "pc-secret", "222222", "lbl-secret"]) assert.doesNotMatch(tree, new RegExp(secret), secret);
  assert.match(tree, /gift note/, "an ordinary field still reads");
  for (const id of ["pw", "ac", "np", "otc", "byname", "otp", "bylabel"]) {
    const el = d.getElementById(id);
    const ref = p.window.__clearcartPage.refFor(el);
    const r = await p.call("form_input", { ref, value: "typed" });
    assert.equal(r.ok, false, id);
    assert.equal(r.error.code, "payment_field", id);
    el.focus();
    assert.equal((await p.call("focused_field", {})).result.password, true, id);
  }
  const note = d.getElementById("note");
  assert.equal((await p.call("form_input", { ref: p.window.__clearcartPage.refFor(note), value: "hi" })).ok, true);
  note.focus();
  assert.notEqual((await p.call("focused_field", {})).result.password, true);
});

test("passwords: a field that turns into a password later is re-checked at type time", async () => {
  const p = loadPage(`<!doctype html><body><input id="x" type="text" aria-label="Field"></body>`, { url: "https://shop.example/" });
  const x = p.document.getElementById("x");
  x.focus();
  assert.notEqual((await p.call("focused_field", {})).result.password, true);
  x.setAttribute("type", "password");
  await new Promise((r) => setTimeout(r, 0));
  x.setAttribute("type", "text");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await p.call("focused_field", {})).result.password, true);
});

test("a marked control with a neutral label never unlocks on request", async () => {
  const p = loadPage(PW_TRICKS, { url: "https://shop.example/signin" });
  const btn = p.document.getElementById("neutral");
  box(btn);
  p.document.elementFromPoint = () => btn;
  let clicks = 0;
  btn.addEventListener("click", () => clicks++);
  const ref = p.window.__clearcartPage.refFor(btn);
  const info = (await p.call("lock_info", { ref })).result;
  assert.equal(info.locked, true);
  assert.equal(info.cls, null);
  for (const cls of ["marked", "checkout", "account"]) {
    assert.equal((await p.call("press_check_user", { ref, label: info.label, cls })).error.code, "locked", cls);
    assert.equal((await p.call("press_ref_user", { ref, label: info.label, cls })).error.code, "locked", cls);
  }
  assert.equal(clicks, 0);
});

test("press_check_user keeps the lock marker until press_done_user; press_hit_user hit-tests the point", async () => {
  const cart = load("cart", "/cart");
  const tree = (await cart.call("read_page", {})).result.tree;
  const ref = refIn(lineOf(tree, /Proceed to checkout/));
  const info = (await cart.call("lock_info", { ref })).result;
  const target = [...cart.document.querySelectorAll("a,button")].find((e) => /Proceed to checkout/i.test(e.textContent));
  box(target);
  cart.document.elementFromPoint = () => target;
  const MARK = cart.window.ClearcartProtect.LOCKED_ATTR;
  target.setAttribute(MARK, "");
  const t = { ref, label: info.label, cls: "checkout" };
  assert.equal((await cart.call("press_check_user", t)).ok, true);
  assert.ok(target.hasAttribute(MARK), "still marked before the press");
  assert.equal((await cart.call("press_hit_user", { ...t, x: 60, y: 40 })).ok, true);
  const other = cart.document.createElement("div");
  cart.document.body.appendChild(other);
  cart.document.elementFromPoint = () => other;
  assert.equal((await cart.call("press_hit_user", { ...t, x: 60, y: 40 })).error.code, "no_element", "covered or swapped");
  assert.equal((await cart.call("press_done_user", t)).ok, true);
  assert.ok(!target.hasAttribute(MARK));
});

// ------------------------------------------------ lock awareness for Claude
// Every refusal names the control and a ref Claude can pass to
// request_unlock, and says the next step. Payment controls never point at
// request_unlock.

const LINKS = `<!doctype html><body>
<a id="co" href="/checkout" class="btn"><span id="co-text">Proceed to checkout</span></a>
<div id="pseudo" onclick="void 0">Sign up</div>
<button id="buy" type="button">Buy now</button>
<button id="pay" type="button">Apple Pay</button>
<label><input id="sns" type="checkbox"> Subscribe and save 10%</label>
<form id="f" action="/session" method="post">
  <label>Email <input id="email" name="email" type="email"></label>
  <label>Password <input id="pw" name="password" type="password" value="x"></label>
  <button id="go" type="submit">Sign in</button>
</form>
</body>`;

test("lock refusals name the control's ref and send Claude to request_unlock, never for paying", async () => {
  const p = loadPage(LINKS, { url: "https://shop.example/cart" });
  const d = p.document;
  const refOf = (id) => p.window.__clearcartPage.refFor(d.getElementById(id));
  const next = (ref, label) => "call request_unlock with ref " + ref + " and label '" + label + "'";

  // A click by point on the span inside a checkout link: the link's ref.
  d.elementFromPoint = () => d.getElementById("co-text");
  let r = await p.call("guard_point", { x: 1, y: 1 });
  assert.equal(r.error.code, "locked");
  assert.match(r.error.message, /^Locked: 'Proceed to checkout' \(ref_\d+\) starts checkout/);
  assert.ok(r.error.message.includes(next(refOf("co"), "Proceed to checkout")), r.error.message);
  assert.match(r.error.message, /nothing was pressed/);
  // That ref is one request_unlock can use.
  const info = (await p.call("lock_info", { ref: refOf("co") })).result;
  assert.deepEqual([info.locked, info.cls], [true, "checkout"]);

  // A div styled as a button.
  d.elementFromPoint = () => d.getElementById("pseudo");
  r = await p.call("guard_point", { x: 1, y: 1 });
  assert.ok(r.error.message.includes(next(refOf("pseudo"), "Sign up")), r.error.message);

  // Enter in the password field: the form's submit button is named.
  d.getElementById("email").focus();
  r = await p.call("guard_key", { key: "Enter" });
  assert.equal(r.error.code, "locked");
  assert.ok(r.error.message.includes(next(refOf("go"), "Sign in")), r.error.message);
  // Space on a focused locked button.
  d.getElementById("go").focus();
  r = await p.call("guard_key", { key: " " });
  assert.ok(r.error.message.includes(next(refOf("go"), "Sign in")), r.error.message);

  // An uncheck-only box: turning it on goes through request_unlock.
  r = await p.call("form_input", { ref: refOf("sns"), value: true });
  assert.equal(r.error.code, "locked");
  assert.match(r.error.message, /can only be unchecked by the AI, so nothing was changed/);
  assert.ok(r.error.message.includes("if the user wants it on, " + next(refOf("sns"), "Subscribe and save 10%")), r.error.message);
  // Clicking its label is the same lock.
  d.elementFromPoint = () => d.querySelector("label");
  r = await p.call("guard_point", { x: 1, y: 1 });
  assert.ok(r.error.message.includes(next(refOf("sns"), "Subscribe and save 10%")), r.error.message);

  // Buy now and wallets: named, never request_unlock.
  for (const [id, re] of [["buy", /places the order or pays/], ["pay", /one-tap wallet/]]) {
    r = await p.call("guard_ref", { ref: refOf(id) });
    assert.equal(r.error.code, "locked", id);
    assert.match(r.error.message, re);
    assert.match(r.error.message, /Never call request_unlock for it/);
    assert.doesNotMatch(r.error.message, /call request_unlock with/);
  }
});

test("Place order and the card form never point at request_unlock; the lock's element stays out of JSON", async () => {
  const p = load("checkout", "/checkout");
  const tree = (await p.call("read_page", { filter: "all" })).result.tree;
  const r = await p.call("guard_ref", { ref: refIn(lineOf(tree, /Place order/)) });
  assert.match(r.error.message, /Never call request_unlock for it: paying goes only through request_checkout and pay_now/);
  p.document.querySelector('[name="cc-name"]').focus();
  const k = await p.call("guard_key", { key: "Enter" });
  assert.equal(k.error.code, "locked");
  assert.doesNotMatch(k.error.message, /call request_unlock with/);
  const P = p.window.ClearcartProtect;
  const lock = P.lockInChain(p.document.getElementById("place-order"));
  assert.ok(lock.el);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(lock))).sort(), ["checked", "kind", "label", "optin"]);
});

test("frames and hidden components are named as only the user's, with no ref", async () => {
  const p = loadPage(`<!doctype html><body><iframe id="w" src="about:blank"></iframe></body>`, { url: "https://shop.example/cart" });
  const P = p.window.ClearcartProtect;
  for (const kind of ["frame", "shadow"]) {
    const m = P.message({ kind, label: kind }, null);
    assert.match(m, /nothing was pressed/);
    assert.match(m, /only the user can/);
    assert.doesNotMatch(m, /request_unlock/);
  }
});

test("get_page_text lists the locked controls with refs shared with read_page", async () => {
  const cart = load("cart", "/cart");
  const text = (await cart.call("get_page_text", {})).result;
  const tree = (await cart.call("read_page", {})).result.tree;
  const co = text.locked.find((x) => /Proceed to checkout/.test(x.name));
  assert.equal(co.ref, refIn(lineOf(tree, /Proceed to checkout/)));
  assert.equal(co.uncheckOnly, undefined);
  // The pre-checked add-on does not block (it may be turned off) until it is off.
  assert.equal(text.locked.some((x) => /Subscribe/.test(x.name)), false);
  cart.document.getElementById("addon_subscription").checked = false;
  const again = (await cart.call("get_page_text", {})).result;
  const sub = again.locked.find((x) => /Subscribe/.test(x.name));
  assert.equal(sub.uncheckOnly, true);
  assert.equal(sub.ref, refIn(lineOf(tree, /Subscribe/)));
  // A page with no locked controls has no list.
  const product = (await load("product", "/product/cetirizine-30").call("get_page_text", {})).result;
  assert.equal(product.locked, undefined);
});

test("controls in a card form, and a password form with no button, never point at request_unlock", async () => {
  const p = loadPage(`<!doctype html><body>
<form id="card"><input autocomplete="cc-number" name="cardnumber"><button id="co" type="submit">Continue to checkout</button><button id="si" type="submit">Sign in</button></form>
<form id="pwf"><input id="u" name="u"><input id="pw" type="password" name="pw"></form>
</body>`, { url: "https://shop.example/pay" });
  const d = p.document;
  const refOf = (id) => p.window.__clearcartPage.refFor(d.getElementById(id));
  for (const id of ["co", "si"]) {
    const f = await p.call("form_input", { ref: refOf(id), value: "x" });
    assert.equal(f.error.code, "locked", id);
    assert.doesNotMatch(f.error.message, /call request_unlock with/, id);
    const g = await p.call("guard_ref", { ref: refOf(id) });
    assert.doesNotMatch(g.error.message, /call request_unlock with/, id);
    assert.equal((await p.call("lock_info", { ref: refOf(id) })).result.cls, null, id);
  }
  d.getElementById("u").focus();
  const k = await p.call("guard_key", { key: "Enter" });
  assert.equal(k.error.code, "locked");
  assert.doesNotMatch(k.error.message, /call request_unlock with/);
  const text = (await p.call("get_page_text", {})).result;
  assert.ok(text.locked.length >= 2);
  assert.ok(text.locked.every((x) => x.userOnly === true));
});
