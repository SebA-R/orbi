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
const kinds = (sent: ServerMessage[]) => sent.filter((m) => m.type === "busy" || m.type === "agent_text").map((m) => (m.type === "busy" ? `busy:${m.on}:${m.seq}` : `say:${(m as any).text}`));

test("busy goes on with the user's words and off after the turn's reply", () => {
  const { s, sent } = session();
  s.userText("find socks");
  s.onSdkMessage(reply("Found three."));
  s.onSdkMessage(result());
  assert.deepEqual(kinds(sent), ["busy:true:1", "say:Found three.", "busy:false:1"]);
});

test("a spoken ack mid-turn does not end busy", () => {
  const { s, sent } = session();
  s.userText("find socks");
  (s as any).say("On it.");
  assert.deepEqual(kinds(sent), ["busy:true:1", "say:On it."]);
  s.onSdkMessage(result());
  assert.deepEqual(kinds(sent).at(-1), "busy:false:1");
});

test("words during a turn get their own ack; the first turn's end sends nothing stale, the last one ends it", () => {
  const { s, sent, busy } = session();
  s.userText("find socks");
  s.interrupt();
  s.userText("wool ones");
  assert.deepEqual(busy(), [{ type: "busy", on: true, seq: 1 }, { type: "busy", on: true, seq: 2 }]);
  s.onSdkMessage(result()); // the interrupted turn
  assert.equal(busy().length, 2, "still busy: no message");
  s.onSdkMessage(reply("Wool socks, $12."));
  s.onSdkMessage(result());
  assert.deepEqual(busy().at(-1), { type: "busy", on: false, seq: 2 });
});

test("busy is off while a question waits for the user's answer, and on again once answered", async () => {
  const { s, busy } = session();
  s.userText("buy the mug");
  const done = s.requestCheckout({ item: "Blue mug", quantity: 1, total: "$14.27" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(busy().at(-1), { type: "busy", on: false, seq: 1 }, "waiting for the yes");
  s.userText("no, wait");
  await done;
  assert.deepEqual(busy().at(-1), { type: "busy", on: true, seq: 2 }, "the agent goes on with the answer");
  s.onSdkMessage(result());
  assert.deepEqual(busy().at(-1), { type: "busy", on: false, seq: 2 });
});

test("an agent error ends the turn out loud and busy goes off", async () => {
  const { s, sent } = session();
  s.userText("find socks");
  async function* broken(): AsyncGenerator<any> {
    yield reply("thinking");
    throw new Error("socket hang up");
  }
  await s.consume(broken());
  assert.deepEqual(kinds(sent), ["busy:true:1", "say:Sorry, something went wrong on my side. Please try again.", "busy:false:1"]);
  assert.equal((s as any).turnsOpen, 0);
});

test("a session closed mid-turn says busy off", () => {
  const { s, busy } = session();
  s.userText("find socks");
  s.close();
  assert.deepEqual(busy().at(-1), { type: "busy", on: false, seq: 1 });
});

test("the hub stamps busy with the count of user_text that window sent, stale ones included", () => {
  let send: (m: ServerMessage) => void = () => {};
  const hub = new SessionHub((sendFn) => {
    send = sendFn;
    return { userText: () => send({ type: "busy", on: true, seq: 99 }), interrupt() {}, handOff() {}, close() {} };
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
