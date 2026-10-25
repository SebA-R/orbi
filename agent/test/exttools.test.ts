import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { ExtError, INTERNAL, TOOLS } from "../extbridge.ts";
import { createExtToolsServer, extToolDefinitions } from "../exttools.ts";

type Call = { method: string; params: any };
function fakeBridge(answer: (method: string, params: any) => any) {
  const calls: Call[] = [];
  return {
    calls,
    call: async (method: string, params: any = {}) => {
      calls.push({ method, params });
      return answer(method, params);
    },
  };
}

test("exposes exactly the TOOLS, none of the INTERNAL methods", () => {
  const defs = extToolDefinitions(fakeBridge(() => null) as any);
  assert.deepEqual(defs.map((d) => d.name).sort(), [...TOOLS].sort());
  for (const m of INTERNAL) assert.ok(!defs.some((d) => d.name === m));
  const server = createExtToolsServer(fakeBridge(() => null) as any);
  assert.equal(server.type, "sdk");
  assert.equal(server.name, "browser");
});

test("schemas validate the documented params", () => {
  const defs = Object.fromEntries(extToolDefinitions(fakeBridge(() => null) as any).map((d) => [d.name, z.object(d.inputSchema)]));
  assert.ok(defs.navigate.safeParse({ url: "http://localhost:4000/" }).success);
  assert.ok(!defs.navigate.safeParse({}).success);
  assert.ok(defs.click.safeParse({ ref: "ref_3" }).success);
  assert.ok(defs.click.safeParse({ tabId: 5, x: 10, y: 20 }).success);
  assert.ok(!defs.find.safeParse({ query: 3 }).success);
  assert.ok(defs.read_page.safeParse({ filter: "interactive" }).success);
  assert.ok(!defs.read_page.safeParse({ filter: "secret" }).success);
  assert.ok(defs.form_input.safeParse({ ref: "ref_1", value: true }).success);
  assert.ok(defs.tabs_context.safeParse({}).success);
});

test("pass-through tools forward params and drop undefined keys", async () => {
  const b = fakeBridge((m) => (m === "find" ? { matches: [{ ref: "ref_1", role: "button", name: "Add" }] } : null));
  const defs = Object.fromEntries(extToolDefinitions(b as any).map((d) => [d.name, d]));
  const r: any = await defs.find.handler({ query: "Add", tabId: undefined }, {});
  assert.deepEqual(b.calls[0], { method: "find", params: { query: "Add" } });
  assert.deepEqual(JSON.parse(r.content[0].text).matches[0].ref, "ref_1");
});

test("click by ref calls rect then clicks the centre", async () => {
  const b = fakeBridge((m) => (m === "rect" ? { x: 100, y: 200, width: 50, height: 20 } : null));
  const defs = Object.fromEntries(extToolDefinitions(b as any).map((d) => [d.name, d]));
  const r: any = await defs.click.handler({ ref: "ref_7", tabId: 9 }, {});
  assert.deepEqual(b.calls, [
    { method: "rect", params: { tabId: 9, ref: "ref_7" } },
    { method: "click", params: { tabId: 9, x: 125, y: 210 } },
  ]);
  assert.equal(JSON.parse(r.content[0].text).via, "cdp");
});

test("click by ref falls back to click_ref when rect is unknown", async () => {
  const b = fakeBridge((m) => {
    if (m === "rect") throw new ExtError("unknown_method", "rect");
    return { ok: true };
  });
  const defs = Object.fromEntries(extToolDefinitions(b as any).map((d) => [d.name, d]));
  const r: any = await defs.click.handler({ ref: "ref_7" }, {});
  assert.deepEqual(b.calls.map((c) => c.method), ["rect", "click_ref"]);
  assert.equal(JSON.parse(r.content[0].text).via, "dom");
});

test("click by coordinates and bad click args", async () => {
  const b = fakeBridge(() => null);
  const defs = Object.fromEntries(extToolDefinitions(b as any).map((d) => [d.name, d]));
  await defs.click.handler({ x: 1, y: 2 }, {});
  assert.deepEqual(b.calls[0], { method: "click", params: { x: 1, y: 2 } });
  const bad: any = await defs.click.handler({ x: 1 }, {});
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /bad_request/);
});

test("errors come back as isError text; screenshot as an image", async () => {
  const b = fakeBridge((m) => {
    if (m === "navigate") throw new ExtError("not_allowed", "https://evil.example is not allowed");
    if (m === "screenshot") return { data: "AAAA", mimeType: "image/jpeg" };
  });
  const defs = Object.fromEntries(extToolDefinitions(b as any).map((d) => [d.name, d]));
  const nav: any = await defs.navigate.handler({ url: "https://evil.example" }, {});
  assert.equal(nav.isError, true);
  assert.match(nav.content[0].text, /not_allowed/);
  const shot: any = await defs.screenshot.handler({}, {});
  assert.deepEqual(shot.content[0], { type: "image", data: "AAAA", mimeType: "image/jpeg" });
});

test("tool descriptions tell Claude locked means request_unlock, not give up", () => {
  const defs = Object.fromEntries(extToolDefinitions({ call: async () => ({}) } as any).map((t: any) => [t.name, t.description]));
  for (const name of ["read_page", "find", "click"]) assert.match(defs[name], /request_unlock/, name);
  assert.match(defs.read_page, /never for Place order, Buy now, Pay or wallets/);
  assert.match(defs.get_page_text, /locked/);
  assert.match(defs.click, /names the control and its ref/);
});

test("screenshot says its CSS size, and the scale when the image is not 1:1", async () => {
  let answer: any = { data: "AAAA", mimeType: "image/jpeg", width: 1440, height: 900, scale: 1 };
  const defs = Object.fromEntries(extToolDefinitions(fakeBridge(() => answer) as any).map((d) => [d.name, d]));
  let shot: any = await defs.screenshot.handler({}, {});
  assert.equal(shot.content[0].type, "image");
  assert.match(shot.content[1].text, /Viewport 1440x900 CSS px; image pixels are click coordinates/);
  answer = { ...answer, scale: 2 };
  shot = await defs.screenshot.handler({}, {});
  assert.match(shot.content[1].text, /divide image coordinates by 2/);
  assert.match(defs.click.description, /CSS pixels/);
});

test("dismiss_overlay passes through to the extension", async () => {
  const b = fakeBridge((m) => (m === "dismiss_overlay" ? { dismissed: true, via: "close button", name: "Get 10% off" } : null));
  const defs = Object.fromEntries(extToolDefinitions(b as any).map((d) => [d.name, d]));
  const r: any = await defs.dismiss_overlay.handler({ tabId: 4 }, {});
  assert.deepEqual(JSON.parse(r.content[0].text), { dismissed: true, via: "close button", name: "Get 10% off" });
  assert.deepEqual(b.calls, [{ method: "dismiss_overlay", params: { tabId: 4 } }]);
  assert.match(defs.dismiss_overlay.description, /Sign-in, checkout, payment/);
});
