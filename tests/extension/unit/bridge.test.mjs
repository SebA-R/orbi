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

async function openClient(opts = {}) {
  const { wss, url } = await server();
  const { c, states } = client(url, opts);
  c.start();
  const [sock] = await once(wss, "connection");
  await once(sock, "message"); // hello
  sock.send(JSON.stringify({ type: "welcome", protocol: 1 }));
  await waitFor(() => c.state === "open");
  return { wss, url, c, states, sock };
}

test("pings on the heartbeat interval and answers server pings", async () => {
  const { sock } = await openClient({ timing: { HEARTBEAT_MS: 30, DEAD_AFTER_MS: 5000 } });
  const got = [];
  sock.on("message", (raw) => got.push(JSON.parse(String(raw))));
  sock.send(JSON.stringify({ type: "ping", t: 42 }));
  await waitFor(() => got.some((m) => m.type === "pong" && m.t === 42) && got.filter((m) => m.type === "ping").length >= 2);
});

test("drops a silent link after DEAD_AFTER_MS", async () => {
  // The fake server never answers pings.
  const { c } = await openClient({ timing: { HEARTBEAT_MS: 20, DEAD_AFTER_MS: 80 } });
  await waitFor(() => c.state === "closed", 2000);
});

const FAST = { BACKOFF_MIN_MS: 20, BACKOFF_MAX_MS: 100 };

test("reconnects with backoff after the server drops it", async () => {
  const { wss, sock, c } = await openClient({ timing: FAST });
  const second = once(wss, "connection");
  sock.terminate();
  const [sock2] = await second;
  await once(sock2, "message");
  sock2.send(JSON.stringify({ type: "welcome", protocol: 1 }));
  await waitFor(() => c.state === "open");
});

test("keeps retrying until the server comes up, and stop() ends retries", async () => {
  const probe = new WebSocketServer({ port: 0 });
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const { c } = client(`ws://127.0.0.1:${port}/ext`, { timing: FAST });
  c.start();
  await new Promise((r) => setTimeout(r, 150)); // a few failed attempts
  assert.equal(c.state, "closed");

  const wss = new WebSocketServer({ port });
  cleanups.push(() => new Promise((r) => { for (const s of wss.clients) s.terminate(); wss.close(r); }));
  const [sock] = await once(wss, "connection");
  await once(sock, "message");
  sock.send(JSON.stringify({ type: "welcome", protocol: 1 }));
  await waitFor(() => c.state === "open");

  c.stop();
  await waitFor(() => c.state === "closed");
  let reconnected = false;
  wss.on("connection", () => { reconnected = true; });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(reconnected, false);
});

test("setUrl moves the client to a new server", async () => {
  const { c } = await openClient({ timing: FAST });
  const { wss: other, url } = await server();
  c.setUrl(url);
  const [sock] = await once(other, "connection");
  await once(sock, "message");
  sock.send(JSON.stringify({ type: "welcome", protocol: 1 }));
  await waitFor(() => c.state === "open");
});
