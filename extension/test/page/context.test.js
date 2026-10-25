// page_context in jsdom: content/context.js remembers what the user points
// at, page.js names it with a ref and masks payment and password fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPage } from "./harness.js";

const CONTEXT_SRC = readFileSync(fileURLToPath(new URL("../../content/context.js", import.meta.url)), "utf8");
const HTML = `<main>
  <ul><li class="card"><h3><a href="/p/1">Blue speckled mug</a></h3><span>$24.00</span><button>Add to cart</button></li></ul>
  <form><label>Password <input id="pw" type="password" value="hunter2"></label>
  <label>Card number <input id="cc" autocomplete="cc-number" value="4111111111111111"></label>
  <label>Search <input id="q" value="secret words"></label></form>
</main>`;

function setup() {
  const p = loadPage(HTML, { url: "https://www.etsy.com/" });
  p.window.eval(CONTEXT_SRC);
  return p;
}

test("hovering a product link names it with a ref, title and price", async () => {
  const { window, document, call } = setup();
  document.querySelector("a").dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const { result } = await call("page_context");
  assert.equal(result.pointing.via, "hover");
  assert.match(result.pointing.ref, /^ref_\d+$/);
  assert.equal(result.pointing.role, "link");
  assert.equal(result.pointing.name, "Blue speckled mug");
  assert.deepEqual(result.pointing.product, { title: "Blue speckled mug", price: "$24.00" });
  assert.equal(result.selection, "");
});

test("payment and password fields are masked and no field value or input selection leaves the page", async () => {
  const { document, call } = setup();
  for (const id of ["pw", "cc"]) {
    document.getElementById(id).focus();
    const { result } = await call("page_context");
    assert.equal(result.pointing.masked, true, id);
    assert.equal(result.pointing.name, "[masked field]");
    assert.ok(!JSON.stringify(result).match(/hunter2|4111/), id);
  }
  const q = document.getElementById("q");
  q.focus();
  q.select();
  const { result } = await call("page_context");
  assert.equal(result.selection, "");
  assert.ok(!JSON.stringify(result).includes("secret words"));
});
