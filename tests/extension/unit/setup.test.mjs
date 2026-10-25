import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agentHealth, allReady, hasSiteAccess, missingSetup, onInstalledSetup, requestSiteAccess, setupDone, shouldOpenSetup, talkKeyHelp, SETUP_PATH, SETUP_STEPS,
} from "../../../extension/lib/setup.js";
import { grantMic } from "../../../extension/lib/mic-grant.js";

function fakeChrome({ site = true, grant = false, throws = false } = {}) {
  const state = { site, tabs: [], badge: null, title: null, requested: 0 };
  const chromeApi = {
    permissions: {
      contains: async (p) => { if (throws) throw new Error("x"); assert.deepEqual(p, { origins: ["<all_urls>"] }); return state.site; },
      request: async () => { state.requested++; if (grant) state.site = true; return grant; },
    },
    tabs: { create: async (o) => { state.tabs.push(o.url); } },
    runtime: { getURL: (p) => `chrome-extension://id/${p}`, id: "id" },
    action: {
      setBadgeText: async ({ text }) => { state.badge = text; },
      setBadgeBackgroundColor: async () => {},
      setTitle: async ({ title }) => { state.title = title; },
    },
  };
  return { chromeApi, state };
}
const perms = (s) => ({ query: async () => ({ state: s }) });

test("site access check and request", async () => {
  assert.equal(await hasSiteAccess(fakeChrome({ site: false }).chromeApi), false);
  assert.equal(await hasSiteAccess(fakeChrome({ throws: true }).chromeApi), false);
  const refused = fakeChrome({ site: false });
  assert.equal(await requestSiteAccess(refused.chromeApi), false);
  const granted = fakeChrome({ site: false, grant: true });
  assert.equal(await requestSiteAccess(granted.chromeApi), true);
  assert.equal(granted.state.requested, 1);
});

test("missing lists site and mic; an unreadable mic state is not counted", async () => {
  const { chromeApi } = fakeChrome({ site: false });
  assert.deepEqual(await missingSetup({ chromeApi, permissions: perms("prompt") }), ["site", "mic"]);
  assert.deepEqual(await missingSetup({ chromeApi, permissions: { query: async () => { throw new Error("no"); } } }), ["site"]);
  assert.deepEqual(await missingSetup({ chromeApi: fakeChrome().chromeApi, permissions: perms("granted") }), []);
});

test("agent health reads ok and voice from /healthz", async () => {
  let asked = null;
  const ok = await agentHealth("ws://localhost:5050", async (url) => { asked = url; return { ok: true, json: async () => ({ ok: true, voice: false }) }; });
  assert.equal(asked, "http://localhost:5050/healthz");
  assert.deepEqual(ok, { connected: true, voice: false, cartesia: null, url: asked });
  const down = await agentHealth("ws://localhost:5050", async () => { throw new TypeError("refused"); });
  assert.equal(down.connected, false);
  assert.equal(allReady({ site: true, mic: "granted", agent: ok }), true);
  assert.equal(allReady({ site: true, mic: "prompt", agent: ok }), false);
});

test("mic grant stops the tracks and explains a block", async () => {
  let stopped = 0;
  const ok = await grantMic({ getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) });
  assert.equal(ok.ok, true);
  assert.equal(stopped, 1);
  const blocked = await grantMic({ getUserMedia: async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); } });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /blocked/);
});

test("onInstalled opens setup on install, and on update only when something is missing", async () => {
  assert.equal(shouldOpenSetup("install", []), true);
  assert.equal(shouldOpenSetup("update", []), false);
  assert.equal(shouldOpenSetup("chrome_update", ["site"]), false);

  const fresh = fakeChrome();
  assert.equal(await onInstalledSetup("install", { chromeApi: fresh.chromeApi, permissions: perms("prompt") }), true);
  assert.deepEqual(fresh.state.tabs, [`chrome-extension://id/${SETUP_PATH}`]);
  assert.equal(fresh.state.badge, "!");
  assert.match(fresh.state.title, /microphone/);

  const done = fakeChrome();
  assert.equal(await onInstalledSetup("update", { chromeApi: done.chromeApi, permissions: perms("granted") }), false);
  assert.deepEqual(done.state.tabs, []);
  assert.equal(done.state.badge, "");

  const restricted = fakeChrome({ site: false });
  assert.equal(await onInstalledSetup("update", { chromeApi: restricted.chromeApi, permissions: perms("granted") }), true);
  assert.match(restricted.state.title, /site access/);
});

test("talk key help has no em dashes and mentions text fields", () => {
  for (const k of ["Space", "Alt+Space", "F9"]) {
    assert.doesNotMatch(talkKeyHelp(k), /—/);
    assert.match(talkKeyHelp(k), /text field/);
  }
  assert.equal(talkKeyHelp("Space"), "Hold Space to talk. Option+Space keeps listening until you press Space, and works in text fields too. Double-tap Space to stop Orbi talking.");
  assert.match(talkKeyHelp("F9"), /^Hold F9 until Orbi is listening \(a short rising tone\)/);
});

test("update opens setup in the background, once per version", async () => {
  const f = fakeChrome({ site: false });
  const stored = {};
  const created = [];
  f.chromeApi.storage = { local: { get: async (k) => ({ [k]: stored[k] }), set: async (o) => { Object.assign(stored, o); } } };
  f.chromeApi.runtime.getManifest = () => ({ version: f.version });
  f.chromeApi.tabs.create = async (o) => { created.push(o); };
  const apis = { chromeApi: f.chromeApi, permissions: { query: async () => ({ state: "granted" }) } };

  f.version = "1.0.0";
  assert.equal(await onInstalledSetup("update", apis), true);
  assert.equal(created[0].active, false);
  assert.equal(await onInstalledSetup("update", apis), false); // reload, same version
  f.version = "1.0.1";
  assert.equal(await onInstalledSetup("update", apis), true);
  assert.equal(created.length, 2);
  assert.equal(created[1].active, false);
  assert.equal(await onInstalledSetup("install", apis), true);
  assert.equal(created[2].active, true);
});

test("setup and popup buttons keep 4.5:1 text contrast in light and dark", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../../../extension/setup/setup.css", import.meta.url), "utf8");
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const blocks = css.match(/:root \{[^}]*\}/g);
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    const v = (name) => block.match(new RegExp(`--${name}: (#[0-9a-f]{6})`, "i"))[1];
    assert.ok(ratio(v("on-accent"), v("accent")) >= 4.5, block);
  }
  assert.match(css, /button \{[^}]*color: var\(--on-accent\)/);
});

test("setupDone counts the four setup checks; the talk key is always done", () => {
  assert.equal(SETUP_STEPS, 4);
  assert.equal(setupDone({ site: true, mic: "granted", agent: { connected: true } }), 4);
  assert.equal(setupDone({ site: false, mic: "prompt", agent: { connected: false } }), 1);
  assert.equal(setupDone({ site: true, mic: "unknown", agent: null }), 2);
  assert.equal(setupDone({ site: false, mic: "granted", agent: { connected: true } }), 3);
});

test("popup and options text keeps 4.5:1 contrast and controls 3:1", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(`../../../extension/${path}`, import.meta.url), "utf8");
  // The tokens live in lib/ui.css, shared by both pages.
  const css = await read("lib/ui.css");
  const blocks = css.match(/:root \{[^}]*\}/g).filter((b) => b.includes("--bg:"));
  assert.equal(blocks.length, 2, "light and dark tokens");
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const block of blocks) {
    const v = (name) => block.match(new RegExp(`--${name}: (#[0-9a-f]{6})`, "i"))[1];
    const ratio = (a, b) => { const [x, y] = [lum(v(a)), lum(v(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    for (const [fg, bg] of [["fg", "bg"], ["muted", "bg"], ["fg", "sheet"], ["muted", "sheet"], ["soft", "sheet"], ["soft", "fill"], ["fg", "fill"],
      ["fg", "hover"], ["ok-fg", "ok-bg"], ["warn-fg", "warn-bg"], ["wait-fg", "wait-bg"], ["primary-fg", "primary-bg"], ["error", "sheet"]]) {
      assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
    }
    for (const [a, b] of [["switch-off", "sheet"], ["sw-on", "sheet"], ["knob", "sw-on"], ["focus", "bg"], ["focus", "sheet"],
      ["field-line", "sheet"], ["field-line", "bg"]]) {
      assert.ok(ratio(a, b) >= 3, `${a} on ${b}: ${ratio(a, b).toFixed(2)}`);
    }
  }
  const amber = (name) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6})`, "i"))[1];
  const [x, y] = [lum(amber("on-amber")), lum(amber("amber"))].sort((p, q) => q - p);
  assert.ok((x + 0.05) / (y + 0.05) >= 4.5, "Danger mode button text");
  for (const path of ["lib/ui.css", "popup/popup.css", "options/options.css"]) {
    assert.doesNotMatch(await read(path), /@import|url\(\s*["']?https?:/, `${path}: no remote fonts or images`);
  }
  for (const path of ["popup/popup.html", "options/options.html"]) {
    assert.match(await read(path), /<link rel="stylesheet" href="\.\.\/lib\/ui\.css">/, `${path} uses the shared look`);
  }
});
