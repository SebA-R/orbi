// A minimal client for an OpenAI-compatible chat-completions endpoint on
// this computer (Ollama, LM Studio, llama.cpp): one non-streaming request
// per model step, and the model list for the settings page. Redirects are
// refused, so a local server cannot pass the conversation on to another
// host. Errors come back as LocalModelError with a few words that can be
// spoken to the user.
//
// Ollama is the one exception to plain chat completions: its OpenAI
// endpoint loads a model with Ollama's default context window (4096 tokens)
// and ignores a size sent there, while Orbi's rules and tools alone
// are about 4.5k tokens, so Ollama would quietly cut most of them. When the
// server answers Ollama's /api/version, its own /api/chat is used instead,
// with num_ctx (CLEARCART_LOCAL_CONTEXT, default 16384).

import { parseLocalModel } from "./config.ts";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export type LocalErrorKind = "unreachable" | "timeout" | "model_missing" | "no_tools" | "http" | "bad_response";

export class LocalModelError extends Error {
  constructor(public kind: LocalErrorKind, message: string, public spoken: string) {
    super(message);
    this.name = "LocalModelError";
  }
}

type Fetch = typeof fetch;

const hostOf = (baseUrl: string) => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

export function unreachable(baseUrl: string, why: string): LocalModelError {
  return new LocalModelError("unreachable", `cannot reach ${baseUrl}: ${why}`, `I can't reach your local model at ${hostOf(baseUrl)}. Check that it's running, or switch back to Claude in Orbi settings.`);
}

// Sorts a failed HTTP answer into something the user can act on.
function httpError(status: number, body: string, model: string): LocalModelError {
  let message = body.slice(0, 300);
  try {
    const j = JSON.parse(body);
    message = String(j?.error?.message ?? j?.error ?? j?.message ?? message).slice(0, 300);
  } catch {}
  if (/does not support tools|tools? (is|are)? ?not supported|not support(ed)? (for )?tool|tool use is not supported/i.test(message)) {
    return new LocalModelError("no_tools", `HTTP ${status}: ${message}`, `The model ${model} can't use tools, so it can't work the browser. Pick one with tool support in Orbi settings.`);
  }
  if (status === 404 || /model .*not found|not found.*model|no such model|model_not_found|failed to load model/i.test(message)) {
    return new LocalModelError("model_missing", `HTTP ${status}: ${message}`, `Your local model server doesn't have ${model}. Pick another model in Orbi settings.`);
  }
  return new LocalModelError("http", `HTTP ${status}: ${message}`, "Your local model ran into an error. Try again in a moment.");
}

// Reasoning models put their thinking in <think> blocks; never speak it.
function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

let callCounter = 0;

function toolCallsOf(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c === "object" && typeof c.function?.name === "string")
    .map((c) => {
      const args = c.function.arguments;
      return {
        id: typeof c.id === "string" && c.id ? c.id.slice(0, 64) : `call_${++callCounter}`,
        type: "function" as const,
        function: { name: c.function.name.slice(0, 128), arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
      };
    });
}

export type Flavor = "ollama" | "openai";

export type ChatRequest = {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  timeoutMs: number;
  flavor?: Flavor;
  // Ollama only: the context window to load the model with.
  contextTokens?: number;
  fetch?: Fetch;
};

// promptTokens: what the server says the prompt came to (OpenAI-style
// servers), to notice one that cut it short.
export type ChatReply = { content: string; toolCalls: ToolCall[]; promptTokens?: number };

export const DEFAULT_CONTEXT_TOKENS = 16_384;
const rootOf = (baseUrl: string) => baseUrl.replace(/\/v1$/, "");

// "ollama" when the server answers Ollama's /api/version, "openai" when it
// answers anything else, null when it can't be reached (ask again later).
export async function detectFlavor(baseUrl: string, f: Fetch = fetch): Promise<Flavor | null> {
  try {
    const res = await f(`${rootOf(baseUrl)}/api/version`, { redirect: "error", signal: AbortSignal.timeout(2_000) });
    const text = await res.text();
    try {
      if (res.ok && typeof JSON.parse(text)?.version === "string") return "ollama";
    } catch {}
    return "openai";
  } catch {
    return null;
  }
}

function argsObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Chat messages in Ollama's own shape: tool call arguments as objects,
// tool results with their tool's name, images as base64 beside the text.
function ollamaMessages(messages: ChatMessage[]) {
  const names = new Map<string, string>();
  return messages.map((m) => {
    if (m.role === "assistant") {
      for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
      const calls = (m.tool_calls ?? []).map((c) => ({ id: c.id, function: { name: c.function.name, arguments: argsObject(c.function.arguments) } }));
      return { role: "assistant", content: m.content, ...(calls.length ? { tool_calls: calls } : {}) };
    }
    if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.tool_call_id, tool_name: names.get(m.tool_call_id) ?? "" };
    if (m.role === "user" && Array.isArray(m.content)) {
      const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      const images = m.content.flatMap((p) => (p.type === "image_url" ? [p.image_url.url.replace(/^data:[^,]*,/, "")] : []));
      return { role: "user", content: text, images };
    }
    return m;
  });
}

// One model step. Throws LocalModelError, or the abort reason when `signal`
// fired first (the caller checks signal.aborted).
export async function chat(r: ChatRequest): Promise<ChatReply> {
  const timeout = AbortSignal.timeout(r.timeoutMs);
  const signal = AbortSignal.any([r.signal, timeout]);
  const ollama = r.flavor === "ollama";
  const body = ollama
    ? {
        model: r.model,
        messages: ollamaMessages(r.messages),
        ...(r.tools.length ? { tools: r.tools } : {}),
        stream: false,
        options: { num_ctx: r.contextTokens ?? DEFAULT_CONTEXT_TOKENS, temperature: 0.3, num_predict: 1024 },
      }
    : {
        model: r.model,
        messages: r.messages,
        ...(r.tools.length ? { tools: r.tools, tool_choice: "auto" } : {}),
        stream: false,
        temperature: 0.3,
        max_tokens: 1024,
      };
  let res: Response;
  try {
    res = await (r.fetch ?? fetch)(ollama ? `${rootOf(r.baseUrl)}/api/chat` : `${r.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  } catch (e) {
    if (r.signal.aborted) throw e;
    if (timeout.aborted) throw timedOut(r.timeoutMs);
    throw unreachable(r.baseUrl, String((e as any)?.cause?.code || (e as Error).message));
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (r.signal.aborted) throw e;
    if (timeout.aborted) throw timedOut(r.timeoutMs);
    throw new LocalModelError("bad_response", `reading the answer failed: ${(e as Error).message}`, BAD_RESPONSE);
  }
  if (!res.ok) throw httpError(res.status, text, r.model);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  const msg = ollama ? json?.message : json?.choices?.[0]?.message;
  if (!msg || typeof msg !== "object") throw new LocalModelError("bad_response", `no ${ollama ? "message" : "choices[0].message"} in the answer`, BAD_RESPONSE);
  const promptTokens = ollama ? undefined : json?.usage?.prompt_tokens;
  return {
    content: typeof msg.content === "string" ? stripThinking(msg.content) : "",
    toolCalls: toolCallsOf(msg.tool_calls),
    ...(typeof promptTokens === "number" ? { promptTokens } : {}),
  };
}

const BAD_RESPONSE = "Your local model sent an answer I couldn't read. Try again, or pick another model in Orbi settings.";

function timedOut(ms: number): LocalModelError {
  return new LocalModelError("timeout", `no answer within ${Math.round(ms / 1000)} s`, "Your local model took too long to answer. Try again, or pick a smaller model in Orbi settings.");
}

export type LocalModel = { id: string; tools?: boolean };

async function getJson(url: string, timeoutMs: number, f: Fetch): Promise<any> {
  const res = await f(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  if (text.length > 2_000_000) throw new Error("answer too large");
  return JSON.parse(text);
}

// The models the endpoint offers: its OpenAI-style /models, else Ollama's
// /api/tags. Ollama's list also says which models can use tools, so it is
// read for that too when it answers. Only names that pass parseLocalModel
// are returned. Throws LocalModelError when neither answers.
export async function listModels(baseUrl: string, opts: { timeoutMs?: number; fetch?: Fetch } = {}): Promise<LocalModel[]> {
  const f = opts.fetch ?? fetch;
  const ms = opts.timeoutMs ?? 3_000;
  const [openai, ollama] = await Promise.allSettled([getJson(`${baseUrl}/models`, ms, f), getJson(`${rootOf(baseUrl)}/api/tags`, ms, f)]);
  const tools = new Map<string, boolean>();
  const ids: string[] = [];
  if (ollama.status === "fulfilled" && Array.isArray(ollama.value?.models)) {
    for (const m of ollama.value.models) {
      const id = parseLocalModel(m?.name ?? m?.model);
      if (!id) continue;
      ids.push(id);
      if (Array.isArray(m.capabilities)) tools.set(id, m.capabilities.includes("tools"));
    }
  }
  if (openai.status === "fulfilled" && Array.isArray(openai.value?.data)) {
    ids.length = 0;
    for (const m of openai.value.data) {
      const id = parseLocalModel(m?.id);
      if (id) ids.push(id);
    }
  }
  if (openai.status === "rejected" && ollama.status === "rejected") {
    const e = openai.reason as any;
    if (typeof e?.status === "number") throw new LocalModelError("http", `HTTP ${e.status} from ${baseUrl}/models`, "Your local model server answered, but not with a list of models.");
    throw unreachable(baseUrl, String(e?.cause?.code || e?.message || e));
  }
  return [...new Set(ids)].slice(0, 200).map((id) => (tools.has(id) ? { id, tools: tools.get(id) } : { id }));
}
