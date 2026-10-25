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
      "checkout", "secure checkout", "proceed to checkout", "continue to checkout", "go to checkout",
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
  PHRASES.order.push("check out");

  // Kinds the internal pay flow may press once unlocked. Wallets,
  // subscriptions, saved cards, accounts and frames never unlock.
  var PRESSABLE = { order: 1, marked: 1, "payment-form": 1 };
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
    if (el.tagName === "BUTTON") {
      var bt = String(el.getAttribute("type") || "submit").toLowerCase();
      return bt === "submit";
    }
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

  // Lock of one element, or null. { kind, label, optin, checked }.
  function lockOf(el) {
    if (!el || el.nodeType !== 1) return null;
    var marked = el.closest ? el.closest("[data-clearcart-protected]") : null;
    var control = isControl(el);
    if (!control && !marked) return null;
    var label = control ? labelOf(el) : labelOf(marked);
    var checkable = control && isCheckable(el);
    if (marked) {
      var mk = { kind: "marked", label: clip(label || "this control"), optin: checkable, checked: checkable && checkedOf(el) };
      return mk;
    }
    var kind = classifyLabel(label, { checkable: checkable });
    if (!kind && !checkable) {
      var idk = classifyLabel(idWords(el), { checkable: false });
      // Ids only count for commit and money words; an id like "login-help"
      // or "account-menu" is too loose to lock on.
      if (idk && idk !== "account") kind = idk;
    }
    if (!kind && isSubmit(el)) kind = formKind(el.form);
    if (!kind) return null;
    return { kind: kind, label: clip(label || kind), optin: checkable, checked: checkable && checkedOf(el) };
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
    for (var n = el; n && n.nodeType === 1; n = parentOf(n)) {
      var l = lockOf(n);
      if (l && blocks(l)) return l;
      if (l) return null; // an uncheck-only box that is on: the click turns it off
      if (n.tagName === "LABEL" && n.control) {
        var c = lockOf(n.control);
        if (c && blocks(c)) return c;
      }
    }
    return null;
  }

  var FRAME_TAGS = { IFRAME: 1, FRAME: 1, OBJECT: 1, EMBED: 1, FENCEDFRAME: 1 };
  var FRAME_LOCK = { kind: "frame", label: "embedded frame", optin: false, checked: false };

  // Blocking lock under viewport point (x, y), or null. Descends open shadow
  // roots and same-origin frames; a cross-origin frame (hosted payment
  // fields, wallet buttons) cannot be inspected, so it is locked.
  function lockAt(doc, x, y) {
    if (!doc || typeof doc.elementFromPoint !== "function") return null;
    var el = doc.elementFromPoint(x, y);
    var guard = 0;
    while (el && el.shadowRoot && typeof el.shadowRoot.elementFromPoint === "function" && guard++ < 20) {
      var inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el) return null;
    if (FRAME_TAGS[el.tagName]) {
      var sub = null;
      try { sub = el.contentDocument; } catch (_) { sub = null; }
      if (!sub) return FRAME_LOCK;
      var r = el.getBoundingClientRect();
      return lockAt(sub, x - r.left, y - r.top) || lockInChain(el);
    }
    return lockInChain(el);
  }

  function deepActive(doc) {
    var el = doc.activeElement;
    var guard = 0;
    while (el && el.shadowRoot && el.shadowRoot.activeElement && guard++ < 20) el = el.shadowRoot.activeElement;
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
    var k = keyName(spec);
    var enter = ENTER.test(k);
    if (!enter && !SPACE.test(k)) return null;
    var el = doc && deepActive(doc);
    if (!el || el === doc.body || el === doc.documentElement) return null;
    if (FRAME_TAGS[el.tagName]) {
      var sub = null;
      try { sub = el.contentDocument; } catch (_) { sub = null; }
      return sub ? lockForKey(sub, spec) : FRAME_LOCK;
    }
    var chain = lockInChain(el);
    if (chain) return chain;
    if (enter && el.form && (el.tagName === "INPUT" || el.tagName === "SELECT")) {
      var t = inputType(el);
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return null;
      var fk = formKind(el.form);
      if (fk) return { kind: fk, label: clip(formLabel(el.form) || "this form"), optin: false, checked: false };
      var subs = el.form.querySelectorAll("button,input[type=submit],input[type=image]");
      for (var i = 0; i < subs.length; i++) {
        if (!isSubmit(subs[i])) continue;
        var l = lockOf(subs[i]);
        if (l && blocks(l)) return l;
      }
    }
    return null;
  }

  function formLabel(form) {
    var subs = form.querySelectorAll("button,input[type=submit],input[type=image]");
    for (var i = 0; i < subs.length; i++) if (isSubmit(subs[i])) return labelOf(subs[i]);
    return form.getAttribute("aria-label") || "";
  }

  // The error Claude gets back. Never includes field values.
  function message(lock) {
    var name = "'" + (lock && lock.label ? lock.label : "this control") + "'";
    switch (lock && lock.kind) {
      case "frame":
        return "Locked: that point is inside an embedded frame, often a payment widget, that Clearcart cannot inspect. The AI may not click inside it.";
      case "account":
        return "Locked: " + name + " signs in or creates an account. Clearcart never logs in or creates accounts.";
      case "express":
      case "subscription":
      case "payment-method":
        if (lock.optin) return "Locked: " + name + " can only be unchecked. Clearcart never turns on subscriptions, saved cards or one-tap payments.";
        return "Locked: " + name + " moves money or saves payment details, and only the user can press it.";
      default:
        if (lock && lock.optin) return "Locked: " + name + " can only be unchecked.";
        return "Locked: " + name + " can only be pressed by Clearcart after the user says yes.";
    }
  }

  // Every protected control in the document, for badges and listings.
  // Capped so a huge page cannot stall the content script.
  var CANDIDATES = "a[href],button,summary,input[type=submit],input[type=button],input[type=image],input[type=checkbox]," +
    "input[type=radio],[role=button],[role=link],[role=menuitem],[role=checkbox],[role=radio],[role=switch]," +
    "[role=tab],[role=option],[data-clearcart-protected]";

  function listLocks(doc, max) {
    var out = [];
    if (!doc || !doc.querySelectorAll) return out;
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

  function paint() {
    var st = badgeState;
    if (!st) return;
    st.pending = false;
    if (!st.host.isConnected) return stop(st);
    var doc = st.doc;
    var layer = st.layer;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    var view = doc.defaultView;
    var vh = (view && view.innerHeight) || 0;
    var vw = (view && view.innerWidth) || 0;
    var locks = listLocks(doc, 60);
    for (var i = 0; i < locks.length; i++) {
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

  // Draws (and keeps drawing) the badges for doc. Idempotent. Returns the
  // number of badges on screen.
  function showBadges(doc) {
    doc = doc || root.document;
    if (!doc || !doc.documentElement || !doc.createElement) return 0;
    if (badgeState && badgeState.doc === doc && badgeState.host.isConnected) {
      paint();
      return badgeState.count;
    }
    if (badgeState) stop(badgeState);
    var old = doc.getElementById(HOST_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var host = doc.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("role", "presentation");
    host.style.cssText = "position:fixed;inset:0;width:0;height:0;pointer-events:none;z-index:2147483646";
    var shadow = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    var style = doc.createElement("style");
    style.textContent = CSS;
    var layer = doc.createElement("div");
    layer.className = "layer";
    shadow.appendChild(style);
    shadow.appendChild(layer);
    doc.documentElement.appendChild(host);
    badgeState = { doc: doc, host: host, layer: layer, pending: false, count: 0 };
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
    blocks: blocks,
    lockInChain: lockInChain,
    lockAt: lockAt,
    lockForKey: lockForKey,
    isActivationKey: isActivationKey,
    pressable: function (lock) { return !!lock && !lock.optin && !!PRESSABLE[lock.kind]; },
    message: message,
    listLocks: listLocks,
    showBadges: showBadges,
    BADGE_HOST_ID: HOST_ID,
  };
  root.ClearcartProtect = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
