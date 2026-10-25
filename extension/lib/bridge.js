// WebSocket client for the agent server's bridge (ws://localhost:5050/ext).
//
// The extension is the client: the agent server sends requests, the
// extension runs them and answers. Written against the standard WebSocket
// API so it runs unchanged in the service worker and in Node tests.

import { Backoff } from "./backoff.js";
import { ERR, MSG, TIMING, errorResponse, hello, okResponse, parseMessage } from "./protocol.js";

const HELLO_TIMEOUT_MS = 5_000;

export class BridgeClient {
  constructor({ url, version = "0", log = console, WebSocketImpl = globalThis.WebSocket, onState = () => {}, onOpen = () => {}, onRequest = null, timing = {} }) {
    this.url = url;
    this.timing = { ...TIMING, ...timing };
    this.version = version;
    this.log = log;
    this.WebSocketImpl = WebSocketImpl;
    this.onState = onState;
    this.onOpen = onOpen;
    this.onRequest = onRequest;
    this.ws = null;
    this.state = "idle"; // idle | connecting | open | closed
    this.wanted = false;
    this.helloTimer = null;
    this.beatTimer = null;
    this.retryTimer = null;
    this.lastSeen = 0;
    this.backoff = new Backoff({ min: this.timing.BACKOFF_MIN_MS, max: this.timing.BACKOFF_MAX_MS });
  }

  start() {
    this.wanted = true;
    if (!this.ws && !this.retryTimer) this.connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close(1000, "stopped");
  }

  // Called when the worker wakes up (alarm, startup): reconnect right away
  // instead of waiting out a long backoff.
  ensureConnected() {
    if (!this.wanted || this.ws) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  setUrl(url) {
    if (url === this.url) return;
    this.url = url;
    this.backoff.reset();
    if (this.ws) this.drop(this.ws, "url changed");
    else this.ensureConnected();
  }

  scheduleReconnect() {
    if (!this.wanted || this.retryTimer) return;
    const delay = this.backoff.next();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted && !this.ws) this.connect();
    }, delay);
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
      this.scheduleReconnect();
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
      this.lastSeen = Date.now();
      const m = parseMessage(typeof e.data === "string" ? e.data : "");
      if (m) this.handle(m);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearTimeout(this.helloTimer);
      clearInterval(this.beatTimer);
      this.ws = null;
      this.setState("closed");
      this.scheduleReconnect();
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
      this.backoff.reset();
      this.setState("open");
      this.startHeartbeat();
      this.onOpen();
    } else if (m.type === MSG.PING) {
      this.send({ type: MSG.PONG, t: m.t });
    } else if (m.type === MSG.REQUEST) {
      this.answer(m);
    }
  }

  // Runs one server request through onRequest(method, params) and replies on
  // the socket it came in on. Errors carry their ERR code; anything else is
  // reported as internal.
  async answer({ id, method, params }) {
    const ws = this.ws;
    let reply;
    if (!this.onRequest) {
      reply = errorResponse(id, ERR.UNKNOWN_METHOD, `no handler for ${method}`);
    } else {
      try {
        reply = okResponse(id, await this.onRequest(method, params));
      } catch (e) {
        reply = errorResponse(id, e?.code || ERR.INTERNAL, e?.message || "failed");
      }
    }
    if (this.ws === ws) this.send(reply);
  }

  // Keepalive. Chrome 116+ resets the service worker's idle timer on
  // WebSocket traffic, so a ping every 20 s keeps the worker (and the socket)
  // alive. Silence for DEAD_AFTER_MS means the link is gone even if the
  // socket still claims to be open (sleep, network change), so drop it.
  startHeartbeat() {
    clearInterval(this.beatTimer);
    this.lastSeen = Date.now();
    const ws = this.ws;
    this.beatTimer = setInterval(() => {
      if (this.ws !== ws) return clearInterval(this.beatTimer);
      if (Date.now() - this.lastSeen > this.timing.DEAD_AFTER_MS) {
        this.log.warn("bridge: no traffic from the agent server, reconnecting");
        this.drop(ws, "heartbeat timeout");
        return;
      }
      this.send({ type: MSG.PING, t: Date.now() });
    }, this.timing.HEARTBEAT_MS);
  }

  // Close and forget a socket now, without waiting for the close handshake.
  drop(ws, reason) {
    try {
      ws.close(4001, reason);
    } catch {}
    ws.onclose?.({ code: 4001 });
  }
}
