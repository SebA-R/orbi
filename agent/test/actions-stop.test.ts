// At turn end and on interrupt the session tells the extension to stop any
// paced click, typing or scroll still playing (actions_stop).
import assert from "node:assert/strict";
import { test } from "node:test";

import { extBridge } from "../extbridge.ts";
import { Session } from "../session.ts";

process.env.CLEARCART_BROWSER = "ext";

function session(connected = true) {
  const calls: string[] = [];
  (extBridge as any).connected = () => connected;
  (extBridge as any).call = async (m: string) => {
    calls.push(m);
    return {};
  };
  return { s: new Session(() => {}), calls };
}

test("a finished turn sends actions_stop", () => {
  const f = session();
  f.s.onSdkMessage({ type: "result", subtype: "success" } as any);
  assert.deepEqual(f.calls, ["actions_stop"]);
});

test("an interrupt sends actions_stop, even with no turn open", () => {
  const f = session();
  f.s.interrupt();
  assert.deepEqual(f.calls, ["actions_stop"]);
});

test("no extension connected: nothing is sent", () => {
  const f = session(false);
  f.s.onSdkMessage({ type: "result", subtype: "success" } as any);
  f.s.interrupt();
  assert.deepEqual(f.calls, []);
});
