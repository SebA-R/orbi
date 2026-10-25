import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agentHealth, allReady, hasSiteAccess, missingSetup, onInstalledSetup, requestSiteAccess, shouldOpenSetup, talkKeyHelp, SETUP_PATH,
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
  assert.deepEqual(ok, { connected: true, voice: false, url: asked });
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
  assert.match(talkKeyHelp("Space"), /^Hold Space, wait for the chime/);
});
