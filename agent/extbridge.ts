// Server side of the Orbi extension bridge (ws://localhost:5050/ext).
//
// The extension is the client: it connects, sends hello, and we reply
// welcome. After that we send requests and it answers. One extension at a
// time, and the first one keeps the bridge until it goes away:
//   - Each install sends a stable random client id in its hello. A hello
//     with the id of the connected client (a reloaded service worker, a
//     reconnect after sleep) replaces the old socket at once.
//   - A hello from any other client (a second Chrome profile, a test
//     Chromium that loaded the extension) is refused with 4004 while the
//     owner is live, and that client keeps retrying on its backoff. Before,
//     the newest hello always won; both clients reconnect on their own, so
//     two of them took the bridge from each other forever, each bringing
//     its own settings (provider, Danger mode) and restarting the session.
//   - An owner silent for STALE_AFTER_MS (no ping or reply) counts as gone,
//     so a half-open socket can't hold the bridge.
// A hello without an id (an older extension) is a client of its own: it
// replaces nobody and is refused like any other while an owner is live.
//
// Request params can hold card values (fill_card), so nothing here ever
// logs params or results; only method names and error codes.

import { EventEmitter } from "node:events";
import type http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { parseBlockLines, type BlockEntry } from "./blocklist.ts";
import { extensionOrigins } from "./hostcheck.ts";
import { parseClaudeModel, parseLocalBaseUrl, parseLocalModel, parseProvider, type ClaudeModel, type Provider } from "./local/config.ts";
import { SEARCH_ENGINES, type SearchEngine } from "./search-engines.ts";

// Mirrors extension/lib/protocol.js (the test checks they agree). Kept as a
// copy because that file is plain JS outside this tsconfig.
export const PROTOCOL_VERSION = 1;
export const EXT_NAME = "clearcart";
export const SERVER_NAME = "clearcart-agent";
export const TOOLS = [
  "tabs_context",
  "tabs_create",
  "tabs_close",
  "tabs_activate",
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
  "dismiss_overlay",
] as const;
export const INTERNAL = ["tab_info", "agent_tabs", "page_context", "fill_card", "clear_card", "card_state", "order_buttons", "rect", "click_ref", "lock_arm", "press_protected", "press_unlocked", "lock_info", "actions_stop"] as const;
export const ERR = {
  BAD_REQUEST: "bad_request",
  UNKNOWN_METHOD: "unknown_method",
  NOT_ALLOWED: "not_allowed",
  NO_TAB: "no_tab",
  NO_ELEMENT: "no_element",
  PAYMENT_FIELD: "payment_field",
  LOCKED: "locked",
  TIMEOUT: "timeout",
  NOT_CONNECTED: "not_connected",
  INTERRUPTED: "interrupted",
  // The page did not load: no connection, unknown address, refused (tabs.js).
  NET_ERROR: "net_error",
  INTERNAL: "internal",
} as const;
export const REQUEST_TIMEOUT_MS = 30_000;
// type goes key by key at a typist's cadence with page checks around every
// key (router.js guardChar), so long text needs more than the flat timeout.
// Generous per character: a request that times out while the extension is
// still typing leaves the agent free to retry over it.
export const TYPE_MS_PER_CHAR = 250;
// dismiss_overlay can try two paced clicks and an Escape, each with a settle.
export const DISMISS_TIMEOUT_MS = 60_000;
// Under the 90 s browser tool timeout (exttools.ts, session.ts), so this
// timer fires first and sends actions_stop: text too long for it stops
// part way instead of typing on behind a retry.
export const MAX_REQUEST_TIMEOUT_MS = 85_000;
// Paced actions the extension keeps playing after the server gives up on
// them: a timeout sends actions_stop so nothing keeps going behind a retry
// (or presses a button after the caller was told it failed).
const STOP_ON_TIMEOUT: ReadonlySet<string> = new Set(["type", "click", "scroll", "dismiss_overlay", "press_protected", "press_unlocked"]);

// The default timeout for a request: the flat one, plus time per character
// for type and more headroom for dismiss_overlay.
export function requestTimeoutFor(method: string, params: Record<string, unknown> = {}): number {
  if (method === "type" && typeof params.text === "string") {
    return Math.min(MAX_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS + [...params.text].length * TYPE_MS_PER_CHAR);
  }
  if (method === "dismiss_overlay") return DISMISS_TIMEOUT_MS;
  return REQUEST_TIMEOUT_MS;
}
const HELLO_TIMEOUT_MS = 5_000;
// A client's ping comes every 20 s (protocol.js TIMING.HEARTBEAT_MS); this
// long without a message means the owner's socket is dead even if it looks
// open (protocol.js TIMING.DEAD_AFTER_MS).
export const STALE_AFTER_MS = 45_000;
// Bridge close codes; mirror extension/lib/protocol.js CLOSE.
export const CLOSE = { REPLACED: 4002, BUSY: 4004 } as const;
// Close code for a hello refused because another client owns the bridge.
export const BUSY_CLOSE = CLOSE.BUSY;
// A client id; mirrors extension/lib/protocol.js CLIENT_ID_RE.
export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// A client id from a hello: a short token, or null when absent or malformed.
export function parseClientId(v: unknown): string | null {
  return typeof v === "string" && CLIENT_ID_RE.test(v) ? v : null;
}

export class ExtError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ExtError";
  }
}

type Pending = { ws: WebSocket; method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export type ExtInfo = { version: string; connectedAt: number };

// The user's agent provider settings as the extension sent them: Claude
// (and which Claude model) or a local model, and the local endpoint
// (local/config.ts). A field is null
// until the extension sends a good value for it.
export type ExtProviderSettings = { provider: Provider | null; claudeModel: ClaudeModel | null; localBaseUrl: string | null; localModel: string | null; localVision: boolean | null };

export interface ExtBridgeEvents {
  connect: [ExtInfo];
  disconnect: [{ reason: string }];
  blocklist: [readonly BlockEntry[]];
  settings: [{ guidedMode: boolean; memory: boolean | null }];
  danger_mode: [boolean];
  provider: [ExtProviderSettings];
}

// The Origin of an /ext upgrade: none (not a browser) or Orbi's own
// extension (hostcheck.ts extensionOrigins).
export function extOriginAllowed(origin: string | string[] | undefined, origins: ReadonlySet<string> = extensionOrigins()): boolean {
  if (origin === undefined) return true;
  return typeof origin === "string" && origins.has(origin);
}

export class ExtBridge extends EventEmitter<ExtBridgeEvents> {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  private current: WebSocket | null = null;
  // The current socket's client id (null: none sent) and when it last sent
  // anything.
  private currentId: string | null = null;
  private lastSeen = 0;
  // The last client refused as busy, so a retrying one is logged once.
  private lastRefused: string | null | undefined = undefined;
  private info: ExtInfo | null = null;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private entries: readonly BlockEntry[] | null = null;
  private guided: boolean | null = null;
  private engine: SearchEngine | null = null;
  private danger = false;
  private memory: boolean | null = null;
  private agent: ExtProviderSettings = { provider: null, claudeModel: null, localBaseUrl: null, localModel: null, localVision: null };

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

  // The user's blocked sites as the extension last sent them (kept across a
  // reconnect), or null before the first one arrives.
  blocklist(): readonly BlockEntry[] | null {
    return this.entries;
  }

  // The user's Guided mode setting as the extension last sent it (kept
  // across a reconnect), or null before the first one arrives.
  guidedMode(): boolean | null {
    return this.guided;
  }

  // The user's Search engine setting as the extension last sent it (kept
  // across a reconnect), or null before the first one arrives.
  searchEngine(): SearchEngine | null {
    return this.engine;
  }

  // The user's Memory setting as the extension last sent it (kept across a
  // reconnect), or null before the first one arrives (an older extension
  // never sends it).
  memoryEnabled(): boolean | null {
    return this.memory;
  }

  // The user's agent provider settings as the extension last sent them
  // (kept across a reconnect). Each field is null until a good value
  // arrives (an older extension never sends them); a value that fails its
  // check is refused and the last good one stays.
  providerSettings(): ExtProviderSettings {
    return { ...this.agent };
  }

  // The user's Danger mode setting as the extension last sent it (false
  // until it does, and again once it disconnects). The extension enforces
  // the click lock itself; the server reads this to skip the spoken yes
  // (session.ts), so only the connected extension can set it.
  dangerMode(): boolean {
    return this.danger;
  }

  // Resolves once an extension is connected, or rejects after timeoutMs.
  waitForConnection(timeoutMs = 5_000): Promise<void> {
    if (this.connected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("connect", on);
        reject(new ExtError(ERR.NOT_CONNECTED, "The Orbi extension is not connected."));
      }, timeoutMs);
      const on = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("connect", on);
    });
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = requestTimeoutFor(method, params)): Promise<T> {
    const ws = this.current;
    if (!ws || ws.readyState !== ws.OPEN) {
      return Promise.reject(new ExtError(ERR.NOT_CONNECTED, "The Orbi extension is not connected. Open Chrome with the extension enabled."));
    }
    const id = `s${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The extension may still be playing it: stop it before anyone retries.
        if (STOP_ON_TIMEOUT.has(method) && ws === this.current) this.call("actions_stop", {}, 5_000).catch(() => {});
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
  // their own noServer WebSocketServers, anything else gets a 400. `verify`
  // (the server's Host check) runs first; a refused upgrade gets a 403.
  attach(server: http.Server, others: Record<string, WebSocketServer> = {}, path = "/ext", verify: (req: http.IncomingMessage) => boolean = () => true) {
    server.on("upgrade", (req, socket, head) => {
      if (!verify(req)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      let pathname = "";
      try {
        pathname = new URL(req.url || "/", "http://localhost").pathname;
      } catch {}
      const target = pathname === path ? this.wss : others[pathname];
      if (!target) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      // Only the extension may be the extension: not a web page, not the
      // voice console, not another extension. Otherwise it could take over
      // the bridge and send settings such as Danger mode, or receive the
      // card pay_with_saved_card fills. Clients outside a browser send no Origin.
      if (target === this.wss && !extOriginAllowed(req.headers.origin)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
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
      if (ws === this.current) this.lastSeen = Date.now();

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
        const clientId = parseClientId(m.client);
        if (!this.mayTakeOver(clientId)) {
          if (this.lastRefused !== clientId) this.log("ext: refused a second extension (another one is connected)");
          this.lastRefused = clientId;
          ws.close(CLOSE.BUSY, "another extension is connected");
          return;
        }
        this.promote(ws, String(m.version ?? "0"), clientId);
        return;
      }
      if (m.type === "response" && (typeof m.id === "string" || typeof m.id === "number")) {
        const p = this.pending.get(String(m.id));
        if (!p || p.ws !== ws) return;
        clearTimeout(p.timer);
        this.pending.delete(String(m.id));
        if (m.ok === true) p.resolve(m.result ?? null);
        else p.reject(new ExtError(String(m.error?.code || ERR.INTERNAL), String(m.error?.message || `${p.method} failed`)));
        return;
      }
      // The extension's blocked sites. Only read here: nothing on this side
      // can write extension settings.
      if (m.type === "blocklist" && ws === this.current && Array.isArray(m.lines)) {
        this.entries = parseBlockLines(m.lines.slice(0, 5000)).entries;
        this.log(`ext: blocked sites list updated (${this.entries.length} entries)`);
        this.emit("blocklist", this.entries);
      }
      if (m.type === "settings" && ws === this.current) {
        if (typeof m.guidedMode === "boolean") {
          this.guided = m.guidedMode;
          if (typeof m.memory === "boolean") this.memory = m.memory;
          this.log(`ext: guided mode ${this.guided ? "on" : "off"}, memory ${this.memory === false ? "off" : "on"}`);
          this.emit("settings", { guidedMode: m.guidedMode, memory: this.memory });
        }
        if ((SEARCH_ENGINES as readonly unknown[]).includes(m.searchEngine)) this.engine = m.searchEngine;
        this.takeProvider(m);
      }
      if (m.type === "danger_mode" && ws === this.current) {
        this.danger = m.on === true;
        this.log(`ext: Danger mode ${this.danger ? "on" : "off"}`);
        this.emit("danger_mode", this.danger);
      }
      // pong and anything else: nothing to do.
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      this.dropPending(ws, "the extension disconnected");
      if (this.current === ws) {
        this.current = null;
        this.currentId = null;
        this.info = null;
        this.danger = false;
        this.log("ext: extension disconnected");
        this.emit("disconnect", { reason: "closed" });
      }
    });
    ws.on("error", () => {});
  }

  // provider ("claude" or "local"), claudeModel (local/config.ts
  // CLAUDE_MODELS only), localBaseUrl (http(s) to localhost,
  // 127.0.0.1 or [::1] only), localModel (a short plain name) and
  // localVision from a settings message. Emits "provider" when they change.
  private takeProvider(m: Record<string, unknown>) {
    const next = { ...this.agent };
    const refused: string[] = [];
    const take = <K extends keyof ExtProviderSettings>(key: K, parse: (v: unknown) => ExtProviderSettings[K] | null) => {
      if (m[key] === undefined) return;
      const v = parse(m[key]);
      if (v === null) refused.push(key);
      else next[key] = v;
    };
    take("provider", parseProvider);
    take("claudeModel", parseClaudeModel);
    take("localBaseUrl", parseLocalBaseUrl);
    take("localModel", parseLocalModel);
    take("localVision", (v) => (typeof v === "boolean" ? v : null));
    if (refused.length) this.log(`ext: refused agent settings: ${refused.join(", ")}`);
    const keys = Object.keys(next) as Array<keyof ExtProviderSettings>;
    if (keys.every((k) => next[k] === this.agent[k])) return;
    this.agent = next;
    this.log(`ext: agent ${next.provider === "local" ? `local model ${next.localModel ?? "(default)"} at ${next.localBaseUrl ?? "(default)"}` : `${next.provider ?? "(default)"} ${next.claudeModel ?? "(default model)"}`}`);
    this.emit("provider", { ...next });
  }

  // Whether a greeted client may take the bridge: nobody holds it, the
  // holder is this same client again, or the holder has gone silent.
  private mayTakeOver(clientId: string | null): boolean {
    if (!this.connected()) return true;
    if (clientId !== null && clientId === this.currentId) return true;
    return Date.now() - this.lastSeen > STALE_AFTER_MS;
  }

  private promote(ws: WebSocket, version: string, clientId: string | null = null) {
    const old = this.current;
    const same = clientId !== null && clientId === this.currentId;
    this.current = ws;
    this.currentId = clientId;
    this.lastSeen = Date.now();
    this.lastRefused = undefined;
    this.info = { version, connectedAt: Date.now() };
    // A new connection states Danger mode itself (the worker sends it on connect).
    this.danger = false;
    let replay = false;
    if (old && old !== ws) {
      replay = this.dropPending(old, same ? "replaced by a newer connection from the same extension" : "replaced after it went silent");
      old.close(CLOSE.REPLACED, "replaced");
    }
    ws.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL_VERSION, server: SERVER_NAME }));
    // The same extension may still be playing a paced action whose call just
    // failed: stop it, as a timeout would, so a retry doesn't double it.
    if (same && replay) this.call("actions_stop", {}, 5_000).catch(() => {});
    this.log(`ext: extension connected (version ${version})`);
    this.emit("connect", this.info);
  }

  // Fails the socket's pending calls; answers whether one was a paced
  // action (STOP_ON_TIMEOUT).
  private dropPending(ws: WebSocket, why: string): boolean {
    let paced = false;
    for (const [id, p] of this.pending) {
      if (p.ws !== ws) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (STOP_ON_TIMEOUT.has(p.method)) paced = true;
      p.reject(new ExtError(ERR.NOT_CONNECTED, `${p.method} failed: ${why}`));
    }
    return paced;
  }
}

// The process-wide bridge used by server.ts, session.ts and pay.ts.
export const extBridge = new ExtBridge();

// CLEARCART_BROWSER=ext switches session.ts and pay.ts to this bridge. Read
// lazily so a value from .env (loaded after imports) still counts.
export function extMode(): boolean {
  return process.env.CLEARCART_BROWSER === "ext";
}
