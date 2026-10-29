// Word-list rules of the button lock classifier (extension/content/protect.js).
import { test } from "node:test";
import assert from "node:assert/strict";

// protect.js is a classic content script; it puts its API on globalThis.
await import("../../../extension/content/protect.js");
const P = globalThis.ClearcartProtect;

const kind = (label, opts) => P.classifyLabel(label, opts);

test("order commits and money moves are locked", () => {
  for (const l of [
    "Place order",
    "Place order · $14.27",
    "Place your order",
    "Buy now",
    "Buy it now",
    "Pay",
    "Pay $58.28",
    "Pay now",
    "Complete purchase",
    "Submit order",
    "Confirm order",
    "Confirm and pay",
    "Checkout",
    "Check out",
    "Secure checkout",
    "Proceed to checkout",
    "Continue to checkout",
    "Continue to payment",
    "Purchase",
    "Donate $5",
  ]) assert.equal(kind(l), "order", l);
});

test("express wallets and one-click buttons are locked", () => {
  for (const l of ["Apple Pay", "Buy with Apple Pay", "Google Pay", "GPay", "PayPal", "Pay with PayPal", "Shop Pay", "Amazon Pay", "Express checkout", "Buy with 1-Click", "One-click buy", "Klarna"]) {
    assert.equal(kind(l), "express", l);
  }
});

test("subscriptions and saved cards are locked", () => {
  for (const l of ["Subscribe", "Subscribe & Save", "Start free trial", "Start your free trial", "Join now", "Upgrade"]) assert.equal(kind(l), "subscription", l);
  for (const l of ["Add payment method", "Add card", "Save card", "Save this card", "Add new card"]) assert.equal(kind(l), "payment-method", l);
});

test("sign in and account creation are locked", () => {
  for (const l of ["Sign in", "Sign In", "Log in", "Login", "Sign up", "Create account", "Create an account", "Register", "Continue with Google", "Sign in with Apple"]) {
    assert.equal(kind(l), "account", l);
  }
});

test("shopping controls stay unlocked", () => {
  for (const l of [
    "Add to cart",
    "Add to bag",
    "Add to Bag - $48",
    "Remove",
    "Remove from cart",
    "Update cart",
    "Quantity",
    "Increase quantity",
    "Search",
    "Size S",
    "Black",
    "Continue shopping",
    "View cart",
    "Cart (1)",
    "Close",
    "Reject all cookies",
    "Next",
  ]) assert.equal(kind(l), null, l);
});

test("help, guide and undo links that mention checkout are not locked", () => {
  for (const l of [
    "Checkout guide",
    "Checkout help",
    "Learn more about Klarna",
    "Pay in 4 with Klarna. Learn more",
    "Shipping and returns policy",
    "How to pay",
    "Edit payment method",
    "Remove card",
    "Unsubscribe",
    "Sign out",
    "Log out",
    "Back to checkout",
    "Cancel order",
    "Check out our new arrivals for fall",
  ]) assert.equal(kind(l), null, l);
});

test("long labels are sentences, not buttons", () => {
  assert.equal(kind("Buy one get one free on all fall sweaters this weekend only"), null);
  assert.equal(kind("Free shipping on orders over $50 when you checkout today"), null);
});

test("words match whole words only", () => {
  assert.equal(kind("Payment options"), null); // "pay" is not "payment"
  assert.equal(kind("Buying guide"), null);
  assert.equal(kind("Express shipping"), null); // "express" alone is shipping
  assert.equal(kind("Loginov sweater"), null);
  assert.equal(kind("Paypal"), "express");
});

test("checkboxes: opt-ins are caught with long labels, order words are not", () => {
  const box = { checkable: true };
  assert.equal(kind("Subscribe & Save: auto-deliver every 30 days (+$4.99 membership)", box), "subscription");
  assert.equal(kind("Save this card for future purchases", box), "payment-method");
  assert.equal(kind("Create an account for faster checkout next time", box), "account");
  // "One-time purchase" is the safe choice next to Subscribe & Save.
  assert.equal(kind("One-time purchase", box), null);
  assert.equal(kind("Gift wrap this order", box), null);
});

test("normalize reads & as and and drops punctuation", () => {
  assert.equal(P.normalize("Subscribe & Save!"), " subscribe and save ");
  assert.equal(P.normalize("1-Click®"), " 1 click ");
});

test("activation keys", () => {
  for (const k of ["Enter", "Return", "NumpadEnter", " ", "Space", "ctrl+Enter", "Shift+Space"]) assert.ok(P.isActivationKey(k), k);
  for (const k of ["Tab", "Escape", "ArrowDown", "a", "PageDown"]) assert.ok(!P.isActivationKey(k), k);
});

test("only order commits are pressable by the internal pay flow", () => {
  assert.ok(P.pressable({ kind: "order", optin: false }));
  assert.ok(P.pressable({ kind: "marked", optin: false }));
  assert.ok(P.pressable({ kind: "payment-form", optin: false }));
  for (const k of ["account", "express", "subscription", "payment-method", "frame"]) assert.ok(!P.pressable({ kind: k, optin: false }), k);
  assert.ok(!P.pressable({ kind: "marked", optin: true }));
  assert.ok(!P.pressable(null));
});

test("messages name the control and never offer a way around", () => {
  assert.equal(P.message({ kind: "order", label: "Place order" }), "Locked: 'Place order' places the order or pays, so nothing was pressed. Never call request_unlock for it: paying goes only through request_checkout and pay_with_saved_card, after the user's yes.");
  assert.match(P.message({ kind: "account", label: "Sign in" }), /signs in or creates an account, so it needs the user's permission/);
  assert.match(P.message({ kind: "subscription", label: "Subscribe", optin: true }), /can only be unchecked/);
  assert.match(P.message({ kind: "frame", label: "embedded frame" }), /embedded frame/);
  assert.match(P.message({ kind: "express", label: "Apple Pay" }), /only the user can press it/i);
});

test("unlockClass: checkout, account, subscription and saved card unlock on request; paying never does", () => {
  const lock = (label, extra = {}) => ({ kind: P.classifyLabel(label), label, optin: false, checked: false, ...extra });
  for (const l of ["Checkout", "Proceed to checkout", "Secure checkout", "Go to checkout"]) assert.equal(P.unlockClass(lock(l)), "checkout", l);
  // A checkout step that only moves on stays locked and is still not
  // checkout navigation for the desktop lock or the pay flow's order
  // buttons. It unlocks only with its element, on a page that takes no card
  // (jsdom: extension/test/page/protect.test.js); by label alone, never.
  for (const l of ["Continue to payment", "Proceed to payment", "Continue to billing"]) {
    assert.equal(P.classifyLabel(l), "order", l);
    assert.equal(P.isCheckoutStep(l), true, l);
    assert.equal(P.isCheckoutNav(l), false, l);
    assert.equal(P.unlockClass(lock(l)), null, l);
    assert.match(P.message({ ...lock(l), cls: "checkout" }, "ref_3"), /next checkout step.*request_unlock/, l);
  }
  for (const l of ["Place order", "Buy now", "Pay now", "Pay and checkout", "Pay and continue to payment", "Continue to payment and place order", "Submit payment", "Confirm payment", "Complete payment", "Checkout and place order", "Confirm purchase"]) {
    assert.equal(P.unlockClass(lock(l)), null, l);
  }
  for (const l of ["Apple Pay", "Checkout with PayPal", "Shop Pay"]) assert.equal(P.unlockClass(lock(l)), null, l);
  assert.equal(P.unlockClass(lock("Sign in")), "account");
  assert.equal(P.unlockClass(lock("Create account")), "account");
  assert.equal(P.unlockClass(lock("Subscribe")), "subscription");
  assert.equal(P.unlockClass(lock("Save card")), "payment-method");
  // Marked controls (data-clearcart-protected) never unlock on request.
  for (const l of ["Continue", "Proceed to checkout", "Sign in", "Subscribe"]) assert.equal(P.unlockClass({ kind: "marked", label: l }), null, "marked " + l);
  for (const kind of ["payment-form", "express", "frame", "shadow"]) assert.equal(P.unlockClass({ kind, label: "Continue" }), null, kind);
  assert.equal(P.unlockClass(null), null);
});

test("sameLabel: equal after normalizing, or a long clipped prefix", () => {
  assert.ok(P.sameLabel("Proceed to checkout", "proceed to Checkout"));
  assert.ok(P.sameLabel("Subscribe & Save: deliver every…", "Subscribe and Save: deliver every 30 days"));
  assert.ok(!P.sameLabel("Sign in", "Sign up"));
  assert.ok(!P.sameLabel("", "Sign in"));
});
