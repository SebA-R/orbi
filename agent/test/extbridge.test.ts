import assert from "node:assert/strict";
import { test } from "node:test";

import * as proto from "../../extension/lib/protocol.js";
import { CLIENT_ID_RE, CLOSE, ERR, EXT_NAME, ExtError, INTERNAL, PROTOCOL_VERSION, STALE_AFTER_MS, TOOLS, parseClientId } from "../extbridge.ts";
// @ts-ignore: plain JS module from the extension
import { BridgeClient } from "../../extension/lib/bridge.js";
import { WebSocket } from "ws";
import { ExtError2, FakeExt, NO_REPLY, onceEvent, startBridge } from "./fake-ext.ts";

test("constants mirror extension/lib/protocol.js", () => {
  assert.deepEqual([...TOOLS], [...proto.TOOLS]);
  assert.deepEqual([...INTERNAL], [...proto.INTERNAL]);
  assert.deepEqual({ ...ERR }, { ...proto.ERR });
  assert.equal(PROTOCOL_VERSION, proto.PROTOCOL_VERSION);
  assert.equal(EXT_NAME, proto.EXT_NAME);
  assert.deepEqual({ ...CLOSE }, { ...proto.CLOSE });
  assert.equal(CLIENT_ID_RE.source, proto.CLIENT_ID_RE.source);
  assert.equal(STALE_AFTER_MS, proto.TIMING.DEAD_AFTER_MS);
  for (const v of [crypto.randomUUID(), "install-aaaa", "short", "a".repeat(65), "bad id!", 7, undefined]) {
    assert.equal(parseClientId(v), proto.CLIENT_ID_RE.test(String(v)) && typeof v === "string" ? v : null, String(v));
  }
});

test("handshake: hello gets welcome, connect event fires", async () => {
  const b = await startBridge();
  try {
    assert.equal(b.bridge.connected(), false);
    const connected = onceEvent(b.bridge, "connect");
    const ext = new FakeExt(b.url, () => null, "1.2.3");
    await ext.open();
    assert.deepEqual(ext.welcome, { type: "welcome", protocol: 1, server: "clearcart-agent" });
    assert.equal((await connected).version, "1.2.3");
    assert.equal(b.bridge.connected(), true);
    assert.equal(b.bridge.extInfo()?.version, "1.2.3");
    assert.deepEqual(await ext.ping(7), { type: "pong", t: 7 });

    const gone = onceEvent(b.bridge, "disconnect");
    ext.close();
    await gone;
    assert.equal(b.bridge.connected(), false);
  } finally {
    await b.stop();
  }
});

test("a client with the wrong protocol is refused", async () => {
  const b = await startBridge();
  try {
    const ext = new FakeExt(b.url);
    await ext.open(false);
    ext.ws.send(JSON.stringify({ type: "hello", protocol: 99, ext: "clearcart", version: "x" }));
    const c = await ext.waitClosed();
    assert.equal(c.code, 4003);
    assert.equal(b.bridge.connected(), false);
  } finally {
    await b.stop();
  }
});

test("other paths are refused", async () => {
  const b = await startBridge();
  try {
    const bad = new FakeExt(b.url.replace("/ext", "/nope"));
    await assert.rejects(bad.open());
  } finally {
    await b.stop();
  }
});

test("call: request/response and error responses", async () => {
  const b = await startBridge();
  try {
    const ext = new FakeExt(b.url, (method, params) => {
      if (method === "tab_info") return { tabId: params.tabId, url: "https://shop.example/", title: "Shop" };
      throw new ExtError2("no_element", "nothing at ref_9");
    });
    await ext.open();
    assert.deepEqual(await b.bridge.call("tab_info", { tabId: 3 }), { tabId: 3, url: "https://shop.example/", title: "Shop" });
    await assert.rejects(b.bridge.call("rect", { ref: "ref_9" }), (e: any) => e instanceof ExtError && e.code === "no_element" && /ref_9/.test(e.message));
    // Concurrent calls get their own ids and answers.
    const [x, y] = await Promise.all([b.bridge.call("tab_info", { tabId: 1 }), b.bridge.call("tab_info", { tabId: 2 })]);
    assert.equal(x.tabId, 1);
    assert.equal(y.tabId, 2);
    assert.notEqual(ext.requests.length, 0);
    ext.close();
  } finally {
    await b.stop();
  }
});

test("call: not connected and timeout", async () => {
  const b = await startBridge();
  try {
    await assert.rejects(b.bridge.call("tabs_context"), (e: any) => e.code === ERR.NOT_CONNECTED);
    const ext = new FakeExt(b.url, () => NO_REPLY);
    await ext.open();
    const t0 = Date.now();
    await assert.rejects(b.bridge.call("tabs_context", {}, 150), (e: any) => e.code === ERR.TIMEOUT);
    assert.ok(Date.now() - t0 >= 140);
    ext.close();
  } finally {
    await b.stop();
  }
});

test("disconnect mid-request rejects pending calls", async () => {
  const b = await startBridge();
  try {
    const ext = new FakeExt(b.url, () => NO_REPLY);
    await ext.open();
    const p = b.bridge.call("screenshot", {}, 5_000);
    await new Promise((r) => setTimeout(r, 30));
    ext.close();
    await assert.rejects(p, (e: any) => e.code === ERR.NOT_CONNECTED);
  } finally {
    await b.stop();
  }
});

test("same install: a newer hello replaces the older socket at once; reconnect works", async () => {
  const b = await startBridge();
  try {
    const first = new FakeExt(b.url, () => NO_REPLY, "0.0.1", "install-aaaa");
    await first.open();
    // Pending call on the first socket gets rejected when it is replaced.
    const pending = b.bridge.call("tabs_context", {}, 5_000).then(
      () => assert.fail("should have been rejected"),
      (e) => e
    );
    await new Promise((r) => setTimeout(r, 20));

    const second = new FakeExt(b.url, () => ({ who: "second" }), "0.0.1", "install-aaaa");
    await second.open();
    assert.equal((await pending).code, ERR.NOT_CONNECTED);
    assert.equal((await first.waitClosed()).code, 4002);
    assert.deepEqual(await b.bridge.call("tabs_context"), { who: "second" });
    assert.equal(b.bridge.connected(), true);

    // The replaced socket closing must not mark the bridge disconnected.
    second.close();
    await onceEvent(b.bridge, "disconnect");
    assert.equal(b.bridge.connected(), false);

    // Reconnect after a drop, from any install.
    const again = new FakeExt(b.url, () => ({ who: "again" }), "0.0.1", "install-bbbb");
    await again.open();
    assert.deepEqual(await b.bridge.call("tabs_context"), { who: "again" });
    again.close();
  } finally {
    await b.stop();
  }
});

test("another install is refused while the first is connected: its settings never apply, no flapping", async () => {
  const lines: string[] = [];
  const b = await startBridge();
  (b.bridge as any).log = (l: string) => lines.push(l);
  try {
    const mine = new FakeExt(b.url, () => ({ who: "mine" }), "0.0.1", "install-mine");
    await mine.open();
    mine.ws.send(JSON.stringify({ type: proto.MSG.SETTINGS, guidedMode: false, provider: "local", localModel: "qwen3:8b" }));
    mine.ws.send(JSON.stringify({ type: proto.MSG.DANGER_MODE, on: true }));
    await mine.ping();
    let connects = 0;
    let providers = 0;
    b.bridge.on("connect", () => connects++);
    b.bridge.on("provider", () => providers++);

    // A test Chromium (or a second profile) keeps trying, with and without an id.
    for (const id of ["install-test", "install-test", undefined]) {
      const other = new FakeExt(b.url, () => ({ who: "other" }), "0.0.1", id);
      await other.open(false);
      other.ws.send(JSON.stringify({ type: "hello", protocol: 1, ext: "clearcart", version: "0.0.1", ...(id ? { client: id } : {}) }));
      other.ws.send(JSON.stringify({ type: proto.MSG.SETTINGS, guidedMode: true, provider: "claude" }));
      other.ws.send(JSON.stringify({ type: proto.MSG.DANGER_MODE, on: false }));
      assert.equal((await other.waitClosed()).code, 4004);
      assert.equal(other.welcome, null);
    }
    assert.equal(connects, 0);
    assert.equal(providers, 0);
    assert.equal(b.bridge.providerSettings().provider, "local");
    assert.equal(b.bridge.dangerMode(), true);
    assert.equal(b.bridge.guidedMode(), false);
    assert.equal(mine.closed, null, "the owner keeps its socket");
    assert.deepEqual(await b.bridge.call("tabs_context"), { who: "mine" });
    assert.equal(lines.filter((l) => l.includes("refused a second extension")).length, 2, "logged once per client, not per retry");

    // Once the owner goes, the other install gets it.
    mine.close();
    await onceEvent(b.bridge, "disconnect");
    const other = new FakeExt(b.url, () => ({ who: "other" }), "0.0.1", "install-test");
    await other.open();
    assert.deepEqual(await b.bridge.call("tabs_context"), { who: "other" });
    other.close();
  } finally {
    await b.stop();
  }
});

test("an owner silent past STALE_AFTER_MS can be replaced by another install", async () => {
  const b = await startBridge();
  try {
    const mine = new FakeExt(b.url, () => null, "0.0.1", "install-mine");
    await mine.open();
    (b.bridge as any).lastSeen = Date.now() - STALE_AFTER_MS - 1;
    const other = new FakeExt(b.url, () => ({ who: "other" }), "0.0.1", "install-test");
    await other.open();
    assert.equal((await mine.waitClosed()).code, 4002);
    assert.deepEqual(await b.bridge.call("tabs_context"), { who: "other" });
    other.close();
  } finally {
    await b.stop();
  }
});

test("two BridgeClients from different installs don't ping-pong: the first keeps the bridge", async () => {
  const b = await startBridge();
  let connects = 0;
  b.bridge.on("connect", () => connects++);
  const quiet = { info() {}, warn() {}, debug() {} };
  const timing = { BACKOFF_MIN_MS: 10, BACKOFF_MAX_MS: 40 };
  const a = new BridgeClient({ url: b.url, WebSocketImpl: WebSocket, log: quiet, timing, clientId: "install-aaaa", onRequest: async () => "a" });
  const c = new BridgeClient({ url: b.url, WebSocketImpl: WebSocket, log: quiet, timing, clientId: "install-cccc", onRequest: async () => "c" });
  try {
    a.start();
    await onceEvent(b.bridge, "connect");
    c.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connects, 1, "no takeovers back and forth");
    assert.equal(await b.bridge.call("tabs_context"), "a");
    a.stop();
    await onceEvent(b.bridge, "connect");
    assert.equal(await b.bridge.call("tabs_context"), "c", "the waiting install takes over once the first lets go");
  } finally {
    a.stop();
    c.stop();
    await b.stop();
  }
});

test("blocklist: the extension's list is kept and parsed; only the current, greeted socket counts", async () => {
  const b = await startBridge();
  try {
    assert.equal(b.bridge.blocklist(), null);
    const early = new FakeExt(b.url);
    await early.open(false);
    early.ws.send(JSON.stringify({ type: "blocklist", lines: ["etsy.com"] }));
    await early.ping();
    assert.equal(b.bridge.blocklist(), null, "before hello");
    early.close();

    const ext = new FakeExt(b.url);
    await ext.open();
    const got = onceEvent(b.bridge, "blocklist");
    ext.ws.send(JSON.stringify({ type: "blocklist", lines: ["# shops", "https://www.etsy.com/", "*bank*", "not a site"] }));
    assert.deepEqual((await got).map((e: any) => e.text), ["etsy.com", "*bank*"]);
    ext.close();
    await onceEvent(b.bridge, "disconnect");
    assert.equal(b.bridge.blocklist()?.length, 2, "kept across a disconnect");
  } finally {
    await b.stop();
  }
});

test("blocklist: the extension's BridgeClient sends it on connect", async () => {
  const b = await startBridge();
  const got = onceEvent(b.bridge, "blocklist");
  const client = new BridgeClient({
    url: b.url,
    WebSocketImpl: WebSocket,
    log: { info() {}, warn() {}, debug() {} },
    onOpen: () => client.send({ type: proto.MSG.BLOCKLIST, lines: ["chase.com", "amazon.*/ap"] }),
  });
  try {
    client.start();
    assert.deepEqual((await got).map((e: any) => e.text), ["chase.com", "amazon.*/ap"]);
  } finally {
    client.stop();
    await b.stop();
  }
});

test("settings: guidedMode from the current socket is kept; non-booleans are ignored", async () => {
  const b = await startBridge();
  try {
    assert.equal(b.bridge.guidedMode(), null);
    const ext = new FakeExt(b.url);
    await ext.open();
    ext.ws.send(JSON.stringify({ type: proto.MSG.SETTINGS, guidedMode: "no" }));
    await ext.ping();
    assert.equal(b.bridge.guidedMode(), null, "a string is not a setting");
    const got = onceEvent(b.bridge, "settings");
    ext.ws.send(JSON.stringify({ type: proto.MSG.SETTINGS, guidedMode: false }));
    assert.deepEqual(await got, { guidedMode: false, memory: null });
    assert.equal(b.bridge.guidedMode(), false);
    assert.equal(b.bridge.memoryEnabled(), null, "an older extension sends no memory setting");
    const mem = onceEvent(b.bridge, "settings");
    ext.ws.send(JSON.stringify({ type: proto.MSG.SETTINGS, guidedMode: false, memory: false }));
    assert.deepEqual(await mem, { guidedMode: false, memory: false });
    assert.equal(b.bridge.memoryEnabled(), false);
    ext.close();
    await onceEvent(b.bridge, "disconnect");
    assert.equal(b.bridge.guidedMode(), false, "kept across a disconnect");
  } finally {
    await b.stop();
  }
});
