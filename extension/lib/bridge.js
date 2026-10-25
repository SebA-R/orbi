// WebSocket client for the agent server's bridge (ws://localhost:5050/ext).
//
// The extension is the client: the agent server sends requests, the
// extension runs them and answers. Written against the standard WebSocket
// API so it runs unchanged in the service worker and in Node tests.

import { MSG, hello, parseMessage } from "./protocol.js";

const HELLO_TIMEOUT_MS = 5_000;

export class BridgeClient {
  constructor({ url, version = "0", log = console, WebSocketImpl = globalThis.WebSocket, onState = () => {} }) {
    this.url = url;
    this.version = version;
    this.log = log;
    this.WebSocketImpl = WebSocketImpl;
    this.onState = onState;
    this.ws = null;
    this.state = "idle"; // idle | connecting | open | closed
    this.wanted = false;
    this.helloTimer = null;
  }

  start() {
    this.wanted = true;
    if (!this.ws) this.connect();
  }

  stop() {
    this.wanted = false;
    this.ws?.close(1000, "stopped");
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }

  connect() {
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (e) {
      this.log.warn(`bridge: cannot open ${this.url}: ${e.message}`);
      this.setState("closed");
      return;
    }
    this.ws = ws;
    this.setState("connecting");
    ws.onopen = () => {
      this.send(hello(this.version));
      this.helloTimer = setTimeout(() => {
        this.log.warn("bridge: no welcome from the agent server");
        ws.close(4000, "no welcome");
      }, HELLO_TIMEOUT_MS);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const m = parseMessage(typeof e.data === "string" ? e.data : "");
      if (m) this.handle(m);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearTimeout(this.helloTimer);
      this.ws = null;
      this.setState("closed");
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  handle(m) {
    if (m.type === MSG.WELCOME) {
      clearTimeout(this.helloTimer);
      this.log.info(`bridge: connected to ${m.server || "agent server"} (protocol ${m.protocol})`);
      this.setState("open");
    }
  }
}
