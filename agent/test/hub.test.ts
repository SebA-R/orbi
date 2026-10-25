// One voice session for every /session socket (hub.ts): who owns it, where
// its output goes, and that a read-back can only be answered from the
// window that heard it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { MOVED_TEXT, SessionHub, STALE_TEXT, type HubMessage, type HubSession } from "../hub.ts";
import { claimConfirmation } from "../pay.ts";
import { Session, type ServerMessage } from "../session.ts";

// A window: everything the hub sent to its socket.
function windowOf(hub: SessionHub) {
  const got: HubMessage[] = [];
  const peer = hub.join((m) => got.push(m));
  return { got, peer, spoken: () => got.filter((m) => m.type === "agent_text").map((m) => (m as any).text), standby: () => got.filter((m) => m.type === "standby") };
}

// Sessions that record what reached them and can talk back.
function fakeHub() {
  const made: Array<HubSession & { calls: string[]; send: (m: ServerMessage) => void; ended: () => void; closed: boolean }> = [];
  const hub = new SessionHub((send, ended) => {
    const s = {
      calls: [] as string[],
      send,
      ended,
      closed: false,
      userText(text: string) { s.calls.push(`text:${text}`); },
      interrupt() { s.calls.push("interrupt"); },
      handOff() { s.calls.push("handOff"); },
      close() { s.closed = true; },
    };
    made.push(s);
    return s;
  });
  return { hub, made };
}

// A real Session behind the hub, without the agent loop running.
function realHub() {
  let session: Session | null = null;
  const hub = new SessionHub((send) => (session = new Session(send)));
  return { hub, session: () => session! };
}

const tick = () => new Promise((r) => setImmediate(r));

test("one session for every socket; opening a socket takes nothing from the window in use", () => {
  const { hub, made } = fakeHub();
  const a = windowOf(hub);
  a.peer.userText("find allergy pills");
  const b = windowOf(hub);
  assert.equal(made.length, 1, "the second socket joins the same session");
  made[0].send({ type: "agent_text", text: "Found three." });
  assert.deepEqual(a.spoken(), ["Found three."]);
  assert.deepEqual(b.spoken(), [], "a socket that never talked gets no output");
  assert.ok(b.got.some((m) => m.type === "status" && /in use in another window/.test(m.text)));
  assert.deepEqual(made[0].calls, ["handOff", "text:find allergy pills"]);
});

test("a second socket that talks takes the session over; the first gets standby and nothing more", () => {
  const { hub, made } = fakeHub();
  const a = windowOf(hub);
  a.peer.userText("find allergy pills");
  const b = windowOf(hub);
  b.peer.interrupt();
  assert.deepEqual(a.standby(), [{ type: "standby", reason: "moved", text: MOVED_TEXT }]);
  assert.deepEqual(made[0].calls.slice(-2), ["handOff", "interrupt"], "the old window's turn is handed off and stopped");
  made[0].send({ type: "agent_text", text: "Here is the cheapest." });
  made[0].send({ type: "receipt", item: "Advil", total: "$9.00", last4: "1111" });
  assert.deepEqual(a.spoken(), []);
  assert.deepEqual(b.spoken(), ["Here is the cheapest."]);
  assert.ok(b.got.some((m) => m.type === "receipt"));
  assert.ok(!a.got.some((m) => m.type === "receipt"));
});

test("words from a window that lost the session are dropped, never sent; talking there again takes it back", () => {
  const { hub, made } = fakeHub();
  const a = windowOf(hub);
  const b = windowOf(hub);
  a.peer.interrupt();
  a.peer.userText("buy the advil");
  b.peer.interrupt();
  a.peer.userText("yes"); // said in a before the user moved to b
  assert.ok(!made[0].calls.includes("text:yes"));
  assert.deepEqual(a.standby().at(-1), { type: "standby", reason: "stale", text: STALE_TEXT });
  a.peer.interrupt();
  a.peer.userText("actually, the cetirizine");
  assert.ok(made[0].calls.includes("text:actually, the cetirizine"));
  assert.equal(b.standby().length, 1, "b is the one on standby now");
});

test("the owner's own barge-in does not hand the session off", () => {
  const { hub, made } = fakeHub();
  const a = windowOf(hub);
  a.peer.interrupt();
  a.peer.interrupt();
  a.peer.userText("hi");
  assert.deepEqual(made[0].calls, ["handOff", "interrupt", "interrupt", "text:hi"]);
});

test("a checkout read-back can't be confirmed from another window", async () => {
  const { hub, session } = realHub();
  const a = windowOf(hub);
  const b = windowOf(hub);
  a.peer.userText("buy the advil");
  const s = session();
  const done = s.requestCheckout({ item: "Advil 50 count", quantity: 1, total: "$14.27" });
  await tick();
  assert.ok(a.got.some((m) => m.type === "confirm"), "the read-back goes to the window in use");
  assert.ok(!b.got.some((m) => m.type === "confirm" || m.type === "agent_text"), "and only there");
  b.peer.userText("yes"); // a yes from the other window
  const r = await done;
  assert.match(r.content[0].text, /^declined\. No answer came/);
  assert.equal((s as any).state.confirmation.state, "declined");
  assert.ok(!b.got.some((m) => m.type === "status" && m.text === "checkout confirmed"));
  // a's own late yes can't revive it either: a lost the session.
  a.peer.userText("yes");
  assert.equal((s as any).state.confirmation.state, "declined");
  assert.deepEqual(a.standby().at(-1)?.reason, "stale");
});

test("the window that heard the read-back still confirms it with a yes", async () => {
  const { hub, session } = realHub();
  const a = windowOf(hub);
  windowOf(hub); // another window, never used
  a.peer.userText("buy the advil");
  const done = session().requestCheckout({ item: "Advil", quantity: 1, total: "$9.00" });
  await tick();
  a.peer.interrupt(); // barge-in to answer
  a.peer.userText("yes");
  assert.equal((await done).content[0].text, "confirmed");
  assert.equal((session() as any).state.confirmation.state, "confirmed");
});

test("a yes pay_now has not used yet is withdrawn when the user moves to another window; a payment under way is left alone", async () => {
  const { hub, session } = realHub();
  const a = windowOf(hub);
  const b = windowOf(hub);
  a.peer.userText("buy the advil");
  const s = session();
  let done = s.requestCheckout({ item: "Advil", quantity: 1, total: "$9.00" });
  await tick();
  a.peer.userText("yes");
  assert.equal((await done).content[0].text, "confirmed");
  b.peer.interrupt(); // the user moves to b before pay_now ran
  const claim = claimConfirmation((s as any).state);
  assert.equal(claim.ok, false);
  assert.match((claim as any).error, /No confirmed checkout/);
  // b hears its own read-back and says yes; pay_now takes it; then a takes over.
  s.onSdkMessage({ type: "result", subtype: "success" } as any); // the interrupted turn ends
  done = s.requestCheckout({ item: "Advil", quantity: 1, total: "$9.00" });
  await tick();
  b.peer.userText("yes");
  assert.equal((await done).content[0].text, "confirmed");
  (s as any).state.confirmation.state = "used"; // what claimConfirmation does as pay_now starts
  a.peer.interrupt();
  assert.equal((s as any).state.confirmation.state, "used");
});

test("a read-back still waiting when its window closes is declined; the session lives on until the last window closes", async () => {
  const { hub, session } = realHub();
  const a = windowOf(hub);
  const b = windowOf(hub);
  a.peer.userText("buy the advil");
  const s = session();
  const done = s.requestCheckout({ item: "Advil", quantity: 1, total: "$9.00" });
  await tick();
  a.peer.leave();
  assert.match((await done).content[0].text, /^declined/);
  assert.equal((s as any).closed, false, "b is still connected");
  b.peer.userText("hi");
  assert.equal(session(), s, "b continues the same conversation");
  b.peer.leave();
  assert.equal((s as any).closed, true);
  windowOf(hub).peer.userText("hello");
  assert.notEqual(session(), s, "the next window starts a fresh session");
});

test("a session whose agent stopped is replaced on the next message; its late output reaches nobody", () => {
  const { hub, made } = fakeHub();
  const a = windowOf(hub);
  a.peer.userText("hi");
  made[0].ended();
  assert.equal(made[0].closed, true);
  a.peer.userText("are you there?");
  assert.equal(made.length, 2);
  assert.deepEqual(made[1].calls, ["text:are you there?"]);
  made[0].send({ type: "agent_text", text: "late words from the old session" });
  made[1].send({ type: "agent_text", text: "Yes." });
  assert.deepEqual(a.spoken(), ["Yes."]);
});

test("a closed session's late output never reaches the next session's window", () => {
  const { hub, made } = fakeHub();
  const a = windowOf(hub);
  a.peer.userText("pay for it");
  a.peer.leave();
  assert.equal(made[0].closed, true);
  const b = windowOf(hub);
  b.peer.userText("hello");
  made[0].send({ type: "receipt", item: "Advil", total: "$9.00", last4: "1111" });
  made[0].send({ type: "confirm", item: "Advil", quantity: 1, total: "$9.00", changes: "" });
  assert.deepEqual(b.got.filter((m) => m.type === "receipt" || m.type === "confirm"), []);
});
