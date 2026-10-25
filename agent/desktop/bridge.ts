// Server side of the Orbi Desktop bridge, over a Unix domain socket
// (link.ts: ~/Library/Application Support/Orbi/desktop.sock, framed JSON
// and audio). There is no TCP endpoint for the helper.
//
// The native menu-bar helper (desktop/) is the client: it connects, sends
// hello, proves the token (token.ts), and we reply welcome. After that we send requests ({type:"req"})
// and it answers ({type:"res"}). One helper at a time: a newer hello
// replaces the older socket (newest wins), like the extension bridge.
//
// The helper also sends push-to-talk events (ptt_down, ptt_up,
// latch_toggle) and binary frames of mic audio (PCM s16le, 16 kHz mono).
// We send binary frames of speech (PCM s16le, 24 kHz mono), audio_stop for
// a barge-in, and overlay updates.
//
// Params and results can hold what is on the user's screen, so nothing
// here ever logs them: only method names and error codes.

import type { SpeechUpdate } from "./voice.ts";
import { EventEmitter } from "node:events";
import type net from "node:net";

import { LinkSocket, listenDesktop } from "./link.ts";

import { userBlockedApps } from "./safety.ts";
import { NONCE, helperProof, newNonce, proofMatches, serverProof, tokenMatches } from "./token.ts";

export const DESKTOP_PROTOCOL_VERSION = 1;
export const DESKTOP_HELPER_NAME = "orbi-desktop";
export const DESKTOP_METHODS = [
  "frontmost",
  "apps_list",
  "app_activate",
  "ax_tree",
  "element",
  "element_at",
  "focused",
  "click",
  "type",
  "key",
  "scroll",
  "screenshot",
  "overlay",
] as const;
export type DesktopMethod = (typeof DESKTOP_METHODS)[number];
export const DERR = {
  BAD_REQUEST: "bad_request",
  UNKNOWN_METHOD: "unknown_method",
  NOT_ALLOWED: "not_allowed",
  NO_ELEMENT: "no_element",
  STALE_REF: "stale_ref",
  TARGET_CHANGED: "target_changed",
  SECURE_FIELD: "secure_field",
  BLOCKED_APP: "blocked_app",
  NO_PERMISSION: "no_permission",
  TIMEOUT: "timeout",
  NOT_CONNECTED: "not_connected",
  INTERNAL: "internal",
} as const;
export const DESKTOP_REQUEST_TIMEOUT_MS = 20_000;
const HELLO_TIMEOUT_MS = 5_000;

export class DesktopError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "DesktopError";
  }
}

export type DesktopPermissions = { accessibility: boolean; screen: boolean; mic: boolean };
// features: what the helper says it supports beyond the base methods, e.g.
// "expectRef" (click {x,y} re-checks the element under the point).
export type DesktopInfo = { connectedAt: number; permissions: DesktopPermissions; features: string[] };
export type OverlayState = "idle" | "listening" | "thinking" | "speaking";
// v1 fields; the rest need the helper's "overlay2" feature (state may then
// be left out). docs/desktop-protocol.md has them all.
export type Overlay = {
  state?: OverlayState;
  subtitle?: string;
  cursor?: { x: number; y: number };
  ring?: boolean | { x: number; y: number; w: number; h: number; label?: string };
  speech?: SpeechUpdate;
};

export interface DesktopBridgeEvents {
  connect: [DesktopInfo];
  disconnect: [{ reason: string }];
  ptt_down: [];
  ptt_up: [];
  latch_toggle: [];
  audio: [Buffer];
}

type WebSocket = LinkSocket;
type Pending = { ws: WebSocket; method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const bool = (v: unknown) => v === true;

export class DesktopBridge extends EventEmitter<DesktopBridgeEvents> {
  private server: net.Server | null = null;
  private sockets = new Set<WebSocket>();
  private current: WebSocket | null = null;
  private info: DesktopInfo | null = null;
  private pending = new Map<string, Pending>();
  private counter = 0;

  // blockedApps: the user's extra blocked apps (safety.ts), sent in welcome
  // so the helper refuses them too. The server enforces them either way.
  // token: the shared secret both sides prove with (token.ts). Null
  // (no token could be made) refuses every helper.
  constructor(private log: (line: string) => void = (l) => console.log(l), private blockedApps: () => string[] = () => [], private token: () => string | null = () => null) {
    super();
  }

  // Starts listening on the socket path (link.ts).
  async listen(sockPath: string): Promise<void> {
    this.server = await listenDesktop(sockPath, (s) => this.attach(s));
  }

  // One new connection (from listen, or a test).
  attach(ws: WebSocket) {
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    this.accept(ws);
  }

  connected(): boolean {
    return !!this.current && this.current.readyState === this.current.OPEN;
  }

  helperInfo(): DesktopInfo | null {
    return this.connected() ? this.info : null;
  }

  call<T = any>(method: DesktopMethod, params: Record<string, unknown> = {}, timeoutMs = DESKTOP_REQUEST_TIMEOUT_MS): Promise<T> {
    const ws = this.current;
    if (!ws || ws.readyState !== ws.OPEN) {
      return Promise.reject(new DesktopError(DERR.NOT_CONNECTED, "Orbi Desktop is not connected. Ask the user to open the Orbi Desktop app."));
    }
    const id = `d${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log(`desktop: ${method} timed out`);
        reject(new DesktopError(DERR.TIMEOUT, `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { ws, method, resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new DesktopError(DERR.NOT_CONNECTED, `${method} could not be sent`));
      }
    });
  }

  // Fire and forget: overlay updates and audio never wait on an answer.
  overlay(o: Overlay) {
    this.call("overlay", o as unknown as Record<string, unknown>, 5_000).catch(() => {});
  }

  sendAudio(pcm: Buffer) {
    const ws = this.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(pcm, { binary: true });
  }

  audioStop() {
    const ws = this.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "audio_stop" }));
  }

  close() {
    this.current?.close(1001, "server closing");
    for (const ws of this.sockets) ws.terminate();
    this.server?.close();
    this.server = null;
  }

  private accept(ws: WebSocket) {
    let greeted = false;
    // Between hello and auth: the hello, both nonces and the token used.
    let pending: { hello: any; helperNonce: string; serverNonce: string; token: string } | null = null;
    const helloTimer = setTimeout(() => {
      if (!greeted) ws.close(4001, "no hello");
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        // Mic audio, only from the helper in charge.
        if (greeted && ws === this.current) this.emit("audio", Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
        return;
      }
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
        const refuse = () => {
          this.log("desktop: refused a helper that could not prove the token");
          ws.close(4004, "unauthorized");
        };
        // hello {nonce} -> challenge {nonce, proof} -> auth {proof} -> welcome.
        // The token itself never crosses the socket.
        if (m.type === "auth" && pending) {
          const { hello, helperNonce, serverNonce, token } = pending;
          pending = null;
          if (!proofMatches(helperProof(token, serverNonce, helperNonce), m.proof)) return refuse();
          greeted = true;
          clearTimeout(helloTimer);
          const p = hello.permissions && typeof hello.permissions === "object" ? hello.permissions : {};
          const features = Array.isArray(hello.features) ? hello.features.filter((f: unknown) => typeof f === "string").slice(0, 50) : [];
          this.promote(ws, { accessibility: bool(p.accessibility), screen: bool(p.screen), mic: bool(p.mic) }, features);
          return;
        }
        if (m.type !== "hello" || pending) return refuse();
        if (m.name !== DESKTOP_HELPER_NAME || m.version !== DESKTOP_PROTOCOL_VERSION) {
          ws.close(4003, "unsupported client");
          return;
        }
        let token: string | null = null;
        try {
          token = this.token();
        } catch {}
        // tokenMatches(token, token): the server has a well formed token.
        if (!token || !tokenMatches(token, token) || typeof m.nonce !== "string" || !NONCE.test(m.nonce)) return refuse();
        const serverNonce = newNonce();
        pending = { hello: m, helperNonce: m.nonce, serverNonce, token };
        ws.send(JSON.stringify({ type: "challenge", nonce: serverNonce, proof: serverProof(token, m.nonce, serverNonce) }));
        return;
      }
      if (ws !== this.current) return;
      if (m.type === "res" && (typeof m.id === "string" || typeof m.id === "number")) {
        const p = this.pending.get(String(m.id));
        if (!p || p.ws !== ws) return;
        clearTimeout(p.timer);
        this.pending.delete(String(m.id));
        if (m.error) {
          const code = typeof m.error.code === "string" ? m.error.code : DERR.INTERNAL;
          this.log(`desktop: ${p.method} failed (${code})`);
          p.reject(new DesktopError(code, typeof m.error.message === "string" ? m.error.message : `${p.method} failed`));
        } else p.resolve(m.result ?? null);
        return;
      }
      // Talk key events: {type:"event", name}, or the bare {type:name}.
      const ev = m.type === "event" ? m.name : m.type;
      if (ev === "ptt_down" || ev === "ptt_up" || ev === "latch_toggle") this.emit(ev);
      // Anything else: nothing to do.
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      this.dropPending(ws, "Orbi Desktop disconnected");
      if (this.current === ws) {
        this.current = null;
        this.info = null;
        this.log("desktop: helper disconnected");
        this.emit("disconnect", { reason: "closed" });
      }
    });
    ws.on("error", () => {});
  }

  private promote(ws: WebSocket, permissions: DesktopPermissions, features: string[]) {
    const old = this.current;
    this.current = ws;
    this.info = { connectedAt: Date.now(), permissions, features };
    if (old && old !== ws) {
      this.dropPending(old, "replaced by a newer Orbi Desktop connection");
      old.close(4002, "replaced");
    }
    let blockedApps: string[] = [];
    try {
      blockedApps = this.blockedApps();
    } catch {}
    ws.send(JSON.stringify({ type: "welcome", version: DESKTOP_PROTOCOL_VERSION, blockedApps }));
    const missing = (Object.keys(permissions) as Array<keyof DesktopPermissions>).filter((k) => !permissions[k]);
    this.log(`desktop: helper connected${missing.length ? ` (missing permissions: ${missing.join(", ")})` : ""}`);
    this.emit("connect", this.info);
  }

  private dropPending(ws: WebSocket, why: string) {
    for (const [id, p] of this.pending) {
      if (p.ws !== ws) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new DesktopError(DERR.NOT_CONNECTED, `${p.method} failed: ${why}`));
    }
  }
}

// The process-wide bridge used by server.ts and session.ts.
// server.ts sets the token at startup (setDesktopToken); until then, none.
let serverToken: string | null = null;
export function setDesktopToken(t: string | null) {
  serverToken = t;
}
export const desktopBridge = new DesktopBridge(undefined, () => userBlockedApps(), () => serverToken);
