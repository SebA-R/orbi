import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";

import { BridgeClient } from "../../../extension/lib/bridge.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function server() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  cleanups.push(() => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }));
  return { wss, url: `ws://127.0.0.1:${wss.address().port}/ext` };
}

function client(url, opts = {}) {
  const states = [];
  const c = new BridgeClient({ url, version: "9.9.9", log: quiet, onState: (s) => states.push(s), ...opts });
  cleanups.push(() => c.stop());
  return { c, states };
}

function waitFor(pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("timed out waiting"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("sends hello on open and becomes open on welcome", async () => {
  const { wss, url } = await server();
  const { c, states } = client(url);
  c.start();
  const [sock] = await once(wss, "connection");
  const [raw] = await once(sock, "message");
  assert.deepEqual(JSON.parse(String(raw)), { type: "hello", protocol: 1, ext: "clearcart", version: "9.9.9" });
  assert.equal(c.state, "connecting");
  sock.send(JSON.stringify({ type: "welcome", protocol: 1, server: "test" }));
  await waitFor(() => c.state === "open");
  assert.deepEqual(states, ["connecting", "open"]);
});

test("reports closed when the server goes away", async () => {
  const { wss, url } = await server();
  const { c } = client(url);
  c.start();
  const [sock] = await once(wss, "connection");
  sock.send(JSON.stringify({ type: "welcome", protocol: 1 }));
  await waitFor(() => c.state === "open");
  sock.close();
  await waitFor(() => c.state === "closed");
});
