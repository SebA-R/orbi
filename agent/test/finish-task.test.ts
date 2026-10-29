// Doing the whole task: the prompt asks Orbi to decide with the user's
// criteria, the Stop hook sends a task turn that ends on a question halfway
// back to work once, and remember never asks a question mid-task.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryStore } from "../memory.ts";
import { buildSystemPrompt, GUIDED_PROMPT, MEMORY_PROMPT, SEARCH_PROMPT, sitesPrompt, SYSTEM_PROMPT } from "../prompt.ts";
import { FINISH_TASK, Session, type ServerMessage } from "../session.ts";

process.env.CLEARCART_MEMORY = "1";

function setup() {
  const sent: ServerMessage[] = [];
  const memory = new MemoryStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-finish-")), "memory.json"));
  const s = new Session((m) => sent.push(m), { memory });
  s.pageContext = null;
  (s as any).input = { push() {}, close() {} };
  const spoken = () => sent.filter((m) => m.type === "agent_text").map((m: any) => m.text);
  return { s, sent, memory, spoken };
}

const reply = (text: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } }) as any;
let id = 0;
const toolCall = (name: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: `t${++id}`, name, input: {} }] } }) as any;
const result = () => ({ type: "result", subtype: "success" }) as any;
const stop = (s: Session, last: string, active = false) =>
  (s as any).finishTask({ hook_event_name: "Stop", stop_hook_active: active, last_assistant_message: last, session_id: "x", transcript_path: "", cwd: "" }, undefined, { signal: new AbortController().signal });
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");
const tick = () => new Promise((r) => setImmediate(r));

test("prompt: do the whole task, decide with the user's criteria, keep confirmations", () => {
  assert.match(SYSTEM_PROMPT, /\nDoing the whole task\n/);
  assert.match(SYSTEM_PROMPT, /do all of it in one turn/);
  assert.match(SYSTEM_PROMPT, /pick the best match, choose its size and colour, and add it to the cart/);
  assert.match(SYSTEM_PROMPT, /use a saved fact/);
  assert.match(SYSTEM_PROMPT, /ask it before you start, not halfway through/);
  assert.match(SYSTEM_PROMPT, /call say with a few words.*instead of ending your turn/);
  assert.match(SYSTEM_PROMPT, /never skips a confirmation a tool or rule asks for: the checkout read-back, request_unlock's question, or a confirmation before sending a message/);
  assert.match(SYSTEM_PROMPT, /Never guess or make up personal details\. Choosing a product option .* is not guessing/);
  assert.match(SYSTEM_PROMPT, /never enter an address, card, email, phone number, password or other personal details; the user does that/);
  assert.match(sitesPrompt("open"), /Never start checkout on your own/);
  assert.match(sitesPrompt("open"), /end with "It's in your cart\. Say check out and I'll finish\."/);
  assert.match(GUIDED_PROMPT, /Then let the user choose, unless they already gave criteria to choose by; then choose and say which you picked and why in one sentence\./);
  assert.match(SEARCH_PROMPT, /unless the user already gave criteria to choose by; then choose and say which you picked and why/);
  assert.match(MEMORY_PROMPT, /Call remember at the start of the turn, before any other tool\./);
  assert.match(MEMORY_PROMPT, /Never remember one-off criteria for the task at hand/);
  assert.match(MEMORY_PROMPT, /When a choice depends on a saved fact \(size, brand, diet\), apply it without asking\./);
  assert.ok(!/—/.test(buildSystemPrompt({ guided: true }) + SEARCH_PROMPT + MEMORY_PROMPT), "no em dashes");
});

test("Stop hook: a task turn that ends on a question halfway is sent back once, unspoken", async () => {
  const { s, spoken, sent } = setup();
  s.userText("buy me black pants under fifty dollars on uniqlo");
  s.onSdkMessage(toolCall("mcp__browser__navigate"));
  s.onSdkMessage(reply("Which size would you like?"));
  const out = await stop(s, "Which size would you like?");
  assert.deepEqual(out, { decision: "block", reason: FINISH_TASK });
  // Only once per turn: the next stop goes through.
  s.onSdkMessage(toolCall("mcp__browser__click"));
  s.onSdkMessage(reply("Which colour, black or navy?"));
  assert.deepEqual(await stop(s, "Which colour, black or navy?"), {});
  s.onSdkMessage(result());
  assert.deepEqual(spoken(), ["Which colour, black or navy?"]);
  assert.ok(sent.some((m) => m.type === "status" && /not spoken\) Which size would you like\?/.test(m.text)));
  s.close();
});

test("Stop hook: the held question is dropped even when its message comes after the hook", async () => {
  const { s, spoken } = setup();
  s.userText("buy me black pants under fifty dollars");
  s.onSdkMessage(toolCall("mcp__browser__navigate"));
  assert.equal((await stop(s, "Which size?")).decision, "block");
  s.onSdkMessage(reply("Which size?"));
  s.onSdkMessage(toolCall("mcp__browser__click"));
  s.onSdkMessage(reply("Added the Smart Ankle Pants in black, size medium, to your cart."));
  s.onSdkMessage(result());
  assert.deepEqual(spoken(), ["Added the Smart Ankle Pants in black, size medium, to your cart."]);
  s.close();
});

test("Stop hook: lets the turn end when it should", async () => {
  const cases: Array<[string, (s: Session) => void, string]> = [
    ["not a question", (s) => { s.userText("buy me black pants"); s.onSdkMessage(toolCall("mcp__browser__navigate")); }, "Added the black pants to your cart."],
    ["no browsing yet (asking before starting)", (s) => { s.userText("buy me pants"); }, "Which store should I use?"],
    ["the user asked a question", (s) => { s.userText("what pants do they have?"); s.onSdkMessage(toolCall("mcp__browser__navigate")); }, "Want me to read more?"],
    ["after request_checkout", (s) => { s.userText("check out and pay"); s.onSdkMessage(toolCall("mcp__browser__navigate")); s.onSdkMessage(toolCall("mcp__clearcart__request_checkout")); }, "What should I change?"],
    ["after request_unlock", (s) => { s.userText("sign me in please"); s.onSdkMessage(toolCall("mcp__browser__navigate")); s.onSdkMessage(toolCall("mcp__clearcart__request_unlock")); }, "Is your password in?"],
    ["after a desktop tool", (s) => { s.userText("message Sam the link"); s.onSdkMessage(toolCall("mcp__browser__navigate")); s.onSdkMessage(toolCall("mcp__desktop__desktop_type")); }, "Send it to Sam?"],
    ["interrupted", (s) => { s.userText("buy me pants"); s.onSdkMessage(toolCall("mcp__browser__navigate")); s.interrupt(); }, "Which size?"],
  ];
  for (const [name, arrange, last] of cases) {
    const { s } = setup();
    arrange(s);
    assert.deepEqual(await stop(s, last), {}, name);
    s.close();
  }
  const { s } = setup();
  s.userText("buy me pants");
  s.onSdkMessage(toolCall("mcp__browser__navigate"));
  assert.deepEqual(await stop(s, "Which size?", true), {}, "stop_hook_active");
  s.close();
});

test("Stop hook: a new turn can be sent back again; only the Claude hooks carry it", async () => {
  const { s } = setup();
  s.userText("buy me pants");
  s.onSdkMessage(toolCall("mcp__browser__navigate"));
  assert.equal((await stop(s, "Which size?")).decision, "block");
  s.onSdkMessage(reply("Done."));
  s.onSdkMessage(result());
  s.userText("now get a black belt too");
  s.onSdkMessage(toolCall("mcp__browser__navigate"));
  assert.equal((await stop(s, "Which length?")).decision, "block");
  assert.ok(!("Stop" in s.hooks()), "the shared hooks (local backend) have no Stop hook");
  assert.ok("Stop" in s.claudeHooks());
  s.close();
});

test("remember: no question mid-task; at the start of a turn it still asks", async () => {
  const { s, memory, spoken } = setup();
  s.userText("buy me black pants under fifty dollars");
  s.onSdkMessage(toolCall("mcp__browser__navigate"));
  const r = text(await s.remember({ fact: "you like black pants" }));
  assert.match(r, /^Not saved; don't ask now\./);
  assert.deepEqual(spoken(), [], "nothing asked");
  assert.equal(memory.list().length, 0);
  // The user's own lasting fact still saves quietly mid-task.
  s.userText("I wear a medium, get the medium");
  s.onSdkMessage(toolCall("mcp__browser__click"));
  assert.match(text(await s.remember({ fact: "you wear a medium" })), /^Saved/);
  s.onSdkMessage(result());

  // Before any browsing, the question is asked as before.
  s.userText("buy me a blue hoodie");
  const p = s.remember({ fact: "you like blue" });
  await tick();
  assert.deepEqual(spoken(), ["Want me to remember that you like blue?"]);
  s.userText("no");
  assert.match(text(await p), /^Not saved/);
  s.close();
});
