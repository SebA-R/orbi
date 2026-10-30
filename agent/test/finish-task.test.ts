// Doing the whole task: the prompt asks Orbi to decide with the user's
// criteria, the Stop hook sends a task turn that ends on a question halfway
// back to work once, and remember waits with its question until the task is done.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryStore } from "../memory.ts";
import { buildSystemPrompt, GUIDED_PROMPT, MEMORY_PROMPT, SEARCH_PROMPT, sitesPrompt, SYSTEM_PROMPT } from "../prompt.ts";
import { FINISH_TASK, SAID_BEFORE, Session, type ServerMessage } from "../session.ts";

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
const toolResult = (tool_use_id: string) => ({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id, content: "ok" }] } }) as any;
// A browser tool call and its result.
const browse = (s: Session, name = "mcp__browser__navigate") => {
  const m = toolCall(name);
  s.onSdkMessage(m);
  s.onSdkMessage(toolResult(m.message.content[0].id));
};
const result = () => ({ type: "result", subtype: "success" }) as any;
const stop = (s: Session, last: string, active = false) =>
  (s as any).finishTask({ hook_event_name: "Stop", stop_hook_active: active, last_assistant_message: last, session_id: "x", transcript_path: "", cwd: "" }, undefined, { signal: new AbortController().signal });
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");
const tick = () => new Promise((r) => setImmediate(r));

test("prompt: do the whole task, decide with the user's criteria, keep confirmations", () => {
  assert.match(SYSTEM_PROMPT, /\nDoing the whole task\n/);
  assert.match(SYSTEM_PROMPT, /do all of it in one turn/);
  assert.match(SYSTEM_PROMPT, /pick the best match, choose its size and colour, and add it to the cart/);
  assert.match(SYSTEM_PROMPT, /decide it from a saved fact \(their clothing size, a favorite brand\) or their criteria/);
  assert.match(SYSTEM_PROMPT, /A size or fit that no saved fact or criterion gives is something only the user knows: ask for it once/);
  assert.doesNotMatch(SYSTEM_PROMPT, /most sensible choice/);
  assert.match(SYSTEM_PROMPT, /ask it before you start, not halfway through/);
  assert.match(SYSTEM_PROMPT, /call say with a few words.*instead of ending your turn/);
  assert.match(SYSTEM_PROMPT, /never skips a confirmation a tool or rule asks for: the checkout read-back, request_unlock's question, or a confirmation before sending a message/);
  assert.match(SYSTEM_PROMPT, /Never guess or make up personal details\. Choosing a product option .* is not guessing; do it\. Picking a size neither gives is\./);
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
  browse(s, "mcp__browser__navigate");
  s.onSdkMessage(reply("Which one do you want, the Smart Ankle or the Ultra Stretch?"));
  const out = await stop(s, "Which one do you want, the Smart Ankle or the Ultra Stretch?");
  assert.deepEqual(out, { decision: "block", reason: FINISH_TASK });
  // Only once per turn: the next stop goes through.
  browse(s, "mcp__browser__click");
  s.onSdkMessage(reply("Which colour, black or navy?"));
  assert.deepEqual(await stop(s, "Which colour, black or navy?"), {});
  s.onSdkMessage(result());
  assert.deepEqual(spoken(), ["Which colour, black or navy?"]);
  assert.ok(sent.some((m) => m.type === "status" && /not spoken\) Which one do you want/.test(m.text)));
  s.close();
});

test("Stop hook: the held question is dropped even when its message comes after the hook", async () => {
  const { s, spoken } = setup();
  s.userText("buy me black pants under fifty dollars");
  browse(s, "mcp__browser__navigate");
  assert.equal((await stop(s, "Which pair do you want?")).decision, "block");
  s.onSdkMessage(reply("Which pair do you want?"));
  browse(s, "mcp__browser__click");
  s.onSdkMessage(reply("Added the Smart Ankle Pants in black, size medium, to your cart."));
  s.onSdkMessage(result());
  assert.deepEqual(spoken(), ["Added the Smart Ankle Pants in black, size medium, to your cart."]);
  s.close();
});

test("Stop hook: lets the turn end when it should", async () => {
  const cases: Array<[string, (s: Session) => void, string]> = [
    ["not a question", (s) => { s.userText("buy me black pants"); browse(s, "mcp__browser__navigate"); }, "Added the black pants to your cart."],
    ["no browsing yet (asking before starting)", (s) => { s.userText("buy me pants"); }, "Which store should I use?"],
    ["the user asked a question", (s) => { s.userText("what pants do they have?"); browse(s, "mcp__browser__navigate"); }, "Want me to read more?"],
    ["after request_checkout", (s) => { s.userText("check out and pay"); browse(s, "mcp__browser__navigate"); s.onSdkMessage(toolCall("mcp__clearcart__request_checkout")); }, "What should I change?"],
    ["after request_unlock", (s) => { s.userText("sign me in please"); browse(s, "mcp__browser__navigate"); s.onSdkMessage(toolCall("mcp__clearcart__request_unlock")); }, "Is your password in?"],
    ["after a desktop tool", (s) => { s.userText("message Sam the link"); browse(s, "mcp__browser__navigate"); s.onSdkMessage(toolCall("mcp__desktop__desktop_type")); }, "Send it to Sam?"],
    ["interrupted", (s) => { s.userText("buy me pants"); browse(s, "mcp__browser__navigate"); s.interrupt(); }, "Which pair?"],
    ["a size only the user knows", (s) => { s.userText("buy me black pants"); browse(s); }, "I found the Smart Ankle Pants in black. Which size do you wear?"],
    ["the offer that closes a finished task", (s) => { s.userText("add the black pants to my cart"); browse(s); }, "Added the black pants to your cart. Want a matching belt too?"],
    ["more to read after a summary", (s) => { s.userText("read me the reviews"); browse(s); }, "Most reviews say they run small and wash well. Want me to read more?"],
    ["a read-only desktop tool ran, then a check-in", (s) => { s.userText("message Sam the link"); browse(s); s.onSdkMessage(toolCall("mcp__desktop__desktop_type")); }, "Which Sam, Sam Lee or Sam Park?"],
  ];
  for (const [name, arrange, last] of cases) {
    const { s } = setup();
    arrange(s);
    assert.deepEqual(await stop(s, last), {}, name);
    s.close();
  }
  const { s } = setup();
  s.userText("buy me pants");
  browse(s, "mcp__browser__navigate");
  assert.deepEqual(await stop(s, "Which pair?", true), {}, "stop_hook_active");
  s.close();
});

test("Stop hook: a size the user's saved facts give is decided, not asked; a read-only desktop tool asks nothing", async () => {
  const { s, memory } = setup();
  memory.add("you wear a medium");
  s.userText("buy me black pants");
  browse(s);
  assert.equal((await stop(s, "Which size, small or medium?")).decision, "block");
  s.close();
  const d = setup();
  d.s.userText("buy me black pants");
  browse(d.s);
  d.s.onSdkMessage(toolCall("mcp__desktop__desktop_frontmost"));
  d.s.onSdkMessage(toolCall("mcp__desktop__desktop_read"));
  assert.equal((await stop(d.s, "Which pair do you want?")).decision, "block");
  d.s.close();
});

test("Stop hook: what came before the question is still said", async () => {
  const { s, spoken } = setup();
  s.userText("buy me black pants under fifty dollars");
  browse(s);
  const out = await stop(s, "I found the Smart Ankle and the Ultra Stretch, both under fifty. Which one do you want?");
  assert.deepEqual(out, { decision: "block", reason: `${FINISH_TASK} ${SAID_BEFORE}` });
  assert.deepEqual(spoken(), ["I found the Smart Ankle and the Ultra Stretch, both under fifty."]);
  s.onSdkMessage(reply("I found the Smart Ankle and the Ultra Stretch, both under fifty. Which one do you want?"));
  browse(s, "mcp__browser__click");
  s.onSdkMessage(reply("Added the Smart Ankle to your cart."));
  s.onSdkMessage(result());
  assert.deepEqual(spoken(), ["I found the Smart Ankle and the Ultra Stretch, both under fifty.", "Added the Smart Ankle to your cart."]);
  s.close();
});

test("Stop hook: the turn's own words count, not a message queued mid-turn", async () => {
  const { s } = setup();
  s.userText("buy me black pants");
  browse(s);
  s.userText("thanks");
  assert.equal((await stop(s, "Which pair do you want?")).decision, "block");
  s.close();
});

test("an agent error ends the turn: the next turn starts afresh", async () => {
  const { s } = setup();
  s.userText("buy me black pants");
  browse(s);
  assert.equal((await stop(s, "Which pair do you want?")).decision, "block");
  await s.consume((async function* () {
    throw new Error("boom");
  })());
  assert.equal((s as any).turnNudged, false);
  assert.equal((s as any).turnBrowsed, false);
  assert.equal((s as any).dropText, "");
  s.close();
});

test("local ack: a first call refused before the guard passes the ack to the step's next call", () => {
  const { s } = setup();
  (s as any).serverAck = true;
  s.userText("open the jackets");
  s.onSdkMessage({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "a1", name: "mcp__browser__click", input: {} }, { type: "tool_use", id: "a2", name: "mcp__browser__find", input: {} }] } } as any);
  assert.equal((s as any).ackFor, "a1");
  s.onSdkMessage({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "Not run", is_error: true }] } } as any);
  assert.equal((s as any).ackFor, "a2");
  s.close();
});

test("Stop hook: a new turn can be sent back again; only the Claude hooks carry it", async () => {
  const { s } = setup();
  s.userText("buy me pants");
  browse(s, "mcp__browser__navigate");
  assert.equal((await stop(s, "Which pair?")).decision, "block");
  s.onSdkMessage(reply("Done."));
  s.onSdkMessage(result());
  s.userText("now get a black belt too");
  browse(s, "mcp__browser__navigate");
  assert.equal((await stop(s, "Which belt, leather or canvas?")).decision, "block");
  assert.ok(!("Stop" in s.hooks()), "the shared hooks (local backend) have no Stop hook");
  assert.ok("Stop" in s.claudeHooks());
  s.close();
});

test("remember: no question mid-task; at the start of a turn it still asks", async () => {
  const { s, memory, spoken } = setup();
  s.userText("buy me black pants under fifty dollars");
  browse(s, "mcp__browser__navigate");
  const r = text(await s.remember({ fact: "you like black pants" }));
  assert.match(r, /^Not saved yet; don't ask now\. Finish the task first, then end your last reply with "Want me to remember that you like black pants\?"/);
  assert.deepEqual(spoken(), [], "nothing asked");
  assert.equal(memory.list().length, 0);
  // The user's own lasting fact still saves quietly mid-task.
  s.userText("I wear a medium, get the medium");
  browse(s, "mcp__browser__click");
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

test("Stop hook: polite questions count as tasks; Guided mode is left alone", async () => {
  const { s } = setup();
  s.userText("Can you find me black pants under $50?");
  browse(s);
  assert.equal((await stop(s, "Which pair?”")).decision, "block", "curly quote after the question mark");
  s.close();
  const g = setup();
  g.s.userText("find me headphones on amazon");
  g.s.guided = true; // as the model heard it with this turn
  browse(g.s);
  assert.deepEqual(await stop(g.s, "Which would you like?"), {});
  g.s.close();
});

test("Stop hook: every block of a late question is dropped, and a repeat later is spoken", async () => {
  const { s, spoken } = setup();
  s.userText("buy me black pants");
  browse(s);
  assert.equal((await stop(s, "Found three pairs. Which pair?")).decision, "block");
  s.onSdkMessage({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Found three pairs." }, { type: "text", text: "Which pair?" }] } } as any);
  s.onSdkMessage(reply("Which pair?"));
  s.onSdkMessage(result());
  assert.deepEqual(spoken(), ["Found three pairs.", "Which pair?"]);
  s.close();
});

test("Stop hook: a late question split across two messages is dropped; a later reply that is part of it is spoken", async () => {
  const { s, spoken } = setup();
  s.userText("buy me black pants");
  browse(s);
  assert.equal((await stop(s, "Which pair, the Smart Ankle or the Ultra Stretch?")).decision, "block");
  s.onSdkMessage(reply("Which pair,"));
  s.onSdkMessage(reply("the Smart Ankle or the Ultra Stretch?"));
  s.onSdkMessage(reply("Ultra Stretch"));
  s.onSdkMessage(result());
  assert.deepEqual(spoken(), ["Ultra Stretch"]);
  s.close();
});

test("remember mid-task: the question waits for the reply after the task, and a yes to it saves", async () => {
  const { s, memory, spoken } = setup();
  s.userText("buy me black pants under fifty dollars");
  browse(s);
  assert.match(text(await s.remember({ fact: "you like slim fits" })), /^Not saved yet/);
  s.onSdkMessage(reply("Added the Smart Ankle Pants to your cart. Want me to remember that you like slim fits?"));
  assert.deepEqual(await stop(s, "Added the Smart Ankle Pants to your cart. Want me to remember that you like slim fits?"), {}, "the offer after the task is not sent back");
  s.onSdkMessage(result());
  assert.equal(spoken().length, 1);
  s.userText("yes please");
  assert.match(text(await s.remember({ fact: "you like slim fits" })), /^Saved: you like slim fits\. The question was already spoken/);
  assert.equal(spoken().length, 1, "not asked again");
  assert.equal(memory.list().length, 1);
  s.close();

  // A yes to anything else, or a later yes, saves nothing without asking.
  const o = setup();
  o.s.userText("buy me black pants under fifty dollars");
  browse(o.s);
  await o.s.remember({ fact: "you like slim fits" });
  o.s.onSdkMessage(reply("Added the Smart Ankle Pants to your cart. Want a matching belt?"));
  o.s.onSdkMessage(result());
  o.s.userText("yes");
  const p = o.s.remember({ fact: "you like slim fits" });
  await tick();
  assert.equal(o.spoken().at(-1), "Want me to remember that you like slim fits?");
  o.s.userText("no");
  assert.match(text(await p), /^Not saved/);
  o.s.close();
});

test("remember mid-task in Guided mode asks as before (the Stop hook is off there)", async () => {
  const { s, spoken } = setup();
  s.userText("find me headphones on amazon");
  s.guided = true;
  browse(s);
  const p = s.remember({ fact: "you like over-ear headphones" });
  await tick();
  assert.deepEqual(spoken(), ["Want me to remember that you like over-ear headphones?"]);
  s.userText("yes");
  assert.match(text(await p), /^Saved/);
  s.close();
});

test("remember: in the same step as the first navigate it is still the start; an explicit ask still asks", async () => {
  const { s, spoken } = setup();
  s.userText("buy me pants from my usual store");
  const nav = toolCall("mcp__browser__navigate");
  s.onSdkMessage(nav);
  const p = s.remember({ fact: "you like Uniqlo" });
  await tick();
  assert.deepEqual(spoken(), ["Want me to remember that you like Uniqlo?"]);
  s.userText("no");
  await p;
  s.onSdkMessage(toolResult(nav.message.content[0].id));
  s.onSdkMessage(result());

  s.userText("remember I'm vegetarian and find me a meal kit");
  browse(s);
  const q = s.remember({ fact: "you don't eat meat" });
  await tick();
  assert.equal(spoken().at(-1), "Want me to remember that you don't eat meat?");
  s.userText("yes");
  assert.match(text(await q), /^Saved/);
  s.close();
});
