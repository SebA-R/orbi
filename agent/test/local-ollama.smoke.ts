// One real run against the local Ollama (never part of npm test):
//
//   CLEARCART_VOICE=false npx tsx test/local-ollama.smoke.ts
//
// An in-process Session on the local backend (llama3.1:8b at
// http://localhost:11434/v1 unless CLEARCART_LOCAL_URL / _MODEL say
// otherwise) with a fake extension bridge as its browser: no agent server,
// no Chrome. Turns: say hello; open a page in a new tab; read the Google
// Doc the user is on; add a line to it. Prints what was said and which
// browser calls ran, and fails if a turn gets no spoken reply.

import assert from "node:assert/strict";

import { extBridge } from "../extbridge.ts";
import { Session, type ServerMessage } from "../session.ts";

process.env.CLEARCART_BROWSER = "ext";
process.env.CLEARCART_PROVIDER = "local";
process.env.CLEARCART_LOCAL_URL ||= "http://localhost:11434/v1";
process.env.CLEARCART_LOCAL_MODEL ||= "llama3.1:8b";

const DOC = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit";
const DOC_TEXT = "Trip plan\nDay 1: fly to Lisbon on Friday at 9am.\nDay 2: walk around Alfama, lunch at Time Out Market.";
const tabs: Record<number, { url: string; title: string }> = {
  7: { url: "https://www.etsy.com/", title: "Etsy" },
  9: { url: DOC, title: "Trip plan - Google Docs" },
};
let nextTab = 20;
let typed = "";

const calls: string[] = [];
(extBridge as any).call = async (method: string, p: any) => {
  if (!["agent_tabs", "actions_stop", "page_context"].includes(method)) calls.push(`${method} ${JSON.stringify(p)}`);
  const tab = tabs[p?.tabId ?? 9];
  switch (method) {
    case "agent_tabs":
      return { tabs: Object.entries(tabs).map(([id, t]) => ({ tabId: Number(id), url: t.url })) };
    case "tabs_context":
      return { tabs: Object.entries(tabs).map(([id, t]) => ({ tabId: Number(id), title: t.title, url: t.url, active: Number(id) === 9, openedByClearcart: Number(id) >= 20 })) };
    case "tabs_create": {
      const id = nextTab++;
      tabs[id] = { url: p.url || "about:blank", title: /example\.com/.test(p.url) ? "Example Domain" : "New tab" };
      return { tabId: id };
    }
    case "navigate":
      if (tab) Object.assign(tab, { url: p.url, title: /example\.com/.test(p.url) ? "Example Domain" : tab.title });
      return { tabId: p.tabId, url: p.url, title: tab?.title };
    case "get_page_text":
      if (tab?.url === DOC) return { url: DOC, title: tab.title, text: DOC_TEXT + (typed ? `\n${typed}` : "") };
      return { url: tab?.url, title: tab?.title, text: tab?.title === "Example Domain" ? "Example Domain. This domain is for use in documentation examples without needing permission." : "" };
    case "read_page":
      if (tab?.url === DOC) return '- document "Trip plan - Google Docs"\n  - menubar "Menu bar" [ref_1]\n  - button "Share. Private to only me." [ref_2]\n  - textbox "Document content" [ref_3]\n    - paragraph "Trip plan"\n    - paragraph "Day 1: fly to Lisbon on Friday at 9am."\n    - paragraph "Day 2: walk around Alfama, lunch at Time Out Market."';
      return `- heading "${tab?.title}" [ref_1]`;
    case "find":
      return { matches: tab?.url === DOC ? [{ ref: "ref_3", role: "textbox", name: "Document content" }] : [] };
    case "rect":
      return { x: 300, y: 400, width: 600, height: 300 };
    case "type":
      typed += p.text;
      return { ok: true };
    default:
      return { ok: true };
  }
};

const sent: ServerMessage[] = [];
const s = new Session((m) => {
  sent.push(m);
  if (m.type === "agent_text") console.log(`  said: ${m.text}`);
  else if (m.type === "status") console.log(`  status: ${m.text}`);
});
s.lookup = async () => [{ address: "93.184.215.14" }];
s.pageContext = async () => ({ active: { tabId: 9, title: tabs[9].title, url: DOC } });
const running = s.run();

async function turn(text: string, ms = 180_000): Promise<string[]> {
  console.log(`\nuser: ${text}`);
  const from = sent.length;
  const t0 = Date.now();
  s.userText(text);
  while (!sent.slice(from).some((m) => m.type === "status" && /^turn ended/.test(m.text)) && (s as any).turnsOpen > 0) {
    if (Date.now() - t0 > ms) throw new Error(`no answer to "${text}" in ${ms / 1000} s`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const said = sent.slice(from).filter((m) => m.type === "agent_text").map((m: any) => m.text as string);
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return said;
}

const report: Record<string, unknown> = {};
try {
  const hello = await turn("Say hello.");
  assert.ok(hello.length, "a spoken reply to hello");
  report.hello = hello;

  let n = calls.length;
  const opened = await turn("Open example.com in a new tab and tell me the page title.");
  report.open = { said: opened, calls: calls.slice(n) };
  assert.ok(calls.slice(n).some((c) => /^(tabs_create|navigate) /.test(c) && /example\.com/.test(c)), "a browser call opened example.com");

  n = calls.length;
  const read = await turn("What does the first line of this Google Doc say?");
  report.docRead = { said: read, calls: calls.slice(n) };
  assert.ok(calls.slice(n).some((c) => /^(get_page_text|read_page|find) /.test(c)), "the doc was read");

  n = calls.length;
  const wrote = await turn("Add a new line at the end of the doc that says: book the hotel.");
  report.docWrite = { said: wrote, calls: calls.slice(n), typed };
  console.log("\nREPORT", JSON.stringify(report, null, 2));
} finally {
  s.close();
  await running;
}
