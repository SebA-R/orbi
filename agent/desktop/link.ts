// The link to Orbi Desktop: a Unix domain socket, not TCP, so no other
// process can take the port, shadow it, or sit in the middle.
//
//   ~/Library/Application Support/Orbi/desktop.sock   (ORBI_DESKTOP_SOCKET overrides)
//
// The directory is 0700 and the socket 0600, so only this user (and root)
// can connect; Node has no getpeereid, so that file mode is the server's
// uid check. The helper checks the server's uid with getpeereid, and the
// HMAC handshake (token.ts) runs on top.
//
// Frames: a 4-byte big-endian length, then that many bytes: one type byte
// (1 = JSON text, 2 = binary audio) and the payload. A close is a JSON
// frame {type:"close", code, reason} followed by the end of the stream.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const FRAME_JSON = 1;
export const FRAME_BINARY = 2;
export const MAX_FRAME = 32 * 1024 * 1024;

export function desktopSocketPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.ORBI_DESKTOP_SOCKET?.trim()) return path.resolve(env.ORBI_DESKTOP_SOCKET.trim());
  return path.join(home, "Library", "Application Support", "Orbi", "desktop.sock");
}

export function encodeFrame(type: number, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, body]);
}

// Splits a byte stream into frames. Returns false (and stops) on a frame
// that is empty, too large or of an unknown type.
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private onFrame: (type: number, payload: Buffer) => void) {}
  push(chunk: Buffer): boolean {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < 1 || len > MAX_FRAME + 1) return false;
      if (this.buf.length < 4 + len) return true;
      const type = this.buf[4];
      if (type !== FRAME_JSON && type !== FRAME_BINARY) return false;
      const payload = this.buf.subarray(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.onFrame(type, payload);
    }
    return true;
  }
}

// What the bridge needs from a connection, shaped like the ws WebSocket it
// replaced: send text or binary, close with a code, message/close events.
export class LinkSocket extends EventEmitter {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  constructor(private sock: net.Socket) {
    super();
    const dec = new FrameDecoder((type, payload) => {
      if (this.readyState !== this.OPEN) return;
      this.emit("message", type === FRAME_BINARY ? payload : payload.toString("utf8"), type === FRAME_BINARY);
    });
    sock.on("data", (chunk) => {
      if (!dec.push(chunk as Buffer)) this.close(4000, "bad frame");
    });
    sock.on("close", () => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close", 1006);
    });
    sock.on("error", () => {});
  }
  send(data: string | Buffer, opts: { binary?: boolean } = {}) {
    if (this.readyState !== this.OPEN) return;
    const binary = opts.binary ?? typeof data !== "string";
    this.sock.write(encodeFrame(binary ? FRAME_BINARY : FRAME_JSON, data));
  }
  close(code = 1000, reason = "") {
    if (this.readyState !== this.OPEN) return;
    this.sock.write(encodeFrame(FRAME_JSON, JSON.stringify({ type: "close", code, reason })));
    this.readyState = 2;
    this.sock.end();
    this.readyState = 3;
    this.emit("close", code);
  }
  terminate() {
    this.readyState = 3;
    this.sock.destroy();
  }
}

// Makes the 0700 directory, clears a stale socket (only a socket of this
// user that nothing answers on), listens, and sets the socket to 0600. A
// live socket, or a path that is not this user's socket, is left alone and
// the listen fails.
export async function listenDesktop(sockPath: string, onConnection: (s: LinkSocket) => void): Promise<net.Server> {
  // macOS caps a socket path at 104 bytes (sun_path); longer would be cut.
  if (Buffer.byteLength(sockPath) >= 104) throw new Error(`${sockPath} is too long for a Unix socket`);
  const dir = path.dirname(sockPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(sockPath);
  } catch {}
  if (st) {
    if (!st.isSocket() || st.uid !== process.getuid?.()) throw new Error(`${sockPath} exists and is not this user's socket; not touching it`);
    const live = await new Promise<boolean>((resolve) => {
      const c = net.connect(sockPath);
      c.once("connect", () => {
        c.destroy();
        resolve(true);
      });
      c.once("error", () => resolve(false));
    });
    if (live) throw new Error(`another Orbi server is already listening on ${sockPath}`);
    fs.unlinkSync(sockPath);
  }
  const server = net.createServer((sock) => onConnection(new LinkSocket(sock)));
  const old = process.umask(0o077); // the socket is born 0600
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => resolve());
    });
  } finally {
    process.umask(old);
  }
  fs.chmodSync(sockPath, 0o600);
  return server;
}
