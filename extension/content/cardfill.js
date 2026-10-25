// Orbi saved-card fill, for one frame.
//
// The worker injects this, after content/mask.js, into every frame of the
// checkout tab, the cross-origin payment frames (Stripe, Adyen, Braintree
// hosted fields) included:
//   chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content/mask.js", "content/cardfill.js"] })
// It runs in the extension's isolated world: no page script, the frame's
// own included, can reach its variables or the values it is handed, and
// the worker hands each frame only the values for the fields that frame
// has (background/router.js fill_card).
//
//   scan()        the card fields here, by kind, and whether each is empty
//   fill(values)  puts the values in the way the browser's autofill does
//                 (the native value setter, then input and change events)
//   clear()       empties every card field here
//
// None of them returns or logs a value: kinds, counts and true/false only.
// A field is a card field by its autocomplete kind (cc-number, cc-exp,
// cc-exp-month, cc-exp-year, cc-csc, cc-name), or by its name, id,
// placeholder or label when mask.js already reads it as a payment field.
// Classic script; re-injecting is a no-op. Under Node (tests) it also sets
// module.exports.
(function (root) {
  "use strict";
  if (root.__clearcartCardFill) return;
  var Mask = root.ClearcartMask;

  var AUTOCOMPLETE = { "cc-number": 1, "cc-name": 1, "cc-exp": 1, "cc-exp-month": 1, "cc-exp-year": 1, "cc-csc": 1 };
  // For payment fields without an autocomplete kind. Order matters: the
  // month and year before the whole expiry, the code and the name before
  // the number.
  var GUESS = [
    ["cc-exp-month", /exp\w*[ _-]*(month|mm)\b|\b(month|mm)[ _-]*exp|\bcc[ _-]*month|card[ _-]*month|expiration[ _-]*month/],
    ["cc-exp-year", /exp\w*[ _-]*(year|yy|yyyy)\b|\b(year|yy)[ _-]*exp|\bcc[ _-]*year|card[ _-]*year|expiration[ _-]*year/],
    ["cc-csc", /\b(cvc|cvv|cvv2|cvn|csc|cid)\b|security[ _-]*code|card[ _-]*code|card[ _-]*verification/],
    ["cc-exp", /\bexp(iry|iration|ires|ire)?\b|exp[ _-]*date|valid[ _-]*(thru|through)|mm *\/ *yy/],
    ["cc-name", /name[ _-]*on[ _-]*(the[ _-]*)?(credit[ _-]*)?card|card[ _-]*holder|cardholder|holder[ _-]*name|\bcc[ _-]*name|card[ _-]*name/],
    ["cc-number", /card[ _-]*(number|no\b|num|#)|cardnumber|\bcc[ _-]*(number|num)|\bpan\b/],
  ];
  var POSTAL = /postal|\bzip\b|zip[ _-]*code|post[ _-]*code/;
  var SKIP_TYPES = /^(hidden|submit|button|reset|image|file|checkbox|radio|color|range|email|date|month|week|time|datetime-local|url|search)$/;

  function labelText(el) {
    var out = [];
    try {
      if (el.labels) for (var i = 0; i < el.labels.length; i++) out.push(el.labels[i].textContent || "");
    } catch (_) { /* not labelable */ }
    var ids = el.getAttribute("aria-labelledby");
    if (ids && el.ownerDocument) {
      ids.split(/\s+/).forEach(function (id) {
        var n = el.ownerDocument.getElementById(id);
        if (n) out.push(n.textContent || "");
      });
    }
    return out.join(" ");
  }

  // "encryptedCardNumber" reads as "encrypted card number".
  function words(el) {
    return [el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"),
      el.getAttribute("data-fieldtype"), labelText(el)]
      .filter(Boolean).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/\s+/g, " ");
  }

  function tokens(el) {
    return String(el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).filter(Boolean);
  }

  function usable(el) {
    if (el.hidden || el.disabled || el.readOnly) return false;
    if (el.getAttribute("aria-hidden") === "true" || (el.closest && el.closest("[hidden],[aria-hidden=true]"))) return false;
    if (typeof el.checkVisibility === "function") {
      try {
        if (!el.checkVisibility({ checkVisibilityCSS: true })) return false;
      } catch (_) { /* old Chrome */ }
      // A real browser lays out: a field with no box is not one a person sees.
      var r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
    }
    return true;
  }

  // A card kind for one field, or null. A guessed kind needs mask.js to
  // read the field as a payment field too, so a plain "Name" never is one.
  function kindOf(el) {
    var t = tokens(el);
    for (var i = 0; i < t.length; i++) {
      if (t[i] === "cc-given-name" || t[i] === "cc-family-name" || t[i] === "cc-additional-name") return null;
      if (AUTOCOMPLETE[t[i]]) return t[i];
    }
    if (t.indexOf("postal-code") !== -1) return "postal-code";
    var hay = words(el);
    if (Mask && Mask.isPaymentField(el)) {
      for (var g = 0; g < GUESS.length; g++) if (GUESS[g][1].test(hay)) return GUESS[g][0];
      return null;
    }
    return POSTAL.test(hay) ? "postal-code" : null;
  }

  function inFrame() {
    try { return root.top !== root.self; } catch (_) { return true; }
  }

  // The card fields here: [{ kind, el }]. A postal code counts only inside
  // a payment frame that has a card number (hosted card fields), or when
  // its autocomplete says billing: never a shipping ZIP.
  function fieldsIn(doc) {
    var list = [];
    var hasNumber = false;
    var els = doc.querySelectorAll("input,select");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.tagName === "INPUT" && SKIP_TYPES.test(String(el.type || "text").toLowerCase())) continue;
      if (!usable(el)) continue;
      var k = kindOf(el);
      if (!k) continue;
      if (k === "cc-number") hasNumber = true;
      list.push({ kind: k, el: el });
    }
    var frame = inFrame();
    return list.filter(function (f) {
      return f.kind !== "postal-code" || (hasNumber && frame) || tokens(f.el).indexOf("billing") !== -1;
    });
  }

  function filled(el) {
    if (el.tagName === "SELECT") return el.selectedIndex > 0;
    return String(el.value || "").length > 0;
  }

  function scan() {
    return {
      href: String((root.location && root.location.href) || ""),
      fields: fieldsIn(root.document).map(function (f) { return { kind: f.kind, filled: filled(f.el) }; }),
    };
  }

  function nativeSet(el, value) {
    var view = el.ownerDocument.defaultView;
    var proto = el.tagName === "SELECT" ? view.HTMLSelectElement.prototype : view.HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, "value");
    if (d && d.set) d.set.call(el, value);
    else el.value = value;
  }

  function fire(el, data) {
    var view = el.ownerDocument.defaultView;
    var ev;
    try { ev = new view.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: data }); } catch (_) { ev = new view.Event("input", { bubbles: true }); }
    el.dispatchEvent(ev);
    el.dispatchEvent(new view.Event("change", { bubbles: true }));
  }

  // The option for a month or year in a select, by value or text: "07",
  // "7", "Jul..." or "2030", "30".
  var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function option(el, want) {
    var opts = Array.prototype.slice.call(el.options);
    for (var i = 0; i < want.length; i++) {
      var w = String(want[i]).toLowerCase();
      for (var j = 0; j < opts.length; j++) {
        var v = String(opts[j].value).trim().toLowerCase();
        var t = String(opts[j].textContent || "").trim().toLowerCase();
        if (v === w || t === w) return opts[j].value;
        if (/^[a-z]{3}$/.test(w) && t.indexOf(w) === 0) return opts[j].value;
      }
    }
    return null;
  }

  // What a field takes for its kind. exp is { mm, yy, yyyy }.
  function textFor(el, kind, v) {
    var max = el.maxLength > 0 ? el.maxLength : 0;
    if (kind === "cc-exp") {
      var ph = String(el.getAttribute("placeholder") || "").toLowerCase();
      if (/yyyy/.test(ph) || max === 7) return v.mm + "/" + v.yyyy;
      if (max === 4) return v.mm + v.yy;
      if (/mm \/ yy/.test(ph)) return v.mm + " / " + v.yy;
      return v.mm + "/" + v.yy;
    }
    if (kind === "cc-exp-month") return v.mm;
    if (kind === "cc-exp-year") return max === 2 ? v.yy : v.yyyy;
    return String(v);
  }

  function put(el, kind, v) {
    if (el.tagName === "SELECT") {
      var want = kind === "cc-exp-month" ? [v.mm, String(Number(v.mm)), MONTHS[Number(v.mm) - 1]]
        : kind === "cc-exp-year" ? [v.yyyy, v.yy] : [String(v)];
      var hit = option(el, want);
      if (hit == null) return false;
      nativeSet(el, hit);
      fire(el, null);
      return el.value === hit;
    }
    var text = textFor(el, kind, v);
    try { el.focus({ preventScroll: true }); } catch (_) { /* not focusable */ }
    nativeSet(el, text);
    fire(el, text);
    try { el.blur(); } catch (_) { /* fine */ }
    return filled(el);
  }

  // values: { "cc-number": "...", "cc-exp": { mm, yy, yyyy }, ... } for the
  // kinds this frame has. Each kind must be exactly one field here; a
  // postal code goes in only when its field is empty. Answers which kinds
  // went in, never what.
  function fill(values) {
    var fields = fieldsIn(root.document);
    var done = {};
    var ok = true;
    Object.keys(values || {}).forEach(function (kind) {
      var mine = fields.filter(function (f) { return f.kind === kind; });
      if (mine.length !== 1) { done[kind] = false; ok = false; return; }
      if (kind === "postal-code" && filled(mine[0].el)) { done[kind] = true; return; }
      var went = false;
      try { went = put(mine[0].el, kind, values[kind]); } catch (_) { went = false; }
      done[kind] = went;
      if (!went) ok = false;
    });
    return { ok: ok, filled: done };
  }

  // Empties every card field here.
  function clear() {
    var n = 0;
    fieldsIn(root.document).forEach(function (f) {
      try {
        if (!filled(f.el)) return;
        if (f.el.tagName === "SELECT") f.el.selectedIndex = 0;
        else nativeSet(f.el, "");
        fire(f.el, null);
        n++;
      } catch (_) { /* gone */ }
    });
    return { ok: true, cleared: n };
  }

  var api = { scan: scan, fill: fill, clear: clear, kindOf: kindOf };
  root.__clearcartCardFill = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
