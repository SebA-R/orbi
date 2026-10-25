// The agent session socket (ws://localhost:5050/session by default), the same
// one voice/public/js/app.js talks to: we send {type:"user_text", text}; the
// agent sends {type:"agent_text"|"status"|"receipt", ...}. Reconnects with
// backoff; messages sent while disconnected are queued.
import { Backoff } from "../backoff.js";

export class AgentSession {
  constructor({ url, onMessage, onState = () => {}, log = () => {}, WebSocketImpl = globalThis.WebSocket, backoff = new Backoff({ min: 500, max: 5000 }), setTimer = (fn, ms) => setTimeout(fn, ms) }) {
    Object.assign(this, { url, onMessage, onState, log, WebSocketImpl, backoff, setTimer });
    this.ws = null;
    this.outbox = [];
    this.stopped = false;
  }

  connect() {
    if (this.stopped || this.ws) return;
    const url = typeof this.url === "function" ? this.url() : this.url;
    const ws = new this.WebSocketImpl(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff.reset();
      this.onState("open");
      for (const msg of this.outbox) ws.send(msg);
      this.outbox = [];
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { this.log("agent sent a non-JSON message"); return; }
      if (m && typeof m.type === "string") this.onMessage(m);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onState("closed");
      if (!this.stopped) this.setTimer(() => this.connect(), this.backoff.next());
    };
  }

  send(obj) {
    const msg = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === 1) this.ws.send(msg);
    else {
      this.outbox.push(msg);
      this.connect();
    }
  }

  // Point at a new URL (settings changed): drop the socket and reconnect.
  reconnect() {
    const ws = this.ws;
    this.ws = null;
    if (ws) try { ws.close(); } catch {}
    this.connect();
  }

  close() {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) try { ws.close(); } catch {}
  }
}
