// Clearcart agent server: static voice console at /, GET /cartesia-token,
// and the /session WebSocket (one Claude conversation per socket).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { WebSocketServer, type WebSocket } from "ws";

import { extBridge, extMode } from "./extbridge.ts";
import { hostAllowed } from "./hostcheck.ts";
import { Session, type ServerMessage } from "./session.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const PORT = Number(process.env.AGENT_PORT || 5050);
// CLEARCART_BROWSER=ext: the Clearcart extension connects to /ext and drives
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

async function cartesiaToken(res: http.ServerResponse) {
  if (!VOICE_ENABLED) return json(res, 503, { error: "Voice is off (CLEARCART_VOICE=false)", voice: false });
  const key = process.env.CARTESIA_API_KEY;
  if (!key) return json(res, 500, { error: "CARTESIA_API_KEY is not set in .env" });
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

const server = http.createServer((req, res) => {
  if (!localHost(req)) return void res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden host");
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/cartesia-token") return void cartesiaToken(res);
  if (req.method === "GET" && url.pathname === "/healthz") {
    if (EXT) return json(res, 200, { ok: true, echo: ECHO, voice: VOICE_ENABLED, browser: "ext", extension: extBridge.connected() });
    return json(res, 200, { ok: true, echo: ECHO, voice: VOICE_ENABLED });
  }
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(url.pathname, res);
  res.writeHead(405).end();
});

// Two WebSocket paths on one server need noServer mode plus a router: a
// server-attached WebSocketServer answers 400 to every path but its own.
// Both refuse an upgrade whose Host header is not this computer (hostcheck.ts).
const wss = EXT
  ? new WebSocketServer({ noServer: true })
  : new WebSocketServer({ server, path: "/session", verifyClient: ({ req }: { req: http.IncomingMessage }, done: (ok: boolean, code?: number) => void) => done(localHost(req), 403) });
if (EXT) extBridge.attach(server, { "/session": wss }, "/ext", localHost);

wss.on("connection", (ws: WebSocket) => {
  const send = (m: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  console.log("session opened");

  const session = ECHO ? null : new Session(send);
  if (session) void session.run().finally(() => console.log("session agent stopped"));
  send({ type: "status", text: ECHO ? "connected (echo mode)" : "connected" });

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send({ type: "status", text: "ignored a message that was not JSON" });
    }
    // Barge-in: the user held the talk key over our speech.
    if (msg?.type === "interrupt") return void session?.interrupt();
    if (msg?.type !== "user_text" || typeof msg.text !== "string") {
      return send({ type: "status", text: `ignored message type ${String(msg?.type)}` });
    }
    if (ECHO) return send({ type: "agent_text", text: `You said: ${msg.text}` });
    session!.userText(msg.text);
  });

  ws.on("close", () => {
    console.log("session closed");
    session?.close();
  });
});

server.listen(PORT, () => {
  console.log(`Clearcart agent on http://localhost:${PORT} (WebSocket /session${EXT ? ", /ext" : ""}${ECHO ? ", echo mode" : ""})`);
  if (!fs.existsSync(PUBLIC_DIR)) console.log(`note: ${PUBLIC_DIR} does not exist yet`);
});
