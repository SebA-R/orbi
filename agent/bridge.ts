// Direct client for the Open Claude in Chrome browser bridge.
//
// The extension's native host owns a unix socket and multiplexes every
// attached client onto the one native-messaging link (see
// open-claude-in-chrome/host/endpoint.js and native-host.js). Claude's browser
// tools come from a server-hybrid.js child the SDK spawns; this module is a
// second, separate client used only by our own code (the lock checks and the
// tab sweep), so what it sends never passes through Claude's context.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Mirrors getPipePath() in open-claude-in-chrome/host/endpoint.js (POSIX).
function pipePath(): string {
  if (process.env.OCIC_PIPE) return process.env.OCIC_PIPE;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".config", "open-claude-in-chrome", "config.json"), "utf-8")
    );
    if (cfg.pipe) return cfg.pipe;
  } catch {}
  let uid: number | string;
  try {
    uid = os.userInfo().uid;
  } catch {
    uid = (process.env.USER || "default").replace(/[^\w.-]/g, "_");
  }
  return path.join(os.tmpdir(), `open-claude-in-chrome-${uid}`, "bridge.sock");
}

type ToolResult = { content?: Array<{ type: string; text?: string }> };

const REQUEST_TIMEOUT_MS = 60_000;

let socket: net.Socket | null = null;
let connecting: Promise<net.Socket> | null = null;
let buffer = Buffer.alloc(0);
let counter = 0;
const pending = new Map<string, { resolve: (r: ToolResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function connect(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return Promise.resolve(socket);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const sock = net.createConnection(pipePath());
    sock.once("connect", () => {
      sock.write(JSON.stringify({ type: "client_hello" }) + "\n");
      socket = sock;
      connecting = null;
      resolve(sock);
    });
    sock.once("error", (err) => {
      connecting = null;
      reject(new Error(`Browser bridge not reachable (${(err as NodeJS.ErrnoException).code || "error"}). Is the browser open with the Open Claude in Chrome extension?`));
    });
    sock.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let idx;
      while ((idx = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, idx).toString("utf-8").trim();
        buffer = buffer.subarray(idx + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const entry = msg.id && pending.get(msg.id);
        if (!entry) continue;
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        if (msg.type === "tool_error") entry.reject(new Error(msg.error || "tool failed"));
        else entry.resolve(typeof msg.result === "string" ? { content: [{ type: "text", text: msg.result }] } : msg.result);
      }
    });
    sock.on("close", () => {
      if (socket === sock) socket = null;
      buffer = Buffer.alloc(0);
      for (const [, e] of pending) {
        clearTimeout(e.timer);
        e.reject(new Error("Browser bridge closed mid-request"));
      }
      pending.clear();
    });
  });
  return connecting;
}

export async function callBrowserTool(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const sock = await connect();
  const id = `cc${++counter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${tool} timed out`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    sock.write(JSON.stringify({ id, type: "tool_request", tool, args }) + "\n");
  });
}

export function resultText(r: ToolResult): string {
  return (r.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("\n");
}

// Runs page JS and returns the parsed value of the last expression. Throws on
// a page-side exception. The error message never includes the script.
export async function evalInTab<T = unknown>(tabId: number, code: string): Promise<T> {
  const text = resultText(await callBrowserTool("javascript_tool", { action: "javascript_exec", text: code, tabId }));
  if (text === "undefined") return undefined as T;
  if (text.startsWith("Error:") || text.startsWith("Tab ")) throw new Error("page script failed");
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

export function closeBridge() {
  socket?.destroy();
  socket = null;
}
