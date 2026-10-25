// Orbi page content script.
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

  // Throws ERR.LOCKED with the message for Claude when lock is set. The
  // message names the control's ref (el, else the control the lock was
  // found on) so Claude can pass it to request_unlock. A control in another
  // document (a frame) has no ref Claude could use.
  function refuse(lock, el) {
    if (!lock) return;
    var target = el || lock.el;
    var ref = target && target.nodeType === 1 && target.ownerDocument === document ? refFor(target) : null;
    throw PageError(ERR.LOCKED, Protect.message(lock, ref, target));
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
        var pw = isPassword(el);
        if (Mask.isPaymentField(el) || pw) parts.push(v ? 'value="' + Mask.MASK + '"' : "empty");
        else if (v) parts.push('value="' + clean(Mask.maskValue(v, null), 120) + '"');
        if (Mask.isPaymentField(el)) parts.push("payment");
        else if (pw) parts.push("password");
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
    return { url: pageUrl(), title: Mask.maskCardRuns(document.title), tree: lines.join("\n") };
  }

  // Origin and path only: a query string or fragment can carry login codes
  // and tokens, and this goes to Claude.
  function pageUrl() {
    var o = location.origin;
    return o && o !== "null" ? o + location.pathname : location.protocol;
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
    var out = { url: pageUrl(), title: Mask.maskCardRuns(document.title), text: text, truncated: truncated };
    var locked = lockedList();
    if (locked.length) out.locked = locked;
    return out;
  }

  // The page's locked controls for get_page_text, which has no refs of its
  // own: [{ ref, name, uncheckOnly?, userOnly? }], so Claude knows them without a
  // read_page and can pass the ref to request_unlock. An uncheck-only box
  // that is already off is listed too (it may never be turned on).
  var LOCKED_LIST_MAX = 40;
  function lockedList() {
    var out = [];
    var locks = Protect.listLocks(document, 300);
    for (var i = 0; i < locks.length && out.length < LOCKED_LIST_MAX; i++) {
      var x = locks[i];
      if (!Protect.blocks(x.lock) || hiddenByStyle(x.el) || (x.el.closest && x.el.closest("[hidden],[aria-hidden=true]"))) continue;
      var m = { ref: refFor(x.el), name: x.lock.label };
      if (x.lock.optin) m.uncheckOnly = true;
      // Never unlocks on request (Place order, wallets, card forms, marked).
      if (!Protect.unlockClass(x.lock, x.el)) m.userOnly = true;
      out.push(m);
    }
    return out;
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

  // A password field, now or ever (Protect.isPasswordField): masked in
  // read_page, refused by form_input, and typing into it is refused.
  function isPassword(el) {
    return !!Protect.isPasswordField(el);
  }

  function formInput(params) {
    var el = elementFor(params.ref);
    if (Mask.isPaymentField(el)) throw PageError(ERR.PAYMENT_FIELD, "refusing to fill a payment field; only pay_with_saved_card fills card fields");
    if (isPassword(el)) throw PageError(ERR.PAYMENT_FIELD, "refusing to fill a password field; Orbi never types passwords, the user types it themselves");
    if (!("value" in params)) throw PageError(ERR.BAD_REQUEST, "value is required");
    var value = params.value;
    if (typeof value !== "boolean" && Mask.luhn(String(value))) {
      throw PageError(ERR.PAYMENT_FIELD, "refusing to type a card number into the page");
    }
    if (el.disabled) throw PageError(ERR.BAD_REQUEST, "element is disabled");
    // Locked controls: an uncheck-only box may be turned off, nothing else.
    var lk = Protect.lockOf(el);
    if (lk && !(lk.optin && (!truthy(value) || lk.checked))) refuse(lk, el);
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
      // Spacing, case and punctuation aside: "Nomad Taupe black" picks
      // "Nomad Taupe/Black".
      var loose = function (t) { return clean(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); };
      var hit = opts.find(function (o) { return o.value === s; }) ||
        opts.find(function (o) { return clean(o.textContent).toLowerCase() === s.trim().toLowerCase(); }) ||
        opts.find(function (o) { return loose(o.textContent) === loose(s) && loose(s) !== ""; }) ||
        // "Medium" picks "M (Medium)", when only one option has it as words.
        (function () {
          var w = " " + loose(s) + " ";
          if (w.trim() === "") return null;
          var hits = opts.filter(function (o) { return (" " + loose(o.textContent) + " ").indexOf(w) >= 0; });
          return hits.length === 1 ? hits[0] : null;
        })();
      if (!hit) {
        var names = opts.slice(0, 15).map(function (o) { return clean(Mask.maskValue(o.textContent, null), 40); }).filter(Boolean);
        throw PageError(ERR.BAD_REQUEST, "no option matching value" + (names.length ? ". The options are: " + names.join(", ") : ""));
      }
      // Uncheck-only, for a dropdown: the AI may move the choice away from
      // an opt-in option ("Subscribe and save"), never onto one.
      // Danger mode lifts this too.
      if (!hit.selected && !Protect.dangerMode()) {
        var optKind = Protect.classifyLabel(clean(hit.textContent), { checkable: true }) ||
          Protect.classifyLabel(clean(hit.label), { checkable: true }) ||
          Protect.classifyLabel(clean(hit.value).replace(/[-_]+/g, " "), { checkable: true });
        if (optKind) {
          throw PageError(ERR.LOCKED, "Locked: '" + Mask.maskCardRuns(clean(hit.label || hit.textContent)).replace(/'/g, "\u2019").slice(0, 60) +
            "' turns on a subscription, saved card, account or one-tap payment, so nothing was changed. The AI may choose another option, but only the user can choose this one; tell them if they want it.");
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
    // classify, not lockOf: the same order-button check with Danger mode on.
    var lk = Protect.classify(el);
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

  // ------------------------------------------------- user-directed unlock
  // request_unlock on the agent server, after the user asked for this action
  // or said yes to it. lock_info says what a ref is; press_check_user and
  // press_ref_user press it once, after the worker has spent a "user" scope
  // nonce. The ref must resolve to a control of the expected unlock class
  // and label (Protect.unlockClass: checkout, account, subscription, saved
  // card, marked). Order, wallet and card form controls never pass.
  function lockTarget(el) {
    var lk = Protect.lockOf(el);
    if (!lk) {
      for (var n = el.parentElement; n && !lk; n = n.parentElement) {
        lk = Protect.lockOf(n);
        if (lk) el = n;
      }
    }
    return { el: el, lock: lk };
  }

  function lockInfo(params) {
    var t = lockTarget(elementFor(params.ref));
    if (!t.lock) return { locked: false };
    var pw = Protect.passwordState(t.el);
    return {
      locked: Protect.blocks(t.lock),
      kind: t.lock.kind,
      label: t.lock.label,
      optin: !!t.lock.optin,
      cls: Protect.unlockClass(t.lock, t.el),
      password: pw.password,
      passwordFilled: pw.filled,
    };
  }

  function userTarget(params) {
    var t = lockTarget(elementFor(params.ref));
    var cls = Protect.unlockClass(t.lock, t.el);
    if (!cls || cls !== params.cls) throw PageError(ERR.LOCKED, "Locked: this control cannot be unlocked on request");
    if (!Protect.sameLabel(t.lock.label, params.label)) throw PageError(ERR.LOCKED, "Locked: the control changed since the user asked");
    return t;
  }

  // Throws unless the point (x, y) lands on t.el or inside it.
  function hitTest(t, x, y, ref) {
    if (typeof document.elementFromPoint !== "function") return;
    var hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === t.el || t.el.contains(hit))) throw PageError(ERR.NO_ELEMENT, ref + " is covered by another element");
  }

  // Scrolls the control into view and returns its rect. The lock marker
  // stays on until the press is done (press_done_user), so the page gets no
  // early signal to swap the control.
  function pressCheckUser(params) {
    var t = userTarget(params);
    if (typeof t.el.scrollIntoView === "function") t.el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    var r = t.el.getBoundingClientRect();
    var x = r.x !== undefined ? r.x : r.left, y = r.y !== undefined ? r.y : r.top;
    if (!(r.width > 0 && r.height > 0)) throw PageError(ERR.NO_ELEMENT, params.ref + " is not visible");
    hitTest(t, x + r.width / 2, y + r.height / 2, params.ref);
    return { x: x, y: y, width: r.width, height: r.height, cls: params.cls };
  }

  // Right before the CDP click: the ref still resolves to a control of that
  // class and label, and the click point (params.x, params.y) still lands
  // on it.
  function pressHitUser(params) {
    var t = userTarget(params);
    if (typeof params.x !== "number" || typeof params.y !== "number") throw PageError(ERR.BAD_REQUEST, "x and y are required");
    hitTest(t, params.x, params.y, params.ref);
    return { ok: true };
  }

  // After the press: the control stops looking locked.
  function pressDoneUser(params) {
    var el = elementFor(params.ref);
    Protect.release(lockTarget(el).el);
    return { ok: true };
  }

  // DOM fallback when CDP cannot attach: check, click and release in one
  // task, so nothing on the page runs in between.
  function pressRefUser(params) {
    var t = userTarget(params);
    if (typeof t.el.scrollIntoView === "function") t.el.scrollIntoView({ block: "center", behavior: "instant" });
    var r = t.el.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) {
      var x = r.x !== undefined ? r.x : r.left, y = r.y !== undefined ? r.y : r.top;
      hitTest(t, x + r.width / 2, y + r.height / 2, params.ref);
    }
    t.el.click();
    Protect.release(t.el);
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

  // ------------------------------------------------------------ field kinds
  // Card fields are found and filled by content/cardfill.js, in every frame;
  // this is only for the typing guard (focused_field).
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

  // ------------------------------------------------------- order_buttons
  // The controls pay_with_saved_card may press once after the user's yes:
  // order commits and card form submits (Protect.pressable), never a
  // wallet, a subscription, a saved card, an account control or one that
  // only goes to checkout. Classified as with Danger mode off (classify),
  // the same check press_protected makes in either mode. Refs and labels
  // only; labels are masked like everything read from the page.
  var ORDER_CANDIDATES = "button,input[type=submit],input[type=button],input[type=image],[role=button],a[href],[data-clearcart-protected]";
  function orderButtons() {
    var out = [];
    var els = document.querySelectorAll(ORDER_CANDIDATES);
    for (var i = 0; i < els.length && out.length < 10; i++) {
      var el = els[i];
      var lk = Protect.classify(el);
      if (!Protect.pressable(lk) || Protect.isCheckoutNav(lk.label)) continue;
      if (hiddenByStyle(el) || (el.closest && el.closest("[hidden],[aria-hidden=true]"))) continue;
      var off = !!el.disabled || el.getAttribute("aria-disabled") === "true";
      out.push({ ref: refFor(el), label: Mask.maskCardRuns(lk.label), kind: lk.kind, disabled: off });
    }
    return { buttons: out };
  }

  // A document whose whole body is the editor (designMode, or an editable
  // body, as old rich-text editors in a frame have).
  function editableDoc(doc) {
    return doc.designMode === "on" || !!(doc.body && doc.body.isContentEditable);
  }

  // Kind of the element that has keyboard focus, so the worker can refuse
  // CDP typing into a card field. Never returns the value. nothing: no
  // element has focus (only the page or a frame's page), so typed text
  // would go nowhere.
  // No visible area: off its window's viewport, or under 2px on a side.
  function offscreen(el) {
    var win = el.ownerDocument && el.ownerDocument.defaultView;
    var r = el.getBoundingClientRect();
    return !win || !(r.width >= 2) || !(r.height >= 2) || r.right <= 0 || r.bottom <= 0 || r.left >= win.innerWidth || r.top >= win.innerHeight;
  }

  // hidden: the field (or a frame it is in) can't be seen, like the hidden
  // field a canvas editor types through (Google Docs). content/hotkey.js
  // talks on a held Space there, so the worker types spaces there without a
  // Space key event.
  function focusedField() {
    var out = focusedKind();
    if (out.el) {
      var hidden = false;
      try {
        hidden = offscreen(out.el) || out.frames.some(offscreen);
      } catch (_) { hidden = false; }
      if (hidden) out.info.hidden = true;
    }
    return out.info;
  }

  function focusedKind() {
    var frames = [];
    var done = function (info, el) { return { info: info, el: el || null, frames: frames }; };
    var el = document.activeElement;
    for (var guard = 0; el && guard < 20; guard++) {
      if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
      if (!/^(IFRAME|FRAME|OBJECT|EMBED|FENCEDFRAME)$/.test(el.tagName)) break;
      // Focus inside a frame: a same-origin one is read like the page; a
      // cross-origin one (hosted card fields) cannot be checked, so typing
      // there is refused like a payment field.
      var sub = null;
      try { sub = el.contentDocument || null; } catch (_) { sub = null; }
      if (!sub) return done({ kind: "frame", payment: true, text: false });
      frames.push(el);
      var inner = sub.activeElement;
      if (!inner || inner === sub.body || inner === sub.documentElement) {
        return done(editableDoc(sub) ? { kind: "other", payment: false, text: true } : { kind: "none", payment: false, nothing: true });
      }
      el = inner;
    }
    if (!el || el === document.body || el === document.documentElement) {
      return done(editableDoc(document) ? { kind: "other", payment: false, text: true } : { kind: "none", payment: false, nothing: true });
    }
    var tag = el.tagName;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
      return done({ kind: el.isContentEditable ? "other" : "none", payment: false, text: !!el.isContentEditable }, el);
    }
    var k = kindOf(el);
    // text: a field that takes typed characters, so a key press there only
    // types (watchable typing sends key events only then).
    var text = !el.disabled && !el.readOnly && (tag === "TEXTAREA" ||
      (tag === "INPUT" && /^(text|search|email|url|tel|number)$/.test(String(el.type || "text").toLowerCase())));
    return done({ kind: k, payment: k.indexOf("cc-") === 0 || !!Mask.isPaymentField(el), password: isPassword(el), text: text }, el);
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

  // ------------------------------------------------------ marketing pop-ups
  // overlay_find and overlay_hide, for the worker's dismiss_overlay (it
  // tries the close button, Escape and the backdrop first, through the
  // guarded click path; overlay_hide is the last resort). Never for a
  // dialog that signs in, checks out or takes payment: those are refused.
  // Not bridge methods: only the router calls them.
  var OVERLAY_SEL = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  var CLOSE_NAME = /^(?:close|close (?:dialog|modal|pop-?up|window|this|form|banner|offer|sign ?up)|dismiss|no,? ?thanks?|no thank you|not now|not today|maybe later|skip|x|×|✕|✖|╳)$/i;
  var CLOSE_HINT = /(?:^|[\s_-])(?:close|dismiss)(?:$|[\s_-])|^(?:close|dismiss)/i;
  var SENSITIVE_NAME = /\b(?:sign[\s-]?in|log[\s-]?in|login|create (?:an |your )?account|welcome back|my account|checkout|check[\s-]out|payment|billing|password|verify|verification|captcha|security check|one[\s-]time (?:code|password)|otp|enter (?:the|your) code)\b/i;
  // Checked against the whole pop-up's text, not just its name.
  var SENSITIVE_TEXT = /\b(?:verification code|one[\s-]time (?:code|passcode|password)|enter (?:the|your) (?:code|password)|security check|captcha)\b/i;
  var COOKIE_NAME = /\b(?:cookies?|consent|privacy|gdpr|ccpa)\b/i;
  var SIGNIN_LABEL = /sign[\s-]?in|log[\s-]?in|login|continue with|create (?:an |my )?account|register/i;
  var SENSITIVE_KINDS = { order: 1, express: 1, "payment-method": 1 };
  var SENSITIVE_PATH = /checkout|payment|\/pay(?:\/|$)|login|log-in|signin|sign-in|password|\/account/i;
  var COVER_SHARE = 0.3; // a fixed box over this much of the viewport is a backdrop

  function ours(el) {
    for (var n = el; n; n = n.parentElement) {
      if (n.hasAttribute && n.hasAttribute("data-clearcart-overlay")) return true;
      if (/^CLEARCART-/.test(n.tagName) || n.id === "clearcart-lock-badges") return true;
    }
    return false;
  }

  function boxShown(el) {
    if (!el || el.nodeType !== 1 || hiddenByStyle(el)) return null;
    var r = el.getBoundingClientRect();
    if (!(r.width > 1 && r.height > 1)) return null;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return null;
    return r;
  }

  function fixedCover(el) {
    var cs;
    try { cs = getComputedStyle(el); } catch (_) { return false; }
    if (cs.position !== "fixed" && cs.position !== "sticky") return false;
    var r = boxShown(el);
    if (!r) return false;
    var w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    var h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return (w * h) / Math.max(1, innerWidth * innerHeight) >= COVER_SHARE;
  }

  // A fixed box with no dialog role is a pop-up only when it is not the
  // page's own layout: no main, nav or header in it, and well under half of
  // the page's text.
  function popupLike(cover) {
    if (cover.querySelector("main,nav,header,[role=main],[role=navigation],[role=banner]")) return false;
    var all = clean(textOf(document.body), 100000).length;
    var mine = clean(textOf(cover), 100000).length;
    return all === 0 || mine / all < 0.5;
  }

  // The topmost pop-up: from what sits over the middle of the viewport, the
  // outermost fixed box covering much of it (the backdrop or wrapper) and
  // the dialog inside it; else any open dialog on screen.
  function topOverlay() {
    var stack = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(innerWidth / 2, innerHeight / 2) : [];
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (el === document.documentElement || el === document.body || ours(el)) continue;
      var cover = null, dialog = null;
      for (var n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        if (!dialog && n.matches && n.matches(OVERLAY_SEL)) dialog = n;
        if (fixedCover(n)) cover = n;
      }
      if (cover && !dialog && !cover.querySelector(OVERLAY_SEL) && !popupLike(cover)) cover = null;
      if (cover || dialog) {
        if (!dialog && cover) dialog = cover.querySelector(OVERLAY_SEL) || cover;
        return { root: cover || dialog, dialog: dialog, cover: cover };
      }
      break; // the page itself is on top
    }
    var all = document.querySelectorAll(OVERLAY_SEL);
    for (var j = 0; j < all.length; j++) {
      if (!ours(all[j]) && boxShown(all[j])) return { root: all[j], dialog: all[j], cover: null };
    }
    return null;
  }

  function overlayName(o) {
    var d = o.dialog;
    var s = nameOf(d, "dialog");
    if (!s) {
      var h = d.querySelector("h1,h2,h3,h4,[role=heading]");
      s = h ? clean(textOf(h)) : "";
    }
    return s || clean(textOf(d), 60) || "pop-up";
  }

  // Why this pop-up must stay, or "" when it may be dismissed.
  function sensitiveWhy(o) {
    if (SENSITIVE_PATH.test(location.pathname)) return "this is a checkout, payment or sign-in page";
    var root = o.root;
    var fields = root.querySelectorAll("input,select,textarea");
    for (var i = 0; i < fields.length; i++) {
      if (Mask.isPaymentField(fields[i])) return "it has a payment field";
      if (Protect.isPasswordField(fields[i])) return "it has a password field";
    }
    var name = overlayName(o);
    if (SENSITIVE_NAME.test(name)) return "it looks like a sign-in, checkout, payment or verification dialog";
    var text = clean(textOf(root), 4000);
    if (COOKIE_NAME.test(name) || /\bcookies?\b/i.test(text)) return "it is a cookie or privacy banner: choose reject, decline or necessary only in it instead";
    if (SENSITIVE_TEXT.test(text)) return "it asks for a code or verification";
    var controls = root.querySelectorAll("button,a,input,[role=button]");
    for (var j = 0; j < controls.length && j < 300; j++) {
      var l = Protect.classify(controls[j]);
      if (l && SENSITIVE_KINDS[l.kind]) return "it has a checkout or payment button";
      if (l && l.kind === "account" && SIGNIN_LABEL.test(Protect.labelOf(controls[j]) || "")) return "it has a sign-in button";
    }
    return "";
  }

  function clickable(el) {
    if (/^(BUTTON|A|SUMMARY)$/.test(el.tagName) || (el.tagName === "INPUT" && /^(button|submit|image|reset)$/i.test(el.type))) return true;
    var role = el.getAttribute("role");
    if (role === "button" || role === "link") return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) return true;
    try { return getComputedStyle(el).cursor === "pointer"; } catch (_) { return false; }
  }

  function closeName(el) {
    return clean(el.getAttribute("aria-label") || el.getAttribute("title") || nameOf(el, "button") || textOf(el), 40);
  }

  // The pop-up's close or decline control: by accessible name first
  // (close, dismiss, no thanks, X), then by a close-ish class or id.
  function findClose(o) {
    var scope = o.cover || o.root;
    var els = scope.querySelectorAll("button,a,[role=button],[aria-label],[title],input[type=button],input[type=image],span,div,svg,i");
    var hint = null;
    for (var i = 0; i < els.length && i < 2000; i++) {
      var el = els[i];
      if (el.tagName === "svg" || el.tagName === "SPAN" || el.tagName === "I" || el.tagName === "DIV") {
        // An icon inside a button: the button is the control.
        var up = el.closest("button,a,[role=button]");
        if (up && scope.contains(up)) continue;
      }
      if (!boxShown(el) || !clickable(el)) continue;
      var lock = Protect.classify(el);
      if (lock) continue;
      if (CLOSE_NAME.test(closeName(el))) return el;
      var cls = (typeof el.className === "string" ? el.className : "") + " " + (el.id || "");
      if (!hint && CLOSE_HINT.test(cls.trim()) && clean(textOf(el)).length <= 3) hint = el;
    }
    return hint;
  }

  // A point on the backdrop, outside the dialog, where a click lands on the
  // backdrop itself.
  function backdropPoint(o) {
    if (!o.cover || o.cover === o.dialog) return null;
    // Pinch zoom: page and input coordinates differ; skip the backdrop.
    if (globalThis.visualViewport && Math.abs(visualViewport.scale - 1) > 0.01) return null;
    var inner = o.dialog !== o.cover ? o.dialog : null;
    var w = innerWidth, h = innerHeight;
    var pts = [[w / 2, 12], [w / 2, h - 12], [12, h / 2], [w - 24, h / 2], [24, 24], [w - 24, h - 24]];
    for (var i = 0; i < pts.length; i++) {
      var x = Math.round(pts[i][0]), y = Math.round(pts[i][1]);
      var hit = document.elementFromPoint(x, y);
      if (!hit || !o.cover.contains(hit)) continue;
      if (inner && inner.contains(hit)) continue;
      if (hit !== o.cover && clickable(hit)) continue; // a control, not the backdrop
      return { x: x, y: y };
    }
    return null;
  }

  function overlayFind() {
    var o = topOverlay();
    if (!o) return { found: false };
    var name = overlayName(o);
    var why = sensitiveWhy(o);
    if (why) return { found: true, ref: refFor(o.root), name: name, sensitive: why };
    var close = findClose(o);
    return { found: true, ref: refFor(o.root), name: name, closeRef: close ? refFor(close) : null, backdrop: backdropPoint(o) };
  }

  // Last resort: hides the pop-up and gives the page its scrolling back.
  function overlayHide(params) {
    var root = elementFor(params.ref);
    var o = topOverlay();
    if (!o || (o.root !== root && !root.contains(o.root) && !o.root.contains(root))) o = { root: root, dialog: root.matches(OVERLAY_SEL) ? root : root.querySelector(OVERLAY_SEL) || root, cover: null };
    var why = sensitiveWhy(o);
    if (why) throw PageError(ERR.LOCKED, "Locked: not hiding this dialog, " + why + ". Ask the user.");
    var dialogs = [o.root].concat(Array.prototype.slice.call(o.root.querySelectorAll("dialog[open]")));
    for (var i = 0; i < dialogs.length; i++) {
      var d = dialogs[i];
      if (d.tagName === "DIALOG" && d.open && typeof d.close === "function") { try { d.close(); } catch (_) { /* hide below */ } }
    }
    o.root.style.setProperty("display", "none", "important");
    o.root.setAttribute("data-clearcart-dismissed", "");
    // Its backdrop, when it is a separate fixed sibling covering the page.
    var sib = o.root.previousElementSibling;
    if (sib && !ours(sib) && fixedCover(sib) && clean(textOf(sib)) === "") sib.style.setProperty("display", "none", "important");
    // Modals lock scrolling with overflow hidden on html or body.
    [document.documentElement, document.body].forEach(function (n) {
      if (!n) return;
      try { if (getComputedStyle(n).overflow === "hidden" || getComputedStyle(n).overflowY === "hidden") n.style.setProperty("overflow", "auto", "important"); } catch (_) { /* cosmetic */ }
    });
    return { hidden: true, name: overlayName(o) };
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
    order_buttons: orderButtons,
    guard_ref: guardRef,
    guard_point: guardPoint,
    guard_key: guardKey,
    press_check: pressCheck,
    press_ref: pressRef,
    lock_info: lockInfo,
    press_check_user: pressCheckUser,
    press_hit_user: pressHitUser,
    press_done_user: pressDoneUser,
    press_ref_user: pressRefUser,
    overlay_find: overlayFind,
    overlay_hide: overlayHide,
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
      .then(function () {
        // Danger mode comes from the worker, from the extension's own
        // settings, on every call (the message, never params, which carry
        // what the agent sent). Anything but true is off.
        if (Protect) Protect.setDangerMode(msg.dangerMode === true);
        return call(msg.method, msg.params);
      })
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
  // Remember every password field from the start, so a later type change
  // (a show-password toggle) still counts as a password.
  if (Protect && typeof Protect.watchPasswords === "function") {
    try { Protect.watchPasswords(document); } catch (_) { /* isPasswordField still checks each field */ }
  }

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
