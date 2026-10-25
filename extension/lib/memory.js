// Saved facts on the agent server, for the options page's Memory section.
//
// The agent keeps them on this computer (agent/memory.ts) and serves them at
// POST /memory/list (Chrome sends no Origin on a GET, and the server needs
// one), DELETE /memory/<id> and DELETE /memory (forget everything),
// to this extension's origin only. Nothing here can add a fact: only the
// agent's remember tool does, when the user asks out loud.

import { endpoints } from "./settings.js";

const ID = /^m[0-9a-f]{8}$/;

async function call(agentUrl, method, path, fetchImpl) {
  const r = await fetchImpl(`${endpoints(agentUrl).http}${path}`, { method, cache: "no-store" });
  if (!r.ok) throw new Error(`the agent server answered ${r.status}`);
  return r.json();
}

// { enabled, facts: [{ id, text, at }] }. Throws when the server can't be reached.
export async function listMemory(agentUrl, fetchImpl = globalThis.fetch) {
  const body = await call(agentUrl, "POST", "/memory/list", fetchImpl);
  const facts = Array.isArray(body?.facts) ? body.facts.filter((f) => f && ID.test(f.id) && typeof f.text === "string") : [];
  return { enabled: body?.enabled !== false, facts: facts.map((f) => ({ id: f.id, text: f.text, at: Number(f.at) || 0 })) };
}

export async function forgetFact(agentUrl, id, fetchImpl = globalThis.fetch) {
  if (!ID.test(String(id))) throw new Error("not a saved fact id");
  return call(agentUrl, "DELETE", `/memory/${id}`, fetchImpl);
}

export async function forgetAll(agentUrl, fetchImpl = globalThis.fetch) {
  return call(agentUrl, "DELETE", "/memory", fetchImpl);
}
