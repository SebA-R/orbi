// DOM rules of the button lock (content/protect.js) in jsdom: forms with
// payment or password fields, the data-clearcart-protected marker, labels,
// uncheck-only boxes, keys and the badge overlay. Real hit-testing runs in
// Chromium (chromium.test.js); jsdom has no layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const MASK = src("../../content/mask.js");
const PROTECT = src("../../content/protect.js");

function load(html) {
  const dom = new JSDOM(html, { url: "http://localhost:4000/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(MASK);
  dom.window.eval(PROTECT);
  const P = dom.window.ClearcartProtect;
  const $ = (s) => dom.window.document.querySelector(s);
  return { dom, P, $, document: dom.window.document, window: dom.window };
}

test("the submit of a form with card fields is locked whatever it says", () => {
  const { P, $ } = load(`<form>
    <label>Card number <input name="cardnumber"></label>
    <button id="go">Continue</button>
    <button id="plain" type="button">Apply coupon</button>
  </form>`);
  assert.equal(P.lockOf($("#go")).kind, "payment-form");
  assert.equal(P.lockOf($("#plain")), null, "a type=button is not the submit");
});

test("the submit of a password form is an account control", () => {
  const { P, $ } = load(`<form><input name="email"><input type="password" name="pw"><input type="submit" id="s" value="Continue"></form>`);
  assert.deepEqual({ ...P.lockOf($("#s")) }, { kind: "account", label: "Continue", optin: false, checked: false });
});

test("data-clearcart-protected locks the element and anything inside it", () => {
  const { P, $ } = load(`<div data-clearcart-protected><button id="a">Go</button><span id="s">x</span></div>`);
  assert.equal(P.lockOf($("#a")).kind, "marked");
  assert.equal(P.lockInChain($("#s")).kind, "marked");
});

test("ids count for commit words", () => {
  const { P, $ } = load(`<button id="place-order">→</button><button id="buyNowButton"><img alt=""></button><a id="login-help" href="/h">?</a>`);
  assert.equal(P.lockOf($("#place-order")).kind, "order");
  assert.equal(P.lockOf($("#buyNowButton")).kind, "order");
  assert.equal(P.lockOf($("#login-help")), null);
});

test("aria-label and aria-labelledby name the control", () => {
  const { P, $ } = load(`<div role="button" id="ap" aria-label="Buy with Apple Pay"></div>
    <span id="lbl">Place order</span><button id="lb" aria-labelledby="lbl">→</button>`);
  assert.equal(P.lockOf($("#ap")).kind, "express");
  assert.equal(P.lockOf($("#lb")).label, "Place order");
});

test("a click on the inside of a link or button is a click on it", () => {
  const { P, $ } = load(`<a href="/checkout"><span><b id="in">Checkout</b></span></a><button id="add"><span id="in2">Add to cart</span></button>`);
  assert.equal(P.lockInChain($("#in")).kind, "order");
  assert.equal(P.lockInChain($("#in2")), null);
});

test("uncheck-only boxes: blocked while off, allowed while on, labels stand for their box", () => {
  const { P, $ } = load(`<label id="l1"><input type="checkbox" id="on" checked> Subscribe &amp; Save: auto-deliver every 30 days (+$4.99 membership)</label>
    <label id="l2"><input type="checkbox" id="off"> Save this card for next time</label>
    <label><input type="radio" name="p" id="once"> One-time purchase</label>`);
  const on = P.lockOf($("#on"));
  assert.equal(on.kind, "subscription");
  assert.ok(on.optin && on.checked);
  assert.equal(P.blocks(on), false, "unchecking is allowed");
  assert.equal(P.lockInChain($("#on")), null);
  assert.equal(P.lockInChain($("#l1")), null, "clicking the label unchecks: allowed");
  assert.equal(P.lockInChain($("#off")).kind, "payment-method");
  assert.equal(P.lockInChain($("#l2")).kind, "payment-method", "clicking the label would check it");
  assert.equal(P.lockOf($("#once")), null);
});

test("lockAt uses elementFromPoint and walks up", () => {
  const { P, $, document } = load(`<a href="/checkout" id="co"><span id="t">Checkout</span></a><p id="x">hello</p><iframe id="f"></iframe>`);
  document.elementFromPoint = () => $("#t");
  assert.equal(P.lockAt(document, 5, 5).kind, "order");
  document.elementFromPoint = () => $("#x");
  assert.equal(P.lockAt(document, 5, 5), null);
  document.elementFromPoint = () => null;
  assert.equal(P.lockAt(document, 5, 5), null);
});

test("lockAt locks a frame it cannot look into", () => {
  const { P, document } = load(`<iframe id="f"></iframe>`);
  const frame = document.getElementById("f");
  Object.defineProperty(frame, "contentDocument", { get: () => null });
  document.elementFromPoint = () => frame;
  assert.equal(P.lockAt(document, 5, 5).kind, "frame");
});

test("keys: Enter and Space on a locked control, Enter in a payment or login form", () => {
  const { P, $ } = load(`<button id="b">Place order</button><button id="ok">Add to cart</button>
    <form id="pay"><input id="addr" name="address"><input name="cc-number" autocomplete="cc-number"><textarea id="ta"></textarea><button>Continue</button></form>
    <form role="search"><input id="q" name="q"><button>Search</button></form>
    <form><input id="email" name="email"><input type="password"><button>Next</button></form>
    <form><input id="qty" name="qty"><button>Proceed to checkout</button></form>`);
  const at = (sel, key) => {
    $(sel).focus();
    return P.lockForKey($(sel).ownerDocument, key);
  };
  assert.equal(at("#b", "Enter").kind, "order");
  assert.equal(at("#b", " ").kind, "order");
  assert.equal(at("#b", "Tab"), null);
  assert.equal(at("#ok", "Enter"), null);
  assert.equal(at("#addr", "Enter").kind, "payment-form");
  assert.equal(at("#addr", "Space"), null, "Space in a field just types");
  assert.equal(at("#ta", "Enter"), null, "Enter in a textarea is a new line");
  assert.equal(at("#q", "Enter"), null, "search still works");
  assert.equal(at("#email", "Enter").kind, "account");
  assert.equal(at("#qty", "Enter").kind, "order");
});

test("listLocks finds every locked control, and the store's shopping controls are not among them", () => {
  const { P, document } = load(`<form action="/cart/add"><input name="quantity" value="1"><button id="add-to-cart">Add to cart</button></form>
    <form action="/cart/remove"><button>Remove</button></form>
    <form id="cart-form"><label><input type="checkbox" name="addon_subscription" checked> Subscribe &amp; Save: auto-deliver every 30 days (+$4.99 membership)</label>
    <button id="checkout-button">Proceed to checkout</button></form>
    <a href="/checkout-guide">Checkout guide</a>`);
  const found = Array.from(P.listLocks(document), (x) => `${x.lock.kind}:${x.lock.label}${x.lock.optin ? ":optin" : ""}`);
  // Labels are clipped to 60 characters.
  assert.deepEqual(found, ["subscription:Subscribe & Save: auto-deliver every 30 days (+$4.99 member\u2026:optin", "order:Proceed to checkout"]);
});

test("badges: aria-hidden overlay outside <body>, pointer-events none, idempotent", () => {
  const { P, document, window } = load(`<button id="b">Place order</button><button>Add to cart</button>`);
  // jsdom has no layout; give the button a box.
  document.getElementById("b").getBoundingClientRect = () => ({ left: 10, top: 40, right: 110, bottom: 80, width: 100, height: 40, x: 10, y: 40 });
  const before = document.body.innerHTML;
  assert.equal(P.showBadges(document), 1);
  assert.equal(P.showBadges(document), 1);
  const hosts = document.querySelectorAll("#" + P.BADGE_HOST_ID);
  assert.equal(hosts.length, 1);
  const host = hosts[0];
  assert.equal(host.parentNode, document.documentElement);
  assert.equal(host.getAttribute("aria-hidden"), "true");
  assert.match(host.style.cssText, /pointer-events: none/);
  assert.equal(document.body.innerHTML.replace(' data-clearcart-locked=""', ""), before, "the page body is untouched but for the gray mark");
  assert.equal(host.shadowRoot, null, "closed shadow root");
  assert.equal(window.document.body.textContent.includes("Locked for AI"), false);
});

test("listbox options and tabs are selection controls: one-time purchase stays selectable", () => {
  const { P, $ } = load(`<div role="listbox">
    <div role="option" id="once" aria-selected="false">One-time purchase</div>
    <div role="option" id="sub" aria-selected="true">Subscribe &amp; save 10%</div>
    <div role="option" id="sub2" aria-selected="false">Subscribe &amp; save 15%</div>
  </div>`);
  assert.equal(P.lockOf($("#once")), null);
  assert.equal(P.lockInChain($("#sub")), null, "selected subscription: choosing another option is allowed");
  assert.equal(P.lockInChain($("#sub2")).kind, "subscription", "picking a subscription is not");
});

test("gray marks: on what the AI is locked out of, never disabled, gone once unlocked or re-rendered", () => {
  const { P, $, document } = load(`<button id="po">Place order</button><button id="add">Add to cart</button>
    <label><input type="checkbox" id="on" checked> Subscribe &amp; Save</label>
    <label><input type="checkbox" id="off"> Save this card</label>
    <form id="pay"><input id="addr" name="address"><input id="cc" name="cc-number" autocomplete="cc-number"><select id="exp"><option>12</option></select><textarea id="note"></textarea><button id="go">Continue</button></form>
    <form><input id="email" name="email"><input id="pw" type="password"><button id="next">Next</button></form>
    <form role="search"><input id="q" name="q"><button id="s">Search</button></form>`);
  P.showBadges(document);
  const marked = (s) => $(s).hasAttribute(P.LOCKED_ATTR);
  for (const s of ["#po", "#off", "#addr", "#cc", "#exp", "#note", "#go", "#email", "#pw", "#next"]) assert.ok(marked(s), s);
  for (const s of ["#add", "#on", "#q", "#s"]) assert.ok(!marked(s), s);
  for (const el of document.querySelectorAll("button,input,select,textarea")) {
    for (const a of ["disabled", "aria-disabled", "inert"]) assert.ok(!el.hasAttribute(a), `${el.id} ${a}`);
    assert.ok(!/pointer-events/.test(el.getAttribute("style") || ""), el.id);
  }
  assert.ok(document.getElementById("clearcart-lock-style"), "one stylesheet");

  P.release($("#po"));
  $("#next").textContent = "Search";
  $("#pw").remove();
  P.showBadges(document);
  assert.ok(!marked("#po"), "the single-use press is no longer grayed");
  assert.ok(!marked("#next") && !marked("#email"), "re-rendered as unlocked");
});

test("gray marks come off when the extension goes away", () => {
  const { P, $, document } = load(`<button id="po">Place order</button>`);
  let alive = true;
  P.showBadges(document, { alive: () => alive });
  assert.ok($("#po").hasAttribute(P.LOCKED_ATTR));
  alive = false;
  P.showBadges(document);
  assert.ok(!$("#po").hasAttribute(P.LOCKED_ATTR));
  assert.equal(document.getElementById("clearcart-lock-style"), null);
  assert.equal(document.getElementById(P.BADGE_HOST_ID), null);
});
