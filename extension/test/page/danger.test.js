// Danger mode inside page.js (jsdom, inline HTML, no store): with it on,
// the button lock is off (no [locked] markers, no ERR.LOCKED, Place order
// and wallets included), while the masking of card and password fields
// and the refusal to type into them stay. Off, every lock is as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage } from "./harness.js";

const HTML = `
<form id="login" action="/login" method="post">
  <label>Email <input id="email" name="email"></label>
  <label>Password <input id="pw" type="password" name="password" value="hunter2-secret"></label>
  <button type="submit">Sign in</button>
</form>
<button type="button">Create account</button>
<form id="pay" action="/pay" method="post">
  <label>Card number <input id="cc" autocomplete="cc-number" value="4242424242424242"></label>
  <label>Security code <input id="cvc" name="cvc" value="123"></label>
  <button type="submit">Continue</button>
</form>
<button type="button">Place order · $14.27</button>
<button type="button">Buy now</button>
<button type="button">Apple Pay</button>
<button type="button">Proceed to checkout</button>
<button type="button">Subscribe &amp; Save</button>
<button type="button">Save card</button>
<div data-clearcart-protected><button type="button">Confirm</button></div>
<button type="button">Add to cart</button>
<form id="reauth" action="/account/confirm-purchase" method="post">
  <p>Enter your password to confirm this purchase.</p>
  <label>Your password <input id="pw2" type="password" name="pw2"></label>
  <button type="submit">Continue to confirm</button>
</form>
<form id="mixed" action="/login" method="post">
  <label>Password again <input id="pw3" type="password" name="pw3"></label>
  <button type="submit">Sign in</button>
  <button type="submit">Sign in and pay</button>
</form>
<button type="button">Sign up for Prime</button>`;

const lineOf = (tree, re) => tree.split("\n").find((l) => re.test(l));
const refIn = (line) => /\[(ref_\d+)\]/.exec(line)[1];
const call = (p, method, params, dangerMode) => p.send({ type: "page.call", method, params, dangerMode });

async function tree(p, dangerMode) {
  return (await call(p, "read_page", { filter: "all" }, dangerMode)).result.tree;
}

// Every control the lock covers with Danger mode off.
const LOCKED_OFF = [/"Sign in"/, /"Create account"/, /Place order/, /"Buy now"/, /"Apple Pay"/, /Proceed to checkout/, /Subscribe/,
  /"Save card"/, /"Confirm"/, /button "Continue"/, /"Continue to confirm"/, /"Sign in and pay"/, /"Sign up for Prime"/];

test("Danger mode off (the default): every protected control is locked, as before", async () => {
  const p = loadPage(HTML);
  for (const dm of [undefined, false]) {
    const t = await tree(p, dm);
    for (const re of LOCKED_OFF) {
      const line = lineOf(t, re);
      assert.match(line, /\[locked\]$/, String(re));
      const r = await call(p, "guard_ref", { ref: refIn(line) }, dm);
      assert.equal(r.error.code, "locked", String(re));
    }
    assert.doesNotMatch(lineOf(t, /"Add to cart"/), /locked/);
    for (const id of ["pw", "pw2", "cvc"]) {
      p.document.getElementById(id).focus();
      assert.equal((await call(p, "guard_key", { key: "Enter" }, dm)).error.code, "locked", id);
    }
  }
});

test("Danger mode on: no control is locked, Place order and wallets included", async () => {
  const p = loadPage(HTML);
  const t = await tree(p, true);
  assert.doesNotMatch(t, /\[locked\]|\[uncheck only\]/);
  for (const re of LOCKED_OFF) {
    const line = lineOf(t, re);
    assert.ok(line, String(re));
    const r = await call(p, "guard_ref", { ref: refIn(line) }, true);
    assert.equal(r.ok, true, String(re));
    // A click by ref goes through too.
    assert.equal((await call(p, "click_ref", { ref: refIn(line) }, true)).ok, true, String(re));
  }
  // Enter in a password or card form submits it.
  for (const id of ["pw", "pw2", "pw3", "cvc", "email"]) {
    p.document.getElementById(id).focus();
    assert.equal((await call(p, "guard_key", { key: "Enter" }, true)).ok, true, id);
  }
  // find carries no lock either.
  const found = (await call(p, "find", { query: "Place order" }, true)).result;
  assert.ok(!JSON.stringify(found).includes('"locked":true'), JSON.stringify(found));
  // The pay flow's own press still only takes an order button.
  const signIn = await call(p, "press_check", { ref: refIn(lineOf(t, /"Sign in"/)) }, true);
  assert.match(signIn.error.message, /only presses an order button/);
  // Place order passes that check (jsdom has no layout, so it stops at visibility).
  const order = await call(p, "press_check", { ref: refIn(lineOf(t, /Place order/)) }, true);
  assert.doesNotMatch(String(order.error && order.error.message), /only presses an order button/);
  // No badges or gray-out on controls.
  assert.equal(p.document.querySelectorAll("button[data-clearcart-locked]").length, 0);
});

test("Danger mode on: card and password values stay masked and refused", async () => {
  const p = loadPage(HTML);
  const t = await tree(p, true);
  assert.doesNotMatch(t, /4242424242424242|hunter2|value="123"/);
  assert.match(lineOf(t, /textbox "Password"/), /value="\[masked\]"/);
  assert.match(lineOf(t, /textbox "Card number"/), /value="\[masked\]"/);
  for (const re of [/textbox "Card number"/, /textbox "Security code"/, /textbox "Password"/]) {
    const line = lineOf(t, re);
    assert.ok(line, String(re));
    const r = await call(p, "form_input", { ref: refIn(line), value: "4000056655665556" }, true);
    assert.equal(r.ok, false, String(re));
    assert.equal(r.error.code, "payment_field", String(re));
  }
  const email = refIn(lineOf(t, /textbox "Email"/));
  assert.equal((await call(p, "form_input", { ref: email, value: "4242 4242 4242 4242" }, true)).error.code, "payment_field");
  const text = (await call(p, "get_page_text", {}, true)).result;
  assert.doesNotMatch(JSON.stringify(text), /4242424242424242|hunter2/);
  p.document.getElementById("pw").focus();
  assert.equal((await call(p, "focused_field", {}, true)).result.password, true);
});

test("focus in a frame: a card field in a same-origin frame, or any cross-origin frame, refuses typing", async () => {
  for (const dm of [true, false]) {
    const p = loadPage(`<iframe id="same"></iframe><iframe id="cross" tabindex="0"></iframe>`);
    const same = p.document.getElementById("same");
    same.contentDocument.body.innerHTML = '<input id="cc" autocomplete="cc-number">';
    same.contentDocument.getElementById("cc").focus();
    const a = (await call(p, "focused_field", {}, dm)).result;
    assert.equal(a.payment, true, "same-origin card field " + dm);
    const cross = p.document.getElementById("cross");
    Object.defineProperty(cross, "contentDocument", { get: () => null });
    cross.focus();
    const b = (await call(p, "focused_field", {}, dm)).result;
    assert.equal(b.payment, true, "cross-origin frame " + dm);
  }
});

