// Runs page.js against real HTML from the demo store (store/server.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadPage, startStore, fetchHtml } from "./harness.js";

const CARD = "4111111111111111";
let store;
const pages = {};

before(async () => {
  store = await startStore();
  const b = store.base;
  await fetch(b + "/reset", { method: "POST", redirect: "manual" });
  pages.home = await fetchHtml(b + "/");
  pages.search = await fetchHtml(b + "/search?q=allergy");
  pages.product = await fetchHtml(b + "/product/cetirizine-30");
  await fetch(b + "/cart/add", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "product_id=cetirizine-30&quantity=1",
    redirect: "manual",
  });
  pages.cart = await fetchHtml(b + "/cart");
  pages.checkout = await fetchHtml(b + "/checkout");
});
after(() => store && store.stop());

const load = (name, path = "/") => loadPage(pages[name], { url: store.base + path });

test("read_page interactive lists search, links and buttons with refs", async () => {
  const p = load("search", "/search?q=allergy");
  const r = await p.call("read_page", {});
  assert.equal(r.ok, true, JSON.stringify(r));
  const { tree, url, title } = r.result;
  assert.ok(url.includes("/search"));
  assert.ok(title.length > 0);
  assert.match(tree, /^- searchbox "Search products" value="allergy" \[ref_\d+\]$/m);
  assert.match(tree, /^- button "Search" \[ref_\d+\]$/m);
  assert.match(tree, /- link "Elm Health Cetirizine[^"]*" href="\/product\/cetirizine-30" \[ref_\d+\]/);
});

test("read_page refs are stable across calls and re-injection", async () => {
  const p = load("product", "/product/cetirizine-30");
  const a = (await p.call("read_page", {})).result.tree;
  p.inject();
  const b = (await p.call("read_page", {})).result.tree;
  assert.equal(a, b);
  assert.match(a, /- button "Add to cart" \[ref_\d+\]/);
  assert.match(a, /- spinbutton "Quantity" value="1" \[ref_\d+\]/);
});

test("read_page shows the pre-checked add-on checkbox on the cart", async () => {
  const p = load("cart", "/cart");
  const { tree } = (await p.call("read_page", {})).result;
  assert.match(tree, /- checkbox "Subscribe & Save[^"]*" checked \[ref_\d+\]/);
  assert.match(tree, /- button "Proceed to checkout" \[ref_\d+\]/);
});

test("read_page all mode includes headings and text", async () => {
  const p = load("product", "/product/cetirizine-30");
  const { tree } = (await p.call("read_page", { filter: "all" })).result;
  assert.match(tree, /- heading "Elm Health Cetirizine[^"]*" level=1 \[ref_\d+\]/);
  assert.match(tree, /text "\$8\.99"/);
});

test("read_page masks filled payment fields and card numbers in text", async () => {
  const p = load("checkout", "/checkout");
  const d = p.document;
  d.querySelector('[name="cc-number"]').value = CARD;
  d.querySelector('[name="cc-csc"]').value = "123";
  d.querySelector('[name="cc-exp"]').value = "12/29";
  d.querySelector('[name="cc-name"]').value = "Ada Lovelace";
  const note = d.createElement("p");
  note.textContent = "Saved card 4111 1111 1111 1111";
  d.querySelector("main").append(note);
  for (const filter of ["interactive", "all"]) {
    const out = JSON.stringify((await p.call("read_page", { filter })).result);
    for (const secret of [CARD, "4111 1111", "123", "12/29", "Ada Lovelace"]) {
      assert.ok(!out.includes(secret), `${filter} leaked ${secret}`);
    }
    assert.ok(out.includes("[masked]"));
  }
});

test("read_page maxNodes truncates with a note", async () => {
  const p = load("home");
  const { tree } = (await p.call("read_page", { filter: "all", maxNodes: 5 })).result;
  const lines = tree.split("\n");
  assert.equal(lines.length, 6);
  assert.match(lines[5], /more nodes/);
});

test("unknown methods and bad refs return protocol errors", async () => {
  const p = load("home");
  const r = await p.call("nope", {});
  assert.deepEqual(r.ok, false);
  assert.equal(r.error.code, "unknown_method");
});

