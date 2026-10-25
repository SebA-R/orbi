// The extension's Claude model setting: only the allowlisted models reach
// the SDK, the extension's choice wins over CLEARCART_MODEL, and a change
// moves the backend so the hub retires the session (hub.ts switchBackend).

import assert from "node:assert/strict";
import { test } from "node:test";

import { extBridge } from "../extbridge.ts";
import { CLAUDE_MODELS, backendKey, describeBackend, envProviderSettings, parseClaudeModel } from "../local/config.ts";
import { currentProvider } from "../session.ts";
import { FakeExt, onceEvent, startBridge } from "./fake-ext.ts";

test("only the three Claude models pass; anything else falls back to Sonnet", () => {
  assert.deepEqual(Object.keys(CLAUDE_MODELS), ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
  for (const id of Object.keys(CLAUDE_MODELS)) assert.equal(parseClaudeModel(id), id);
  for (const v of ["claude-opus-4", "claude-opus-5-5 ", "gpt-5", "", "__proto__", "toString", 5, null, {}]) assert.equal(parseClaudeModel(v), null, String(v));
  assert.equal(envProviderSettings({ CLEARCART_MODEL: "claude-haiku-5-5" }).claudeModel, "claude-haiku-5-5");
  assert.equal(envProviderSettings({ CLEARCART_MODEL: "some-other-model" }).claudeModel, "claude-sonnet-5-5");
  assert.equal(envProviderSettings({}).claudeModel, "claude-sonnet-5-5");
});

test("the model is part of the backend, and the status line names it", () => {
  const p = envProviderSettings({});
  assert.notEqual(backendKey({ ...p, claudeModel: "claude-opus-5-5" }), backendKey(p), "a model change is a backend change");
  assert.equal(describeBackend({ ...p, claudeModel: "claude-opus-5-5" }), "Claude (Opus 5.5)");
  assert.equal(describeBackend(p), "Claude (Sonnet 5.5)");
});

test("precedence: the extension's setting, then CLEARCART_MODEL, then Sonnet", () => {
  const saved = { browser: process.env.CLEARCART_BROWSER, model: process.env.CLEARCART_MODEL };
  const take = (m: Record<string, unknown>) => (extBridge as unknown as { takeProvider(m: Record<string, unknown>): void }).takeProvider(m);
  try {
    process.env.CLEARCART_BROWSER = "ext";
    delete process.env.CLEARCART_MODEL;
    assert.equal(currentProvider().claudeModel, "claude-sonnet-5-5");
    process.env.CLEARCART_MODEL = "claude-haiku-5-5";
    assert.equal(currentProvider().claudeModel, "claude-haiku-5-5", "the environment until the extension says");
    take({ claudeModel: "claude-opus-5-5" });
    assert.equal(currentProvider().claudeModel, "claude-opus-5-5", "the extension wins");
    take({ claudeModel: "claude-ultra-9" });
    assert.equal(currentProvider().claudeModel, "claude-opus-5-5", "a bad value is refused, the last good one stays");
  } finally {
    for (const [k, v] of [["CLEARCART_BROWSER", saved.browser], ["CLEARCART_MODEL", saved.model]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("the settings message carries claudeModel and a change emits provider", async () => {
  const b = await startBridge();
  try {
    const ext = new FakeExt(b.url);
    await ext.open();
    const send = (extra: Record<string, unknown>) => ext.ws.send(JSON.stringify({ type: "settings", guidedMode: false, memory: true, provider: "claude", ...extra }));
    let changed = onceEvent(b.bridge, "provider");
    send({ claudeModel: "claude-opus-5-5" });
    assert.equal((await changed).claudeModel, "claude-opus-5-5");
    let events = 0;
    b.bridge.on("provider", () => events++);
    send({ claudeModel: "claude-opus-5-5" });
    send({ claudeModel: "anything-else" });
    await ext.ping();
    assert.equal(events, 0, "the same model again, or a bad one, is not a change");
    changed = onceEvent(b.bridge, "provider");
    send({ claudeModel: "claude-haiku-5-5" });
    assert.equal((await changed).claudeModel, "claude-haiku-5-5");
    ext.close();
  } finally {
    await b.stop();
  }
});
