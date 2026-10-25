// A small unbranded shop for tests: plain pages (home, search, product,
// cart, checkout, order) and a local server for the tests that need real
// navigation. Nothing here is real: two made-up products, a mocked charge,
// and a card check that accepts only the published Visa test number
// 4111 1111 1111 1111. Card values are never logged, kept or echoed back;
// an order keeps the last 4 digits only.
//
//   import { pages, startShop } from "tests/fixtures/shop.mjs";
//   pages()            HTML strings with one mug in the cart (no server)
//   await startShop()  { base, port, stop } on 127.0.0.1, a free port
//
// startShop({ cardFrame }) takes the card number, expiry and security code
// in frames from another origin instead (tests/fixtures/card-frame.mjs),
// the way hosted card fields work: one frame with every field, or with
// cardLayout "split" one frame per field. The name on the card stays on
// the shop's own page.

import http from "node:http";
import { randomBytes } from "node:crypto";

export const PRODUCTS = Object.freeze([
  { id: "mug", name: "Blue mug", size: "12 oz", price: 12 },
  { id: "notebook", name: "Lined notebook", size: "80 pages", price: 6.5 },
]);
export const ADDON = Object.freeze({ price: 4.99, label: "Subscribe & Save: auto-deliver every 30 days (+$4.99 membership)" });
export const HELP_LINE = "Questions? Call 555-0100.";
const TAX_RATE = 0.08;
const byId = new Map(PRODUCTS.map((p) => [p.id, p]));

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const round2 = (n) => Math.round(n * 100) / 100;
export const money = (n) => `$${n.toFixed(2)}`;

// A fresh cart: empty, with the add-on pre-checked.
export function newCart() {
  return { items: new Map(), addon: true };
}

export function totals(cart) {
  const lines = [...cart.items].map(([id, qty]) => {
    const product = byId.get(id);
    return { product, qty, lineTotal: round2(product.price * qty) };
  });
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const addon = lines.length && cart.addon ? ADDON.price : 0;
  const tax = round2(subtotal * TAX_RATE);
  return { lines, subtotal, addon, tax, total: round2(subtotal + addon + tax), count: lines.reduce((s, l) => s + l.qty, 0) };
}

function layout(title, body, { cart, q = "" }) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} | Test shop</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0}header,main,footer{padding:12px 16px}button{cursor:pointer;padding:8px 14px}
form.checkout{display:grid;gap:10px;max-width:420px}form.checkout label{display:grid;gap:4px}.summary div{display:flex;justify-content:space-between;max-width:320px}</style>
</head>
<body>
<header>
  <a href="/">Test shop</a>
  <form action="/search" method="get" role="search">
    <input type="search" name="q" value="${esc(q)}" aria-label="Search products">
    <button type="submit">Search</button>
  </form>
  <a href="/cart">Cart (${totals(cart).count})</a>
</header>
<main>
${body}
</main>
<footer>${esc(HELP_LINE)} Test pages only: nothing is sold and no payment is taken.</footer>
</body>
</html>`;
}

function results(list) {
  return `<ul>
${list.map((p) => `  <li><a href="/product/${esc(p.id)}">${esc(p.name)}, ${esc(p.size)}</a> <span>${money(p.price)}</span></li>`).join("\n")}
</ul>`;
}

export function homeHtml(cart = newCart()) {
  return layout("Home", `<h1>Test shop</h1>\n<h2>Popular</h2>\n${results(PRODUCTS)}`, { cart });
}

export function searchHtml(q, cart = newCart()) {
  const words = String(q || "").toLowerCase().split(/\W+/).filter(Boolean);
  const hits = PRODUCTS.filter((p) => words.some((w) => `${p.name} ${p.size}`.toLowerCase().includes(w)));
  const body = hits.length
    ? `<h1>${hits.length} result${hits.length === 1 ? "" : "s"} for &ldquo;${esc(q)}&rdquo;</h1>\n${results(hits)}`
    : `<h1>No results for &ldquo;${esc(q)}&rdquo;</h1>`;
  return layout(`Search: ${q}`, body, { cart, q });
}

export function productHtml(id, cart = newCart()) {
  const p = byId.get(id);
  if (!p) return null;
  return layout(
    p.name,
    `<h1 id="product-name">${esc(p.name)}</h1>
<p><span id="product-price">${money(p.price)}</span> &middot; ${esc(p.size)}</p>
<form action="/cart/add" method="post">
  <input type="hidden" name="product_id" value="${esc(p.id)}">
  <label>Quantity <input type="number" name="quantity" value="1" min="1" max="10"></label>
  <button type="submit" id="add-to-cart">Add to cart</button>
</form>`,
    { cart }
  );
}

export function cartHtml(cart = newCart()) {
  const t = totals(cart);
  if (!t.lines.length) return layout("Cart", `<h1>Your cart is empty</h1><p><a href="/">Continue shopping</a></p>`, { cart });
  return layout(
    "Cart",
    `<h1>Your cart</h1>
<table>
${t.lines
  .map(
    (l) => `  <tr><td><a href="/product/${esc(l.product.id)}">${esc(l.product.name)}</a></td><td>${l.qty}</td><td>${money(l.lineTotal)}</td>
    <td><form action="/cart/remove" method="post"><input type="hidden" name="product_id" value="${esc(l.product.id)}"><button type="submit">Remove</button></form></td></tr>`
  )
  .join("\n")}
</table>
<form action="/cart/update" method="post" id="cart-form">
  <p><label><input type="checkbox" name="addon_subscription" id="addon_subscription" value="on"${cart.addon ? " checked" : ""}> ${esc(ADDON.label)}</label></p>
  <div class="summary" data-base="${round2(t.subtotal + t.tax)}">
    <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
    <div id="addon-line"${cart.addon ? "" : " hidden"}><span>Subscribe &amp; Save membership</span><span>${money(ADDON.price)}</span></div>
    <div><span>Estimated tax</span><span>${money(t.tax)}</span></div>
    <div><span>Order total</span><span id="order-total">${money(t.total)}</span></div>
  </div>
  <p><button type="submit" id="checkout-button">Proceed to checkout</button></p>
</form>
<script>
const box = document.getElementById("addon_subscription");
box.addEventListener("change", () => {
  document.getElementById("addon-line").hidden = !box.checked;
  const base = Number(document.querySelector(".summary").dataset.base);
  document.getElementById("order-total").textContent = "$" + (base + (box.checked ? ${ADDON.price} : 0)).toFixed(2);
  const body = new URLSearchParams(box.checked ? { addon_subscription: "on" } : {});
  body.set("ajax", "1");
  fetch("/cart/update", { method: "POST", body }).catch(() => {});
});
</script>`,
    { cart }
  );
}

// The card fields in frames from frame.origin (card-frame.mjs), and the
// script that collects them on submit: each frame posts its fields to its
// own server, and the form then goes out with the session id only.
function cardFramesHtml(frame) {
  const src = (kinds) => `${frame.origin}/fields?kinds=${kinds}&parent=${encodeURIComponent(frame.parent)}`;
  const frames = frame.layout === "split"
    ? [["number", "Card number", 58], ["exp", "Expiry date", 58], ["cvc", "Security code", 58]]
    : [["number,exp,cvc,postal", "Card details", 230]];
  return `${frames.map(([kinds, title, h]) => `<iframe data-card-frame src="${esc(src(kinds))}" title="${esc(`Secure ${title.toLowerCase()} input frame`)}" style="border:0;width:100%;height:${h}px"></iframe>`).join("\n  ")}
  <input type="hidden" name="card_session" value="">
  <script>
  (() => {
    const form = document.querySelector("form.checkout");
    const FRAME = ${JSON.stringify(frame.origin)};
    let busy = false;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const frames = [...document.querySelectorAll("iframe[data-card-frame]")];
      let left = frames.length;
      const onMessage = (m) => {
        if (m.origin !== FRAME || !m.data || m.data.type !== "collected" || m.data.session !== session) return;
        if (--left > 0) return;
        removeEventListener("message", onMessage);
        form.elements.card_session.value = session;
        form.submit();
      };
      addEventListener("message", onMessage);
      for (const f of frames) f.contentWindow.postMessage({ type: "collect", session }, FRAME);
    });
  })();
  </script>`;
}

// values: what a failed submit shows again. Never the card number or code.
// frame: { origin, parent, layout } for card fields in frames (startShop
// cardFrame).
export function checkoutHtml(cart = newCart(), { error = "", values = {}, frame = null } = {}) {
  const t = totals(cart);
  if (!t.lines.length) return layout("Checkout", `<h1>Checkout</h1><p>Your cart is empty.</p>`, { cart });
  const card = frame
    ? cardFramesHtml(frame)
    : `<label>Card number <input type="text" name="cc-number" autocomplete="cc-number" inputmode="numeric"></label>
  <label>Expiration (MM/YY) <input type="text" name="cc-exp" autocomplete="cc-exp" placeholder="MM/YY" value="${esc(values["cc-exp"])}"></label>
  <label>Security code <input type="text" name="cc-csc" autocomplete="cc-csc" inputmode="numeric"></label>`;
  return layout(
    "Checkout",
    `<h1>Checkout</h1>
${error ? `<div role="alert" id="checkout-error">${esc(error)}</div>` : ""}
<form class="checkout" action="/checkout" method="post" autocomplete="on">
  <label>Shipping address <textarea name="address" rows="2" autocomplete="street-address">${esc(values.address)}</textarea></label>
  <label>Name on card <input type="text" name="cc-name" autocomplete="cc-name" value="${esc(values["cc-name"])}"></label>
  ${card}
  <button type="submit" id="place-order">Place order &middot; ${money(t.total)}</button>
</form>
<h2>Order summary</h2>
${t.lines.map((l) => `<p>${l.qty} &times; ${esc(l.product.name)}, ${esc(l.product.size)}: ${money(l.lineTotal)}</p>`).join("\n")}
<div class="summary">
  <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
  ${t.addon ? `<div><span>Subscribe &amp; Save membership</span><span>${money(t.addon)}</span></div>` : ""}
  <div><span>Estimated tax</span><span>${money(t.tax)}</span></div>
  <div><span>Order total</span><span id="order-total">${money(t.total)}</span></div>
</div>`,
    { cart }
  );
}

export function orderHtml(o, cart = newCart()) {
  return layout(
    `Order ${o.id}`,
    `<p role="status">Thank you! Your order is confirmed.</p>
<h1>Order <span id="order-id">${esc(o.id)}</span></h1>
<ul id="order-items">${o.items.map((i) => `<li>${i.qty} &times; ${esc(i.name)} (${money(i.lineTotal)})</li>`).join("")}</ul>
<p>Total charged: <span id="order-total">${money(o.total)}</span></p>
<p>Paid with the card ending in <span id="card-last4">${esc(o.last4)}</span></p>`,
    { cart }
  );
}

// The pages with one mug in the cart and the add-on on, for tests that
// load HTML without a server.
export function pages() {
  const cart = newCart();
  const empty = newCart();
  cart.items.set("mug", 1);
  return {
    home: homeHtml(empty),
    search: searchHtml("mug", empty),
    product: productHtml("mug", empty),
    cart: cartHtml(cart),
    checkout: checkoutHtml(cart),
    total: money(totals(cart).total),
  };
}

function luhn(d) {
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (dbl && (n *= 2) > 9) n -= 9;
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(data))));
    req.on("error", reject);
  });
}

// Starts the shop on 127.0.0.1 (a free port unless one is given). One cart
// per server; POST /reset empties it. cardFrame: a startCardFrame() server
// whose frames take the card (cardLayout "one" or "split").
export async function startShop({ port = 0, cardFrame = null, cardLayout = "one" } = {}) {
  let cart = newCart();
  const orders = new Map();
  let base = "";
  const frame = () => (cardFrame ? { origin: cardFrame.origin, parent: base, layout: cardLayout } : null);
  const send = (res, status, html) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  };
  const redirect = (res, to) => {
    res.writeHead(303, { location: to });
    res.end();
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      let m;
      if (req.method === "GET" && path === "/") return send(res, 200, homeHtml(cart));
      if (req.method === "GET" && path === "/search") return send(res, 200, searchHtml(url.searchParams.get("q") || "", cart));
      if (req.method === "GET" && (m = /^\/product\/([\w-]+)$/.exec(path))) {
        const html = productHtml(m[1], cart);
        return html ? send(res, 200, html) : send(res, 404, "<h1>Not found</h1>");
      }
      if (req.method === "GET" && path === "/cart") return send(res, 200, cartHtml(cart));
      if (req.method === "GET" && path === "/checkout") return send(res, 200, checkoutHtml(cart, { frame: frame() }));
      if (req.method === "GET" && (m = /^\/order\/([\w-]+)$/.exec(path)) && orders.has(m[1])) return send(res, 200, orderHtml(orders.get(m[1]), cart));
      if (req.method !== "POST") return send(res, 404, "<h1>Not found</h1>");
      const body = await readBody(req);
      if (path === "/reset") {
        cart = newCart();
        return redirect(res, "/");
      }
      if (path === "/cart/add" && byId.has(body.product_id)) {
        if (!cart.items.size) cart.addon = true;
        const qty = Math.min(10, Math.max(1, parseInt(body.quantity, 10) || 1));
        cart.items.set(body.product_id, Math.min(10, (cart.items.get(body.product_id) || 0) + qty));
        return redirect(res, "/cart");
      }
      if (path === "/cart/remove") {
        cart.items.delete(body.product_id);
        return redirect(res, "/cart");
      }
      if (path === "/cart/update") {
        cart.addon = body.addon_subscription === "on";
        if (body.ajax) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ total: money(totals(cart).total) }));
        }
        return redirect(res, "/checkout");
      }
      if (path === "/checkout") {
        // Card fields in frames: the card comes from the frame server, by session.
        const framed = cardFrame ? cardFrame.redeem(body.card_session) || {} : null;
        const number = String((framed ? framed.number : body["cc-number"]) || "").replace(/[\s-]/g, "");
        const csc = String((framed ? framed.cvc : body["cc-csc"]) || "");
        const kept = { address: body.address, "cc-name": body["cc-name"], "cc-exp": framed ? "" : body["cc-exp"] };
        const t = totals(cart);
        const error = !t.lines.length ? "Your cart is empty."
          : !/^\d{13,19}$/.test(number) || !luhn(number) ? "That card number is not valid."
          : number !== "4111111111111111" ? "Test pages take the published test card only."
          : !/^\d{3,4}$/.test(csc) ? "Enter the security code."
          : "";
        if (error) return send(res, 400, checkoutHtml(cart, { error, values: kept, frame: frame() }));
        const id = `T-${randomBytes(4).toString("hex").toUpperCase()}`;
        orders.set(id, { id, items: t.lines.map((l) => ({ name: l.product.name, qty: l.qty, lineTotal: l.lineTotal })), total: t.total, last4: number.slice(-4) });
        cart = newCart();
        return redirect(res, `/order/${id}`);
      }
      send(res, 404, "<h1>Not found</h1>");
    } catch {
      if (!res.headersSent) send(res, 500, "<h1>Error</h1>");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = server.address().port;
  base = `http://localhost:${actual}`;
  return {
    port: actual,
    base,
    stop: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
