// Orbi payment masking helpers.
//
// Classic script (no ES module syntax) so chrome.scripting.executeScript can
// inject it into the page's isolated world before content/page.js. It sets
// globalThis.ClearcartMask; under Node (tests) it also sets module.exports.
//
// Rule: a payment field's value, or any Luhn-valid 13-19 digit run, must never
// leave the page through read_page / get_page_text / find.
(function (root) {
  "use strict";

  // Words in name/id/label/placeholder/aria-label that mark a payment field.
  // "card" also covers "Name on card"; "exp" only as a word or exp-/exp_ prefix
  // so "express" does not match.
  var PAYMENT_WORDS = /card|(?:^|[^a-z])cc(?:[^a-z]|$)|cvc|cvv|csc|(?:^|[^a-z])exp(?:iry|iration|ires|ire)?(?:[^a-z]|$)|security\s*code/i;

  var MASK = "[masked]";
  var CARD_MASK = "[masked card number]";

  function labelText(el) {
    var out = [];
    try {
      if (el.labels) for (var i = 0; i < el.labels.length; i++) out.push(el.labels[i].textContent || "");
    } catch (_) { /* not labelable */ }
    var ids = el.getAttribute && el.getAttribute("aria-labelledby");
    if (ids && el.ownerDocument) {
      ids.split(/\s+/).forEach(function (id) {
        var n = el.ownerDocument.getElementById(id);
        if (n) out.push(n.textContent || "");
      });
    }
    return out.join(" ");
  }

  function isPaymentField(el) {
    if (!el || el.nodeType !== 1) return false;
    var ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/(^|\s)cc-/.test(ac)) return true;
    var tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && !el.isContentEditable) return false;
    if (tag === "INPUT") {
      var t = (el.type || "").toLowerCase();
      if (t === "hidden" || t === "submit" || t === "button" || t === "reset" || t === "image" || t === "checkbox" || t === "radio") return false;
    }
    var hay = [
      el.getAttribute("name"),
      el.id,
      el.getAttribute("placeholder"),
      el.getAttribute("aria-label"),
      labelText(el),
    ].filter(Boolean).join(" ");
    return PAYMENT_WORDS.test(hay);
  }

  // True when text, ignoring spaces and dashes, is 13-19 digits that pass Luhn.
  function luhn(text) {
    var d = String(text == null ? "" : text).replace(/[\s-]/g, "");
    if (!/^\d{13,19}$/.test(d)) return false;
    var sum = 0;
    var dbl = false;
    for (var i = d.length - 1; i >= 0; i--) {
      var n = d.charCodeAt(i) - 48;
      if (dbl) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  // Digit runs of 13 or more digits, optionally separated by single spaces
  // or dashes.
  var RUN = /\d(?:[ -]?\d){12,}/g;

  // Card numbers are 13, 14, 15, 16 or 19 digits, never start with 0, and
  // pass Luhn (RuPay and UnionPay start with 8, Troy with 9).
  var CARD_LENGTHS = [13, 14, 15, 16, 19];
  function cardLike(d) {
    return CARD_LENGTHS.indexOf(d.length) !== -1 && /^[1-9]/.test(d) && luhn(d);
  }

  // True when the run holds a card number, also next to other digits. Each
  // window starts at the run's start or a separator and ends at the run's
  // end or a separator: a span of whole groups (the digits between spaces
  // or dashes), as in "4111 1111 1111 1111 123", "Order 12
  // 4111111111111111" or "4111 1111 1111 1111 05/27". A group of 17 to 19
  // digits is also checked for a 16-digit card at its start or end, with a
  // few digits glued on ("4111111111111111123"). Order ids and tracking
  // numbers stay readable.
  function hasCardWindow(run) {
    var groups = String(run).split(/[\s-]+/);
    // Too long to be anything a person reads as a number: mask it.
    if (groups.join("").length > 400) return true;
    for (var i = 0; i < groups.length; i++) {
      var span = "";
      for (var j = i; j < groups.length; j++) {
        span += groups[j];
        if (span.length > 19) break;
        if (cardLike(span)) return true;
      }
      var g = groups[i];
      if (g.length > 16 && g.length <= 19 && (cardLike(g.slice(0, 16)) || cardLike(g.slice(-16)))) return true;
    }
    return false;
  }

  // True when text holds a card number anywhere.
  function hasCardNumber(text) {
    var runs = String(text == null ? "" : text).match(RUN) || [];
    for (var i = 0; i < runs.length; i++) if (hasCardWindow(runs[i])) return true;
    return false;
  }

  // Replaces every digit run holding a card number with label (default
  // CARD_MASK). The one card check for the page scripts, the worker
  // (lib/log.js, background/gdocs.js) and the agent server.
  function maskCardRuns(text, label) {
    var mask = label == null ? CARD_MASK : String(label);
    return String(text).replace(RUN, function (m) { return hasCardWindow(m) ? mask : m; });
  }

  // Masks a value for output. With a payment element the whole value is
  // replaced (empty stays empty so "filled" state is still visible as "");
  // otherwise only Luhn-valid card number runs are replaced.
  function maskValue(text, el) {
    var s = text == null ? "" : String(text);
    if (el && isPaymentField(el)) return s ? MASK : "";
    return maskCardRuns(s);
  }

  var api = { isPaymentField: isPaymentField, luhn: luhn, maskValue: maskValue, maskCardRuns: maskCardRuns, hasCardNumber: hasCardNumber, MASK: MASK, CARD_MASK: CARD_MASK };
  root.ClearcartMask = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
