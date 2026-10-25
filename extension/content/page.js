// Clearcart page content script.
//
// Injected on demand by the worker with
//   chrome.scripting.executeScript({ target: { tabId }, files: ["content/mask.js", "content/protect.js", "content/page.js"] })
// (classic scripts, run in order in the isolated world). Re-injecting is a
// no-op: the first run installs globalThis.__clearcartPage and later runs
// return early, so refs stay stable for the life of the document.
//
// The worker calls methods with
//   chrome.tabs.sendMessage(tabId, { type: "page.call", method, params })
// and gets { ok: true, result } or { ok: false, error: { code, message } }.
(function () {
  "use strict";
  if (globalThis.__clearcartPage) return;

  var RT_PAGE_CALL = "page.call"; // RT.PAGE_CALL in lib/protocol.js
  var ERR = {
    BAD_REQUEST: "bad_request",
    UNKNOWN_METHOD: "unknown_method",
    NO_ELEMENT: "no_element",
    PAYMENT_FIELD: "payment_field",
    LOCKED: "locked",
    INTERNAL: "internal",
  };

  var Mask = globalThis.ClearcartMask;
  var Protect = globalThis.ClearcartProtect;

  function PageError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  // Throws ERR.LOCKED with the message for Claude when lock is set.
  function refuse(lock) {
    if (lock) throw PageError(ERR.LOCKED, Protect.message(lock));
  }

  // Lock marker for read_page and find: only on the control itself (or the
  // element carrying data-clearcart-protected), not on every text node
  // inside a marked block.
  function lockMark(el, role) {
    if (!isInteractive(el, role) && !el.hasAttribute("data-clearcart-protected")) return null;
    return Protect.lockOf(el);
  }

  // ---------------------------------------------------------------- refs
  // ref_N per element, stable for the element's lifetime. WeakMap forward,
  // WeakRef backward so the registry never keeps removed nodes alive.
  var nextRef = 1;
  var refOf = new WeakMap();
  var byRef = new Map();
  var HasWeakRef = typeof WeakRef === "function";

  function refFor(el) {
    var r = refOf.get(el);
    if (r) return r;
    r = "ref_" + nextRef++;
    refOf.set(el, r);
    byRef.set(r, HasWeakRef ? new WeakRef(el) : { deref: function () { return el; } });
    return r;
  }

  function elementFor(ref) {
    if (typeof ref !== "string" || !/^ref_\d+$/.test(ref)) throw PageError(ERR.BAD_REQUEST, "ref must look like ref_N");
    var w = byRef.get(ref);
    var el = w && w.deref();
    if (!el || !el.isConnected) {
      byRef.delete(ref);
      throw PageError(ERR.NO_ELEMENT, "no element for " + ref + " (page changed? call read_page again)");
    }
    return el;
  }

  // ------------------------------------------------------- roles and names
  var INPUT_ROLES = {
    button: "button", submit: "button", reset: "button", image: "button",
    checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton",
    search: "searchbox", email: "textbox", tel: "textbox", text: "textbox",
    url: "textbox", password: "textbox", date: "textbox", month: "textbox",
    week: "textbox", time: "textbox", "datetime-local": "textbox", color: "button", file: "button",
  };
  var TAG_ROLES = {
    A: function (el) { return el.hasAttribute("href") ? "link" : null; },
    BUTTON: "button", SUMMARY: "button", TEXTAREA: "textbox",
    SELECT: function (el) { return el.multiple || el.size > 1 ? "listbox" : "combobox"; },
    OPTION: "option", IMG: function (el) { return el.getAttribute("alt") === "" ? null : "img"; },
    H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    NAV: "navigation", MAIN: "main", ASIDE: "complementary", DIALOG: "dialog",
    HEADER: function (el) { return el.closest("article,aside,main,nav,section") ? null : "banner"; },
    FOOTER: function (el) { return el.closest("article,aside,main,nav,section") ? null : "contentinfo"; },
    FORM: "form", TABLE: "table", TR: "row", TH: "columnheader", TD: "cell",
    UL: "list", OL: "list", LI: "listitem", DETAILS: "group", FIELDSET: "group",
    INPUT: function (el) {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "hidden") return null;
      return INPUT_ROLES[t] || "textbox";
    },
  };
  var INTERACTIVE = {
    link: 1, button: 1, checkbox: 1, radio: 1, textbox: 1, searchbox: 1, combobox: 1,
    listbox: 1, slider: 1, spinbutton: 1, switch: 1, tab: 1, menuitem: 1,
    menuitemcheckbox: 1, menuitemradio: 1, option: 1,
  };
  // Roles whose name comes from their text content.
  var NAME_FROM_CONTENT = {
    link: 1, button: 1, heading: 1, tab: 1, menuitem: 1, option: 1, cell: 1,
    columnheader: 1, listitem: 0, switch: 1, checkbox: 0, radio: 0,
  };

  function roleOf(el) {
    var explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (explicit && explicit !== "none" && explicit !== "presentation") return explicit;
    if (explicit) return null;
    var r = TAG_ROLES[el.tagName];
    if (typeof r === "function") r = r(el);
    if (!r && el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) r = "textbox";
    if (!r && el.hasAttribute("tabindex") && Number(el.getAttribute("tabindex")) >= 0 && el.hasAttribute("onclick")) r = "button";
    return r || null;
  }

  function isInteractive(el, role) {
    if (role && INTERACTIVE[role]) return true;
    return false;
  }

  function hiddenByStyle(el) {
    if (el.hidden) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (typeof el.checkVisibility === "function") {
      try { if (!el.checkVisibility({ checkVisibilityCSS: true })) return true; } catch (_) { /* old Chrome */ }
    }
    var cs;
    try { cs = getComputedStyle(el); } catch (_) { return false; }
    return cs.display === "none" || cs.visibility === "hidden";
  }

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 0, HEAD: 1, META: 1, LINK: 1 };

  function clean(s, max) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    max = max || 100;
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  // Visible text of a subtree. Embedded form controls contribute nothing
  // (deliberately: their values could be payment data).
  function textOf(node) {
    var out = "";
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeType === 1) {
        if (SKIP_TAGS[c.tagName] || c.tagName === "INPUT" || c.tagName === "TEXTAREA" || c.tagName === "SELECT") continue;
        if (c.hidden || c.getAttribute("aria-hidden") === "true") continue;
        if (c.tagName === "IMG") out += " " + (c.getAttribute("alt") || "") + " ";
        else out += " " + textOf(c) + " ";
      }
    }
    return out;
  }

  function byIds(ids) {
    return ids.split(/\s+/).map(function (id) {
      var n = document.getElementById(id);
      return n ? textOf(n) : "";
    }).join(" ");
  }

  // Simplified accessible name (accname steps: labelledby, aria-label,
  // native label / alt / value-for-buttons, content, title/placeholder).
  function nameOf(el, role) {
    var s;
    if ((s = el.getAttribute("aria-labelledby")) && (s = clean(byIds(s)))) return s;
    if ((s = clean(el.getAttribute("aria-label")))) return s;
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      var t = (el.type || "").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset") return clean(el.value || (t === "submit" ? "Submit" : t === "reset" ? "Reset" : ""));
      if (t === "image") return clean(el.getAttribute("alt") || "Submit");
      if (el.labels && el.labels.length) {
        s = clean(Array.prototype.map.call(el.labels, textOf).join(" "));
        if (s) return s;
      }
      return clean(el.getAttribute("title") || el.getAttribute("placeholder") || "");
    }
    if (tag === "IMG") return clean(el.getAttribute("alt") || el.getAttribute("title"));
    if (tag === "FIELDSET") {
      var lg = el.querySelector("legend");
      if (lg) return clean(textOf(lg));
    }
    if (tag === "TABLE") {
      var cap = el.querySelector("caption");
      if (cap) return clean(textOf(cap));
    }
    if (NAME_FROM_CONTENT[role] || role === "checkbox" || role === "radio") {
      s = clean(textOf(el));
      if (s) return s;
    }
    return clean(el.getAttribute("title"));
  }

  // State annotations, value masked through ClearcartMask.
  function statesOf(el, role) {
    var parts = [];
    var tag = el.tagName;
    if (role === "heading") {
      var lvl = /^H([1-6])$/.exec(tag);
      parts.push("level=" + (el.getAttribute("aria-level") || (lvl ? lvl[1] : "2")));
    }
    if (role === "checkbox" || role === "radio" || role === "switch") {
      var checked = "checked" in el && (tag === "INPUT") ? el.checked : el.getAttribute("aria-checked") === "true";
      parts.push(checked ? "checked" : "unchecked");
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (el.required) parts.push("required");
    if (tag === "A" && el.hasAttribute("href")) {
      var href = el.getAttribute("href");
      try {
        var u = new URL(href, location.href);
        href = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href;
      } catch (_) { /* keep raw */ }
      parts.push('href="' + clean(href, 120) + '"');
    }
    if (tag === "INPUT" || tag === "TEXTAREA") {
      var t = (el.type || "").toLowerCase();
      if (t !== "checkbox" && t !== "radio" && t !== "submit" && t !== "button" && t !== "reset" && t !== "image" && t !== "hidden") {
        var v = el.value;
        if (Mask.isPaymentField(el)) parts.push(v ? 'value="' + Mask.MASK + '"' : "empty");
        else if (v) parts.push('value="' + clean(Mask.maskValue(v, null), 120) + '"');
        if (Mask.isPaymentField(el)) parts.push("payment");
      }
    }
    if (tag === "SELECT") {
      var opt = el.selectedOptions && el.selectedOptions[0];
      if (opt) parts.push('value="' + clean(Mask.isPaymentField(el) ? Mask.MASK : Mask.maskValue(opt.textContent, null), 80) + '"');
    }
    return parts;
  }

  function q(s) { return '"' + String(s).replace(/"/g, '\\"') + '"'; }

  // ------------------------------------------------------------- read_page
  function readPage(params) {
    var filter = params.filter === "all" ? "all" : "interactive";
    var maxNodes = Math.max(1, Math.min(Number(params.maxNodes) || 400, 5000));
    var lines = [];
    var dropped = 0;

    function emit(depth, text) {
      if (lines.length >= maxNodes) { dropped++; return; }
      lines.push(new Array(depth + 1).join("  ") + "- " + text);
    }

    function walk(el, depth) {
      if (SKIP_TAGS[el.tagName] || hiddenByStyle(el)) return;
      var role = roleOf(el);
      var interactive = isInteractive(el, role);
      var name = role ? nameOf(el, role) : "";
      var show = filter === "all" ? !!role : interactive;
      if (role === "form" && !name && filter === "all") show = false;
      var childDepth = depth;
      if (show) {
        var line = role + (name ? " " + q(Mask.maskCardRuns(name)) : "");
        var st = statesOf(el, role);
        if (st.length) line += " " + st.join(" ");
        line += " [" + refFor(el) + "]";
        var lk = lockMark(el, role);
        if (lk) line += lk.optin ? " [uncheck only]" : " [locked]";
        emit(depth, line);
        childDepth = depth + 1;
        // Name already covers the content of links, buttons, headings.
        if (NAME_FROM_CONTENT[role] && filter === "all" && !el.querySelector("a[href],button,input,select,textarea")) return;
      }
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1) walk(c, childDepth);
        else if (c.nodeType === 3 && filter === "all") {
          var t = clean(c.nodeValue, 200);
          if (t && !(show && NAME_FROM_CONTENT[role])) emit(childDepth, "text " + q(Mask.maskCardRuns(t)));
        }
      }
    }

    if (document.body) walk(document.body, 0);
    if (dropped) lines.push("- … " + dropped + " more nodes (raise maxNodes or use find)");
    badges();
    return { url: location.href, title: Mask.maskCardRuns(document.title), tree: lines.join("\n") };
  }

  // ------------------------------------------------------------------ find
  // Case-insensitive match of every query word against role + name (+ id,
  // placeholder, name attribute). Exact name matches rank first, then
  // interactive elements, then document order.
  function find(params) {
    var query = clean(params.query, 200).toLowerCase();
    if (!query) throw PageError(ERR.BAD_REQUEST, "query is required");
    var limit = Math.max(1, Math.min(Number(params.limit) || 20, 100));
    var words = query.split(" ");
    var hits = [];
    var all = document.body ? document.body.getElementsByTagName("*") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var role = roleOf(el);
      if (!role) continue;
      if (hiddenByStyle(el) || (el.closest && el.closest("[hidden],[aria-hidden=true]"))) continue;
      var name = Mask.maskCardRuns(nameOf(el, role));
      var hay = (role + " " + name + " " + (el.id || "") + " " + (el.getAttribute("name") || "") + " " +
        (el.getAttribute("placeholder") || "")).toLowerCase();
      var ok = words.every(function (w) { return hay.indexOf(w) !== -1; });
      if (!ok) continue;
      var score = 0;
      if (name.toLowerCase() === query) score += 4;
      else if (name.toLowerCase().indexOf(query) !== -1) score += 2;
      if (isInteractive(el, role)) score += 1;
      hits.push({ el: el, role: role, name: name, score: score, order: i });
    }
    hits.sort(function (a, b) { return b.score - a.score || a.order - b.order; });
    badges();
    return {
      matches: hits.slice(0, limit).map(function (h) {
        var m = { ref: refFor(h.el), role: h.role, name: h.name };
        var lk = lockMark(h.el, h.role);
        if (lk && lk.optin) m.uncheckOnly = true;
        else if (lk) m.locked = true;
        return m;
      }),
    };
  }

  // --------------------------------------------------------- get_page_text
  var BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TBODY|THEAD|TFOOT|TR|UL)$/;

  function collectText(root, skip, out) {
    for (var c = root.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { out.push(c.nodeValue); continue; }
      if (c.nodeType !== 1 || c === skip) continue;
      var tag = c.tagName;
      if (SKIP_TAGS[tag] || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") continue;
      if (hiddenByStyle(c)) continue;
      if (tag === "TD" || tag === "TH") { collectText(c, skip, out); out.push("\t"); continue; }
      var block = BLOCK.test(tag);
      if (block) out.push("\n");
      if (tag === "IMG" && c.getAttribute("alt")) out.push(c.getAttribute("alt"));
      collectText(c, skip, out);
      if (block) out.push("\n");
    }
    return out;
  }

  function tidy(s) {
    return s.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function getPageText(params) {
    var maxChars = Math.max(100, Math.min(Number(params.maxChars) || 20000, 200000));
    var body = document.body;
    var main = body && (body.querySelector("main,[role=main]") || body.querySelector("article"));
    var text = "";
    if (main) text = tidy(collectText(main, null, []).join(""));
    if (body) {
      var rest = tidy(collectText(body, main, []).join(""));
      if (rest) text = text ? text + "\n\n---\n\n" + rest : rest;
    }
    text = Mask.maskCardRuns(text);
    var truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars) + "\n… (truncated)";
    return { url: location.href, title: Mask.maskCardRuns(document.title), text: text, truncated: truncated };
  }

  // ------------------------------------------------------------ form_input
  function nativeSet(el, value) {
    // Use the prototype setter so frameworks that track value (React) see it.
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
      : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, "value");
    if (d && d.set) d.set.call(el, value);
    else el.value = value;
  }

  function fire(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function truthy(v) {
    if (typeof v === "boolean") return v;
    return /^(true|on|yes|1|checked)$/i.test(String(v).trim());
  }

  function formInput(params) {
    var el = elementFor(params.ref);
    if (Mask.isPaymentField(el)) throw PageError(ERR.PAYMENT_FIELD, "refusing to fill a payment field; payment is entered only by pay_now");
    if (!("value" in params)) throw PageError(ERR.BAD_REQUEST, "value is required");
    var value = params.value;
    if (typeof value !== "boolean" && Mask.luhn(String(value))) {
      throw PageError(ERR.PAYMENT_FIELD, "refusing to type a card number into the page");
    }
    if (el.disabled) throw PageError(ERR.BAD_REQUEST, "element is disabled");
    // Locked controls: an uncheck-only box may be turned off, nothing else.
    var lk = Protect.lockOf(el);
    if (lk && !(lk.optin && (!truthy(value) || lk.checked))) refuse(lk);
    var tag = el.tagName;
    if (tag === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
      var want = truthy(value);
      if (el.type === "radio" && !want) throw PageError(ERR.BAD_REQUEST, "a radio can only be selected");
      if (el.checked !== want) {
        el.checked = want;
        fire(el);
      }
      return { ok: true };
    }
    if (tag === "SELECT") {
      var s = String(value);
      var opts = Array.prototype.slice.call(el.options);
      var hit = opts.find(function (o) { return o.value === s; }) ||
        opts.find(function (o) { return clean(o.textContent).toLowerCase() === s.trim().toLowerCase(); });
      if (!hit) throw PageError(ERR.BAD_REQUEST, "no option matching value");
      // Uncheck-only, for a dropdown: the AI may move the choice away from
      // an opt-in option ("Subscribe and save"), never onto one.
      if (!hit.selected) {
        var optKind = Protect.classifyLabel(clean(hit.textContent), { checkable: true }) ||
          Protect.classifyLabel(clean(hit.label), { checkable: true }) ||
          Protect.classifyLabel(clean(hit.value).replace(/[-_]+/g, " "), { checkable: true });
        if (optKind) {
          throw PageError(ERR.LOCKED, "Locked: '" + Mask.maskCardRuns(clean(hit.label || hit.textContent)).replace(/'/g, "\u2019").slice(0, 60) +
            "' turns on a subscription, saved card, account or one-tap payment. The AI may choose another option, but only the user can choose this one.");
        }
      }
      nativeSet(el, hit.value);
      fire(el);
      return { ok: true };
    }
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (el.readOnly) throw PageError(ERR.BAD_REQUEST, "element is read-only");
      if (typeof el.focus === "function") el.focus();
      nativeSet(el, String(value));
      fire(el);
      return { ok: true };
    }
    if (el.isContentEditable) {
      el.textContent = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true };
    }
    throw PageError(ERR.BAD_REQUEST, "element is not a form field");
  }

  // ------------------------------------------------------ rect / click_ref
  function rect(params) {
    var el = elementFor(params.ref);
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    var r = el.getBoundingClientRect();
    return { x: r.x !== undefined ? r.x : r.left, y: r.y !== undefined ? r.y : r.top, width: r.width, height: r.height };
  }

  function clickRef(params) {
    var el = elementFor(params.ref);
    refuse(Protect.lockInChain(el));
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "instant" });
    if (typeof el.focus === "function") el.focus();
    el.click();
    return { ok: true };
  }

  // ------------------------------------------------------ button lock
  // The worker asks these before every agent click and key press. They throw
  // ERR.LOCKED with a message for Claude when the action would press a
  // protected control. Not bridge methods: only the router calls them.

  function point(params) {
    var x = Number(params.x), y = Number(params.y);
    if (!isFinite(x) || !isFinite(y)) throw PageError(ERR.BAD_REQUEST, "x and y must be numbers");
    return { x: x, y: y };
  }

  // Click by ref: the element (and what it sits in) must not be locked, and
  // neither may whatever is on top of its centre, which is where the click
  // will land.
  function guardRef(params) {
    refuse(Protect.lockInChain(elementFor(params.ref)));
    var r = rect(params);
    if (r.width > 0 && r.height > 0) refuse(Protect.lockAt(document, r.x + r.width / 2, r.y + r.height / 2));
    return r;
  }

  function guardPoint(params) {
    var p = point(params);
    refuse(Protect.lockAt(document, p.x, p.y));
    return { ok: true };
  }

  function guardKey(params) {
    refuse(Protect.lockForKey(document, String(params.key == null ? "" : params.key)));
    return { ok: true };
  }

  // The internal pay flow, after the worker has checked its single-use
  // unlock: the ref must be an order commit (never a wallet, subscription,
  // saved card or account control), and its centre must not be covered.
  function pressTarget(params) {
    var el = elementFor(params.ref);
    var lk = Protect.lockOf(el);
    if (!Protect.pressable(lk)) throw PageError(ERR.LOCKED, "press_protected only presses an order button");
    return { el: el, lock: lk };
  }

  function pressCheck(params) {
    var t = pressTarget(params);
    var r = rect(params);
    if (!(r.width > 0 && r.height > 0)) throw PageError(ERR.NO_ELEMENT, params.ref + " is not visible");
    if (typeof document.elementFromPoint === "function") {
      var hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!hit || !(hit === t.el || t.el.contains(hit))) throw PageError(ERR.NO_ELEMENT, params.ref + " is covered by another element");
    }
    Protect.release(t.el);
    return { x: r.x, y: r.y, width: r.width, height: r.height, kind: t.lock.kind };
  }

  function pressRef(params) {
    var t = pressTarget(params);
    Protect.release(t.el);
    if (typeof t.el.scrollIntoView === "function") t.el.scrollIntoView({ block: "center", behavior: "instant" });
    t.el.click();
    return { ok: true };
  }

  // False once the extension is disabled or reloaded (chrome.runtime.id goes
  // away); the badges and grayed marks then come off the page.
  var runtimeId = function () { return globalThis.chrome && chrome.runtime && chrome.runtime.id; };
  var hadRuntime = !!runtimeId();
  function extensionAlive() {
    return !hadRuntime || !!runtimeId();
  }

  // Lock badges and grayed-out marks; see protect.js. Never fails a call.
  function badges() {
    try { Protect.showBadges(document, { alive: extensionAlive }); } catch (_) { /* cosmetic */ }
  }

  // -------------------------------------------- read_fields / fill_payment
  function kindOf(el) {
    var ac = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    if (ac.indexOf("cc-number") !== -1) return "cc-number";
    if (ac.indexOf("cc-name") !== -1 || ac.indexOf("cc-given-name") !== -1) return "cc-name";
    if (ac.indexOf("cc-exp") !== -1 || ac.indexOf("cc-exp-month") !== -1 || ac.indexOf("cc-exp-year") !== -1) return "cc-exp";
    if (ac.indexOf("cc-csc") !== -1) return "cc-csc";
    if (ac.some(function (t) { return /^(street-address|address-line\d|address-level\d|postal-code|country)$/.test(t); })) return "address";
    var hay = [el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"),
      el.labels ? Array.prototype.map.call(el.labels, textOf).join(" ") : ""].join(" ").toLowerCase();
    if (Mask.isPaymentField(el)) {
      if (/cvc|cvv|csc|security/.test(hay)) return "cc-csc";
      if (/exp|mm\s*\/\s*yy/.test(hay)) return "cc-exp";
      if (/name|holder/.test(hay)) return "cc-name";
      if (/number|card/.test(hay)) return "cc-number";
    }
    if (/address/.test(hay)) return "address";
    return "other";
  }

  function formFields() {
    var out = [];
    var els = document.querySelectorAll("input,textarea,select");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var t = (el.type || "").toLowerCase();
      if (/^(hidden|submit|button|reset|image|file)$/.test(t)) continue;
      if (hiddenByStyle(el)) continue;
      out.push(el);
    }
    return out;
  }

  function readFields() {
    return {
      fields: formFields().map(function (el) {
        var t = (el.type || "").toLowerCase();
        return {
          name: el.getAttribute("name") || el.id || "",
          autocomplete: el.getAttribute("autocomplete") || "",
          kind: kindOf(el),
          filled: t === "checkbox" || t === "radio" ? !!el.checked : String(el.value || "").length > 0,
        };
      }),
    };
  }

  function expParts(exp) {
    var m = /^\s*(\d{1,2})\s*[\/\-]\s*(\d{2}|\d{4})\s*$/.exec(String(exp || ""));
    if (!m) return null;
    var mm = ("0" + m[1]).slice(-2);
    var yy = m[2].slice(-2);
    return { mm: mm, yy: yy, yyyy: m[2].length === 4 ? m[2] : "20" + yy };
  }

  function fillPayment(params) {
    var card = params.card;
    if (!card || typeof card !== "object") throw PageError(ERR.BAD_REQUEST, "card is required");
    var number = String(card.number || "").replace(/[\s-]/g, "");
    if (!/^\d{12,19}$/.test(number)) throw PageError(ERR.BAD_REQUEST, "card.number must be 12-19 digits");
    var exp = expParts(card.exp);
    if (card.exp && !exp) throw PageError(ERR.BAD_REQUEST, "card.exp must be MM/YY");
    var fields = formFields();
    var byKind = { "cc-number": [], "cc-name": [], "cc-exp": [], "cc-csc": [], address: [] };
    fields.forEach(function (el) { var k = kindOf(el); if (byKind[k]) byKind[k].push(el); });
    if (!byKind["cc-number"].length) throw PageError(ERR.NO_ELEMENT, "no card number field on this page");

    function put(el, v) {
      if (v == null || v === "") return;
      if (el.tagName === "SELECT") {
        var opts = Array.prototype.slice.call(el.options);
        var hit = opts.find(function (o) { return o.value === v || Number(o.value) === Number(v) || clean(o.textContent) === v; });
        if (!hit) return;
        v = hit.value;
      }
      nativeSet(el, v);
      fire(el);
    }

    byKind["cc-number"].forEach(function (el) { put(el, number); });
    byKind["cc-name"].forEach(function (el) { put(el, card.name ? String(card.name) : ""); });
    byKind["cc-csc"].forEach(function (el) { put(el, card.csc ? String(card.csc) : ""); });
    byKind["cc-exp"].forEach(function (el) {
      if (!exp) return;
      var ac = (el.getAttribute("autocomplete") || "").toLowerCase();
      if (/cc-exp-month/.test(ac)) put(el, exp.mm);
      else if (/cc-exp-year/.test(ac)) put(el, el.tagName === "SELECT" || (el.maxLength > 0 && el.maxLength < 4) ? (el.maxLength === 2 ? exp.yy : exp.yyyy) : exp.yyyy);
      else put(el, exp.mm + "/" + exp.yy);
    });
    if (params.address != null && byKind.address.length) {
      var addr = typeof params.address === "string" ? params.address
        : [params.address.line1, params.address.line2, params.address.city, params.address.region, params.address.postal, params.address.country]
          .filter(Boolean).join(", ");
      byKind.address.forEach(function (el) {
        if (!el.value) put(el, addr);
      });
    }
    return { ok: true, last4: number.slice(-4) };
  }

  function clearPayment() {
    formFields().forEach(function (el) {
      var k = kindOf(el);
      if (k.indexOf("cc-") === 0 || Mask.isPaymentField(el)) {
        if (el.tagName === "SELECT") el.selectedIndex = -1;
        else nativeSet(el, "");
        fire(el);
      }
    });
    return { ok: true };
  }

  // Kind of the element that has keyboard focus, so the worker can refuse
  // CDP typing into a card field. Never returns the value.
  function focusedField() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { kind: "none", payment: false };
    var tag = el.tagName;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
      return { kind: el.isContentEditable ? "other" : "none", payment: false };
    }
    var k = kindOf(el);
    return { kind: k, payment: k.indexOf("cc-") === 0 || !!Mask.isPaymentField(el) };
  }

  // ---------------------------------------------------------- page_context
  // What the user is looking at: their text selection, and the element under
  // the mouse or the one they last clicked or focused (content/context.js
  // remembers those). Never a field value: a selection inside a text field
  // is dropped, and a payment or password field is named only as masked.
  var POINT_MAX_AGE_MS = 30000;
  var SELECTION_MAX = 300;
  var PRICE = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*[.,]\d{2}\s?(?:USD|CAD|EUR|GBP|€))/;

  function isSecretField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password") return true;
    var ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/password|one-time-code/.test(ac)) return true;
    return !!Mask.isPaymentField(el);
  }

  function selectionText() {
    var active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return "";
    var sel = document.getSelection && document.getSelection();
    if (!sel || sel.isCollapsed) return "";
    for (var n = sel.anchorNode; n; n = n.parentNode) {
      if (n.nodeType === 1 && (isSecretField(n) || n.isContentEditable)) return "";
    }
    return clean(Mask.maskCardRuns(sel.toString()), SELECTION_MAX);
  }

  // The nearest meaningful element: a control or link, else a named element.
  function meaningful(el) {
    for (var e = el, i = 0; e && e.nodeType === 1 && i < 6; e = e.parentElement, i++) {
      if (isInteractive(e, roleOf(e))) return e;
    }
    return el;
  }

  // Title and price of the product card around el, when one is cheap to see:
  // the nearest ancestor (8 levels up) whose short text holds a price.
  function productOf(el) {
    for (var e = el, i = 0; e && e !== document.body && i < 8; e = e.parentElement, i++) {
      var text = clean(textOf(e), 600);
      if (text.length >= 600) break;
      var price = PRICE.exec(text);
      if (!price) continue;
      var head = e.querySelector("h1,h2,h3,h4,h5,h6,[itemprop=name],a[href]");
      var title = head ? clean(nameOf(head, roleOf(head) || "heading") || textOf(head), 120) : "";
      return { title: Mask.maskCardRuns(title), price: price[0].trim() };
    }
    return null;
  }

  function pageContext() {
    var snap = globalThis.__clearcartContext ? globalThis.__clearcartContext.snapshot() : {};
    var t = Date.now();
    var picks = [];
    if (snap.hover) picks.push({ via: "hover", el: snap.hover.el, at: snap.hover.at });
    if (snap.click && t - snap.click.at < POINT_MAX_AGE_MS) picks.push({ via: "click", el: snap.click.el, at: snap.click.at });
    if (snap.focus && t - snap.focus.at < POINT_MAX_AGE_MS) picks.push({ via: "focus", el: snap.focus.el, at: snap.focus.at });
    var active = document.activeElement;
    if (!picks.length && active && active !== document.body && active !== document.documentElement) {
      picks.push({ via: "focus", el: active, at: t });
    }
    picks.sort(function (a, b) { return b.at - a.at; });
    var pointing = null;
    var pick = picks[0];
    if (pick && pick.el && pick.el.isConnected && pick.el !== document.body && pick.el !== document.documentElement) {
      var el = meaningful(pick.el);
      var role = roleOf(el) || "generic";
      var secret = isSecretField(el);
      pointing = {
        via: pick.via,
        ref: refFor(el),
        role: role,
        name: secret ? "[masked field]" : Mask.maskCardRuns(clean(nameOf(el, role) || textOf(el), 120)),
      };
      if (secret) pointing.masked = true;
      else {
        var product = productOf(el);
        if (product) pointing.product = product;
      }
    }
    return { selection: selectionText(), pointing: pointing };
  }

  // ------------------------------------------------------------ dispatcher
  var METHODS = {
    page_context: pageContext,
    focused_field: focusedField,
    read_page: readPage,
    find: find,
    get_page_text: getPageText,
    form_input: formInput,
    rect: rect,
    click_ref: clickRef,
    read_fields: readFields,
    fill_payment: fillPayment,
    clear_payment: clearPayment,
    guard_ref: guardRef,
    guard_point: guardPoint,
    guard_key: guardKey,
    press_check: pressCheck,
    press_ref: pressRef,
  };

  function call(method, params) {
    if (!Mask) throw PageError(ERR.INTERNAL, "mask.js was not injected before page.js");
    // Fail closed: without the classifier nothing may be clicked or read.
    if (!Protect) throw PageError(ERR.INTERNAL, "protect.js was not injected before page.js");
    var fn = Object.prototype.hasOwnProperty.call(METHODS, method) && METHODS[method];
    if (!fn) throw PageError(ERR.UNKNOWN_METHOD, "unknown page method: " + method);
    if (params != null && typeof params !== "object") throw PageError(ERR.BAD_REQUEST, "params must be an object");
    return fn(params || {});
  }

  function handle(msg) {
    return Promise.resolve()
      .then(function () { return call(msg.method, msg.params); })
      .then(
        // href: which document answered, so the worker can drop a reply
        // from a page that moved to a blocked site. Never passed to Claude.
        function (result) { return { ok: true, result: result === undefined ? null : result, href: location.href }; },
        function (e) {
          return { ok: false, error: { code: (e && e.code) || ERR.INTERNAL, message: String((e && e.message) || "failed") }, href: location.href };
        }
      );
  }

  globalThis.__clearcartPage = { call: call, handle: handle, refFor: refFor };
  if (Protect) badges();

  if (globalThis.chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.type !== RT_PAGE_CALL) return false;
      // Only the extension itself may drive the page.
      if (sender && chrome.runtime.id && sender.id && sender.id !== chrome.runtime.id) return false;
      handle(msg).then(sendResponse);
      return true; // async response
    });
  }
})();
