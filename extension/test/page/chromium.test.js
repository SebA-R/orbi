// Real-layout check in Playwright's isolated Chromium (never the user's
// Chrome): mask.js + page.js injected in worker order into live store pages.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startStore } from "./harness.js";

const file = (p) => fileURLToPath(new URL(p, import.meta.url));
let store, browser;

before(async () => {
  store = await startStore();
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  store?.stop();
});

async function open(path) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.goto(store.base + path);
  await page.addScriptTag({ path: file("../../content/mask.js") });
  await page.addScriptTag({ path: file("../../content/protect.js") });
  await page.addScriptTag({ path: file("../../content/page.js") });
  await page.addScriptTag({ path: file("../../content/page.js") }); // idempotent re-inject
  const call = (method, params = {}) =>
    page.evaluate(([m, p]) => globalThis.__clearcartPage.handle({ method: m, params: p }), [method, params]);
  return { page, call };
}

test("checkout: fill_payment, masked read_page, rect hits #place-order", async () => {
  await fetch(store.base + "/reset", { method: "POST", redirect: "manual" });
  await fetch(store.base + "/cart/add", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "product_id=cetirizine-30&quantity=1",
    redirect: "manual",
  });
  const { page, call } = await open("/checkout");
  const fill = await call("fill_payment", { card: { name: "Ada Lovelace", number: "4111111111111111", exp: "12/29", csc: "737" }, address: "1 Main St" });
  assert.deepEqual({ ok: fill.ok, result: fill.result }, { ok: true, result: { ok: true, last4: "1111" } });
  const tree = (await call("read_page", { filter: "all" })).result.tree;
  for (const s of ["4111111111111111", "Ada Lovelace", "12/29", "737"]) assert.ok(!tree.includes(s), "leaked " + s);
  const ref = (await call("find", { query: "place order" })).result.matches[0].ref;
  const r = (await call("rect", { ref })).result;
  assert.ok(r.width > 0 && r.height > 0, JSON.stringify(r));
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [r.x + r.width / 2, r.y + r.height / 2]);
  assert.equal(hit, "place-order");
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await page.waitForURL(/\/order\//);
  assert.equal(await page.textContent("#card-last4"), "1111");
  await page.close();
});

test("cart: hidden addon line is skipped after unticking the add-on", async () => {
  await fetch(store.base + "/cart/add", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "product_id=cetirizine-30&quantity=1",
    redirect: "manual",
  });
  const { page, call } = await open("/cart");
  const ref = (await call("find", { query: "subscribe", limit: 5 })).result.matches.find((m) => m.role === "checkbox").ref;
  assert.equal((await call("form_input", { ref, value: false })).ok, true);
  await page.waitForFunction(() => document.getElementById("addon-line").hidden);
  const text = (await call("get_page_text", {})).result.text;
  assert.ok(!text.includes("Subscribe & Save membership"), text);
  await page.close();
});

test("button lock: real hit-testing, label clicks, the badge never blocks a person's click", async () => {
  await fetch(store.base + "/reset", { method: "POST", redirect: "manual" });
  await fetch(store.base + "/cart/add", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "product_id=cetirizine-30&quantity=1",
    redirect: "manual",
  });
  const { page, call } = await open("/checkout");
  const ref = (await call("find", { query: "place order" })).result.matches.find((m) => m.role === "button").ref;
  const r = (await call("rect", { ref })).result;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;

  // A coordinate click on the button, or on its edge, is refused.
  for (const [x, y] of [[cx, cy], [r.x + 3, r.y + 3]]) {
    const g = await call("guard_point", { x, y });
    assert.equal(g.ok, false, `${x},${y}`);
    assert.equal(g.error.code, "locked");
  }
  assert.equal((await call("guard_ref", { ref })).error.code, "locked");
  // Somewhere plain is fine.
  assert.equal((await call("guard_point", { x: 5, y: 5 })).ok, true);

  // The badge is drawn over the button, but the hit test goes straight through it.
  const badge = await page.evaluate(() => {
    const host = document.getElementById("clearcart-lock-badges");
    return host && { aria: host.getAttribute("aria-hidden"), pe: getComputedStyle(host).pointerEvents };
  });
  assert.deepEqual(badge, { aria: "true", pe: "none" });
  const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [r.x + 4, r.y - 6 > 0 ? r.y - 6 : r.y + 2]);
  assert.notEqual(under, "clearcart-lock-badges");

  // Enter from a field of the payment form is refused.
  await page.focus('[name="cc-name"]');
  assert.equal((await call("guard_key", { key: "Enter" })).error.code, "locked");

  // Place order and the card fields look grayed out, but stay enabled for a person.
  const look = await page.evaluate(() => ["#place-order", '[name="cc-number"]'].map((s) => {
    const el = document.querySelector(s);
    const cs = getComputedStyle(el);
    return { marked: el.hasAttribute("data-clearcart-locked"), opacity: cs.opacity, filter: cs.filter, disabled: el.disabled || el.hasAttribute("aria-disabled") || el.inert, pe: cs.pointerEvents };
  }));
  for (const l of look) assert.deepEqual(l, { marked: true, opacity: "0.45", filter: "grayscale(1)", disabled: false, pe: "auto" });

  // The lock is for the agent only: a person's own click places the order.
  await call("fill_payment", { card: { name: "Ada Lovelace", number: "4111111111111111", exp: "12/29", csc: "737" }, address: "1 Main St" });
  await page.mouse.click(cx, cy);
  await page.waitForURL(/\/order\//);
  await page.close();
});

test("button lock: a label click would check the add-on back on, so it is refused once unchecked", async () => {
  await fetch(store.base + "/cart/add", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "product_id=cetirizine-30&quantity=1",
    redirect: "manual",
  });
  const { page, call } = await open("/cart");
  const box = (await call("find", { query: "subscribe", limit: 5 })).result.matches.find((m) => m.role === "checkbox");
  assert.equal(box.uncheckOnly, true);
  const label = await page.evaluate(() => {
    const r = document.querySelector('label:has(#addon_subscription)').getBoundingClientRect();
    return { x: r.right - 20, y: r.top + r.height / 2 };
  });
  // Checked: clicking the label unchecks it, which is allowed.
  if (await page.isChecked("#addon_subscription")) assert.equal((await call("guard_point", label)).ok, true);
  assert.equal((await call("form_input", { ref: box.ref, value: false })).ok, true);
  const g = await call("guard_point", label);
  assert.equal(g.ok, false);
  assert.match(g.error.message, /can only be unchecked/);
  await page.close();
});

test("protect.js in real layout: closed shadow roots fail closed, pointer divs and form= buttons lock", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`<style>.btn{cursor:pointer;padding:8px;width:200px}</style>
    <div id="pd" class="btn"><span>Place order</span></div>
    <pay-widget id="host" style="display:block;width:200px;height:40px"></pay-widget>
    <form id="f"><input id="addr" name="address"></form><button form="f" id="po">Place order</button>`);
  await page.evaluate(() => {
    const sr = document.getElementById("host").attachShadow({ mode: "closed" });
    sr.innerHTML = `<button style="width:200px;height:40px">Buy now</button>`;
    globalThis.__sr = sr;
  });
  await page.addScriptTag({ path: file("../../content/mask.js") });
  await page.addScriptTag({ path: file("../../content/protect.js") });
  const at = (sel) => page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    const l = globalThis.ClearcartProtect.lockAt(document, r.left + r.width / 2, r.top + r.height / 2);
    return l && l.kind;
  }, sel);
  assert.equal(await at("#pd"), "order");
  assert.equal(await at("#host"), "shadow", "no chrome.dom in the main world: fail closed");
  await page.evaluate(() => { globalThis.chrome = { dom: { openOrClosedShadowRoot: (el) => (el.id === "host" ? globalThis.__sr : null) } }; });
  assert.equal(await at("#host"), "order", "with chrome.dom the closed root is read");
  await page.focus("#addr");
  assert.equal(await page.evaluate(() => globalThis.ClearcartProtect.lockForKey(document, "Enter")?.kind), "order");
  await page.close();
});

test("a lock badge at the right edge stays in the viewport and adds no scroll width", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // An open shadow root, so the test can measure the badge.
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function () { return attach.call(this, { mode: "open" }); };
  });
  await page.goto("about:blank");
  // Page CSS that tries to unpin our host does not get to.
  await page.setContent(`<style>html>div{position:static!important;overflow:visible!important}</style>
    <table width="100%"><tr><td>News</td><td style="text-align:right"><a href="/login">login</a></td></tr></table>`);
  for (const f of ["mask.js", "protect.js"]) await page.addScriptTag({ path: file("../../content/" + f) });
  const before = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.equal(await page.evaluate(() => ClearcartProtect.showBadges(document)), 1);
  const after = await page.evaluate(() => {
    const host = document.getElementById("clearcart-lock-badges");
    const b = host.shadowRoot.querySelector(".b").getBoundingClientRect();
    return { sw: document.documentElement.scrollWidth, right: b.right, pos: getComputedStyle(host).position, overflow: getComputedStyle(host).overflow };
  });
  assert.equal(after.sw, before);
  assert.ok(after.right <= 1440, `badge right ${after.right}`);
  assert.deepEqual([after.pos, after.overflow], ["fixed", "hidden"]);
  await page.close();
});

const POPUP = (inner, { close = '<button aria-label="Close" class="x">×</button>' } = {}) => `<body style="overflow:hidden">
  <h1>Wool sweater</h1><button id="add">Add to bag</button><div style="height:3000px"></div>
  <div id="wrap" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10">
    <div id="dlg" role="dialog" aria-modal="true" aria-labelledby="t" style="position:absolute;left:400px;top:200px;width:500px;height:300px;background:#fff">
      ${close}<h2 id="t">Get 10% off your first order</h2>${inner}
    </div>
  </div>
  <script>document.getElementById("wrap").addEventListener("click", (e) => { if (e.target.id === "wrap") window.backdropClicked = true; });</script></body>`;

async function openPopup(html) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("about:blank");
  await page.setContent(html);
  for (const f of ["mask.js", "protect.js", "page.js"]) await page.addScriptTag({ path: file("../../content/" + f) });
  const call = (method, params = {}) => page.evaluate(([m, p]) => globalThis.__clearcartPage.handle({ method: m, params: p }), [method, params]);
  return { page, call };
}

test("dismiss_overlay page helpers: a sign-up pop-up's close button and backdrop are found, and hiding it frees the page", async () => {
  const { page, call } = await openPopup(POPUP('<input type="email" placeholder="Email"><button>Sign up</button><button>No thanks</button>'));
  const f = (await call("overlay_find")).result;
  assert.equal(f.found, true);
  assert.equal(f.name, "Get 10% off your first order");
  assert.ok(!f.sensitive, f.sensitive);
  assert.ok(f.closeRef, "close button found");
  assert.equal(await page.evaluate((ref) => [...document.querySelectorAll("button")].find((b) => globalThis.__clearcartPage.refFor(b) === ref)?.getAttribute("aria-label"), f.closeRef), "Close");
  assert.ok(f.backdrop, "a backdrop point");
  await page.mouse.click(f.backdrop.x, f.backdrop.y);
  assert.equal(await page.evaluate(() => window.backdropClicked), true, "the point lands on the backdrop");

  const h = (await call("overlay_hide", { ref: f.ref })).result;
  assert.equal(h.hidden, true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("wrap")).display), "none");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow), "auto");
  assert.deepEqual((await call("overlay_find")).result, { found: false });
  await page.close();
});

test("dismiss_overlay page helpers: no close button by name falls back to a close-ish class; text 'No thanks' counts too", async () => {
  const a = await openPopup(POPUP("<p>Join the list</p>", { close: '<div class="modal-close" style="cursor:pointer;width:20px;height:20px"></div>' }));
  const fa = (await a.call("overlay_find")).result;
  assert.ok(fa.closeRef);
  await a.page.close();
  const b = await openPopup(POPUP("<p>Join the list</p><a href='#' id='nt'>No, thanks</a>", { close: "" }));
  const fb = (await b.call("overlay_find")).result;
  assert.equal(await b.page.evaluate((ref) => globalThis.__clearcartPage.refFor(document.getElementById("nt")) === ref, fb.closeRef), true);
  await b.page.close();
});

test("dismiss_overlay page helpers: sign-in, payment and cookie dialogs are never hidden", async () => {
  for (const [inner, heading] of [
    ['<input type="password" name="pw"><button>Continue</button>', null],
    ['<input autocomplete="cc-number" name="cardnumber"><button>Save</button>', null],
    ["<button>Continue</button>", "Sign in to your account"],
    ["<button>Accept all</button><button>Reject all</button>", "We use cookies"],
  ]) {
    let html = POPUP(inner);
    if (heading) html = html.replace("Get 10% off your first order", heading);
    const { page, call } = await openPopup(html);
    const f = (await call("overlay_find")).result;
    assert.equal(f.found, true);
    assert.ok(f.sensitive, `${inner} ${heading}`);
    assert.equal(f.closeRef, undefined);
    const h = await call("overlay_hide", { ref: f.ref });
    assert.equal(h.ok, false);
    assert.equal(h.error.code, "locked");
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("wrap")).display), "block");
    await page.close();
  }
});
