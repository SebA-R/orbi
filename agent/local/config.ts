// Which model runs Clearcart's agent: Claude through the Claude Agent SDK
// (the default), or a model on this computer behind an OpenAI-compatible
// chat-completions endpoint such as Ollama or LM Studio (local/query.ts).
//
// The extension sends the user's choice with its settings (extbridge.ts).
// Outside ext mode, and for any field the extension has not sent,
// CLEARCART_PROVIDER, CLEARCART_LOCAL_URL, CLEARCART_LOCAL_MODEL and
// CLEARCART_LOCAL_VISION decide. The endpoint must be on this computer:
// http(s) to localhost, 127.0.0.1 or [::1] only, so no page or setting can
// send the conversation (the user's words, page text) to another machine.

export type Provider = "claude" | "local";
export const DEFAULT_LOCAL_URL = "http://localhost:11434/v1";
export const DEFAULT_LOCAL_MODEL = "llama3.1:8b";

export type ProviderSettings = {
  provider: Provider;
  localBaseUrl: string;
  localModel: string;
  // The local model takes images: screenshots go to it as images, not as a
  // short note. Off unless asked for; most small models cannot.
  localVision: boolean;
};

export const CLAUDE_DEFAULTS: ProviderSettings = { provider: "claude", localBaseUrl: DEFAULT_LOCAL_URL, localModel: DEFAULT_LOCAL_MODEL, localVision: false };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Ollama names (llama3.1:8b, hf.co/org/model:Q4_K_M), LM Studio keys
// (qwen/qwen3-8b@q4_k_m) and llama.cpp aliases.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

export function parseProvider(v: unknown): Provider | null {
  return v === "claude" || v === "local" ? v : null;
}

// The endpoint's base URL, normalized (no trailing slash; /v1 when no path
// is given), or null unless it is http(s) to this computer. Other hosts,
// "localhost." and IPv4-mapped spellings, user names, a query, a fragment
// and a path starting "//" (it reads as a host once joined) are refused.
export function parseLocalBaseUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 300) return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!LOOPBACK_HOSTS.has(u.hostname)) return null;
  if (u.username || u.password || u.search || u.hash || u.pathname.startsWith("//")) return null;
  const pathname = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${pathname || "/v1"}`;
}

// A short, plain model name, or null.
export function parseLocalModel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return MODEL_NAME.test(s) && !s.includes("..") ? s : null;
}

// The environment's choice. Throws on a value it cannot use (server.ts
// checks at startup), so a typo or a remote URL never quietly picks
// something else.
export function envProviderSettings(env: NodeJS.ProcessEnv = process.env): ProviderSettings {
  const raw = (name: string) => env[name]?.trim() ?? "";
  const pick = <T>(name: string, parse: (v: string) => T | null, fallback: T, rule: string): T => {
    if (!raw(name)) return fallback;
    const v = parse(raw(name));
    if (v === null) throw new Error(`${name} must be ${rule}, got "${env[name]}"`);
    return v;
  };
  return {
    provider: pick("CLEARCART_PROVIDER", (v) => parseProvider(v.toLowerCase()), "claude", "claude or local"),
    localBaseUrl: pick("CLEARCART_LOCAL_URL", parseLocalBaseUrl, DEFAULT_LOCAL_URL, "an http(s) URL on this computer (localhost, 127.0.0.1 or [::1])"),
    localModel: pick("CLEARCART_LOCAL_MODEL", parseLocalModel, DEFAULT_LOCAL_MODEL, "a model name such as llama3.1:8b"),
    localVision: pick("CLEARCART_LOCAL_VISION", (v) => (v.toLowerCase() === "true" ? true : v.toLowerCase() === "false" ? false : null), false, "true or false"),
  };
}

// CLEARCART_LOCAL_CONTEXT: the context window, in tokens, Ollama loads the
// model with (local/openai.ts). Throws on a value it cannot use.
export function envLocalContext(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLEARCART_LOCAL_CONTEXT?.trim();
  if (!raw) return 16_384;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 4_096 || n > 262_144) throw new Error(`CLEARCART_LOCAL_CONTEXT must be a whole number of tokens from 4096 to 262144, got "${raw}"`);
  return n;
}

// What a session runs on, as one string. When it changes, the hub starts
// a new session (hub.ts switchBackend).
export function backendKey(p: ProviderSettings): string {
  return p.provider === "claude" ? "claude" : `local ${p.localBaseUrl} ${p.localModel}${p.localVision ? " vision" : ""}`;
}

export function describeBackend(p: ProviderSettings): string {
  return p.provider === "claude" ? "Claude" : `your local model ${p.localModel} (${new URL(p.localBaseUrl).host})`;
}
