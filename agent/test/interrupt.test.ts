import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, type ServerMessage } from "../session.ts";

function session() {
  const sent: ServerMessage[] = [];
  return { s: new Session((m) => sent.push(m)), sent };
}

const reply = (text: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } }) as any;
const toolCall = (name: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", name, input: {} }] } }) as any;
const result = (subtype = "success") => ({ type: "result", subtype }) as any;
const spoken = (sent: ServerMessage[]) => sent.filter((m) => m.type === "agent_text").map((m) => (m as any).text);

test("interrupt drops held reply text; it is logged, not spoken", () => {
  const { s, sent } = session();
  s.userText("find allergy pills");
  s.onSdkMessage(reply("I found three options."));
  s.interrupt();
  s.onSdkMessage(result());
  assert.deepEqual(spoken(sent), []);
  assert.ok(sent.some((m) => m.type === "status" && /not spoken\) I found three options/.test(m.text)));
});

test("everything the interrupted turn says afterwards goes out as status only", () => {
  const { s, sent } = session();
  s.userText("find allergy pills");
  s.interrupt();
  s.onSdkMessage(toolCall("mcp__browser__navigate"));
  s.onSdkMessage(reply("Here is the cheapest."));
  s.onSdkMessage(result("error_during_execution"));
  assert.deepEqual(spoken(sent), []);
  assert.ok(sent.some((m) => m.type === "status" && /not spoken\) Here is the cheapest/.test(m.text)));
});

test("the next user_text after an interrupt starts a turn that is spoken", () => {
  const { s, sent } = session();
  s.userText("find allergy pills");
  s.interrupt();
  s.userText("actually, just the cheapest"); // queued behind the interrupted turn
  s.onSdkMessage(reply("Old answer."));
  s.onSdkMessage(result());
  s.onSdkMessage(reply("The cheapest is $9."));
  s.onSdkMessage(result());
  assert.deepEqual(spoken(sent), ["The cheapest is $9."]);
});

test("an interrupt with no turn running changes nothing", () => {
  const { s, sent } = session();
  s.interrupt();
  s.userText("hi");
  s.onSdkMessage(reply("Hello."));
  s.onSdkMessage(result());
  assert.deepEqual(spoken(sent), ["Hello."]);
});

test("an interrupt during the read-back does not confirm or cancel request_checkout", async () => {
  const { s, sent } = session();
  s.userText("buy it");
  const done = s.requestCheckout({ item: "Advil 50 count", quantity: 1, total: "$14.27" });
  await new Promise((r) => setImmediate(r));
  s.interrupt();
  let settled = false;
  void done.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "still waiting for a spoken answer");
  assert.equal((s as any).state.confirmation.state, "pending");
  assert.ok(!sent.some((m) => m.type === "status" && m.text === "checkout confirmed"));
  s.userText("no");
  const r = await done;
  assert.match(r.content[0].text, /^declined/);
});

test("request_checkout from an interrupted turn is declined without a read-back", async () => {
  const { s, sent } = session();
  s.userText("buy it");
  s.interrupt();
  const r = await s.requestCheckout({ item: "Advil", quantity: 1, total: "$9.00" });
  assert.match(r.content[0].text, /^declined/);
  assert.ok(!sent.some((m) => m.type === "confirm"));
  assert.equal((s as any).state.confirmation, null);
});

test("a say progress note from the interrupted turn is not spoken; the SDK turn is interrupted", () => {
  const { s, sent } = session();
  let interrupts = 0;
  (s as any).q = { interrupt: async () => { interrupts++; } };
  s.userText("find allergy pills");
  s.interrupt();
  (s as any).say("Adding it to your cart now.");
  s.onSdkMessage(result("error_during_execution"));
  assert.equal(interrupts, 1);
  assert.deepEqual(spoken(sent), []);
  assert.ok(sent.some((m) => m.type === "status" && /not spoken\) Adding it to your cart/.test(m.text)));
  s.userText("the cheapest one");
  (s as any).say("Looking now.");
  assert.deepEqual(spoken(sent), ["Looking now."], "the next turn speaks again");
});
