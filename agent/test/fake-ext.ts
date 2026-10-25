// A fake Clearcart extension for tests: a ws client that does the hello
// handshake and answers requests with a handler.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

import { ExtBridge } from "../extbridge.ts";

export type Handler = (method: string, params: any) => any | Promise<any>;

export class FakeExt {
  ws!: WebSocket;
  welcome: any = null;
  requests: Array<{ method: string; params: any }> = [];
  closed: { code: number; reason: string } | null = null;
  private pongs: Array<(m: any) => void> = [];

  constructor(public url: string, public handler: Handler = () => null, public version = "0.0.1") {}

  open(sendHello = true): Promise<void> {
    this.ws = new WebSocket(this.url);
    this.ws.on("close", (code, reason) => (this.closed = { code, reason: String(reason) }));
    return new Promise((resolve, reject) => {
      this.ws.once("error", reject);
      this.ws.on("message", async (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === "welcome") {
          this.welcome = m;
          resolve();
        } else if (m.type === "pong") {
          this.pongs.shift()?.(m);
        } else if (m.type === "request") {
          this.requests.push({ method: m.method, params: m.params });
          try {
            const result = await this.handler(m.method, m.params);
            if (result === NO_REPLY) return;
            this.ws.send(JSON.stringify({ type: "response", id: m.id, ok: true, result: result ?? null }));
          } catch (e: any) {
            this.ws.send(
              JSON.stringify({ type: "response", id: m.id, ok: false, error: { code: e.code || "internal", message: e.message } })
            );
          }
        }
      });
      this.ws.once("open", () => {
        if (sendHello) this.ws.send(JSON.stringify({ type: "hello", protocol: 1, ext: "clearcart", version: this.version }));
        else resolve();
      });
    });
  }

  ping(t = 42): Promise<any> {
    return new Promise((resolve) => {
      this.pongs.push(resolve);
      this.ws.send(JSON.stringify({ type: "ping", t }));
    });
  }

  waitClosed(): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve) => this.ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })));
  }

  close() {
    this.ws?.close();
  }
}

export const NO_REPLY = Symbol("no reply");

export class ExtError2 extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function startBridge(): Promise<{ bridge: ExtBridge; server: http.Server; url: string; stop: () => Promise<void> }> {
  const bridge = new ExtBridge(() => {});
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  bridge.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    bridge,
    server,
    url: `ws://127.0.0.1:${port}/ext`,
    stop: async () => {
      bridge.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export function onceEvent<T = any>(em: { once: (e: any, f: (v: T) => void) => any }, name: string): Promise<T> {
  return new Promise((resolve) => em.once(name, resolve));
}
