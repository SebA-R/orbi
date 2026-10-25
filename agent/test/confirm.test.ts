import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, type ServerMessage } from "../session.ts";

function session() {
  const sent: ServerMessage[] = [];
  return { s: new Session((m) => sent.push(m)), sent };
}

test("request_checkout sends a structured confirm before speaking the read-back", async () => {
  const { s, sent } = session();
  const done = s.requestCheckout({
    item: "Blue mug",
    quantity: 1,
    total: "$14.27 CAD",
    changes: "I removed a Subscribe and Save membership ($4.99) and a gift wrap add-on ($2.50)",
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent[0], {
    type: "confirm",
    item: "Blue mug",
    quantity: 1,
    total: "$14.27 CAD",
    changes: "I removed a Subscribe and Save membership ($4.99) and a gift wrap add-on ($2.50).",
  });
  assert.equal(sent[1].type, "agent_text");
  assert.match((sent[1] as any).text, /for \$14\.27 CAD\. I removed .* \(\$2\.50\)\. Say yes/);
  s.userText("yes");
  const r = await done;
  assert.equal(r.content[0].text, "confirmed");
  assert.ok(!sent.some((m) => m.type === "confirm_done"), "a yes leaves the card up until payment resolves");
});

test("a declined read-back sends confirm_done declined", async () => {
  const { s, sent } = session();
  const done = s.requestCheckout({ item: "Blue mug", quantity: 2, total: "$9.00" });
  await new Promise((r) => setImmediate(r));
  assert.equal((sent[0] as any).changes, "");
  s.userText("no, wait");
  await done;
  assert.deepEqual(sent.at(-1), { type: "confirm_done", outcome: "declined" });
});
