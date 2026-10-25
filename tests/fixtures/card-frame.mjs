// A stand-in for a payment provider's hosted card fields (Stripe Elements,
// Adyen secured fields, Braintree hosted fields), for the saved-card fill
// tests: the card fields live in frames on this server's own origin, so the
// shop page around them cannot read them, and the shop gets the card only
// by redeeming a one-time session id, the way it would redeem a token.
// Nothing here is real: no card is checked, kept past one redeem, or
// logged. Test numbers only.
//
//   import { startCardFrame } from "tests/fixtures/card-frame.mjs";
//   const frame = await startCardFrame();   // { origin, port, redeem, stop }
//   const shop = await startShop({ cardFrame: frame });   // tests/fixtures/shop.mjs
//
// The server listens on 127.0.0.1 while the shop is served as localhost, so
// the two are different sites and Chrome puts each frame in its own
// process.
//
//   GET  /fields?kinds=number,exp,cvc,postal&parent=<shop origin>
//        a page with those card fields. On a { type: "collect", session }
//        message from the parent origin it posts its values to /collect and
//        answers { type: "collected", session, ok }.
//   POST /collect   { session, values } -> 204
//   redeem(session)  the values collected for that session, once, or null

import http from "node:http";

const FIELDS = {
  number: '<label>Card number <input name="cardnumber" data-kind="number" autocomplete="cc-number" inputmode="numeric"></label>',
  exp: '<label>Expiry date <input name="exp-date" data-kind="exp" autocomplete="cc-exp" placeholder="MM / YY"></label>',
  cvc: '<label>Security code <input name="cvc" data-kind="cvc" autocomplete="cc-csc" inputmode="numeric"></label>',
  postal: '<label>ZIP <input name="postal" data-kind="postal" autocomplete="postal-code"></label>',
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fieldsHtml(kinds, parent) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Card details</title>
<style>body{margin:0;font:15px/1.4 system-ui,sans-serif}form{display:grid;gap:6px}label{display:grid;gap:2px}input{font:inherit;padding:4px 6px}</style>
</head>
<body>
<form autocomplete="on" onsubmit="return false">
${kinds.map((k) => FIELDS[k]).join("\n")}
</form>
<script>
(() => {
  const parent = ${JSON.stringify(parent)};
  addEventListener("message", async (e) => {
    if (e.origin !== parent || !e.data || e.data.type !== "collect" || typeof e.data.session !== "string") return;
    const values = {};
    for (const el of document.querySelectorAll("input[data-kind]")) values[el.dataset.kind] = el.value;
    let ok = false;
    try {
      const r = await fetch("/collect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: e.data.session, values }) });
      ok = r.ok;
    } catch {}
    e.source.postMessage({ type: "collected", session: e.data.session, ok }, parent);
  });
})();
</script>
</body>
</html>`;
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e4) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

export async function startCardFrame({ port = 0 } = {}) {
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/fields") {
      const kinds = String(url.searchParams.get("kinds") || "").split(",").filter((k) => FIELDS[k]);
      let parent = "";
      try {
        parent = new URL(String(url.searchParams.get("parent"))).origin;
      } catch {}
      if (!kinds.length || !parent || parent === "null") return res.writeHead(400).end();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(fieldsHtml(kinds, parent));
    }
    if (req.method === "POST" && url.pathname === "/collect") {
      const body = await readJson(req);
      if (!body || typeof body.session !== "string" || !body.values || typeof body.values !== "object") return res.writeHead(400).end();
      const got = sessions.get(body.session) || {};
      for (const k of Object.keys(FIELDS)) if (typeof body.values[k] === "string") got[k] = body.values[k];
      sessions.set(body.session, got);
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = server.address().port;
  return {
    port: actual,
    origin: `http://127.0.0.1:${actual}`,
    // The card collected for a session, once.
    redeem(session) {
      const v = sessions.get(String(session || ""));
      sessions.delete(String(session || ""));
      return v || null;
    },
    stop: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
