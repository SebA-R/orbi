import assert from "node:assert/strict";
import { test } from "node:test";

import * as proto from "../../extension/lib/protocol.js";
import { ERR, EXT_NAME, ExtError, INTERNAL, PROTOCOL_VERSION, TOOLS } from "../extbridge.ts";
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

test("newest wins: a second extension replaces the first; reconnect works", async () => {
  const b = await startBridge();
  try {
    const first = new FakeExt(b.url, () => ({ who: "first" }));
    await first.open();
    // Pending call on the first socket gets rejected when it is replaced.
    const firstOnly = new FakeExt(b.url, () => NO_REPLY);
    await firstOnly.open();
    const pending = b.bridge.call("tabs_context", {}, 5_000).then(
      () => assert.fail("should have been rejected"),
      (e) => e
    );
    await new Promise((r) => setTimeout(r, 20));

    const second = new FakeExt(b.url, () => ({ who: "second" }));
    await second.open();
    assert.equal((await pending).code, ERR.NOT_CONNECTED);
    assert.equal((await firstOnly.waitClosed()).code, 4002);
    assert.equal((await first.waitClosed()).code, 4002);
    assert.deepEqual(await b.bridge.call("tabs_context"), { who: "second" });
    assert.equal(b.bridge.connected(), true);

    // The replaced socket closing must not mark the bridge disconnected.
    second.close();
    await onceEvent(b.bridge, "disconnect");
    assert.equal(b.bridge.connected(), false);

    // Reconnect after a drop.
    const again = new FakeExt(b.url, () => ({ who: "again" }));
    await again.open();
    assert.deepEqual(await b.bridge.call("tabs_context"), { who: "again" });
    again.close();
  } finally {
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
