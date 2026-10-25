// Clearcart page content script.
//
// Injected on demand by the worker with
//   chrome.scripting.executeScript({ target: { tabId }, files: ["content/mask.js", "content/page.js"] })
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
    INTERNAL: "internal",
  };

  var Mask = globalThis.ClearcartMask;

  function PageError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
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
        emit(depth, line + " [" + refFor(el) + "]");
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
    return { url: location.href, title: Mask.maskCardRuns(document.title), tree: lines.join("\n") };
  }

  // ------------------------------------------------------------ dispatcher
  var METHODS = {
    read_page: readPage,
  };

  function call(method, params) {
    if (!Mask) throw PageError(ERR.INTERNAL, "mask.js was not injected before page.js");
    var fn = Object.prototype.hasOwnProperty.call(METHODS, method) && METHODS[method];
    if (!fn) throw PageError(ERR.UNKNOWN_METHOD, "unknown page method: " + method);
    if (params != null && typeof params !== "object") throw PageError(ERR.BAD_REQUEST, "params must be an object");
    return fn(params || {});
  }

  function handle(msg) {
    return Promise.resolve()
      .then(function () { return call(msg.method, msg.params); })
      .then(
        function (result) { return { ok: true, result: result === undefined ? null : result }; },
        function (e) {
          return { ok: false, error: { code: (e && e.code) || ERR.INTERNAL, message: String((e && e.message) || "failed") } };
        }
      );
  }

  globalThis.__clearcartPage = { call: call, handle: handle, refFor: refFor };

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
