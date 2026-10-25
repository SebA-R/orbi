import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_SETTING_KEYS, DEFAULTS, agentSettingsMessage, endpoints, loadSettings, localModels, localStatusText, migrateSettings, MIGRATIONS_KEY, normalize,
  normalizeAgentUrl, normalizeLocalBaseUrl, normalizeLocalModel, normalizeOrigin, parseOriginLines, RETIRED_ALLOWED, saveSettings, seedBlocklist,
} from "../../../extension/lib/settings.js";
import { readFileSync } from "node:fs";
import { SUGGESTED_BLOCKLIST } from "../../../extension/lib/blocklist.js";

function memoryStorage(init = {}) {
  const data = { ...init };
  return {
    data,
    async get(keys) {
      return Object.fromEntries([keys].flat().filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(obj) {
      Object.assign(data, obj);
    },
  };
}

test("agent URL must be a ws(s) URL on this machine", () => {
  assert.equal(normalizeAgentUrl("ws://localhost:5050/"), "ws://localhost:5050");
  assert.equal(normalizeAgentUrl("ws://127.0.0.1:6000/ext"), "ws://127.0.0.1:6000");
  assert.equal(normalizeAgentUrl("http://localhost:5050"), null);
  assert.equal(normalizeAgentUrl("ws://evil.example:5050"), null);
  assert.equal(normalizeAgentUrl("ws://localhost.evil.example"), null);
  assert.equal(normalizeAgentUrl("nonsense"), null);
});

test("origins are parsed and credentials are refused", () => {
  assert.equal(normalizeOrigin("http://localhost:4100/cart"), "http://localhost:4100");
  assert.equal(normalizeOrigin("http://localhost:4100@evil.example/"), null);
  assert.equal(normalizeOrigin("javascript:alert(1)"), null);
});

test("normalize falls back to defaults for bad values", () => {
  assert.deepEqual(normalize({}), { ...DEFAULTS, allowlist: [], blocklist: [...SUGGESTED_BLOCKLIST] });
  assert.deepEqual(DEFAULTS.allowlist, [], "no allowed sites until the user adds some");
  const s = normalize({ agentUrl: "ws://x.example", hotkey: "Nope", speed: 9, subtitles: "yes", allowlist: ["bad"] });
  assert.equal(s.agentUrl, DEFAULTS.agentUrl);
  assert.equal(s.hotkey, DEFAULTS.hotkey);
  assert.equal(s.speed, 2);
  assert.equal(s.subtitles, true);
  assert.deepEqual(s.allowlist, [], "bad lines are dropped, nothing is put back");
  assert.deepEqual(normalize({ allowlist: ["http://localhost:4100/", "http://localhost:4100"] }).allowlist, ["http://localhost:4100"]);
});

test("the Orbi new tab page is on by default; only a stored boolean changes it", () => {
  assert.equal(DEFAULTS.newTabPage, true);
  assert.equal(normalize({ newTabPage: "no" }).newTabPage, true);
  assert.equal(normalize({ newTabPage: false }).newTabPage, false);
  assert.equal(DEFAULTS.errorPages, true);
  assert.equal(normalize({ errorPages: "no" }).errorPages, true);
  assert.equal(normalize({ errorPages: false }).errorPages, false);
});

test("endpoints derive the bridge, session and token URLs", () => {
  assert.deepEqual(endpoints("ws://localhost:5150"), {
    ext: "ws://localhost:5150/ext",
    session: "ws://localhost:5150/session",
    http: "http://localhost:5150",
    token: "http://localhost:5150/cartesia-token",
    localModels: "http://localhost:5150/local-models",
  });
});

test("load and save round-trip through storage with validation", async () => {
  const st = memoryStorage({ speed: 1.4 });
  assert.equal((await loadSettings(st)).speed, 1.4);
  const next = await saveSettings({ hotkey: "F9", agentUrl: "ws://evil.example" }, st);
  assert.equal(next.hotkey, "F9");
  assert.equal(st.data.agentUrl, DEFAULTS.agentUrl);
});

test("browse mode defaults to open and only takes known values", () => {
  assert.equal(DEFAULTS.browseMode, "open");
  assert.equal(normalize({}).browseMode, "open");
  assert.equal(normalize({ browseMode: "allowlist" }).browseMode, "allowlist");
  assert.equal(normalize({ browseMode: "anything" }).browseMode, "open");
});

test("the blocklist keeps valid entries and comments, and may be empty", () => {
  assert.deepEqual(
    normalize({ blocklist: ["# mine", "https://shop.example/x", "bad", "https://u:p@x.example", "SHOP.example/x", "*bank*"] }).blocklist,
    ["# mine", "shop.example/x", "*bank*"]
  );
  assert.deepEqual(normalize({ blocklist: [] }).blocklist, [], "an emptied list stays empty");
  assert.deepEqual(normalize({}).blocklist, [...SUGGESTED_BLOCKLIST], "no stored list: the suggested one");
});

test("first install seeds the suggested list once; a stored list is left alone", async () => {
  const st = memoryStorage();
  assert.equal(await seedBlocklist(st), true);
  assert.deepEqual(st.data.blocklist, [...SUGGESTED_BLOCKLIST]);
  st.data.blocklist = ["etsy.com"];
  assert.equal(await seedBlocklist(st), false);
  assert.deepEqual(st.data.blocklist, ["etsy.com"]);
  const empty = memoryStorage({ blocklist: [] });
  assert.equal(await seedBlocklist(empty), false);
  assert.deepEqual(empty.data.blocklist, []);
});

test("parseOriginLines takes one site per line and reports bad lines", () => {
  const r = parseOriginLines("https://www.etsy.com/c/home\nwww.aritzia.com\n\n  http://localhost:4100 \njavascript:alert(1)\nhttps://me:pw@shop.example\nhttps://www.etsy.com");
  assert.deepEqual(r.origins, ["https://www.etsy.com", "https://www.aritzia.com", "http://localhost:4100"]);
  assert.deepEqual(r.bad, ["javascript:alert(1)", "https://me:pw@shop.example"]);
});

test("sounds defaults on and keeps a stored false", () => {
  assert.equal(DEFAULTS.sounds, true);
  assert.equal(normalize({}).sounds, true);
  assert.equal(normalize({ sounds: false }).sounds, false);
  assert.equal(normalize({ sounds: "off" }).sounds, true);
});

test("guidedMode (the blind and low-vision mode) defaults off, keeps booleans only, and round-trips through storage", async () => {
  assert.equal(DEFAULTS.guidedMode, false);
  assert.equal(normalize({}).guidedMode, false);
  assert.equal(normalize({ guidedMode: "true" }).guidedMode, false, "non-boolean falls back");
  assert.equal(normalize({ guidedMode: true }).guidedMode, true);
  const store = memoryStorage();
  assert.equal((await loadSettings(store)).guidedMode, false);
  assert.equal((await saveSettings({ guidedMode: true }, store)).guidedMode, true);
  assert.equal(store.data.guidedMode, true);
  assert.equal((await loadSettings(store)).guidedMode, true);
  assert.equal((await saveSettings({ guidedMode: false }, store)).guidedMode, false);
});

test("an update takes the old default allowed site out of stored settings, once", async () => {
  const old = RETIRED_ALLOWED[0];
  // Saving any setting on an earlier version stored its default list.
  const st = memoryStorage({ allowlist: [old, "https://shop.example"], browseMode: "allowlist", speed: 1.2 });
  assert.equal(await migrateSettings(st), true);
  assert.deepEqual((await loadSettings(st)).allowlist, ["https://shop.example"]);
  assert.equal((await loadSettings(st)).speed, 1.2, "other settings stay");
  // Runs once: a site the user adds again later stays.
  await saveSettings({ allowlist: [old] }, st);
  assert.equal(await migrateSettings(st), false);
  assert.deepEqual((await loadSettings(st)).allowlist, [old]);
  // Nothing stored, or nothing to drop: only the marker is written.
  const fresh = memoryStorage();
  assert.equal(await migrateSettings(fresh), false);
  assert.deepEqual(Object.keys(fresh.data), [MIGRATIONS_KEY]);
  assert.equal("allowlist" in fresh.data, false);
});

test("provider settings default to Claude with the Ollama address", () => {
  assert.equal(DEFAULTS.provider, "claude");
  assert.equal(DEFAULTS.localBaseUrl, "http://localhost:11434/v1");
  assert.equal(DEFAULTS.localModel, "llama3.1:8b");
  const n = normalize({ provider: "openai", localModel: "bad name; rm -rf", localBaseUrl: 5 });
  assert.equal(n.provider, "claude");
  assert.equal(n.localModel, "llama3.1:8b");
  assert.equal(n.localBaseUrl, "http://localhost:11434/v1");
  assert.equal(normalize({ provider: "local" }).provider, "local");
  assert.equal(normalizeLocalModel("lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF"), "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF");
  assert.equal(normalizeLocalModel("<img src=x>"), null);
  assert.equal(normalizeLocalModel("a/../../x"), null);
  assert.equal(normalizeLocalModel("a//b"), null);
  assert.equal(normalizeLocalModel("a".repeat(129)), null);
});

test("local model address must be http(s) on a loopback host", () => {
  assert.equal(normalizeLocalBaseUrl("http://localhost:11434/v1/"), "http://localhost:11434/v1");
  assert.equal(normalizeLocalBaseUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  assert.equal(normalizeLocalBaseUrl("http://[::1]:1234"), "http://[::1]:1234");
  assert.equal(normalizeLocalBaseUrl("https://localhost"), "https://localhost");
  for (const bad of [
    "http://evil.example/v1", "http://localhost.evil.example/v1", "http://192.168.1.5:11434/v1", "http://10.0.0.1",
    "ftp://localhost/v1", "file:///etc/passwd", "javascript:alert(1)", "ws://localhost:11434",
    "http://user:pw@localhost:11434/v1", "http://localhost@evil.example/v1", "http://localhost:11434/v1?x=1",
    "http://localhost:11434/v1#x", "http://localhost//evil.example", "localhost:11434", "", "nonsense",
  ]) assert.equal(normalizeLocalBaseUrl(bad), null, bad);
  assert.equal(normalize({ localBaseUrl: "http://evil.example/v1" }).localBaseUrl, DEFAULTS.localBaseUrl);
  assert.equal(normalize({ localBaseUrl: "http://127.0.0.1:1234/v1" }).localBaseUrl, "http://127.0.0.1:1234/v1");
});

test("the worker sends the provider fields in the settings message and on change", () => {
  assert.deepEqual(agentSettingsMessage({ provider: "local", localModel: "qwen2.5:7b", guidedMode: false }), {
    type: "settings", guidedMode: false, memory: true, provider: "local", localBaseUrl: "http://localhost:11434/v1", localModel: "qwen2.5:7b",
  });
  assert.deepEqual(agentSettingsMessage({ localBaseUrl: "http://evil.example" }).localBaseUrl, DEFAULTS.localBaseUrl);
  for (const k of ["guidedMode", "memory", "provider", "localBaseUrl", "localModel"]) assert.ok(AGENT_SETTING_KEYS.includes(k), k);
  const src = readFileSync(new URL("../../../extension/background/worker.js", import.meta.url), "utf8");
  assert.match(src, /bridge\?\.send\(agentSettingsMessage\(s\)\)/);
  assert.match(src, /AGENT_SETTING_KEYS\.some\(\(k\) => changes\[k\]\)\) sendAgentSettings\(\)/);
});

test("local model list: ok, down, and missing on an older server", async () => {
  const reply = (status, body) => async (url) => {
    assert.equal(url, "http://localhost:5050/local-models");
    return { ok: status < 400, status, json: async () => body };
  };
  assert.deepEqual(await localModels("ws://localhost:5050", reply(200, { models: ["llama3.1:8b", { id: "qwen2.5:7b" }, "<b>"] })),
    { state: "ok", models: ["llama3.1:8b", "qwen2.5:7b"] });
  assert.deepEqual(await localModels("ws://localhost:5050", reply(200, { data: [{ id: "x" }] })), { state: "ok", models: ["x"] });
  assert.equal((await localModels("ws://localhost:5050", reply(404, {}))).state, "missing");
  assert.equal((await localModels("ws://localhost:5050", reply(502, { error: "ECONNREFUSED" }))).state, "down");
  assert.equal((await localModels("ws://localhost:5050", reply(200, { ok: false, error: "x" }))).state, "down");
  assert.equal((await localModels("ws://localhost:5050", async () => { throw new Error("refused"); })).state, "down");
  assert.equal(localStatusText("llama3.1:8b", { state: "ok", models: ["llama3.1:8b"] }), "llama3.1:8b, connected");
  assert.equal(localStatusText("llama3.1:8b", { state: "down", models: [] }), "Local model not reachable");
  assert.equal(localStatusText("llama3.1:8b", { state: "missing", models: [] }), "llama3.1:8b");
});
