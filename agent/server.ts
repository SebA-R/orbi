// Orbi agent server: static voice console at /, GET /cartesia-token,
// and the /session WebSocket. Every /session socket shares one Claude
// conversation; the one the user last talked into owns it (hub.ts).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { WebSocketServer, type WebSocket } from "ws";

import { extBridge, extMode } from "./extbridge.ts";
import * as timing from "./timing.ts";
import { extensionOrigins, hostAllowed, memoryRequestAllowed, upgradeOriginAllowed } from "./hostcheck.ts";
import { echoSession, SessionHub, type HubMessage } from "./hub.ts";
import { backendKey, describeBackend, envLocalContext, envProviderSettings, parseLocalBaseUrl } from "./local/config.ts";
import { listModels, LocalModelError } from "./local/openai.ts";
import { purchaseHistory } from "./history.ts";
import { conversationLog, memoryStore } from "./memory.ts";
import { currentProvider, memoryOn, Session, type SessionCarry } from "./session.ts";
import { orbiConfigPath } from "./userconfig.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
// The keys `npm run setup` saved (userconfig.ts). The repo's .env and the
// process environment win over it. Only the path is ever logged.
const USER_CONFIG = orbiConfigPath();
const userConfigLoaded = !dotenv.config({ path: USER_CONFIG, quiet: true }).error;

const PORT = Number(process.env.AGENT_PORT || 5050);
// CLEARCART_BROWSER=ext: the Orbi extension connects to /ext and drives
// the browser. Unset: today's open-claude-in-chrome path, no /ext endpoint.
const EXT = extMode();
const PUBLIC_DIR = path.join(ROOT, "voice", "public");
// AGENT_MODE=echo answers every user_text with an agent_text echo and never
// starts Claude. Useful for testing the voice console alone.
const ECHO = process.env.AGENT_MODE === "echo";

const CARTESIA_VERSION = process.env.CARTESIA_VERSION || "2026-08-14";
const TOKEN_TTL_S = 300;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
};

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function serveStatic(pathname: string, res: http.ServerResponse) {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(PUBLIC_DIR, "." + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
}

// Environment variables arrive as text; parse "true"/"false" into a real
// boolean and refuse anything else, so a typo can't silently pick a mode.
export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false, got "${process.env[name]}"`);
}

// CLEARCART_VOICE=false: for tests and recordings that don't need audio. No
// token is minted, so nothing reaches Cartesia: replies show as text only and
// the mic reports that voice is off.
const VOICE_ENABLED: boolean = envBool("CLEARCART_VOICE", true);

// CLEARCART_PROVIDER, CLEARCART_LOCAL_URL, CLEARCART_LOCAL_MODEL,
// CLEARCART_LOCAL_VISION and CLEARCART_LOCAL_CONTEXT: refuse to start on a
// value that can't be used (a typo, or a local model URL that is not on
// this computer).
envProviderSettings();
envLocalContext();

// No Cartesia key: the extension uses basic voice (Chrome's own speech),
// and /healthz says so with cartesia: false.
const hasCartesia = () => VOICE_ENABLED && !!process.env.CARTESIA_API_KEY?.trim();

async function cartesiaToken(res: http.ServerResponse) {
  if (!VOICE_ENABLED) return json(res, 503, { error: "Voice is off (CLEARCART_VOICE=false)", voice: false });
  const key = process.env.CARTESIA_API_KEY?.trim();
  if (!key) return json(res, 503, { error: "No Cartesia key is set, so Orbi uses basic voice", cartesia: false });
  try {
    const r = await fetch("https://api.cartesia.ai/access-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Cartesia-Version": CARTESIA_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: { tts: true, stt: true }, expires_in: TOKEN_TTL_S }),
    });
    const body = (await r.json().catch(() => ({}))) as { token?: string };
    if (!r.ok || !body.token) return json(res, 502, { error: `Cartesia token request failed (${r.status})` });
    json(res, 200, { token: body.token, expires_in: TOKEN_TTL_S });
  } catch {
    json(res, 502, { error: "Could not reach Cartesia" });
  }
}

// The port actually listened on (AGENT_PORT=0 picks a free one).
const port = () => (server.address() as { port?: number } | null)?.port ?? PORT;
const localHost = (req: http.IncomingMessage) => hostAllowed(req.headers.host, port());
// Upgrades also need an allowed Origin: a web page can open a socket to
// localhost with the right Host, and /session takes its words as the user's.
const localUpgrade = (req: http.IncomingMessage) => localHost(req) && upgradeOriginAllowed(req.headers.origin, port(), EXT_ORIGINS);

// Saved facts for the extension's settings page (memory.ts):
//   GET    /memory       { enabled, facts: [{ id, text, at }], purchases: [...] }
//   DELETE /memory/<id>  forget one fact (m...) or past purchase (p...)
//   DELETE /memory       forget everything, past purchases and the recent conversation too
// Loopback peers with the Orbi extension's Origin only (hostcheck.ts).
// Nothing here adds a fact: only the remember tool does.
const EXT_ORIGINS = extensionOrigins();
function memoryRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  if (!memoryRequestAllowed(req, port(), EXT_ORIGINS)) return json(res, 403, { error: "forbidden" });
  const store = memoryStore();
  const id = pathname.slice("/memory/".length);
  if (req.method === "GET" && pathname === "/memory") return json(res, 200, { enabled: memoryOn(), facts: store.list(), purchases: purchaseHistory().list() });
  if (req.method === "DELETE" && pathname === "/memory") {
    const n = store.clear();
    purchaseHistory().clear();
    conversationLog().clear();
    console.log("memory: forgot everything (settings page)");
    return json(res, 200, { ok: true, removed: n });
  }
  if (req.method === "DELETE" && /^m[0-9a-f]{8}$/.test(id)) {
    const hit = store.remove(id);
    if (hit) console.log("memory: forgot a fact (settings page)");
    return json(res, hit ? 200 : 404, hit ? { ok: true } : { error: "not found" });
  }
  if (req.method === "DELETE" && /^p[0-9a-f]{8}$/.test(id)) {
    const hit = purchaseHistory().remove(id);
    if (hit) console.log("memory: forgot a past purchase (settings page)");
    return json(res, hit ? 200 : 404, hit ? { ok: true } : { error: "not found" });
  }
  json(res, 405, { error: "method not allowed" });
}

// The local model's list for the extension's settings page:
//   GET /local-models[?baseUrl=<url>]
//   200 { ok: true, connected: true, baseUrl, models: [{ id, tools? }], current }
//   502 { ok: false, connected: false, baseUrl, error }  (the endpoint is down)
// tools is there when the server says (Ollama). baseUrl defaults to the
// current setting and must pass the same check (http(s) to localhost,
// 127.0.0.1 or [::1]), so this never fetches anything off this computer.
// Loopback peers with the Orbi extension's Origin only, like /memory.
async function localModelsRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (!memoryRequestAllowed(req, port(), EXT_ORIGINS)) return json(res, 403, { error: "forbidden" });
  if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
  const asked = url.searchParams.get("baseUrl");
  const baseUrl = asked === null ? currentProvider().localBaseUrl : parseLocalBaseUrl(asked);
  if (!baseUrl) return json(res, 400, { ok: false, error: "baseUrl must be an http(s) URL on this computer (localhost, 127.0.0.1 or [::1])" });
  try {
    const models = await listModels(baseUrl);
    json(res, 200, { ok: true, connected: true, baseUrl, models, current: currentProvider().localModel });
  } catch (e) {
    json(res, 502, { ok: false, connected: false, baseUrl, error: e instanceof LocalModelError ? e.spoken : "Could not reach the local model server." });
  }
}

const server = http.createServer((req, res) => {
  if (!localHost(req)) return void res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden host");
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/memory" || url.pathname.startsWith("/memory/")) return memoryRoute(req, res, url.pathname);
  if (url.pathname === "/local-models") return void localModelsRoute(req, res, url);
  if (req.method === "GET" && url.pathname === "/cartesia-token") return void cartesiaToken(res);
  if (req.method === "GET" && url.pathname === "/healthz") {
    if (EXT) return json(res, 200, { ok: true, echo: ECHO, voice: VOICE_ENABLED, cartesia: hasCartesia(), browser: "ext", extension: extBridge.connected() });
    return json(res, 200, { ok: true, echo: ECHO, voice: VOICE_ENABLED, cartesia: hasCartesia() });
  }
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(url.pathname, res);
  res.writeHead(405).end();
});

// Two WebSocket paths on one server need noServer mode plus a router: a
// server-attached WebSocketServer answers 400 to every path but its own.
// Both refuse an upgrade whose Host header is not this computer (hostcheck.ts).
const wss = EXT
  ? new WebSocketServer({ noServer: true })
  : new WebSocketServer({ server, path: "/session", verifyClient: ({ req }: { req: http.IncomingMessage }, done: (ok: boolean, code?: number) => void) => done(localUpgrade(req), 403) });
if (EXT) extBridge.attach(server, { "/session": wss }, "/ext", localUpgrade);

// One voice session for all /session sockets (hub.ts). Echo mode goes
// through the same hub, so it follows the same one-owner rules.
const hub = new SessionHub(
  (send, ended, carry) => {
    if (ECHO) return echoSession(send);
    // carry: the fail-closed browser state of the session this one replaces
    // (a provider switch), so a card left in a form stays guarded.
    const session = new Session(send, { memory: memoryStore(), log: conversationLog(), history: purchaseHistory(), carry: carry as SessionCarry | undefined });
    void session.run().finally(() => {
      console.log("session agent stopped");
      ended();
    });
    return session;
  },
  (line) => console.log(line)
);

// The user switched the agent between Claude and a local model (or to
// another local model): the hub retires the session in use and starts one
// on the new backend.
if (EXT) {
  extBridge.on("provider", () => {
    const p = currentProvider();
    if (hub.switchBackend(backendKey(p), describeBackend(p))) console.log(`agent: ${describeBackend(p)}`);
  });
}

wss.on("connection", (ws: WebSocket) => {
  const send = (m: HubMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  console.log("session socket opened");
  send({ type: "status", text: ECHO ? "connected (echo mode)" : "connected" });
  const peer = hub.join(send);

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send({ type: "status", text: "ignored a message that was not JSON" });
    }
    // The talk key went down: barge-in, and this window takes the session.
    if (msg?.type === "interrupt") return void peer.interrupt();
    // ORBI_TIMING (timing.ts): a mark the client measured. Never answered.
    if (msg?.type === "timing") return void timing.clientMark(msg.event, msg.at);
    if (msg?.type !== "user_text" || typeof msg.text !== "string") {
      return send({ type: "status", text: `ignored message type ${String(msg?.type)}` });
    }
    timing.beginTurn(msg.timing);
    peer.userText(msg.text);
  });

  ws.on("error", () => {});
  ws.on("close", () => {
    console.log("session socket closed");
    peer.leave();
  });
});

server.listen(PORT, () => {
  if (userConfigLoaded) console.log(`config: ${USER_CONFIG}`);
  if (!process.env.ANTHROPIC_API_KEY?.trim() && envProviderSettings().provider === "claude") {
    console.log("note: no Anthropic API key is set, so Claude can't answer. Run `npm run setup`, or choose Local in Orbi's settings.");
  }
  if (VOICE_ENABLED && !hasCartesia()) console.log("voice: no Cartesia key, so the extension uses basic voice (Chrome's own speech)");
  console.log(`Orbi agent on http://localhost:${PORT} (WebSocket /session${EXT ? ", /ext" : ""}${ECHO ? ", echo mode" : ""})`);
  if (!fs.existsSync(PUBLIC_DIR)) console.log(`note: ${PUBLIC_DIR} does not exist yet`);
});
