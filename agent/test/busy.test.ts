import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, type ServerMessage } from "../session.ts";
import { SessionHub, type HubMessage } from "../hub.ts";

function session() {
  const sent: ServerMessage[] = [];
  const s = new Session((m) => sent.push(m));
  s.pageContext = null;
  return { s, sent, busy: () => sent.filter((m) => m.type === "busy") };
}

const reply = (text: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } }) as any;
const result = (subtype = "success") => ({ type: "result", subtype }) as any;
const kinds = (sent: ServerMessage[]) => sent.filter((m) => m.type === "busy" || m.type === "agent_text").map((m) => (m.type === "busy" ? `busy:${m.on}` : `say:${(m as any).text}`));

test("busy goes on with the user's words and off after the turn's reply", () => {
  const { s, sent } = session();
  s.userText("find socks");
  s.onSdkMessage(reply("Found three."));
  s.onSdkMessage(result());
  assert.deepEqual(kinds(sent), ["busy:true", "say:Found three.", "busy:false"]);
});

test("a spoken ack mid-turn does not end busy", () => {
  const { s, sent } = session();
  s.userText("find socks");
  (s as any).say("On it.");
  assert.deepEqual(kinds(sent), ["busy:true", "say:On it."]);
  s.onSdkMessage(result());
  assert.deepEqual(kinds(sent).at(-1), "busy:false");
});

test("words during a turn get their own ack; the first turn's end sends nothing stale, the last one ends it", () => {
  const { s, sent, busy } = session();
  s.userText("find socks");
  s.interrupt();
  s.userText("wool ones");
  assert.deepEqual(busy(), [{ type: "busy", on: true }, { type: "busy", on: true }]);
  s.onSdkMessage(result()); // the interrupted turn
  assert.equal(busy().length, 2, "still busy: no message");
  s.onSdkMessage(reply("Wool socks, $12."));
  s.onSdkMessage(result());
  assert.deepEqual(busy().at(-1), { type: "busy", on: false });
});

test("busy is off while a question waits for the user's answer, and on again once answered", async () => {
  const { s, busy } = session();
  s.userText("buy the mug");
  const done = s.requestCheckout({ item: "Blue mug", quantity: 1, total: "$14.27" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(busy().at(-1), { type: "busy", on: false }, "waiting for the yes");
  s.userText("no, wait");
  await done;
  assert.deepEqual(busy().at(-1), { type: "busy", on: true }, "the agent goes on with the answer");
  s.onSdkMessage(result());
  assert.deepEqual(busy().at(-1), { type: "busy", on: false });
});

test("an agent error ends the turn out loud and busy goes off", async () => {
  const { s, sent } = session();
  s.userText("find socks");
  async function* broken(): AsyncGenerator<any> {
    yield reply("thinking");
    throw new Error("socket hang up");
  }
  await s.consume(broken());
  assert.deepEqual(kinds(sent), ["busy:true", "say:Sorry, something went wrong on my side. Please try again.", "busy:false"]);
  assert.equal((s as any).turnsOpen, 0);
});

// A result naming the user messages it consumed (SDKResultMessage
// user_message_uuids), as the CLI sends it.
const resultFor = (uuids: string[]) => ({ type: "result", subtype: "success", user_message_uuids: uuids }) as any;
const pushed = (s: Session) => (s as any).sdkTurns as string[];

test("words folded into the running turn: its one result ends busy", () => {
  const { s, sent } = session();
  s.userText("find socks");
  s.userText("wool ones"); // queued while the first runs; the CLI folds it in
  const [a, b] = pushed(s);
  s.onSdkMessage(reply("Wool socks, $12."));
  s.onSdkMessage(resultFor([a, b]));
  assert.deepEqual(kinds(sent).at(-1), "busy:false");
  assert.equal((s as any).turnsOpen, 0);
});

test("a turn cut off without a result of its own is closed by the next one's", () => {
  const { s, sent } = session();
  s.userText("find socks");
  s.interrupt();
  s.userText("wool ones");
  const [, b] = pushed(s);
  s.onSdkMessage(resultFor([b])); // no result came for the first
  assert.deepEqual(kinds(sent).at(-1), "busy:false");
  assert.deepEqual(pushed(s), []);
});

test("a result for the first of two queued turns leaves busy on", () => {
  const { s, busy } = session();
  s.userText("find socks");
  s.userText("wool ones");
  const [a] = pushed(s);
  s.onSdkMessage(resultFor([a]));
  assert.deepEqual(busy().at(-1), { type: "busy", on: true });
  s.onSdkMessage(result()); // names none (a local model): one turn
  assert.deepEqual(busy().at(-1), { type: "busy", on: false });
});

test("a session closed mid-turn says busy off", () => {
  const { s, busy } = session();
  s.userText("find socks");
  s.close();
  assert.deepEqual(busy().at(-1), { type: "busy", on: false });
});

test("the hub stamps busy with the count of user_text that window sent, stale ones included", () => {
  let send: (m: ServerMessage) => void = () => {};
  const hub = new SessionHub((sendFn) => {
    send = sendFn;
    return { userText: () => send({ type: "busy", on: true }), interrupt() {}, handOff() {}, close() {} };
  });
  const a: HubMessage[] = [];
  const b: HubMessage[] = [];
  const pa = hub.join((m) => a.push(m));
  const pb = hub.join((m) => b.push(m));
  pa.userText("one");
  pb.userText("two"); // b takes it
  pa.userText("stale"); // dropped, but a counted it
  pb.userText("three");
  assert.deepEqual(b.filter((m) => m.type === "busy").map((m) => (m as any).seq), [1, 2]);
  pa.interrupt(); // a takes it back
  pa.userText("four");
  assert.deepEqual(a.filter((m) => m.type === "busy").map((m) => (m as any).seq), [1, 3]);
});
