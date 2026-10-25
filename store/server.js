// Clearcart demo store: server-rendered HTML, one in-memory cart, mocked Visa authorization.
// Card numbers are never logged, stored, or echoed; only the last 4 digits survive POST /checkout.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.STORE_PORT || 4000);
const STORE_NAME = 'Elm Street Pharmacy';
const ADDON_PRICE = 4.99;
const ADDON_LABEL = 'Subscribe & Save: auto-deliver every 30 days (+$4.99 membership)';
const SHIPPING = 0;
const TAX_RATE = 0.0725;

const products = JSON.parse(readFileSync(new URL('./products.json', import.meta.url), 'utf8'));
const byId = new Map(products.map((p) => [p.id, p]));

// Single demo user.
const cart = { items: new Map(), addon: true };
const orders = new Map();

// ---------- helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `$${n.toFixed(2)}`;
const round2 = (n) => Math.round(n * 100) / 100;

function cartLines() {
  return [...cart.items.entries()].map(([id, qty]) => {
    const p = byId.get(id);
    return { product: p, qty, lineTotal: round2(p.price * qty) };
  });
}

function cartTotals() {
  const lines = cartLines();
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const addon = lines.length && cart.addon ? ADDON_PRICE : 0;
  const tax = round2(subtotal * TAX_RATE);
  const total = round2(subtotal + addon + tax + SHIPPING);
  return { lines, subtotal, addon, tax, total, count: lines.reduce((s, l) => s + l.qty, 0) };
}

function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function expValid(exp) {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/.exec(exp || '');
  if (!m) return false;
  const month = Number(m[1]);
  let year = Number(m[2]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12) return false;
  const now = new Date();
  return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);
}

// Mocked Visa authorization. Takes the card, returns only non-sensitive results.
function mockVisaAuthorize({ amount }) {
  return {
    approved: true,
    approvalCode: randomBytes(3).toString('hex').toUpperCase(),
    network: 'Visa',
    amount,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/json')) resolve(data ? JSON.parse(data) : {});
        else resolve(Object.fromEntries(new URLSearchParams(data)));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(html);
}
const redirect = (res, location) => {
  res.writeHead(303, { Location: location });
  res.end();
};

function stars(rating) {
  const full = Math.round(rating);
  return `<span class="stars" aria-hidden="true">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span>`;
}

// ---------- layout ----------

const CSS = `
:root { --green:#1f6f50; --green-dark:#17533c; --ink:#1d2421; --muted:#5d6b65; --line:#dfe5e2; --bg:#f6f8f7; --accent:#d9480f; }
* { box-sizing:border-box; }
body { margin:0; font:16px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color:var(--ink); background:var(--bg); }
a { color:var(--green); }
header.top { background:var(--green); color:#fff; }
header.top .wrap { display:flex; align-items:center; gap:24px; padding:14px 16px; }
header.top .logo { color:#fff; text-decoration:none; font-weight:700; font-size:20px; letter-spacing:.2px; white-space:nowrap; }
header.top .logo small { display:block; font-weight:400; font-size:12px; opacity:.85; }
header.top form { flex:1; display:flex; max-width:560px; }
header.top input[type=search] { flex:1; padding:9px 12px; border:0; border-radius:6px 0 0 6px; font-size:15px; }
header.top button { padding:9px 16px; border:0; border-radius:0 6px 6px 0; background:#ffd43b; font-weight:600; cursor:pointer; }
header.top .cart-link { color:#fff; text-decoration:none; font-weight:600; white-space:nowrap; }
.promo { background:#e6f2ec; color:var(--green-dark); text-align:center; font-size:14px; padding:6px 16px; }
.wrap { max-width:1040px; margin:0 auto; padding:0 16px; }
main.wrap { padding-top:24px; padding-bottom:48px; }
h1 { font-size:26px; margin:0 0 16px; }
.card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:20px; }
.results { list-style:none; padding:0; margin:0; display:grid; gap:12px; }
.results li { background:#fff; border:1px solid var(--line); border-radius:10px; padding:16px; display:flex; gap:16px; align-items:center; }
.thumb { width:72px; height:72px; border-radius:8px; background:linear-gradient(135deg,#e6f2ec,#cfe6da); display:flex; align-items:center; justify-content:center; font-size:28px; flex:none; }
.results .info { flex:1; }
.results a.name { font-weight:600; font-size:17px; text-decoration:none; }
.results a.name:hover { text-decoration:underline; }
.meta { color:var(--muted); font-size:14px; }
.price { font-weight:700; font-size:18px; }
.stars { color:#f59f00; letter-spacing:1px; }
.btn { display:inline-block; background:var(--green); color:#fff; border:0; border-radius:6px; padding:10px 18px; font-size:16px; font-weight:600; cursor:pointer; text-decoration:none; }
.btn:hover { background:var(--green-dark); }
.btn.big { padding:13px 26px; font-size:17px; }
.product { display:grid; grid-template-columns:260px 1fr; gap:28px; }
.product .thumb { width:260px; height:260px; font-size:96px; }
table.cart { width:100%; border-collapse:collapse; }
table.cart th, table.cart td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); }
table.cart td.num, table.cart th.num { text-align:right; }
.summary { margin-top:18px; margin-left:auto; max-width:360px; }
.summary div { display:flex; justify-content:space-between; padding:4px 0; }
.summary .grand { font-weight:700; font-size:20px; border-top:1px solid var(--line); margin-top:6px; padding-top:10px; }
.addon { margin-top:18px; padding:14px; background:#fff9db; border:1px solid #ffe066; border-radius:8px; font-size:15px; }
.addon small { display:block; color:var(--muted); margin-left:26px; }
form.checkout { display:grid; gap:14px; max-width:460px; }
form.checkout label { display:grid; gap:4px; font-weight:600; font-size:14px; }
form.checkout input, form.checkout textarea { font:inherit; padding:9px 11px; border:1px solid #b8c4bf; border-radius:6px; font-weight:400; }
.row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.checkout-grid { display:grid; grid-template-columns:1fr 320px; gap:28px; align-items:start; }
.error { background:#fff0f0; border:1px solid #ffa8a8; color:#a61e1e; padding:10px 14px; border-radius:8px; margin-bottom:14px; }
.ok { background:#ebfbee; border:1px solid #8ce99a; color:#2b8a3e; padding:12px 16px; border-radius:8px; margin-bottom:16px; font-weight:600; }
footer { color:var(--muted); font-size:13px; text-align:center; padding:24px 16px 40px; }
@media (max-width:720px) {
  header.top .wrap { flex-wrap:wrap; gap:10px; }
  header.top form { order:3; flex-basis:100%; max-width:none; }
  .product, .checkout-grid { grid-template-columns:1fr; }
  .product .thumb { width:100%; height:180px; }
}
`;

const ICONS = { Allergy: '🌼', 'Pain relief': '💊', Household: '🏠', 'Personal care': '🪥' };

function page(title, body, { q = '' } = {}) {
  const { count } = cartTotals();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${STORE_NAME}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="logo" href="/">${STORE_NAME}<small>Pharmacy &amp; everyday essentials</small></a>
  <form action="/search" method="get" role="search">
    <input type="search" name="q" value="${esc(q)}" placeholder="Search medicines, health &amp; household" aria-label="Search products">
    <button type="submit">Search</button>
  </form>
  <a class="cart-link" href="/cart">Cart (${count})</a>
</div></header>
<div class="promo">Free shipping on every order. Pharmacist questions? Call 1-800-555-0142.</div>
<main class="wrap">
${body}
</main>
<footer>&copy; 2026 ${STORE_NAME}. Demo store for Clearcart. No real orders are placed and no real payments are taken.</footer>
</body>
</html>`;
}

// ---------- pages ----------

function homePage() {
  const featured = ['cetirizine-30', 'zyrtec-30', 'ibuprofen-100', 'tissues-3pk'].map((id) => byId.get(id));
  return page(
    'Home',
    `<h1>What can we help you find?</h1>
<form action="/search" method="get" class="card" style="display:flex;gap:10px;margin-bottom:24px">
  <input type="search" name="q" placeholder="Try &quot;allergy&quot; or &quot;cetirizine&quot;" aria-label="Search products" style="flex:1;padding:11px 12px;font-size:16px;border:1px solid #b8c4bf;border-radius:6px">
  <button class="btn" type="submit">Search</button>
</form>
<h2 style="font-size:19px">Popular right now</h2>
${resultsList(featured)}`
  );
}

function resultsList(list) {
  return `<ul class="results">
${list
  .map(
    (p) => `  <li>
    <div class="thumb" aria-hidden="true">${ICONS[p.category] || '🛒'}</div>
    <div class="info">
      <a class="name" href="/product/${esc(p.id)}">${esc(p.name)}</a>
      <div class="meta">${esc(p.brand)} &middot; <span class="size">${esc(p.size)}</span></div>
      <div class="meta">${stars(p.rating)} <span class="rating">${p.rating.toFixed(1)} out of 5</span> (${p.reviews.toLocaleString('en-US')} reviews)</div>
    </div>
    <div class="price">${money(p.price)}</div>
  </li>`
  )
  .join('\n')}
</ul>`;
}

function search(q) {
  const tokens = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.length) return [];
  return products
    .map((p) => {
      const hay = `${p.name} ${p.brand} ${p.category} ${p.size} ${p.description}`.toLowerCase();
      return { p, score: tokens.filter((t) => hay.includes(t)).length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.p);
}

function searchPage(q) {
  const results = search(q);
  const body = results.length
    ? `<h1>${results.length} result${results.length === 1 ? '' : 's'} for &ldquo;${esc(q)}&rdquo;</h1>\n${resultsList(results)}`
    : `<h1>No results for &ldquo;${esc(q)}&rdquo;</h1><p>Try a different word, like &ldquo;allergy&rdquo;, &ldquo;cetirizine&rdquo; or &ldquo;batteries&rdquo;.</p>`;
  return page(`Search: ${q}`, body, { q });
}

function productPage(p) {
  return page(
    p.name,
    `<p class="meta"><a href="/">Home</a> &rsaquo; ${esc(p.category)}</p>
<div class="card product">
  <div class="thumb" aria-hidden="true">${ICONS[p.category] || '🛒'}</div>
  <div>
    <h1 id="product-name">${esc(p.name)}</h1>
    <div class="meta">${esc(p.brand)}</div>
    <p><span class="price" id="product-price">${money(p.price)}</span> &middot; <span id="product-size">${esc(p.size)}</span> &middot; ${money(round2(p.price / (parseInt(p.size, 10) || 1)))} each</p>
    <p>${stars(p.rating)} ${p.rating.toFixed(1)} out of 5 (${p.reviews.toLocaleString('en-US')} reviews)</p>
    <p>${esc(p.description)}</p>
    <p class="meta">In stock. Ships free in 2 to 3 business days.</p>
    <form action="/cart/add" method="post">
      <input type="hidden" name="product_id" value="${esc(p.id)}">
      <label>Quantity <input type="number" name="quantity" value="1" min="1" max="10" style="width:64px;padding:6px"></label>
      <button class="btn big" type="submit" id="add-to-cart">Add to cart</button>
    </form>
  </div>
</div>`
  );
}

function cartPage() {
  const t = cartTotals();
  if (!t.lines.length) {
    return page('Cart', `<h1>Your cart is empty</h1><p><a href="/">Continue shopping</a></p>`);
  }
  return page(
    'Cart',
    `<h1>Your cart</h1>
<div class="card">
<table class="cart">
  <thead><tr><th>Item</th><th>Size</th><th class="num">Price</th><th class="num">Qty</th><th class="num">Total</th><th></th></tr></thead>
  <tbody>
${t.lines
  .map(
    (l) => `    <tr>
      <td><a href="/product/${esc(l.product.id)}">${esc(l.product.name)}</a></td>
      <td>${esc(l.product.size)}</td>
      <td class="num">${money(l.product.price)}</td>
      <td class="num">${l.qty}</td>
      <td class="num">${money(l.lineTotal)}</td>
      <td class="num"><form action="/cart/remove" method="post" style="margin:0"><input type="hidden" name="product_id" value="${esc(l.product.id)}"><button type="submit" style="background:none;border:0;color:var(--green);cursor:pointer;text-decoration:underline">Remove</button></form></td>
    </tr>`
  )
  .join('\n')}
  </tbody>
</table>
<form action="/cart/update" method="post" id="cart-form">
  <div class="addon">
    <label><input type="checkbox" name="addon_subscription" id="addon_subscription" value="on"${cart.addon ? ' checked' : ''}> ${esc(ADDON_LABEL)}</label>
    <small>Members never run out. Cancel anytime.</small>
  </div>
  <div class="summary">
    <div><span>Subtotal</span><span id="subtotal">${money(t.subtotal)}</span></div>
    <div id="addon-line"${cart.addon ? '' : ' hidden'}><span>Subscribe &amp; Save membership</span><span>${money(ADDON_PRICE)}</span></div>
    <div><span>Shipping</span><span>FREE</span></div>
    <div><span>Estimated tax</span><span id="tax">${money(t.tax)}</span></div>
    <div class="grand"><span>Order total</span><span id="order-total">${money(t.total)}</span></div>
    <p style="text-align:right"><button class="btn big" type="submit" id="checkout-button">Proceed to checkout</button></p>
  </div>
</form>
</div>
<script>
// Persist the add-on choice as soon as it changes so the total is right even if the shopper navigates straight to /checkout.
const box = document.getElementById('addon_subscription');
box.addEventListener('change', async () => {
  const body = new URLSearchParams(box.checked ? { addon_subscription: 'on' } : {});
  body.set('ajax', '1');
  const r = await fetch('/cart/update', { method: 'POST', body });
  const t = await r.json();
  document.getElementById('order-total').textContent = t.total;
  document.getElementById('addon-line').hidden = !box.checked;
});
</script>`
  );
}

function orderSummaryHtml(t) {
  return `<div class="card">
  <h2 style="font-size:18px;margin-top:0">Order summary</h2>
  ${t.lines.map((l) => `<div class="meta">${l.qty} &times; ${esc(l.product.name)}, ${esc(l.product.size)}: ${money(l.lineTotal)}</div>`).join('\n  ')}
  <div class="summary" style="max-width:none">
    <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
    ${t.addon ? `<div><span>Subscribe &amp; Save membership</span><span>${money(t.addon)}</span></div>` : ''}
    <div><span>Shipping</span><span>FREE</span></div>
    <div><span>Estimated tax</span><span>${money(t.tax)}</span></div>
    <div class="grand"><span>Order total</span><span id="order-total">${money(t.total)}</span></div>
  </div>
  <p class="meta"><a href="/cart">Edit cart</a></p>
</div>`;
}

// `values` never includes the card number or CSC, so a failed submit cannot echo them.
function checkoutPage({ error = '', values = {} } = {}) {
  const t = cartTotals();
  if (!t.lines.length) {
    return page('Checkout', `<h1>Checkout</h1><p>Your cart is empty. <a href="/">Continue shopping</a></p>`);
  }
  return page(
    'Checkout',
    `<h1>Checkout</h1>
<div class="checkout-grid">
<div class="card">
${error ? `<div class="error" role="alert" id="checkout-error">${esc(error)}</div>` : ''}
<form class="checkout" action="/checkout" method="post" autocomplete="on">
  <label>Shipping address
    <textarea name="address" rows="3" autocomplete="street-address" required>${esc(values.address)}</textarea>
  </label>
  <h2 style="font-size:17px;margin:6px 0 0">Payment (Visa)</h2>
  <label>Name on card
    <input type="text" name="cc-name" autocomplete="cc-name" value="${esc(values['cc-name'])}" required>
  </label>
  <label>Card number
    <input type="text" name="cc-number" autocomplete="cc-number" inputmode="numeric" required>
  </label>
  <div class="row2">
    <label>Expiration (MM/YY)
      <input type="text" name="cc-exp" autocomplete="cc-exp" placeholder="MM/YY" value="${esc(values['cc-exp'])}" required>
    </label>
    <label>Security code
      <input type="text" name="cc-csc" autocomplete="cc-csc" inputmode="numeric" required>
    </label>
  </div>
  <button class="btn big" type="submit" id="place-order" data-clearcart-protected>Place order &middot; ${money(t.total)}</button>
</form>
</div>
${orderSummaryHtml(t)}
</div>`
  );
}

function orderPage(o) {
  return page(
    `Order ${o.id}`,
    `<div class="ok" role="status">Thank you! Your order is confirmed.</div>
<h1>Order <span id="order-id">${esc(o.id)}</span></h1>
<div class="card">
  <p><strong>Item${o.items.length === 1 ? '' : 's'}:</strong></p>
  <ul id="order-items">${o.items.map((i) => `<li>${i.qty} &times; ${esc(i.name)}, ${esc(i.size)} (${money(i.lineTotal)})</li>`).join('')}</ul>
  ${o.addon ? `<p>Subscribe &amp; Save membership: ${money(o.addon)}</p>` : ''}
  <p><strong>Total charged:</strong> <span id="order-total">${money(o.total)}</span></p>
  <p><strong>Paid with:</strong> Visa ending in <span id="card-last4">${esc(o.last4)}</span></p>
  <p><strong>Visa approval code:</strong> <span id="approval-code">${esc(o.approvalCode)}</span></p>
  <p><strong>Ships to:</strong> ${esc(o.address)}</p>
  <p class="meta">Placed ${esc(o.placedAt)}</p>
  <p><a class="btn" href="/">Continue shopping</a></p>
</div>`
  );
}

// ---------- handlers ----------

async function placeOrder(req, res) {
  const body = await readBody(req);
  const number = String(body['cc-number'] || '').replace(/[\s-]/g, '');
  const csc = String(body['cc-csc'] || '').trim();
  const safe = { 'cc-name': body['cc-name'], 'cc-exp': body['cc-exp'], address: body.address };
  const t = cartTotals();

  let error = '';
  if (!t.lines.length) error = 'Your cart is empty.';
  else if (!String(body.address || '').trim()) error = 'Please enter a shipping address.';
  else if (!String(body['cc-name'] || '').trim()) error = 'Please enter the name on the card.';
  else if (!/^\d{13,19}$/.test(number)) error = 'Please enter a valid card number.';
  else if (number[0] !== '4') error = 'This store accepts Visa only.';
  else if (!luhnValid(number)) error = 'That card number is not valid. Please check it and try again.';
  else if (!expValid(body['cc-exp'])) error = 'Please enter a valid expiration date (MM/YY).';
  else if (!/^\d{3,4}$/.test(csc)) error = 'Please enter the 3-digit security code.';

  if (error) return send(res, 400, checkoutPage({ error, values: safe }));

  const auth = mockVisaAuthorize({ amount: t.total });
  if (!auth.approved) return send(res, 402, checkoutPage({ error: 'Your card was declined.', values: safe }));

  const id = `EL-${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;
  orders.set(id, {
    id,
    items: t.lines.map((l) => ({ name: l.product.name, size: l.product.size, qty: l.qty, lineTotal: l.lineTotal })),
    addon: t.addon,
    total: t.total,
    last4: number.slice(-4),
    approvalCode: auth.approvalCode,
    address: String(body.address).trim(),
    placedAt: new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT',
  });
  cart.items.clear();
  cart.addon = true;
  console.log(`order ${id} approved, total ${money(t.total)}`);
  redirect(res, `/order/${id}`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;
    let m;

    if (method === 'GET' && path === '/') return send(res, 200, homePage());
    if (method === 'GET' && path === '/search') return send(res, 200, searchPage(url.searchParams.get('q') || ''));
    if (method === 'GET' && (m = /^\/product\/([\w-]+)$/.exec(path))) {
      const p = byId.get(m[1]);
      return p ? send(res, 200, productPage(p)) : send(res, 404, page('Not found', '<h1>Product not found</h1>'));
    }
    if (method === 'POST' && path === '/cart/add') {
      const body = await readBody(req);
      const p = byId.get(body.product_id);
      if (!p) return send(res, 400, page('Error', '<h1>Unknown product</h1>'));
      const qty = Math.min(10, Math.max(1, parseInt(body.quantity, 10) || 1));
      if (!cart.items.size) cart.addon = true; // a fresh cart starts with the add-on pre-checked
      cart.items.set(p.id, Math.min(10, (cart.items.get(p.id) || 0) + qty));
      return redirect(res, '/cart');
    }
    if (method === 'POST' && path === '/cart/remove') {
      const body = await readBody(req);
      cart.items.delete(body.product_id);
      return redirect(res, '/cart');
    }
    if (method === 'POST' && path === '/cart/update') {
      const body = await readBody(req);
      cart.addon = body.addon_subscription === 'on' || body.addon_subscription === true;
      if (body.ajax) {
        const t = cartTotals();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ addon: cart.addon, total: money(t.total) }));
      }
      return redirect(res, '/checkout');
    }
    if (method === 'GET' && path === '/cart') return send(res, 200, cartPage());
    if (method === 'GET' && path === '/checkout') return send(res, 200, checkoutPage());
    if (method === 'POST' && path === '/checkout') return await placeOrder(req, res);
    if (method === 'GET' && (m = /^\/order\/([\w-]+)$/.exec(path))) {
      const o = orders.get(m[1]);
      return o ? send(res, 200, orderPage(o)) : send(res, 404, page('Not found', '<h1>Order not found</h1>'));
    }
    if (method === 'POST' && path === '/reset') {
      cart.items.clear();
      cart.addon = true;
      return redirect(res, '/');
    }
    send(res, 404, page('Not found', '<h1>Page not found</h1><p><a href="/">Go home</a></p>'));
  } catch (e) {
    // Log only the error message; never the request body.
    console.error('store error:', e.message);
    if (!res.headersSent) send(res, 500, page('Error', '<h1>Something went wrong</h1>'));
  }
});

server.listen(PORT, () => console.log(`${STORE_NAME} demo store on http://localhost:${PORT}`));
