// The local model backend (local/): the agent loop against a fake
// OpenAI-compatible server, guard parity with the SDK hook path, the
// extension's provider settings, the hub's switch and GET /local-models.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { extBridge } from "../extbridge.ts";
import { SessionHub, type HubMessage } from "../hub.ts";
import { envProviderSettings, parseLocalBaseUrl, parseLocalModel } from "../local/config.ts";
import { claimConfirmation } from "../pay.ts";
import { DISALLOWED_BROWSER, Session, type ServerMessage } from "../session.ts";
import { FakeExt, onceEvent, startBridge } from "./fake-ext.ts";

process.env.CLEARCART_BROWSER = "ext";
process.env.CLEARCART_VOICE = "false";
const B = "mcp__browser__";
const C = "mcp__clearcart__";
const EXT_ALLOWED_SHORT = ["tabs_context", "tabs_create", "tabs_close", "tabs_activate", "navigate", "read_page", "find", "get_page_text", "form_input", "click", "type", "key", "scroll", "screenshot", "say", "request_checkout", "pay_now", "request_unlock", "remember", "forget", "recall"];

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, what: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick(10);
  }
}

// A fake OpenAI-compatible server. script(body, n) says what the nth chat
// request gets: text and tool calls, an HTTP error, or no answer at all.
// ollama: answers like Ollama (/api/version, /api/chat) instead.
type Step = { text?: string; calls?: Array<{ name: string; args?: unknown }> } | { status: number; body: unknown } | { hang: true };
async function fakeModel(script: (body: any, n: number) => Step | Promise<Step>, { ollama = false } = {}) {
  const requests: any[] = [];
  let aborted = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") return void res.end(JSON.stringify({ object: "list", data: [{ id: "tiny:1b" }, { id: "bad name!" }] }));
    if (req.method === "GET" && req.url === "/api/tags") return void res.end(JSON.stringify({ models: [{ name: "tiny:1b", capabilities: ["completion", "tools"] }] }));
    if (req.method === "GET" && req.url === "/api/version" && ollama) return void res.end(JSON.stringify({ version: "0.0.0-test" }));
    if (req.method !== "POST" || req.url !== (ollama ? "/api/chat" : "/v1/chat/completions")) return void res.writeHead(404).end("not found");
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    requests.push(body);
    const n = requests.length;
    const step = await script(body, n);
    if ("hang" in step) return void res.on("close", () => aborted++);
    if ("status" in step) return void res.writeHead(step.status, { "Content-Type": "application/json" }).end(JSON.stringify(step.body));
    const tool_calls = step.calls?.map((c, i) => ({ id: `call_${n}_${i}`, type: "function", function: { name: c.name, arguments: ollama ? c.args ?? {} : typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}) } }));
    const message = { role: "assistant", content: step.text ?? "", ...(tool_calls ? { tool_calls } : {}) };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(ollama ? { message, done: true } : { choices: [{ message }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    aborted: () => aborted,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

// The tool messages the model got in its nth request, by call id.
const toolMessages = (body: any) => (body.messages as any[]).filter((m) => m.role === "tool");

async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

// The extension bridge as the session's browser: handler(method, params).
type Browser = (method: string, params: any) => any;
function useBrowser(handler: Browser) {
  const calls: Array<[string, any]> = [];
  const orig = extBridge.call;
  (extBridge as any).call = async (method: string, params: any) => {
    calls.push([method, params]);
    return handler(method, params);
  };
  return { calls, restore: () => ((extBridge as any).call = orig) };
}

const quietBrowser: Browser = (method) => (method === "agent_tabs" || method === "tabs_context" ? { tabs: [] } : {});

// A Session on the local backend, its agent loop running.
function localSession(modelUrl: string, setup?: (s: Session) => void) {
  process.env.CLEARCART_PROVIDER = "local";
  process.env.CLEARCART_LOCAL_URL = modelUrl;
  process.env.CLEARCART_LOCAL_MODEL = "tiny:1b";
  const sent: ServerMessage[] = [];
  const s = new Session((m) => sent.push(m));
  s.pageContext = null;
  s.lookup = async (host) => [{ address: /rebind/.test(host) ? "127.0.0.1" : "93.184.215.14" }];
  setup?.(s);
  const done = s.run();
  return {
    s,
    sent,
    spoken: () => sent.filter((m) => m.type === "agent_text").map((m: any) => m.text as string),
    statuses: () => sent.filter((m) => m.type === "status").map((m: any) => m.text as string),
    stop: async () => {
      s.close();
      await done;
    },
  };
}

function resetEnv() {
  delete process.env.CLEARCART_PROVIDER;
  delete process.env.CLEARCART_LOCAL_URL;
  delete process.env.CLEARCART_LOCAL_MODEL;
}

test("a tool call loop: the call runs over the bridge, its result goes back, the answer is spoken", async () => {
  const model = await fakeModel((_b, n) => (n === 1 ? { calls: [{ name: "navigate", args: { tabId: 5, url: "https://www.etsy.com/search?q=mug" } }] } : { text: "Found three mugs." }));
  const br = useBrowser((method, p) => {
    if (method === "navigate") return { tabId: p.tabId, url: p.url, title: "Mugs on Etsy" };
    if (method === "agent_tabs") return { tabs: [{ tabId: 5, url: "https://www.etsy.com/search?q=mug" }] };
    return {};
  });
  const r = localSession(model.url);
  try {
    r.s.userText("find me a mug");
    await until(() => r.spoken().length > 0, "the reply");
    assert.deepEqual(r.spoken(), ["Found three mugs."]);
    const [first, second] = model.requests;
    assert.equal(first.model, "tiny:1b");
    assert.deepEqual(first.tools.map((t: any) => t.function.name).sort(), [...EXT_ALLOWED_SHORT].sort(), "every allowed tool, by its short name, nothing else");
    assert.equal(first.tools.find((t: any) => t.function.name === "navigate").function.parameters.required.includes("url"), true, "zod schemas become JSON Schema");
    assert.equal(first.messages[0].role, "system");
    assert.match(first.messages[0].content, /^You are Clearcart/);
    assert.deepEqual(first.messages.at(-1), { role: "user", content: "find me a mug" });
    assert.deepEqual(br.calls.find((c) => c[0] === "navigate"), ["navigate", { tabId: 5, url: "https://www.etsy.com/search?q=mug" }]);
    const [result] = toolMessages(second);
    assert.equal(result.tool_call_id, "call_1_0");
    assert.match(result.content, /Mugs on Etsy/);
    assert.ok(r.statuses().includes("navigate https://www.etsy.com/search?q=mug"), "tool status as on the SDK path");
    assert.ok(r.statuses().some((t) => /^agent ready \(browser: connected, clearcart: connected\)/.test(t)));
    await until(() => (r.s as any).turnsOpen === 0, "the turn closed");
  } finally {
    await r.stop();
    br.restore();
    await model.close();
    resetEnv();
  }
});

test("Ollama: its own /api/chat with a context window that fits the rules and tools; a tool call written as text is not spoken", async () => {
  const model = await fakeModel(
    (_b, n) => (n === 1 ? { calls: [{ name: "get_page_text", args: { tabId: 9 } }] } : n === 2 ? { text: "The first line is Trip plan." } : { text: '{"type":"function","name":"say","parameters{"text":"hello"}}' }),
    { ollama: true }
  );
  const br = useBrowser((method, p) => (method === "get_page_text" ? { url: "https://docs.google.com/document/d/1AbC/edit", title: "Trip plan - Google Docs", text: "Trip plan\nDay 1: Lisbon" } : quietBrowser(method, p)));
  const r = localSession(model.url);
  try {
    r.s.userText("what does the first line of this doc say?");
    await until(() => r.spoken().length > 0, "the reply");
    assert.deepEqual(r.spoken(), ["The first line is Trip plan."]);
    const [first, second] = model.requests;
    assert.equal(first.options.num_ctx, 16384);
    assert.equal(first.stream, false);
    assert.ok(first.tools.some((t: any) => t.function.name === "get_page_text"));
    const call = second.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
    assert.deepEqual(call.tool_calls[0].function, { name: "get_page_text", arguments: { tabId: 9 } }, "arguments as an object");
    const result = second.messages.find((m: any) => m.role === "tool");
    assert.equal(result.tool_name, "get_page_text");
    assert.match(result.content, /Trip plan/);
    r.s.userText("say hello");
    await until(() => r.spoken().length > 1, "the second reply");
    assert.equal(r.spoken()[1], "Sorry, I got stuck on that. Could you ask me another way?");
    assert.ok(r.statuses().includes("local model wrote a tool call as text instead of making it; not spoken"));
  } finally {
    await r.stop();
    br.restore();
    await model.close();
    resetEnv();
  }
});

test("a guard deny: the reason is the tool result and the tool never runs", async () => {
  const model = await fakeModel((_b, n) => (n === 1 ? { calls: [{ name: "navigate", args: { url: "https://mail.google.com/mail/u/0" } }] } : { text: "That site is blocked." }));
  const br = useBrowser(quietBrowser);
  const r = localSession(model.url);
  try {
    r.s.userText("check my email");
    await until(() => r.spoken().length > 0, "the reply");
    assert.ok(!br.calls.some((c) => c[0] === "navigate"), "nothing reached the browser");
    assert.match(toolMessages(model.requests[1])[0].content, /^Blocked: Clearcart does not open https:\/\/mail\.google\.com/);
  } finally {
    await r.stop();
    br.restore();
    await model.close();
    resetEnv();
  }
});

test("post hooks: the tab sweep runs after the call and its note reaches the model", async () => {
  const model = await fakeModel((_b, n) => (n === 1 ? { calls: [{ name: "click", args: { ref: "ref_3", tabId: 9 } }] } : { text: "Done." }));
  let tab9 = "https://mail.google.com/";
  const br = useBrowser((method, p) => {
    if (method === "rect") return { x: 10, y: 10, width: 20, height: 20 };
    if (method === "agent_tabs") return { tabs: [{ tabId: 9, url: tab9 }] };
    if (method === "navigate") return { url: (tab9 = p.url === "back" ? "https://www.etsy.com/" : p.url) };
    return {};
  });
  const r = localSession(model.url);
  try {
    r.s.userText("press it");
    await until(() => r.spoken().length > 0, "the reply");
    assert.deepEqual(br.calls.filter((c) => c[0] === "navigate").map((c) => c[1]), [{ url: "back", tabId: 9 }], "the stray tab was sent back");
    const content = toolMessages(model.requests[1])[0].content;
    assert.match(content, /"ok":true/);
    assert.match(content, /A tab opened a blocked site or a checkout page and was sent back/);
    assert.ok(r.statuses().includes("returned 1 tab(s) from blocked sites"));
  } finally {
    await r.stop();
    br.restore();
    await model.close();
    resetEnv();
  }
});

test("interrupt: the request in flight is aborted, the turn ends, a running tool is not waited for, the next turn speaks", async () => {
  let release: (v: unknown) => void = () => {};
  const model = await fakeModel((_b, n) => {
    if (n === 1) return { hang: true };
    if (n === 2) return { calls: [{ name: "navigate", args: { tabId: 4, url: "https://www.etsy.com/" } }] };
    return { text: "Hello again." };
  });
  const br = useBrowser((method, p) => {
    if (method === "navigate") return new Promise((r) => (release = () => r({ tabId: 4, url: p.url })));
    return quietBrowser(method, p);
  });
  const r = localSession(model.url);
  const ended = () => r.statuses().filter((t) => t === "turn ended: error_during_execution").length;
  try {
    r.s.userText("find allergy pills");
    await until(() => model.requests.length === 1, "the first request");
    r.s.interrupt();
    await until(() => model.aborted() === 1 && ended() === 1, "the aborted request and the turn's end");
    assert.deepEqual(r.spoken(), []);
    assert.equal((r.s as any).muted, false, "the next turn speaks again");

    r.s.userText("open etsy");
    await until(() => br.calls.some((c) => c[0] === "navigate"), "the navigate call");
    r.s.interrupt();
    await until(() => ended() === 2, "the second turn's end, without waiting for navigate");
    r.s.userText("hi");
    await until(() => r.spoken().length > 0, "the reply");
    assert.deepEqual(r.spoken(), ["Hello again."]);
    const msgs = model.requests[2].messages.slice(1).map((m: any) => `${m.role}: ${typeof m.content === "string" ? m.content : "[parts]"}`);
    assert.deepEqual(msgs, [
      "user: find allergy pills",
      "assistant: (Stopped: the user interrupted.)",
      "user: open etsy",
      "assistant: ",
      "tool: Interrupted by the user before this finished. It may or may not have happened; check before doing it again.",
      "assistant: (Stopped: the user interrupted.)",
      "user: hi",
    ]);
    const sweeps = br.calls.filter((c) => c[0] === "agent_tabs").length;
    release(null);
    await until(() => br.calls.filter((c) => c[0] === "agent_tabs").length > sweeps, "the sweep for the cut-off navigate");
  } finally {
    await r.stop();
    br.restore();
    await model.close();
    resetEnv();
  }
});

test("endpoint down, a missing model, a model without tools: a short spoken line and the turn ends cleanly", async () => {
  const br = useBrowser(quietBrowser);
  const port = await closedPort();
  const down = localSession(`http://127.0.0.1:${port}/v1`);
  try {
    down.s.userText("hello");
    await until(() => down.spoken().length === 1, "the spoken error");
    assert.match(down.spoken()[0], new RegExp(`^I can't reach your local model at 127\\.0\\.0\\.1:${port}\\.`));
    assert.ok(down.statuses().some((t) => /^local model error: cannot reach/.test(t)));
    await until(() => (down.s as any).turnsOpen === 0, "the turn closed");
    down.s.userText("hello again");
    await until(() => down.spoken().length === 2, "the loop is still there for the next turn");
  } finally {
    await down.stop();
  }
  const errors = await fakeModel((_b, n) =>
    n === 1
      ? { status: 404, body: { error: { message: 'model "tiny:1b" not found, try pulling it first' } } }
      : { status: 400, body: { error: { message: "registry.ollama.ai/library/tiny:1b does not support tools" } } }
  );
  const r = localSession(errors.url);
  try {
    r.s.userText("hello");
    await until(() => r.spoken().length === 1, "the first error");
    assert.match(r.spoken()[0], /doesn't have tiny:1b/);
    r.s.userText("hello");
    await until(() => r.spoken().length === 2, "the second error");
    assert.match(r.spoken()[1], /^The model tiny:1b can't use tools/);
  } finally {
    await r.stop();
    br.restore();
    await errors.close();
    resetEnv();
  }
});

test("max steps: a model that keeps calling tools is stopped after 25 calls", async () => {
  const model = await fakeModel(() => ({ calls: [{ name: "tabs_context" }] }));
  const br = useBrowser(quietBrowser);
  const r = localSession(model.url);
  try {
    r.s.userText("loop forever");
    await until(() => r.spoken().length > 0, "the stop line");
    assert.match(r.spoken()[0], /too many steps/);
    assert.ok(r.statuses().includes("turn ended: error_max_turns"));
    await tick(50);
    assert.equal(model.requests.length, 25);
  } finally {
    await r.stop();
    br.restore();
    await model.close();
    resetEnv();
  }
});

// The SDK path's decision for a tool call: the SDK refuses a tool outside
// allowedTools or inside disallowedTools (dontAsk), then runs the
// PreToolUse hooks with this input shape (sdk.d.ts PreToolUseHookInput).
async function sdkDecision(s: Session, tool: string, args: Record<string, unknown>): Promise<string | null> {
  const allowed: string[] = EXT_ALLOWED_SHORT.map((t) => (["say", "request_checkout", "pay_now", "request_unlock", "remember", "forget", "recall"].includes(t) ? C : B) + t);
  if (!allowed.includes(tool) || DISALLOWED_BROWSER.includes(tool)) return "not allowed";
  for (const m of s.hooks().PreToolUse!) {
    for (const h of m.hooks) {
      const out: any = await h({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: args, tool_use_id: "toolu_1", session_id: "s", transcript_path: "", cwd: "" } as any, "toolu_1", { signal: new AbortController().signal });
      if (out?.hookSpecificOutput?.permissionDecision === "deny") return String(out.hookSpecificOutput.permissionDecisionReason);
    }
  }
  return null;
}

type Case = { name: string; tool: string; args?: Record<string, unknown>; setup?: (s: Session) => void; danger?: boolean; browser?: Browser; ran?: string };
const CASES: Case[] = [
  { name: "navigate to a store", tool: B + "navigate", args: { tabId: 3, url: "https://www.etsy.com/" } },
  { name: "navigate to a blocked site", tool: B + "navigate", args: { url: "https://mail.google.com/" } },
  { name: "navigate to this computer", tool: B + "navigate", args: { url: "http://localhost:5050/" } },
  { name: "navigate to a name that resolves here", tool: B + "navigate", args: { url: "http://rebind.example/" } },
  { name: "navigate to a checkout page off the store", tool: B + "navigate", args: { url: "https://www.etsy.com/cart/checkout" } },
  { name: "the same checkout page in Danger mode", tool: B + "navigate", args: { url: "https://www.etsy.com/cart/checkout" }, danger: true },
  { name: "navigate to a Google Doc", tool: B + "navigate", args: { tabId: 3, url: "https://docs.google.com/document/d/1AbC/edit" } },
  { name: "type into a Google Doc", tool: B + "type", args: { tabId: 3, text: "book the hotel" } },
  { name: "the Google sign-in page a doc sends you to", tool: B + "navigate", args: { url: "https://accounts.google.com/ServiceLogin?continue=https://docs.google.com/" } },
  { name: "tabs_create on a blocked site", tool: B + "tabs_create", args: { url: "https://accounts.google.com/" } },
  { name: "tabs_create with no url", tool: B + "tabs_create", args: {} },
  { name: "screenshot while card details are in the form", tool: B + "screenshot", setup: (s) => ((s as any).state.cardFieldsLive = true) },
  { name: "read_page while card details are in the form", tool: B + "read_page", setup: (s) => ((s as any).state.cardFieldsLive = true) },
  { name: "tabs_context while card details are in the form", tool: B + "tabs_context", setup: (s) => ((s as any).state.cardFieldsLive = true) },
  {
    name: "read_page while the tab sweep is broken",
    tool: B + "read_page",
    setup: (s) => ((s as any).sweepBroken = true),
    browser: (m, p) => (m === "agent_tabs" ? Promise.reject(new Error("bridge down")) : quietBrowser(m, p)),
  },
  { name: "the say tool", tool: C + "say", args: { text: "Looking now." }, ran: "say" },
  { name: "javascript_tool (never allowed)", tool: B + "javascript_tool", args: { text: "1" } },
  { name: "a made-up tool", tool: B + "delete_everything" },
];

test("parity: the same tool calls get the same allow or deny on the SDK hook path and in the local loop", async () => {
  let current: Case = CASES[0];
  const model = await fakeModel((_b, n) => (n % 2 === 1 ? { calls: [{ name: current.tool.replace(/^mcp__(browser|clearcart)__/, ""), args: current.args ?? {} }] } : { text: "ok" }));
  try {
    for (const c of CASES) {
      current = c;
      const was = (extBridge as any).danger;
      (extBridge as any).danger = !!c.danger;
      const br = useBrowser(c.browser ?? quietBrowser);
      try {
        const sdk = new Session(() => {});
        sdk.lookup = async (host) => [{ address: /rebind/.test(host) ? "127.0.0.1" : "93.184.215.14" }];
        c.setup?.(sdk);
        const sdkDeny = await sdkDecision(sdk, c.tool, c.args ?? {});
        br.calls.length = 0;

        const before = model.requests.length;
        const r = localSession(model.url, c.setup);
        try {
          r.s.userText("go");
          await until(() => model.requests.length === before + 2 && (r.s as any).turnsOpen === 0, `${c.name}: the turn`);
          const short = c.tool.replace(/^mcp__(browser|clearcart)__/, "");
          const ran = c.ran === "say" ? r.spoken().includes("Looking now.") : br.calls.some((x) => x[0] === short);
          const reply = toolMessages(model.requests[before + 1])[0].content as string;
          assert.equal(ran, sdkDeny === null, `${c.name}: SDK path ${sdkDeny === null ? "allows" : "denies"}, local loop ${ran ? "ran it" : "did not"}`);
          if (sdkDeny === "not allowed") assert.match(reply, /^Error: No such tool available/, c.name);
          else if (sdkDeny) assert.equal(reply, sdkDeny, `${c.name}: the same reason`);
        } finally {
          await r.stop();
        }
      } finally {
        br.restore();
        (extBridge as any).danger = was;
      }
    }
  } finally {
    await model.close();
    resetEnv();
  }
});

test("extension settings: provider, a loopback-only base URL and a safe model name, with a change event", async () => {
  assert.equal(parseLocalBaseUrl("http://localhost:11434"), "http://localhost:11434/v1");
  assert.equal(parseLocalBaseUrl("HTTP://LOCALHOST:11434/v1/"), "http://localhost:11434/v1");
  assert.equal(parseLocalBaseUrl("http://[::1]:1234/v1"), "http://[::1]:1234/v1");
  assert.equal(parseLocalModel("hf.co/org/model:Q4_K_M"), "hf.co/org/model:Q4_K_M");
  assert.throws(() => envProviderSettings({ CLEARCART_LOCAL_URL: "https://api.openai.com/v1" }), /CLEARCART_LOCAL_URL/);
  assert.throws(() => envProviderSettings({ CLEARCART_PROVIDER: "gpt" }), /CLEARCART_PROVIDER/);
  assert.deepEqual(envProviderSettings({}), { provider: "claude", localBaseUrl: "http://localhost:11434/v1", localModel: "llama3.1:8b", localVision: false });

  const b = await startBridge();
  try {
    const ext = new FakeExt(b.url);
    await ext.open();
    const send = (extra: Record<string, unknown>) => ext.ws.send(JSON.stringify({ type: "settings", guidedMode: true, memory: true, ...extra }));
    assert.deepEqual(b.bridge.providerSettings(), { provider: null, localBaseUrl: null, localModel: null, localVision: null }, "nothing until the extension says");
    let changed = onceEvent(b.bridge, "provider");
    send({ provider: "local", localBaseUrl: "http://127.0.0.1:1234/v1/", localModel: "qwen2.5:7b" });
    assert.deepEqual(await changed, { provider: "local", localBaseUrl: "http://127.0.0.1:1234/v1", localModel: "qwen2.5:7b", localVision: null });
    let events = 0;
    b.bridge.on("provider", () => events++);
    for (const localBaseUrl of ["https://api.openai.com/v1", "http://localhost.evil.example/v1", "http://localhost@evil.example/v1", "http://localhost./v1", "http://[::ffff:127.0.0.1]:11434/v1", "http://192.168.1.5:11434/v1", "file:///etc/passwd", "http://localhost:11434/v1?x=1", "http://localhost:11434//evil.example/v1", 42]) {
      send({ provider: "local", localBaseUrl, localModel: "qwen2.5:7b" });
    }
    for (const localModel of ["llama; rm -rf /", "../../etc/passwd", "a".repeat(200), "", 7]) send({ provider: "local", localModel });
    for (const provider of ["openai", true, null]) send({ provider });
    await ext.ping();
    assert.equal(events, 0, "every bad value refused, nothing changed");
    assert.deepEqual(b.bridge.providerSettings(), { provider: "local", localBaseUrl: "http://127.0.0.1:1234/v1", localModel: "qwen2.5:7b", localVision: null });
    changed = onceEvent(b.bridge, "provider");
    send({ provider: "claude", localBaseUrl: "http://127.0.0.1:1234/v1", localModel: "qwen2.5:7b" });
    assert.equal((await changed).provider, "claude");
    send({ provider: "claude", localBaseUrl: "http://127.0.0.1:1234/v1", localModel: "qwen2.5:7b" });
    await ext.ping();
    assert.equal(events, 1, "the same settings again are not a change");
    assert.equal(b.bridge.guidedMode(), true, "guided mode and memory parse as before");
    ext.close();
  } finally {
    await b.stop();
  }
});

test("switching the provider retires the session like a hand-off: a waiting read-back is declined, an unused yes withdrawn", async () => {
  const made: Session[] = [];
  const hub = new SessionHub((send) => {
    const s = new Session(send);
    s.backend = "claude";
    made.push(s);
    return s;
  });
  const got: HubMessage[] = [];
  const peer = hub.join((m) => got.push(m));
  peer.userText("buy the advil");
  const done = made[0].requestCheckout({ item: "Advil 50 count", quantity: 1, total: "$14.27" });
  await tick();
  assert.ok(got.some((m) => m.type === "confirm"));
  assert.equal(hub.switchBackend("claude"), false, "the same backend: nothing to do");
  assert.equal(hub.switchBackend("local http://localhost:11434/v1 llama3.1:8b", "your local model llama3.1:8b"), true);
  const r = await done;
  assert.match(r.content[0].text, /^declined\. No answer came/);
  assert.ok(got.some((m) => m.type === "confirm_done" && m.outcome === "declined"), "the read-back card is cleared");
  assert.ok(got.some((m) => m.type === "status" && m.text === "Switched to your local model llama3.1:8b. Starting a new conversation."));
  assert.equal(made.length, 2, "a fresh session on the new backend");
  assert.equal(claimConfirmation((made[0] as any).state).ok, false);
  peer.userText("yes");
  assert.equal((made[1] as any).state.confirmation, null, "the yes reaches the new session, which has nothing to confirm");

  // A yes already given but not used by pay_now is withdrawn too.
  made[1].backend = "local x";
  const s = made[1];
  const paid = s.requestCheckout({ item: "Advil 50 count", quantity: 1, total: "$14.27" });
  await tick();
  peer.userText("yes");
  assert.match((await paid).content[0].text, /^confirmed/);
  assert.equal((s as any).state.confirmation.state, "confirmed");
  hub.switchBackend("claude", "Claude");
  assert.equal(claimConfirmation((s as any).state).ok, false, "pay_now has nothing to use");
  assert.equal(made.length, 3);
  peer.leave();
});

// GET /local-models on the real server (echo mode, spare port).
const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_ORIGIN = "chrome-extension://dhgknfenfoidnchmjfaicafhieepefoc";

async function startServer(port: number, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(path.join(AGENT, "node_modules", ".bin", "tsx"), ["server.ts"], {
    cwd: AGENT,
    env: { ...process.env, CLEARCART_BROWSER: "", CLEARCART_VOICE: "false", ...env, AGENT_PORT: String(port), AGENT_MODE: "echo" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 15_000);
    child.stdout!.on("data", (d) => String(d).includes("Clearcart agent on") && (clearTimeout(t), resolve()));
    child.once("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  return child;
}

function get(port: number, pathname: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        let parsed: any = body;
        try {
          parsed = JSON.parse(body);
        } catch {}
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.once("error", reject);
    req.end();
  });
}

test("GET /local-models: the extension gets the model list; other origins, foreign hosts and remote URLs are refused", async () => {
  const model = await fakeModel(() => ({ text: "" }));
  const port = 5177;
  const child = await startServer(port, { CLEARCART_LOCAL_URL: model.url });
  try {
    const ok = await get(port, "/local-models", { Origin: EXT_ORIGIN });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true, connected: true, baseUrl: model.url, models: [{ id: "tiny:1b", tools: true }], current: "llama3.1:8b" });
    for (const h of [{}, { Origin: "https://evil.example" }, { Origin: EXT_ORIGIN, Host: `evil.example:${port}` }]) {
      assert.equal((await get(port, "/local-models", h)).status, 403, JSON.stringify(h));
    }
    assert.equal((await get(port, "/local-models", { Origin: EXT_ORIGIN }, "POST")).status, 405);
    for (const u of ["https://api.openai.com/v1", "http://10.0.0.2:11434/v1", "http://localhost@evil.example/"]) {
      assert.equal((await get(port, `/local-models?baseUrl=${encodeURIComponent(u)}`, { Origin: EXT_ORIGIN })).status, 400, u);
    }
    const down = await get(port, `/local-models?baseUrl=${encodeURIComponent(`http://127.0.0.1:${await closedPort()}/v1`)}`, { Origin: EXT_ORIGIN });
    assert.equal(down.status, 502);
    assert.equal(down.body.connected, false);
    assert.match(down.body.error, /^I can't reach your local model/);
  } finally {
    child.kill();
    await model.close();
  }
});
