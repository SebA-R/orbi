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
  const dom = new JSDOM(html, { url: "https://shop.example/", runScripts: "outside-only", pretendToBeVisual: true });
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

// takesCard keeps one scan for a synchronous burst; a new tick scans again.
const tick = () => new Promise((r) => setTimeout(r, 0));

test("Checkout and Continue to payment unlock only on a page that takes no card", async () => {
  // The shipping step: address fields, a captcha frame, a tracking pixel.
  let { P, $, document } = load(`<form id="ship"><input name="address1"><button id="next">Continue to payment</button></form>
    <button id="proceed" type="button">Proceed to payment</button><button id="co" type="button">Checkout</button>`);
  const next = P.lockOf($("#next"));
  assert.equal(next.kind, "order");
  assert.equal(P.unlockClass(next, $("#next")), "checkout");
  assert.equal(P.unlockClass(P.lockOf($("#proceed")), $("#proceed")), "checkout");
  assert.equal(P.unlockClass(P.lockOf($("#co")), $("#co")), "checkout");
  assert.match(P.message(next, "ref_2", $("#next")), /next checkout step.*request_unlock/);
  const frame = (src, w, h) => {
    const f = document.createElement("iframe");
    f.setAttribute("src", src);
    // A cross-origin frame: its document cannot be read.
    Object.defineProperty(f, "contentDocument", { get: () => { throw new Error("cross-origin"); } });
    f.getBoundingClientRect = () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h });
    document.body.appendChild(f);
    return f;
  };
  frame("https://www.google.com/recaptcha/api2/anchor", 256, 60);
  frame("https://px.ads.example/t", 1, 1);
  await tick();
  assert.equal(P.unlockClass(next, $("#next")), "checkout", "captcha and pixel frames are fine");
  // Hosted card fields in a frame: the same button may pay, Checkout too.
  const card = frame("https://js.stripe.com/v3/elements-inner-card", 400, 40);
  await tick();
  assert.equal(P.unlockClass(next, $("#next")), null, "hosted card fields");
  assert.equal(P.unlockClass(P.lockOf($("#co")), $("#co")), null, "Checkout next to hosted card fields");
  card.remove();
  await tick();
  assert.equal(P.unlockClass(next, $("#next")), "checkout");
  // A card field anywhere on the page, or the card form's own submit.
  ({ P, $ } = load(`<form id="ship"><input name="address1"><button id="next">Continue to payment</button></form>
    <form><label>Card number <input name="cardnumber"></label><button id="card">Continue to payment</button></form>`));
  assert.equal(P.unlockClass(P.lockOf($("#next")), $("#next")), null, "card field elsewhere on the page");
  assert.equal(P.unlockClass(P.lockOf($("#card")), $("#card")), null, "a card form's submit never unlocks");
  ({ P, $ } = load(`<label>Card number <input name="cardnumber"></label><button id="co">Proceed to checkout</button>`));
  assert.equal(P.unlockClass(P.lockOf($("#co")), $("#co")), null, "Checkout on a page with a card field");
  // By label alone (no element): Checkout as before, a step never.
  assert.equal(P.unlockClass({ kind: "order", label: "Proceed to checkout", optin: false }), "checkout");
  assert.equal(P.unlockClass({ kind: "order", label: "Continue to payment", optin: false }), null);
});

test("card fields in shadow roots, in the parent of a frame, or behind an unreadable host keep the steps locked", async () => {
  // An open shadow root holding hosted card fields.
  let { P, $, document, window } = load(`<div id="host"></div><button id="next" type="button">Continue to payment</button>`);
  const lock = () => P.lockOf($("#next"));
  assert.equal(P.unlockClass(lock(), $("#next")), "checkout");
  const sr = $("#host").attachShadow({ mode: "open" });
  sr.innerHTML = `<label>Card number <input name="cardnumber"></label>`;
  await tick();
  assert.equal(P.unlockClass(lock(), $("#next")), null, "open shadow root");
  // A closed root, read through chrome.dom.
  ({ P, $, document, window } = load(`<pay-box id="host"><span>Pay box</span></pay-box><button id="next" type="button">Continue to payment</button>`));
  const closed = $("#host").attachShadow({ mode: "closed" });
  closed.innerHTML = `<input autocomplete="cc-number">`;
  window.chrome = { dom: { openOrClosedShadowRoot: (el) => (el.id === "host" ? closed : null) } };
  assert.equal(P.unlockClass(P.lockOf($("#next")), $("#next")), null, "closed shadow root through chrome.dom");
  // No chrome.dom (the page main world): a custom element's root cannot
  // be read, so it fails closed; a plain page still unlocks.
  ({ P, $ } = load(`<pay-box id="host"></pay-box><button id="next" type="button">Continue to payment</button>`));
  assert.equal(P.unlockClass(P.lockOf($("#next")), $("#next")), null, "unreadable custom element");
  ({ P, $ } = load(`<div id="spinner"></div><button id="next" type="button">Continue to payment</button>`));
  assert.equal(P.unlockClass(P.lockOf($("#next")), $("#next")), "checkout", "an empty plain box is not a card host");
  // The button in a same-origin frame, the card field in the parent.
  ({ P, $, document } = load(`<label>Card number <input name="cardnumber"></label><iframe id="f"></iframe>`));
  const inner = $("#f").contentDocument;
  inner.body.innerHTML = `<button id="next" type="button">Continue to payment</button>`;
  const btn = inner.getElementById("next");
  assert.equal(P.unlockClass({ kind: "order", label: "Continue to payment", optin: false }, btn), null, "card field in the parent document");
  ({ P, $ } = load(`<p>Shipping</p><iframe id="f"></iframe>`));
  const inner2 = $("#f").contentDocument;
  inner2.body.innerHTML = `<button id="next" type="button">Continue to payment</button>`;
  assert.equal(P.unlockClass({ kind: "order", label: "Continue to payment", optin: false }, inner2.getElementById("next")), "checkout", "same-origin frame, no card anywhere");
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

test("listLocks finds every locked control, and a cart's shopping controls are not among them", () => {
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

// Regressions from the security review of the button lock.

test("a Place order button outside its form with form=id locks Enter in the form's fields", () => {
  const { P, $ } = load(`<form id="f" action="/order"><input id="addr" name="address"><input id="note" name="note"></form>
    <button form="f" id="po">Place order</button>
    <form id="g"><input id="q" name="q"></form><button form="g">Search</button>`);
  assert.equal(P.lockOf($("#po")).kind, "order");
  $("#addr").focus();
  assert.equal(P.lockForKey($("#addr").ownerDocument, "Enter").kind, "order", "Enter in a non-card field submits through Place order");
  $("#note").focus();
  assert.equal(P.lockForKey($("#note").ownerDocument, "Enter").kind, "order");
  assert.equal(P.lockForSubmit($("#f")).kind, "order");
  $("#q").focus();
  assert.equal(P.lockForKey($("#q").ownerDocument, "Enter"), null, "an outside Search button stays usable");
});

test("lockAt reads closed shadow roots through chrome.dom and fails closed without it", () => {
  const { P, document, window } = load(`<pay-button id="host"></pay-button><p id="plain">hello</p>`);
  const host = document.getElementById("host");
  const sr = host.attachShadow({ mode: "closed" });
  sr.innerHTML = `<button id="inner">Place order</button>`;
  const inner = sr.getElementById("inner");
  sr.elementFromPoint = () => inner;
  document.elementFromPoint = () => host;
  assert.equal(host.shadowRoot, null);
  // No chrome.dom (the page main world): an unreadable host is locked.
  assert.equal(P.lockAt(document, 5, 5).kind, "shadow");
  // The content script: chrome.dom.openOrClosedShadowRoot opens it.
  window.chrome = { dom: { openOrClosedShadowRoot: (el) => (el === host ? sr : null) } };
  const l = P.lockAt(document, 5, 5);
  assert.equal(l.kind, "order");
  assert.equal(l.label, "Place order");
  sr.innerHTML = `<button id="inner">Add to cart</button>`;
  const add = sr.getElementById("inner");
  sr.elementFromPoint = () => add;
  assert.equal(P.lockAt(document, 5, 5), null, "a harmless button in a closed root still works");
  document.elementFromPoint = () => document.getElementById("plain");
  assert.equal(P.lockAt(document, 5, 5), null);
});

test("focus inside a closed shadow root: Enter is read through chrome.dom, else fails closed", () => {
  const { P, document, window } = load(`<pay-button id="host"></pay-button>`);
  const host = document.getElementById("host");
  const sr = host.attachShadow({ mode: "closed" });
  sr.innerHTML = `<button id="inner">Buy now</button>`;
  sr.getElementById("inner").focus();
  assert.equal(P.lockForKey(document, "Enter").kind, "shadow");
  window.chrome = { dom: { openOrClosedShadowRoot: (el) => (el === host ? sr : null) } };
  assert.equal(P.lockForKey(document, "Enter").kind, "order");
});

test("a <div onclick> or pointer-cursor div with no role that says Place order is locked", () => {
  const { P, $, document } = load(`<style>.btn{cursor:pointer}</style>
    <div id="d1" onclick="go()">Place order</div>
    <div id="d2" class="btn"><span id="d2s">Place order</span></div>
    <div id="card" class="btn"><span id="cs">Place order</span> <span>for delivery to your home address by Tuesday next week</span></div>
    <div id="d3" tabindex="0">Buy now</div>
    <div id="ok" class="btn">Add to cart</div>
    <div id="plain">Place order</div>
    <label class="btn" id="lab"><input type="checkbox" id="sub" checked> <span id="labs">Subscribe &amp; Save</span></label>`);
  assert.equal(P.lockOf($("#d1")).kind, "order");
  assert.equal(P.lockInChain($("#d1")).kind, "order");
  assert.equal(P.lockInChain($("#d2s")).kind, "order", "inherited pointer: the span under the click names it");
  assert.equal(P.lockOf($("#d2")).kind, "order");
  assert.equal(P.lockInChain($("#cs")).kind, "order", "the hit text counts even inside a long clickable card");
  assert.equal(P.lockOf($("#d3")).kind, "order");
  assert.equal(P.lockInChain($("#ok")), null);
  assert.equal(P.lockOf($("#plain")), null, "plain text that is not clickable is not a control");
  assert.equal(P.lockInChain($("#labs")), null, "unchecking through a pointer label still works");
  document.elementFromPoint = () => $("#d2s");
  assert.equal(P.lockAt(document, 1, 1).kind, "order");
  assert.ok(P.listLocks(document).some((x) => x.el.id === "d1"), "listLocks lists the onclick div");
});
