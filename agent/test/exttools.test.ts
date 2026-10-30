import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { ExtError, INTERNAL, TOOLS } from "../extbridge.ts";
import { createExtToolsServer, extToolDefinitions, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, seenScale } from "../exttools.ts";

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
  assert.ok(defs.navigate.safeParse({ url: "https://shop.example/" }).success);
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

test("click by ref sends the ref to the extension's own ref path, never a rect or a DOM fallback", async () => {
  const b = fakeBridge(() => ({ ok: true, via: "cdp", navigated: true, url: "https://shop.example/c/jackets", title: "Jackets", junk: "x" }));
  const defs = Object.fromEntries(extToolDefinitions(b as any).map((d) => [d.name, d]));
  const r: any = await defs.click.handler({ ref: "ref_7", tabId: 9 }, {});
  assert.deepEqual(b.calls, [{ method: "click", params: { tabId: 9, ref: "ref_7" } }]);
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, via: "cdp", navigated: true, url: "https://shop.example/c/jackets", title: "Jackets" });
});

test("click by ref: a failure comes back as an error, with no second click", async () => {
  const b = fakeBridge(() => {
    throw new ExtError("internal", "Input.dispatchMouseEvent failed");
  });
  const defs = Object.fromEntries(extToolDefinitions(b as any).map((d) => [d.name, d]));
  const r: any = await defs.click.handler({ ref: "ref_7" }, {});
  assert.equal(r.isError, true);
  assert.deepEqual(b.calls.map((c) => c.method), ["click"]);
});

test("click by point and key answer where the tab settled", async () => {
  const settled = { ok: true, navigated: true, url: "https://shop.example/c/jackets", title: "Jackets" };
  const b = fakeBridge(() => settled);
  const defs = Object.fromEntries(extToolDefinitions(b as any).map((d) => [d.name, d]));
  const byPoint = JSON.parse(((await defs.click.handler({ x: 1, y: 2 }, {})) as any).content[0].text);
  assert.deepEqual(byPoint, { ok: true, x: 1, y: 2, via: "cdp", navigated: true, url: "https://shop.example/c/jackets", title: "Jackets" });
  const key = JSON.parse(((await defs.key.handler({ key: "Enter" }, {})) as any).content[0].text);
  assert.equal(key.navigated, true);
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
  // A device-pixel capture (2880x1800) is past the model's image limits, so
  // it sees it shrunk to about 2449x1531, not twice the viewport: the
  // offsite_aritzia clicks read off that rendering landed outside the page.
  answer = { ...answer, scale: 2 };
  shot = await defs.screenshot.handler({}, {});
  assert.match(shot.content[1].text, /this image is 2449x1531, so divide image coordinates by 1\.70\d*/);
  assert.equal(seenScale(1440, 900, 1), 1);
  assert.equal(seenScale(1440, 900, 1.5), 1.5);
  // Shrunk by the extension to fit (an ultrawide window): kept as sent.
  assert.ok(Math.abs(seenScale(3440, 1440, 0.7488) - 0.7488) < 0.001);
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

// The extension's cdp.js keeps its own copy of the image limits (it runs in
// the browser): the two must agree, so a screenshot sent at fitScale is seen
// by the model at that scale, with no further shrink.
test("the image limits match the extension's cdp.js fitScale", async () => {
  const cdpPath = new URL("../../extension/background/cdp.js", import.meta.url).href;
  const cdp: any = await import(cdpPath);
  assert.equal(cdp.MAX_IMAGE_EDGE, MAX_IMAGE_EDGE);
  assert.equal(cdp.MAX_IMAGE_PIXELS, MAX_IMAGE_PIXELS);
  for (const [w, h] of [[1440, 900], [2560, 1440], [3440, 1440], [5120, 2880], [7680, 4320], [1000, 6000]]) {
    const fit = cdp.fitScale(w, h);
    assert.ok(Math.abs(seenScale(w, h, fit) - fit) < 1e-9, `${w}x${h}`);
    assert.ok(Math.round(Math.max(w, h) * fit) <= MAX_IMAGE_EDGE && Math.round(w * fit) * Math.round(h * fit) <= MAX_IMAGE_PIXELS * 1.001, `${w}x${h} within limits`);
  }
});
