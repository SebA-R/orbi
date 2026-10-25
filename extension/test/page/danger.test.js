// Danger mode inside page.js (jsdom, inline HTML, no store): sign in and
// sign up are no longer locked, while the order button, wallets, checkout,
// subscribe, card forms and the masking of card and password fields stay.
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

const STAY_LOCKED = [/Place order/, /"Buy now"/, /"Apple Pay"/, /Proceed to checkout/, /Subscribe/, /"Save card"/, /"Confirm"/, /button "Continue"/];

test("Danger mode off (the default): sign in and sign up are locked", async () => {
  const p = loadPage(HTML);
  const t = await tree(p, undefined);
  assert.match(lineOf(t, /"Sign in"/), /\[locked\]$/);
  assert.match(lineOf(t, /"Create account"/), /\[locked\]$/);
  const r = await call(p, "guard_ref", { ref: refIn(lineOf(t, /"Sign in"/)) });
  assert.equal(r.error.code, "locked");
});

test("Danger mode on: sign in and sign up are pressable; every money and checkout control stays locked", async () => {
  const p = loadPage(HTML);
  const t = await tree(p, true);
  assert.doesNotMatch(lineOf(t, /"Sign in"/), /locked/);
  assert.doesNotMatch(lineOf(t, /"Create account"/), /locked/);
  assert.equal((await call(p, "guard_ref", { ref: refIn(lineOf(t, /"Sign in"/)) }, true)).ok, true);
  for (const re of STAY_LOCKED) {
    const line = lineOf(t, re);
    assert.match(line, /\[locked\]$/, String(re));
    const r = await call(p, "guard_ref", { ref: refIn(line) }, true);
    assert.equal(r.ok, false, String(re));
    assert.equal(r.error.code, "locked", String(re));
  }
  // A password form that pays, or whose other submit pays, stays locked.
  assert.match(lineOf(t, /"Continue to confirm"/), /\[locked\]$/);
  assert.match(lineOf(t, /"Sign in and pay"/), /\[locked\]$/);
  const mixed = t.split("\n").filter((l) => /button "Sign in"/.test(l));
  assert.equal(mixed.length, 2);
  assert.match(mixed[1], /\[locked\]$/, "a Sign in next to Sign in and pay stays locked");
  assert.match(lineOf(t, /"Sign up for Prime"/), /\[locked\]$/);
  p.document.getElementById("pw2").focus();
  assert.equal((await call(p, "guard_key", { key: "Enter" }, true)).error.code, "locked");
  p.document.getElementById("pw3").focus();
  assert.equal((await call(p, "guard_key", { key: "Enter" }, true)).error.code, "locked");
  // Enter in the plain login form is allowed.
  p.document.getElementById("email").focus();
  assert.equal((await call(p, "guard_key", { key: "Enter" }, true)).ok, true);
  // Enter in the card form still submits nothing.
  p.document.getElementById("cvc").focus();
  assert.equal((await call(p, "guard_key", { key: "Enter" }, true)).error.code, "locked");
  // The pay flow's own press still only takes an order button.
  const press = await call(p, "press_check", { ref: refIn(lineOf(t, /"Sign in"/)) }, true);
  assert.equal(press.ok, false);
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

test("Danger mode comes only from the message: params and anything but true are ignored", async () => {
  const p = loadPage(HTML);
  for (const v of [undefined, false, "true", 1, {}]) {
    const t = (await call(p, "read_page", { filter: "all", dangerMode: true }, v)).result.tree;
    assert.match(lineOf(t, /"Sign in"/), /\[locked\]$/, JSON.stringify(v));
  }
  // On, then off again on the next call.
  await tree(p, true);
  assert.match(lineOf(await tree(p, false), /"Sign in"/), /\[locked\]$/);
});
