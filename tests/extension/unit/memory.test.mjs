// The Memory setting and the options page's saved-facts client
// (extension/lib/memory.js): default on, the endpoints it calls, and that
// the page shows facts as text with a Delete button each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULTS, loadSettings, normalize, saveSettings } from "../../../extension/lib/settings.js";
import { forgetAll, forgetFact, listMemory } from "../../../extension/lib/memory.js";

const read = (p) => readFileSync(new URL(`../../../extension/${p}`, import.meta.url), "utf8");

function fakeFetch(reply) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init?.method });
    const r = typeof reply === "function" ? reply(url, init) : reply;
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.body };
  };
  f.calls = calls;
  return f;
}

test("memory defaults on, keeps booleans only, and round-trips through storage", async () => {
  assert.equal(DEFAULTS.memory, true);
  assert.equal(normalize({}).memory, true);
  assert.equal(normalize({ memory: "off" }).memory, true);
  assert.equal(normalize({ memory: false }).memory, false);
  const data = {};
  const store = { get: async () => ({ ...data }), set: async (o) => Object.assign(data, o) };
  assert.equal((await saveSettings({ memory: false }, store)).memory, false);
  assert.equal((await loadSettings(store)).memory, false);
});

test("listMemory reads GET /memory on the agent's http address and keeps well-formed facts", async () => {
  const f = fakeFetch({ body: { enabled: true, facts: [{ id: "m0000000a", text: "you wear a medium", at: 5 }, { id: "../x", text: "bad" }, { id: "m0000000b" }] } });
  const r = await listMemory("ws://localhost:5050", f);
  assert.deepEqual(f.calls, [{ url: "http://localhost:5050/memory", method: "GET" }]);
  assert.deepEqual(r, { enabled: true, facts: [{ id: "m0000000a", text: "you wear a medium", at: 5 }] });
  await assert.rejects(listMemory("ws://localhost:5050", fakeFetch({ status: 403, body: {} })));
});

test("forgetFact and forgetAll send DELETE, and a bad id is never sent", async () => {
  const f = fakeFetch({ body: { ok: true } });
  await forgetFact("ws://127.0.0.1:5050", "m0000000a", f);
  await forgetAll("ws://127.0.0.1:5050", f);
  assert.deepEqual(f.calls, [
    { url: "http://127.0.0.1:5050/memory/m0000000a", method: "DELETE" },
    { url: "http://127.0.0.1:5050/memory", method: "DELETE" },
  ]);
  await assert.rejects(forgetFact("ws://localhost:5050", "../../healthz", f));
  assert.equal(f.calls.length, 2);
});

test("an agent address off this computer falls back to localhost", async () => {
  const f = fakeFetch({ body: { facts: [] } });
  await listMemory("ws://evil.example:5050", f);
  assert.equal(f.calls[0].url, "http://localhost:5050/memory");
});

test("options page: the Memory switch is a data-setting row, facts are text with a Delete each, Forget everything asks first", () => {
  const html = read("options/options.html");
  assert.match(html, /<input id="memory-on"[^>]*role="switch"[^>]*data-setting="memory"/);
  assert.match(html, /id="memory-list"/);
  assert.match(html, /id="memory-forget-all"/);
  assert.match(html, /<p id="memory-confirm" class="row confirm" hidden>/);
  const js = read("options/options.js");
  assert.match(js, /text\.textContent = f\.text/);
  assert.ok(!/innerHTML/.test(js), "no HTML from the server");
  assert.match(js, /setAttribute\("aria-label", `Delete: \$\{f\.text\}`\)/);
  const worker = read("background/worker.js");
  assert.match(worker, /MSG\.SETTINGS, guidedMode, memory/);
  assert.match(worker, /changes\.guidedMode \|\| changes\.memory/);
});
