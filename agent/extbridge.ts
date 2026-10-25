// Server side of the Clearcart extension bridge (ws://localhost:5050/ext).
//
// The extension is the client: it connects, sends hello, and we reply
// welcome. After that we send requests and it answers. One extension at a
// time: a newer hello replaces the older socket (newest wins), so a reloaded
// service worker takes over without waiting for the old socket to time out.
//
// Request params can hold card values (fill_payment), so nothing here ever
// logs params or results; only method names and error codes.

import { EventEmitter } from "node:events";
import type http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

// Mirrors extension/lib/protocol.js (the test checks they agree). Kept as a
// copy because that file is plain JS outside this tsconfig.
export const PROTOCOL_VERSION = 1;
export const EXT_NAME = "clearcart";
export const SERVER_NAME = "clearcart-agent";
export const TOOLS = [
  "tabs_context",
  "tabs_create",
  "navigate",
  "read_page",
  "find",
  "get_page_text",
  "form_input",
  "click",
  "type",
  "key",
  "scroll",
  "screenshot",
] as const;
export const INTERNAL = ["tab_info", "read_fields", "fill_payment", "clear_payment"] as const;
export const ERR = {
  BAD_REQUEST: "bad_request",
  UNKNOWN_METHOD: "unknown_method",
  NOT_ALLOWED: "not_allowed",
  NO_TAB: "no_tab",
  NO_ELEMENT: "no_element",
  PAYMENT_FIELD: "payment_field",
  TIMEOUT: "timeout",
  NOT_CONNECTED: "not_connected",
  INTERNAL: "internal",
} as const;
export const REQUEST_TIMEOUT_MS = 30_000;
const HELLO_TIMEOUT_MS = 5_000;

export class ExtError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ExtError";
  }
}

type Pending = { ws: WebSocket; method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export type ExtInfo = { version: string; connectedAt: number };

export interface ExtBridgeEvents {
  connect: [ExtInfo];
  disconnect: [{ reason: string }];
}

export class ExtBridge extends EventEmitter<ExtBridgeEvents> {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  private current: WebSocket | null = null;
  private info: ExtInfo | null = null;
  private pending = new Map<string, Pending>();
  private counter = 0;

  constructor(private log: (line: string) => void = (l) => console.log(l)) {
    super();
    this.wss.on("connection", (ws) => this.accept(ws));
  }

  connected(): boolean {
    return !!this.current && this.current.readyState === this.current.OPEN;
  }

  extInfo(): ExtInfo | null {
    return this.connected() ? this.info : null;
  }

  // Resolves once an extension is connected, or rejects after timeoutMs.
  waitForConnection(timeoutMs = 5_000): Promise<void> {
    if (this.connected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("connect", on);
        reject(new ExtError(ERR.NOT_CONNECTED, "The Clearcart extension is not connected."));
      }, timeoutMs);
      const on = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("connect", on);
    });
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const ws = this.current;
    if (!ws || ws.readyState !== ws.OPEN) {
      return Promise.reject(new ExtError(ERR.NOT_CONNECTED, "The Clearcart extension is not connected. Open Chrome with the extension enabled."));
    }
    const id = `s${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ExtError(ERR.TIMEOUT, `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { ws, method, resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ type: "request", id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ExtError(ERR.NOT_CONNECTED, `${method} could not be sent`));
      }
    });
  }

  // Routes HTTP upgrades on `server`: /ext here, the paths in `others` to
  // their own noServer WebSocketServers, anything else gets a 400.
  attach(server: http.Server, others: Record<string, WebSocketServer> = {}, path = "/ext") {
    server.on("upgrade", (req, socket, head) => {
      let pathname = "";
      try {
        pathname = new URL(req.url || "/", "http://localhost").pathname;
      } catch {}
      const target = pathname === path ? this.wss : others[pathname];
      if (!target) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
    });
    return this;
  }

  close() {
    this.current?.close(1001, "server closing");
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }

  private accept(ws: WebSocket) {
    let greeted = false;
    const helloTimer = setTimeout(() => {
      if (!greeted) ws.close(4001, "no hello");
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (raw) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!m || typeof m !== "object" || typeof m.type !== "string") return;

      if (m.type === "ping") {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "pong", t: m.t }));
        return;
      }
      if (!greeted) {
        if (m.type !== "hello") return;
        if (m.ext !== EXT_NAME || m.protocol !== PROTOCOL_VERSION) {
          ws.close(4003, "unsupported client");
          return;
        }
        greeted = true;
        clearTimeout(helloTimer);
        this.promote(ws, String(m.version ?? "0"));
        return;
      }
      if (m.type === "response" && (typeof m.id === "string" || typeof m.id === "number")) {
        const p = this.pending.get(String(m.id));
        if (!p || p.ws !== ws) return;
        clearTimeout(p.timer);
        this.pending.delete(String(m.id));
        if (m.ok === true) p.resolve(m.result ?? null);
        else p.reject(new ExtError(String(m.error?.code || ERR.INTERNAL), String(m.error?.message || `${p.method} failed`)));
      }
      // pong and anything else: nothing to do.
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      this.dropPending(ws, "the extension disconnected");
      if (this.current === ws) {
        this.current = null;
        this.info = null;
        this.log("ext: extension disconnected");
        this.emit("disconnect", { reason: "closed" });
      }
    });
    ws.on("error", () => {});
  }

  private promote(ws: WebSocket, version: string) {
    const old = this.current;
    this.current = ws;
    this.info = { version, connectedAt: Date.now() };
    if (old && old !== ws) {
      this.dropPending(old, "replaced by a newer extension connection");
      old.close(4002, "replaced");
    }
    ws.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL_VERSION, server: SERVER_NAME }));
    this.log(`ext: extension connected (version ${version})`);
    this.emit("connect", this.info);
  }

  private dropPending(ws: WebSocket, why: string) {
    for (const [id, p] of this.pending) {
      if (p.ws !== ws) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new ExtError(ERR.NOT_CONNECTED, `${p.method} failed: ${why}`));
    }
  }
}

// The process-wide bridge used by server.ts, session.ts and pay.ts.
export const extBridge = new ExtBridge();

// CLEARCART_BROWSER=ext switches session.ts and pay.ts to this bridge. Read
// lazily so a value from .env (loaded after imports) still counts.
export function extMode(): boolean {
  return process.env.CLEARCART_BROWSER === "ext";
}
