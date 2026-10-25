// Clearcart button lock: which page controls the AI may never press.
//
// Classic script (no ES module syntax), like mask.js. The worker injects it
// after mask.js and before page.js; the agent server also runs it inside the
// page for the Open Claude in Chrome path. It sets globalThis.ClearcartProtect,
// and under Node (tests, the agent) it also sets module.exports.
//
// A control is protected when it commits an order or moves money (place
// order, buy now, pay, checkout, express wallets), subscribes or saves a
// payment method, signs in or creates an account, is the submit control of a
// form that holds payment or password fields, or sits inside an element
// marked data-clearcart-protected. Checkboxes and radios that opt into a
// subscription, saved card or account are "uncheck only": the AI may turn
// them off but never on. Shopping controls (add to cart, quantity, remove)
// are never protected.
//
// The lock applies to the agent's tools only. Nothing here touches what a
// person can click, and the lock badge is aria-hidden with pointer-events
// none, so a screen reader user hears the page exactly as before.
(function (root) {
  "use strict";

  // ------------------------------------------------------------ word lists
  // Phrases are matched as whole words against a normalized label: lower
  // case, "&" read as "and", everything that is not a letter or digit turned
  // into a space. Keep every list here so the tests cover them in one place.
  var PHRASES = {
    // Commits an order or moves money. pay_now may press these on an
    // allowlisted origin after the user's spoken yes.
    order: [
      "place order", "place your order", "place my order",
      "submit order", "submit my order", "submit payment",
      "confirm order", "confirm my order", "confirm purchase", "confirm and pay", "confirm payment",
      "complete order", "complete my order", "complete purchase", "complete my purchase", "complete payment",
      "finish order", "order now", "buy", "buy now", "buy it now", "buy again", "purchase",
      "pay", "pay now", "make payment", "make a payment", "send payment", "authorize payment", "donate",
      "checkout", "check out", "secure checkout", "proceed to checkout", "continue to checkout", "go to checkout",
      "continue to payment", "proceed to payment", "continue to billing",
    ],
    // One-tap wallets and buy-now-pay-later: never pressed by anyone but the user.
    express: [
      "apple pay", "google pay", "g pay", "gpay", "paypal", "pay pal", "shop pay", "shoppay", "amazon pay",
      "venmo", "klarna", "afterpay", "affirm", "sezzle", "express checkout", "express pay",
      "one click", "1 click", "buy with",
    ],
    // Recurring charges.
    subscription: [
      "subscribe", "subscribe and save", "start trial", "start free trial", "start my free trial",
      "start your free trial", "free trial", "try free", "try it free", "join now", "become a member",
      "upgrade", "upgrade now", "enroll", "auto deliver", "autoship", "auto ship", "membership",
    ],
    // Stores a card on the site.
    "payment-method": [
      "add payment method", "add a payment method", "add payment", "add card", "add a card", "add new card",
      "add credit card", "add debit card", "save card", "save this card", "save my card", "save payment",
      "save payment method", "save payment details", "remember card", "remember this card",
    ],
    // Clearcart never logs in or creates accounts.
    account: [
      "sign up", "signup", "sign in", "signin", "log in", "login", "create account", "create an account",
      "create my account", "register", "continue with google", "continue with apple", "continue with facebook",
      "continue with amazon", "sign in with", "log in with",
    ],
  };

  // A label with any of these words is navigation, help or an undo, not a
  // commit: "Remove from cart", "Checkout guide", "Continue shopping",
  // "Learn more about Klarna". Applies to the word lists only; a marked
  // element or the submit of a payment form stays locked whatever it says.
  var NEGATIVE = [
    "remove", "delete", "cancel", "undo", "edit", "change", "close", "dismiss", "no thanks", "not now", "skip",
    "help", "guide", "faq", "faqs", "learn", "learn more", "policy", "policies", "terms", "info", "information",
    "about", "how", "what", "why", "details", "continue shopping", "back to", "return to", "view", "unsubscribe",
    "sign out", "log out", "logout", "signout",
  ];

  // Labels longer than this many words are sentences or product titles, not
  // buttons ("Check out our new arrivals and staff picks for fall").
  var MAX_WORDS = 6;
  // Checkbox and radio labels run long ("Subscribe & Save: auto-deliver every
  // 30 days (+$4.99 membership)").
  var MAX_WORDS_CHECKABLE = 20;
  // "check out" is also everyday English; only a short label counts.
  var SHORT_ONLY = { "check out": 3 };

  // Kinds the internal pay flow may press once unlocked. Wallets,
  // subscriptions, saved cards, accounts and frames never unlock.
  var PRESSABLE = { order: 1, marked: 1, "payment-form": 1 };
  // User-directed unlock (agent request_unlock): the classes of locked
  // control the user may ask Clearcart to press once. "checkout" is only a
  // control that goes to the checkout page ("Proceed to checkout"), never
  // one that pays. Placing an order, wallets, card or password form submits,
  // frames and hidden components never unlock this way: paying goes only
  // through request_checkout and pay_now.
  var CHECKOUT_NAV = ["checkout", "check out", "secure checkout", "proceed to checkout", "continue to checkout",
    "go to checkout"];

  // Kinds that make a checkbox or radio uncheck-only.
  var OPTIN_KINDS = { subscription: 1, "payment-method": 1, account: 1, express: 1 };

  function normalize(s) {
    return (" " + String(s == null ? "" : s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ") + " ")
      .replace(/\s+/g, " ");
  }

  function has(norm, phrase) {
    return norm.indexOf(" " + phrase + " ") !== -1;
  }

  function wordCount(norm) {
    var t = norm.trim();
    return t ? t.split(" ").length : 0;
  }

  var KIND_ORDER = ["account", "payment-method", "subscription", "express", "order"];

  // Kind of a label by the word lists, or null. checkable: the label belongs
  // to a checkbox, radio or switch (longer labels allowed, order words
  // ignored so "One-time purchase" stays selectable).
  function classifyLabel(label, opts) {
    var checkable = !!(opts && opts.checkable);
    var norm = normalize(label);
    var words = wordCount(norm);
    if (!words || words > (checkable ? MAX_WORDS_CHECKABLE : MAX_WORDS)) return null;
    for (var i = 0; i < NEGATIVE.length; i++) if (has(norm, NEGATIVE[i])) return null;
    for (var k = 0; k < KIND_ORDER.length; k++) {
      var kind = KIND_ORDER[k];
      if (checkable && !OPTIN_KINDS[kind]) continue;
      var list = PHRASES[kind];
      for (var j = 0; j < list.length; j++) {
        var p = list[j];
        if (SHORT_ONLY[p] && words > SHORT_ONLY[p]) continue;
        if (has(norm, p)) return kind;
      }
    }
    return null;
  }

  // True when an "order" label only goes to checkout: it has a checkout
  // phrase and no other order or money word ("Checkout", "Proceed to
  // checkout", not "Pay and checkout" or "Checkout and place order").
  function isCheckoutNav(label) {
    var norm = normalize(label);
    var nav = false;
    for (var i = 0; i < CHECKOUT_NAV.length; i++) if (has(norm, CHECKOUT_NAV[i])) nav = true;
    if (!nav) return false;
    var rest = norm;
    var sorted = CHECKOUT_NAV.slice().sort(function (a, b) { return b.length - a.length; });
    for (var j = 0; j < sorted.length; j++) rest = rest.split(" " + sorted[j] + " ").join(" ");
    var order = PHRASES.order;
    for (var k = 0; k < order.length; k++) if (has(rest, order[k])) return false;
    return true;
  }

  // Unlock class of a lock for request_unlock: "checkout", "account",
  // "subscription" or "payment-method", or null when it never unlocks on
  // request. el (optional): the control; the submit of a card form never
  // unlocks, whatever it says.
  function unlockClass(lock, el) {
    if (!lock) return null;
    if (el && el.nodeType === 1 && isSubmit(el) && formKind(el.form) === "payment-form") return null;
    // A marked control (data-clearcart-protected) never unlocks on request,
    // whatever its label says: the page marked it for the pay flow only.
    if (el && el.nodeType === 1 && el.closest && el.closest("[data-clearcart-protected]")) return null;
    switch (lock.kind) {
      case "order": return !lock.optin && isCheckoutNav(lock.label) ? "checkout" : null;
      case "account": return "account";
      case "subscription": return "subscription";
      case "payment-method": return "payment-method";
      default: return null; // marked, express, payment-form, frame, shadow
    }
  }

  // Danger mode, the user's setting (off by default, lib/settings.js
  // dangerMode, turned on only by the user through the two-press switch in
  // the popup or options page). While it is on, the button lock is off: no
  // control, form, frame or hidden component is locked or grayed out, and
  // the agent presses whatever it needs, Place order included. What stays
  // on is data safety, not the lock: card and password fields are still
  // masked and never typed into (mask.js, page.js, the worker), and the
  // blocklist is the worker's. Set by whoever runs this classifier from the
  // extension's own settings (the worker, per page call); the page and the
  // agent cannot set it. Off, every lock below is exactly as before.
  var danger = false;

  // True when Danger mode lifts this lock: any lock, while it is on.
  function dangerLifts(lock) {
    return !!lock && danger;
  }

  function setDangerMode(on) {
    var next = on === true;
    if (next !== danger) {
      danger = next;
      if (badgeState) schedule();
    }
    return danger;
  }

  // Same control name, loosely: equal after normalize, or one a long prefix
  // of the other (labels are clipped to 60 characters).
  function sameLabel(a, b) {
    var x = normalize(a).trim().replace(/…$/, "").trim();
    var y = normalize(b).trim().replace(/…$/, "").trim();
    return !!x && !!y && (x === y || (x.length >= 12 && y.indexOf(x) === 0) || (y.length >= 12 && x.indexOf(y) === 0));
  }

  // ------------------------------------------------------------- the DOM
  var Mask = function () { return root.ClearcartMask || null; };

  function text(node) {
    if (!node) return "";
    var out = "";
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeType === 1) {
        var t = c.tagName;
        if (t === "SCRIPT" || t === "STYLE" || t === "INPUT" || t === "TEXTAREA" || t === "SELECT") continue;
        if (c.getAttribute("aria-hidden") === "true") continue;
        if (t === "IMG") out += " " + (c.getAttribute("alt") || "") + " ";
        else out += " " + text(c) + " ";
      }
    }
    return out;
  }

  function squash(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function inputType(el) {
    return el.tagName === "INPUT" ? String(el.getAttribute("type") || "text").toLowerCase() : "";
  }

  function roleAttr(el) {
    return String(el.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase();
  }

  // Checkboxes, radios and other selection controls (listbox options, tabs):
  // choosing one picks an option rather than committing anything, so order
  // words are ignored ("One-time purchase") and opt-ins are uncheck-only.
  function isCheckable(el) {
    var t = inputType(el);
    if (t === "checkbox" || t === "radio") return true;
    var r = roleAttr(el);
    return r === "checkbox" || r === "radio" || r === "switch" || r === "menuitemcheckbox" || r === "menuitemradio" ||
      r === "option" || r === "tab";
  }

  function isSubmit(el) {
    if (el.tagName === "BUTTON") return String(el.getAttribute("type") || "submit").toLowerCase() === "submit";
    var t = inputType(el);
    return t === "submit" || t === "image";
  }

  // Elements a click or key press can activate.
  function isControl(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === "BUTTON" || tag === "SUMMARY") return true;
    if (tag === "A" && el.hasAttribute("href")) return true;
    if (tag === "INPUT") {
      var t = inputType(el);
      return t === "submit" || t === "button" || t === "image" || t === "checkbox" || t === "radio" || t === "reset";
    }
    var r = roleAttr(el);
    return r === "button" || r === "link" || r === "menuitem" || r === "checkbox" || r === "radio" || r === "switch" ||
      r === "menuitemcheckbox" || r === "menuitemradio" || r === "tab" || r === "option";
  }

  var REAL_CONTROLS = "a[href],button,summary,input,select,textarea,label,[role=button],[role=link],[role=menuitem]," +
    "[role=checkbox],[role=radio],[role=switch],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option]";

  // A <div onclick> or a styled <span> with no role: sites build "Place
  // order" out of these too. It counts when it has an onclick handler, a
  // tabindex, or a pointer cursor (where the pointer starts, not inherited),
  // and holds no real control of its own (a wrapper around a checkbox and
  // its label is not one big button). Only its own text names it. hit: el
  // is the element under the click, which counts with an inherited pointer
  // cursor too ("Place order" in a span inside a long clickable card).
  function isPseudoControl(el, hit) {
    if (!el || el.nodeType !== 1 || isControl(el)) return false;
    var tag = el.tagName;
    if (tag === "HTML" || tag === "BODY" || tag === "LABEL" || FORM_FIELD_TAGS[tag]) return false;
    if (el.querySelector && el.querySelector(REAL_CONTROLS)) return false;
    // Inside a real control or a <label>, that control decides.
    var up = el.parentElement;
    if (up && up.closest && up.closest(REAL_CONTROLS)) return false;
    if (el.hasAttribute("onclick") || typeof el.onclick === "function") return true;
    if (el.hasAttribute("tabindex") && Number(el.getAttribute("tabindex")) >= 0) return true;
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return false;
    try {
      if (view.getComputedStyle(el).cursor !== "pointer") return false;
      if (hit) return true;
      var p = parentOf(el);
      return !p || p.nodeType !== 1 || view.getComputedStyle(p).cursor !== "pointer";
    } catch (_) { return false; }
  }

  var FORM_FIELD_TAGS = { INPUT: 1, SELECT: 1, TEXTAREA: 1, OPTION: 1, FORM: 1, IFRAME: 1, IMG: 1 };

  // What a person (or screen reader) would call the control.
  function labelOf(el) {
    var s;
    var ids = el.getAttribute("aria-labelledby");
    if (ids && el.ownerDocument) {
      s = squash(ids.split(/\s+/).map(function (id) { return text(el.ownerDocument.getElementById(id)); }).join(" "));
      if (s) return s;
    }
    if ((s = squash(el.getAttribute("aria-label")))) return s;
    if (el.tagName === "INPUT") {
      var t = inputType(el);
      if (t === "submit" || t === "button" || t === "reset") return squash(el.value || el.getAttribute("value") || (t === "submit" ? "Submit" : ""));
      if (t === "image") return squash(el.getAttribute("alt") || "Submit");
      try {
        if (el.labels && el.labels.length) {
          s = squash(Array.prototype.map.call(el.labels, text).join(" "));
          if (s) return s;
        }
      } catch (_) { /* not labelable */ }
      return squash(el.getAttribute("title") || "");
    }
    if ((s = squash(text(el)))) return s;
    return squash(el.getAttribute("title") || el.getAttribute("alt") || "");
  }

  // "place-order" and "checkoutButton" read as words for the word lists.
  function idWords(el) {
    return [el.id, el.getAttribute("name")].filter(Boolean).join(" ")
      .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ");
  }

  function isPaymentInput(el) {
    var M = Mask();
    if (M && M.isPaymentField(el)) return true;
    var ac = String(el.getAttribute("autocomplete") || "").toLowerCase();
    return /(^|\s)cc-/.test(ac);
  }

  // "payment-form" when the form holds card fields, "account" when it holds
  // a password field, else null.
  function formKind(form) {
    if (!form || !form.elements) return null;
    var pw = false;
    for (var i = 0; i < form.elements.length; i++) {
      var f = form.elements[i];
      if (isPaymentInput(f)) return "payment-form";
      if (inputType(f) === "password") pw = true;
    }
    return pw ? "account" : null;
  }

  // Password fields. A field stays a password once it was ever seen as
  // type=password, so a show-password toggle or a runtime type change does
  // not expose it. Also: autocomplete current-password, new-password or
  // one-time-code, or a name, id or label that says password, passcode or
  // otp. Button-like and checkable inputs are never value fields.
  var everPassword = typeof WeakSet === "function" ? new WeakSet() : null;
  var PW_AUTOCOMPLETE = /(^|\s)(current-password|new-password|one-time-code)(\s|$)/i;
  var PW_WORDS = /password|passwd|passcode|pass code|(^|[^a-z])otp([^a-z]|$)/i;
  var NOT_VALUE = { submit: 1, button: 1, reset: 1, image: 1, checkbox: 1, radio: 1, file: 1, hidden: 1 };

  function passwordHay(el) {
    var parts = [el.getAttribute("name"), el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder")];
    if (el.labels) for (var i = 0; i < el.labels.length; i++) parts.push(el.labels[i].textContent);
    var by = el.getAttribute("aria-labelledby");
    if (by && el.ownerDocument) {
      by.split(/\s+/).forEach(function (id) {
        var n = id && el.ownerDocument.getElementById(id);
        if (n) parts.push(n.textContent);
      });
    }
    // camelCase and snake_case to words: "userOtp", "otp_code".
    return parts.filter(Boolean).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  }

  function isPasswordField(el) {
    if (!el || el.nodeType !== 1 || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return false;
    if (everPassword && everPassword.has(el)) return true;
    var t = inputType(el);
    if (t === "password") {
      if (everPassword) everPassword.add(el);
      return true;
    }
    if (NOT_VALUE[t]) return false;
    var hit = PW_AUTOCOMPLETE.test(String(el.getAttribute("autocomplete") || "")) || PW_WORDS.test(passwordHay(el));
    if (hit && everPassword) everPassword.add(el);
    return hit;
  }

  // Marks every current type=password field (and the root itself), so a
  // later type change still counts as a password.
  function markPasswords(node) {
    if (!node || !everPassword) return;
    if (node.nodeType === 1 && node.tagName === "INPUT" && inputType(node) === "password") everPassword.add(node);
    if (typeof node.querySelectorAll !== "function") return;
    var all = node.querySelectorAll("input[type=password i]");
    for (var i = 0; i < all.length; i++) everPassword.add(all[i]);
  }

  // Watches doc for password fields: new ones, and fields whose type was
  // password before a change. Returns the observer (or null).
  function watchPasswords(doc) {
    markPasswords(doc);
    var MO = doc && doc.defaultView && doc.defaultView.MutationObserver;
    if (typeof MO !== "function" || !everPassword) return null;
    var ob = new MO(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "attributes") {
          if (String(m.oldValue || "").toLowerCase() === "password") everPassword.add(m.target);
          markPasswords(m.target);
        } else {
          for (var j = 0; j < m.addedNodes.length; j++) markPasswords(m.addedNodes[j]);
        }
      }
    });
    ob.observe(doc.documentElement || doc, { subtree: true, childList: true, attributes: true, attributeFilter: ["type"], attributeOldValue: true });
    return ob;
  }

  // Password fields of the form el submits: { password, filled }. Never the
  // value itself.
  function passwordState(el) {
    var form = el && (el.form || (el.closest && el.closest("form")));
    var out = { password: false, filled: false };
    if (!form || !form.elements) return out;
    for (var i = 0; i < form.elements.length; i++) {
      var f = form.elements[i];
      if (!isPasswordField(f)) continue;
      out.password = true;
      if (String(f.value || "").length) out.filled = true;
    }
    return out;
  }

  function checkedOf(el) {
    if (el.tagName === "INPUT") return !!el.checked;
    return el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true";
  }

  function clip(s) {
    s = squash(s);
    var M = Mask();
    if (M) s = M.maskCardRuns(s);
    s = s.replace(/'/g, "’");
    return s.length > 60 ? s.slice(0, 59) + "…" : s;
  }

  // Lock of one element, or null. { kind, label, optin, checked }. hit: el
  // is the element under the pointer (see isPseudoControl). None while
  // Danger mode is on.
  function lockOf(el, hit) {
    return danger ? null : classify(el, hit);
  }

  // The lock an element would have with Danger mode off, whatever the mode.
  // For press_protected, which presses only an order button in either mode.
  function classify(el, hit) {
    if (!el || el.nodeType !== 1) return null;
    var marked = el.closest ? el.closest("[data-clearcart-protected]") : null;
    var control = isControl(el);
    var pseudo = !control && isPseudoControl(el, !!hit);
    if (pseudo) control = true;
    if (!control && !marked) return null;
    var label = control ? labelOf(el) : labelOf(marked);
    var checkable = control && isCheckable(el);
    var checked = checkable && checkedOf(el);
    if (marked) return { kind: "marked", label: clip(label || "this control"), optin: checkable, checked: checked };
    var kind = classifyLabel(label, { checkable: checkable });
    if (!kind && !checkable && !pseudo) {
      var idk = classifyLabel(idWords(el), { checkable: false });
      // Ids only count for commit and money words; an id like "login-help"
      // or "account-menu" is too loose to lock on.
      if (idk && idk !== "account") kind = idk;
    }
    if (!kind && isSubmit(el)) kind = formKind(el.form);
    if (!kind) return null;
    return { kind: kind, label: clip(label || kind), optin: checkable, checked: checked };
  }

  // Does activating this lock's element do something the AI may not do?
  // An uncheck-only box blocks only while it is off.
  function blocks(lock) {
    return !!lock && (!lock.optin || !lock.checked);
  }

  function parentOf(n) {
    if (n.parentElement) return n.parentElement;
    var p = n.parentNode;
    return p && p.nodeType === 11 && p.host ? p.host : null;
  }

  // First blocking lock on el or an ancestor (a click on the <span> inside a
  // "Buy now" link activates the link). A <label> stands for its control.
  function lockInChain(el) {
    if (danger) return null;
    for (var n = el; n && n.nodeType === 1; n = parentOf(n)) {
      var l = lockOf(n, n === el);
      if (l && blocks(l)) return withEl(l, n);
      if (l) return null; // an uncheck-only box that is on: the click turns it off
      if (n.tagName === "LABEL" && n.control) {
        var c = lockOf(n.control);
        if (c && blocks(c)) return withEl(c, n.control);
      }
    }
    return null;
  }

  // Remembers which control a lock is for (lock.el, not enumerable, so it
  // never reaches JSON), for the ref in the refusal Claude gets back. The
  // shared frame and shadow locks name no control.
  function withEl(lock, el) {
    if (lock && el && el.nodeType === 1 && lock !== FRAME_LOCK && lock !== SHADOW_LOCK) {
      Object.defineProperty(lock, "el", { value: el, configurable: true, writable: true, enumerable: false });
    }
    return lock;
  }

  var FRAME_TAGS = { IFRAME: 1, FRAME: 1, OBJECT: 1, EMBED: 1, FENCEDFRAME: 1 };
  var FRAME_LOCK = { kind: "frame", label: "embedded frame", optin: false, checked: false };

  // The frame's document, or null when it is cross-origin.
  function frameDoc(el) {
    try { return el.contentDocument || null; } catch (_) { return null; }
  }

  var SHADOW_LOCK = { kind: "shadow", label: "hidden component", optin: false, checked: false };
  // Hosts that may hold a closed shadow root: custom elements, and empty
  // boxes whose content must come from somewhere.
  var NO_SHADOW_TAGS = { IMG: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, BUTTON: 1, A: 1, IFRAME: 1, FRAME: 1, OBJECT: 1, EMBED: 1,
    VIDEO: 1, AUDIO: 1, CANVAS: 1, SVG: 1, svg: 1, BR: 1, HR: 1, HTML: 1, BODY: 1, OPTION: 1, LABEL: 1 };

  function closedRootApi() {
    try {
      var c = root.chrome || (typeof chrome !== "undefined" ? chrome : null); // eslint-disable-line no-undef
      var f = c && c.dom && c.dom.openOrClosedShadowRoot;
      return typeof f === "function" ? function (el) { try { return f.call(c.dom, el) || null; } catch (_) { return null; } } : null;
    } catch (_) { return null; }
  }

  function mayHostShadow(el) {
    if (NO_SHADOW_TAGS[el.tagName]) return false;
    if (el.tagName.indexOf("-") !== -1) return true;
    return !el.firstElementChild && !squash(el.textContent);
  }

  // The shadow root of el, open or closed. The content script reads closed
  // roots through chrome.dom.openOrClosedShadowRoot; where that API is
  // missing (the page main world on the Open Claude in Chrome path), an
  // element that may host a closed root returns SHADOW_UNKNOWN so the
  // caller fails closed.
  var SHADOW_UNKNOWN = {};
  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    var api = closedRootApi();
    if (api) return api(el);
    return mayHostShadow(el) ? SHADOW_UNKNOWN : null;
  }

  // Blocking lock under viewport point (x, y), or null. Descends open and
  // closed shadow roots and same-origin frames; a cross-origin frame (hosted
  // payment fields, wallet buttons) or a shadow root it cannot read is
  // locked.
  function lockAt(doc, x, y) {
    if (danger) return null;
    if (!doc || typeof doc.elementFromPoint !== "function") return null;
    var el = doc.elementFromPoint(x, y);
    var guard = 0;
    while (el && guard++ < 20) {
      var sr = shadowOf(el);
      if (sr === SHADOW_UNKNOWN) return lockInChain(el) || SHADOW_LOCK;
      if (!sr || typeof sr.elementFromPoint !== "function") break;
      var inner = sr.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (guard > 20) return SHADOW_LOCK;
    if (!el) return null;
    if (FRAME_TAGS[el.tagName]) {
      var sub = frameDoc(el);
      if (!sub) return FRAME_LOCK;
      var r = el.getBoundingClientRect();
      return lockAt(sub, x - r.left, y - r.top) || lockInChain(el);
    }
    return lockInChain(el);
  }

  // The focused element, through open and closed shadow roots, or
  // SHADOW_UNKNOWN when focus sits on a host whose root cannot be read.
  function deepActive(doc) {
    var el = doc.activeElement;
    var guard = 0;
    while (el && guard++ < 20) {
      var sr = shadowOf(el);
      if (sr === SHADOW_UNKNOWN) return SHADOW_UNKNOWN;
      if (!sr || !sr.activeElement) break;
      el = sr.activeElement;
    }
    return el;
  }

  var ENTER = /^(enter|return|numpadenter|kp_enter)$/i;
  var SPACE = /^( |space|spacebar)$/i;

  // The key part of "Enter", "ctrl+Enter", "Shift+Space", " ".
  function keyName(spec) {
    var s = String(spec == null ? "" : spec);
    if (s === " ") return " ";
    var parts = s.split("+");
    return parts[parts.length - 1].trim() || (s.indexOf(" ") !== -1 ? " " : "");
  }

  function isActivationKey(spec) {
    var k = keyName(spec);
    return ENTER.test(k) || SPACE.test(k);
  }

  // Blocking lock for pressing key with the current focus, or null. Enter
  // in a field also submits its form, so a field in a payment, password or
  // order form is locked too.
  function lockForKey(doc, spec) {
    if (danger) return null;
    var k = keyName(spec);
    var enter = ENTER.test(k);
    if (!enter && !SPACE.test(k)) return null;
    var el = doc && deepActive(doc);
    if (el === SHADOW_UNKNOWN) return SHADOW_LOCK;
    if (!el || el === doc.body || el === doc.documentElement) return null;
    if (FRAME_TAGS[el.tagName]) {
      var sub = frameDoc(el);
      return sub ? lockForKey(sub, spec) : FRAME_LOCK;
    }
    var chain = lockInChain(el);
    if (chain) return chain;
    if (enter && el.form && (el.tagName === "INPUT" || el.tagName === "SELECT")) {
      var t = inputType(el);
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return null;
      return lockForSubmit(el.form);
    }
    return null;
  }

  // Blocking lock for submitting form without a pressed button (Enter in a
  // field, implicit submission): locked when the form holds payment or
  // password fields, or when any of its submit buttons, inside the form or
  // tied to it with form="id", would be locked.
  function lockForSubmit(form) {
    if (danger || !form) return null;
    var fk = formKind(form);
    if (fk) {
      var fl = { kind: fk, label: clip(formLabel(form) || "this form"), optin: false, checked: false };
      var first = submitsOf(form)[0];
      // No submit button: nothing request_unlock could press.
      if (!first) Object.defineProperty(fl, "cls", { value: null, configurable: true, writable: true, enumerable: false });
      return withEl(fl, first);
    }
    var subs = submitsOf(form);
    for (var i = 0; i < subs.length; i++) {
      var l = lockOf(subs[i]);
      if (l && blocks(l)) return withEl(l, subs[i]);
    }
    return null;
  }

  // Submit buttons of form in tree order, including those outside it with
  // form="id" (form.elements has both).
  function submitsOf(form) {
    var els = form.elements || form.querySelectorAll("button,input");
    return Array.prototype.filter.call(els, function (e) {
      return (e.tagName === "BUTTON" || e.tagName === "INPUT") && isSubmit(e);
    });
  }

  function formLabel(form) {
    var subs = submitsOf(form);
    return subs.length ? labelOf(subs[0]) : form.getAttribute("aria-label") || "";
  }

  // The error Claude gets back when a click, key or form_input would press
  // a locked control. Never includes field values. It names the control,
  // its ref when known (ref, e.g. from page.js refFor(lock.el)), says that
  // nothing was pressed, and gives the one next step: request_unlock for a
  // control the user may unlock on request (unlockClass), never for one
  // that pays. lock.cls, when set, is unlockClass worked out where the
  // element was (the OCIC path's page script).
  // el (optional): the control, when the caller found it and lock.el is unset.
  function message(lock, ref, el) {
    var label = lock && lock.label ? lock.label : "this control";
    var name = "'" + label + "'" + (ref ? " (" + ref + ")" : "");
    var cls = lock && lock.cls !== undefined ? lock.cls : unlockClass(lock, el || (lock && lock.el));
    var unlock = "call request_unlock with " + (ref ? "ref " + ref + " and label '" + label + "'" : "label '" + label + "' and its ref from read_page or find") +
      "; it asks the user itself when needed. Do not retry the click or look for another way around it.";
    var userOnly = " Only the user can press it. Never call request_unlock for it; tell the user where it is if they want it.";
    var pay = " Never call request_unlock for it: paying goes only through request_checkout and pay_now, on a Clearcart pay site. Elsewhere, tell the user they can finish it themselves.";
    switch (lock && lock.kind) {
      case "frame":
        return "Locked: that point is inside an embedded frame, often a payment widget, that Clearcart cannot inspect, so nothing was pressed. The AI may not click inside it; only the user can.";
      case "shadow":
        return "Locked: that point is inside a hidden page component that Clearcart cannot inspect, so nothing was pressed. The AI may not click or press keys inside it; only the user can.";
    }
    if (lock && lock.optin) {
      return "Locked: " + name + " can only be unchecked by the AI, so nothing was changed. Turning it on needs the user's permission:" +
        (cls ? " if the user wants it on, " + unlock : " only the user can turn it on. Never call request_unlock for it.");
    }
    switch (lock && lock.kind) {
      case "account":
        return "Locked: " + name + " signs in or creates an account, so it needs the user's permission and nothing was pressed." + (cls ? " If the user wants this, " + unlock : userOnly);
      case "subscription":
      case "payment-method":
        return "Locked: " + name + " subscribes or saves payment details, so it needs the user's permission and nothing was pressed." + (cls ? " If the user wants this, " + unlock : userOnly);
      case "express":
        return "Locked: " + name + " is a one-tap wallet or pay later button, so nothing was pressed." + userOnly;
      default:
        if (cls === "checkout") return "Locked: " + name + " starts checkout, so it needs the user's permission and nothing was pressed. If the user wants this, " + unlock;
        return "Locked: " + name + " places the order or pays, so nothing was pressed." + pay;
    }
  }

  // Every protected control in the document, for badges and listings.
  // Capped so a huge page cannot stall the content script.
  var CANDIDATES = "a[href],button,summary,input[type=submit],input[type=button],input[type=image],input[type=checkbox]," +
    "input[type=radio],[role=button],[role=link],[role=menuitem],[role=checkbox],[role=radio],[role=switch]," +
    "[role=tab],[role=option],[onclick],[tabindex],[data-clearcart-protected]";

  function listLocks(doc, max) {
    var out = [];
    if (danger || !doc || !doc.querySelectorAll) return out;
    max = max || 200;
    var els = doc.querySelectorAll(CANDIDATES);
    for (var i = 0; i < els.length && out.length < max; i++) {
      var l = lockOf(els[i]);
      if (l) out.push({ el: els[i], lock: l });
    }
    return out;
  }

  // ------------------------------------------------------------- badges
  // A small padlock and "Locked for AI" over each protected control, for
  // sighted viewers and the demo video. The overlay lives in a closed shadow
  // root under <html> (outside <body>, so read_page and get_page_text never
  // see it), is aria-hidden, and has pointer-events none, so it changes
  // nothing a screen reader announces and never blocks a person's click.
  var HOST_ID = "clearcart-lock-badges";
  var LOCK_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm-2 6V4.5a2 2 0 1 1 4 0V7H6Z"/></svg>';
  var CSS = ":host{all:initial}" +
    ".layer{position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:hidden}" +
    ".b{position:absolute;display:inline-flex;align-items:center;gap:4px;padding:2px 7px 2px 6px;border-radius:999px;" +
    "font:600 11px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;letter-spacing:.01em;" +
    "color:#fff;background:#1f2937;box-shadow:0 1px 3px rgba(0,0,0,.35);white-space:nowrap;transform:translateY(-100%)}" +
    ".b.opt{background:#92400e}" +
    "@media (prefers-color-scheme: dark){.b{background:#f3f4f6;color:#111827}.b.opt{background:#fcd34d;color:#422006}}";

  // Grayed-out look for every control and field the AI is locked out of:
  // a data attribute on the page's own element plus one stylesheet. Visual
  // only. Nothing sets disabled, aria-disabled, inert or pointer-events, so
  // a person (and their screen reader) can still press or type as before.
  var MARK = "data-clearcart-locked";
  var MARK_STYLE_ID = "clearcart-lock-style";
  var MARK_CSS = "[" + MARK + "]{filter:grayscale(1)!important;opacity:.45!important;" +
    "outline:2px dashed #6b7280!important;outline-offset:2px!important}";
  // Elements pay_now has been unlocked to press: no longer grayed.
  var released = typeof WeakSet === "function" ? new WeakSet() : null;

  // Card, password and other fields of a card or password form.
  function lockedFields(doc) {
    var out = [];
    var kinds = new Map();
    var fields = doc.querySelectorAll("input,textarea,select");
    for (var i = 0; i < fields.length && out.length < 200; i++) {
      var f = fields[i];
      var form = f.form;
      if (form && !kinds.has(form)) kinds.set(form, formKind(form));
      if (isPaymentInput(f) || isPasswordField(f) || (form && kinds.get(form))) out.push(f);
    }
    return out;
  }

  // Sets the attribute on exactly the elements in want and clears it
  // everywhere else (re-rendered or unlocked controls).
  function markLocked(doc, want) {
    if (!doc.getElementById(MARK_STYLE_ID)) {
      var style = doc.createElement("style");
      style.id = MARK_STYLE_ID;
      style.textContent = MARK_CSS;
      (doc.head || doc.documentElement).appendChild(style);
    }
    var keep = new Set();
    for (var i = 0; i < want.length; i++) {
      if (released && released.has(want[i])) continue;
      keep.add(want[i]);
      if (!want[i].hasAttribute(MARK)) want[i].setAttribute(MARK, "");
    }
    var old = doc.querySelectorAll("[" + MARK + "]");
    for (var j = 0; j < old.length; j++) if (!keep.has(old[j])) old[j].removeAttribute(MARK);
  }

  function clearMarks(doc) {
    var old = doc.querySelectorAll("[" + MARK + "]");
    for (var i = 0; i < old.length; i++) old[i].removeAttribute(MARK);
    var style = doc.getElementById(MARK_STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }

  // The single-use press: the target stops looking locked.
  function release(el) {
    if (!el) return;
    if (released) released.add(el);
    el.removeAttribute(MARK);
  }

  var badgeState = null;

  function visibleRect(el) {
    if (typeof el.getBoundingClientRect !== "function") return null;
    var r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    return r;
  }

  // A copy of this script injected again (the agent's main-world path does
  // that) replaces the host; the old copy's listeners then shut down.
  function stop(st) {
    if (st.observer) st.observer.disconnect();
    var view = st.doc.defaultView;
    if (view && view.removeEventListener) {
      view.removeEventListener("scroll", schedule, true);
      view.removeEventListener("resize", schedule);
    }
    if (st.doc.body) st.doc.body.removeEventListener("change", schedule, true);
    if (badgeState === st) badgeState = null;
  }

  // Removes badges, marks and the stylesheet, for when the extension that
  // drew them is disabled or reloaded.
  function teardown(st) {
    stop(st);
    if (st.host.parentNode) st.host.parentNode.removeChild(st.host);
    clearMarks(st.doc);
  }

  function paint() {
    var st = badgeState;
    if (!st) return;
    st.pending = false;
    if (!st.host.isConnected) return stop(st);
    if (st.alive && !st.alive()) return teardown(st);
    var doc = st.doc;
    var layer = st.layer;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    var view = doc.defaultView;
    var vh = (view && view.innerHeight) || 0;
    var vw = (view && view.innerWidth) || 0;
    var locks = listLocks(doc);
    markLocked(doc, locks.filter(function (x) { return blocks(x.lock); }).map(function (x) { return x.el; }).concat(lockedFields(doc)));
    for (var i = 0; i < locks.length && i < 60; i++) {
      var r = visibleRect(locks[i].el);
      if (!r || r.bottom < 0 || r.right < 0 || (vh && r.top > vh) || (vw && r.left > vw)) continue;
      var b = doc.createElement("span");
      b.className = "b" + (locks[i].lock.optin ? " opt" : "");
      b.innerHTML = LOCK_SVG + "<span></span>";
      b.lastChild.textContent = locks[i].lock.optin ? "AI can only uncheck" : "Locked for AI";
      b.style.left = Math.max(0, r.left) + "px";
      b.style.top = Math.max(16, r.top - 2) + "px";
      layer.appendChild(b);
    }
    st.count = layer.childNodes.length;
  }

  function schedule() {
    var st = badgeState;
    if (!st || st.pending) return;
    st.pending = true;
    var view = st.doc.defaultView;
    if (view && typeof view.requestAnimationFrame === "function") view.requestAnimationFrame(paint);
    else setTimeout(paint, 16);
  }

  // Draws (and keeps drawing) the badges and grayed-out marks for doc.
  // Idempotent. Returns the number of badges on screen. opts.alive is
  // checked on every repaint (scroll, resize, DOM change); once it returns
  // false, everything drawn is removed.
  function showBadges(doc, opts) {
    doc = doc || root.document;
    if (!doc || !doc.documentElement || !doc.createElement) return 0;
    if (badgeState && badgeState.doc === doc && badgeState.host.isConnected) {
      paint();
      return badgeState ? badgeState.count : 0;
    }
    if (badgeState) stop(badgeState);
    var old = doc.getElementById(HOST_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var host = doc.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("role", "presentation");
    host.setAttribute("data-clearcart-overlay", "0"); // our overlays never re-append past it
    host.style.cssText = "position:fixed;inset:0;width:0;height:0;pointer-events:none;z-index:2147483646";
    var shadow = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    var style = doc.createElement("style");
    style.textContent = CSS;
    var layer = doc.createElement("div");
    layer.className = "layer";
    shadow.appendChild(style);
    shadow.appendChild(layer);
    doc.documentElement.appendChild(host);
    badgeState = { doc: doc, host: host, layer: layer, pending: false, count: 0, alive: opts && opts.alive };
    var view = doc.defaultView;
    if (view && view.addEventListener) {
      view.addEventListener("scroll", schedule, { passive: true, capture: true });
      view.addEventListener("resize", schedule, { passive: true });
    }
    if (view && typeof view.MutationObserver === "function" && doc.body) {
      badgeState.observer = new view.MutationObserver(schedule);
      badgeState.observer.observe(doc.body, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ["class", "style", "hidden", "disabled", "checked", "aria-checked", "value", "data-clearcart-protected"],
      });
      doc.body.addEventListener("change", schedule, true);
    }
    paint();
    return badgeState.count;
  }

  var api = {
    PHRASES: PHRASES,
    NEGATIVE: NEGATIVE,
    PRESSABLE: PRESSABLE,
    normalize: normalize,
    classifyLabel: classifyLabel,
    labelOf: labelOf,
    lockOf: lockOf,
    classify: classify,
    blocks: blocks,
    lockInChain: lockInChain,
    lockAt: lockAt,
    lockForKey: lockForKey,
    lockForSubmit: lockForSubmit,
    isActivationKey: isActivationKey,
    pressable: function (lock) { return !!lock && !lock.optin && !!PRESSABLE[lock.kind]; },
    isCheckoutNav: isCheckoutNav,
    unlockClass: unlockClass,
    sameLabel: sameLabel,
    dangerLifts: dangerLifts,
    setDangerMode: setDangerMode,
    dangerMode: function () { return danger; },
    passwordState: passwordState,
    isPasswordField: isPasswordField,
    watchPasswords: watchPasswords,
    message: message,
    listLocks: listLocks,
    showBadges: showBadges,
    release: release,
    BADGE_HOST_ID: HOST_ID,
    LOCKED_ATTR: MARK,
  };
  root.ClearcartProtect = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
