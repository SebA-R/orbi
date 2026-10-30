import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// extbridge.ts first: origins.ts and prompt.ts import each other through it.
import "../extbridge.ts";
import { DesktopBridge, DesktopError } from "../desktop/bridge.ts";
import { encodeFrame, FrameDecoder, FRAME_BINARY, FRAME_JSON, LinkSocket, listenDesktop } from "../desktop/link.ts";
import { appBlockReason, classifyElement, decidePress, DesktopUnlockGate, keyEffect, keyLock, maskElement, parseCombo, type AXElement, type Target } from "../desktop/safety.ts";
import { desktopToolDefinitions, type DesktopHost } from "../desktop/tools.ts";
import { DesktopVoice, s16ToF32, SonicSpeaker, VOICE_OFF_TEXT } from "../desktop/voice.ts";
import { ensureDesktopToken, helperProof, newNonce, proofMatches, serverProof, tokenMatches } from "../desktop/token.ts";
import { isSpent, spendDirect } from "../user-unlock.ts";

const TOKEN = "ab".repeat(32);

process.env.ORBI_DESKTOP_BLOCKED_APPS = path.join(os.tmpdir(), `orbi-desktop-blocked-${process.pid}.txt`);

// HMAC vectors for token "ab"x32, helper nonce "01"x32, server nonce "02"x32.
const SERVER_VECTOR = "7d46559683f397d70ec8e45465080ec9b7557ad68430e55a5829e63d39c5e0ab";
const HELPER_VECTOR = "83ebbb5f69b3e568dbdef5bded7af8a37e2e967972decb3ed1b10e9525bee479";

// ------------------------------------------------------------ fake helper

// Over the real link (link.ts): a Unix socket in a temp dir, framed.
class FakeHelper {
  ws!: LinkSocket;
  welcome: any = null;
  closed: { code: number } | null = null;
  requests: Array<{ method: string; params: any }> = [];
  binary: Buffer[] = [];
  texts: any[] = [];
  private onClosed: Array<(c: { code: number }) => void> = [];
  constructor(public sockPath: string, public handler: (method: string, params: any) => any = () => null) {}
  serverProved: boolean | null = null;
  // The handshake as the real helper does it: hello with a nonce, check the
  // server's proof, answer with ours (made with authToken).
  open(hello: Record<string, unknown> = { type: "hello", name: "orbi-desktop", version: 1, nonce: newNonce(), features: ["element", "focused", "expectRef", "exclude"], permissions: { accessibility: true, screen: true, mic: false } }, authToken: string = TOKEN): Promise<void> {
    const sock = net.connect(this.sockPath);
    this.ws = new LinkSocket(sock);
    const closed = (code: number) => {
      if (this.closed) return;
      this.closed = { code };
      for (const f of this.onClosed.splice(0)) f(this.closed);
    };
    this.ws.on("close", () => closed(1006));
    return new Promise((resolve, reject) => {
      sock.once("error", reject);
      this.ws.on("close", () => reject(new Error(`closed ${this.closed?.code}`)));
      this.ws.on("message", async (raw: string | Buffer, isBinary: boolean) => {
        if (isBinary) return void this.binary.push(raw as Buffer);
        const m = JSON.parse(String(raw));
        this.texts.push(m);
        if (m.type === "close") {
          closed(m.code);
        } else if (m.type === "challenge") {
          this.serverProved = proofMatches(serverProof(TOKEN, String(hello.nonce), m.nonce), m.proof);
          this.ws.send(JSON.stringify({ type: "auth", proof: helperProof(authToken, m.nonce, String(hello.nonce)) }));
        } else if (m.type === "welcome") {
          this.welcome = m;
          resolve();
        } else if (m.type === "req") {
          this.requests.push({ method: m.method, params: m.params });
          try {
            this.ws.send(JSON.stringify({ type: "res", id: m.id, result: (await this.handler(m.method, m.params)) ?? null }));
          } catch (e: any) {
            this.ws.send(JSON.stringify({ type: "res", id: m.id, error: { code: e.code || "internal", message: e.message } }));
          }
        }
      });
      sock.once("connect", () => this.ws.send(JSON.stringify(hello)));
    });
  }
  waitClosed(): Promise<{ code: number }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((r) => this.onClosed.push(r));
  }
}

// The bridge on its own socket in a temp dir, as server.ts listens.
async function startDesktop() {
  const bridge = new DesktopBridge(() => {}, () => [], () => TOKEN);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbi-sock-"));
  const sockPath = path.join(dir, "Orbi", "desktop.sock");
  await bridge.listen(sockPath);
  return {
    bridge,
    url: sockPath,
    dir,
    stop: async () => {
      bridge.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("bridge handshake: hello gets welcome, requests round trip, errors keep their code", async () => {
  const d = await startDesktop();
  try {
    const connected = new Promise<any>((r) => d.bridge.once("connect", r));
    const h = new FakeHelper(d.url, (method) => {
      if (method === "frontmost") return { bundleId: "com.apple.Notes", appName: "Notes", windowTitle: "Notes" };
      throw new DesktopError("not_allowed", "no Accessibility permission");
    });
    await h.open();
    assert.deepEqual(h.welcome, { type: "welcome", version: 1, blockedApps: [] });
    assert.deepEqual((await connected).permissions, { accessibility: true, screen: true, mic: false });
    assert.equal((await d.bridge.call<any>("frontmost")).bundleId, "com.apple.Notes");
    await assert.rejects(d.bridge.call("ax_tree", {}), (e: any) => e instanceof DesktopError && e.code === "not_allowed");
    assert.equal(h.requests[0].method, "frontmost");
    const ptt = new Promise<void>((r) => d.bridge.once("ptt_down", () => r()));
    h.ws.send(JSON.stringify({ type: "event", name: "ptt_down" }));
    await ptt;
  } finally {
    await d.stop();
  }
});

test("bridge: wrong name or version is refused, a wrong proof is refused, newest helper wins", async () => {
  const d = await startDesktop();
  try {
    const bad = new FakeHelper(d.url);
    void bad.open({ type: "hello", name: "something-else", version: 1 }).catch(() => {});
    assert.equal((await bad.waitClosed()).code, 4003);
    // A wrong token's proof, no nonce, a bad nonce, and the old raw token
    // in hello are all refused before any welcome.
    const wrong = new FakeHelper(d.url);
    void wrong.open(undefined, "cd".repeat(32)).catch(() => {});
    assert.equal((await wrong.waitClosed()).code, 4004, "wrong token");
    assert.equal(wrong.welcome, null);
    for (const hello of [
      { type: "hello", name: "orbi-desktop", version: 1 },
      { type: "hello", name: "orbi-desktop", version: 1, nonce: "short" },
      { type: "hello", name: "orbi-desktop", version: 1, token: TOKEN },
    ]) {
      const h = new FakeHelper(d.url);
      void h.open(hello).catch(() => {});
      assert.equal((await h.waitClosed()).code, 4004, JSON.stringify(hello));
    }
    // A message other than auth after the challenge is refused too.
    const raw = new LinkSocket(net.connect(d.url));
    const rawClose = new Promise((r) => raw.on("message", (m: string) => { const j = JSON.parse(m); if (j.type === "close") r(j.code); }));
    raw.send(JSON.stringify({ type: "hello", name: "orbi-desktop", version: 1, nonce: newNonce() }));
    await new Promise((r) => raw.once("message", r));
    raw.send(JSON.stringify({ type: "res", id: 1, result: null }));
    assert.equal(await rawClose, 4004);
    assert.equal(d.bridge.connected(), false);
    const old = new FakeHelper(d.url, () => ({ which: "old" }));
    await old.open();
    assert.equal(old.serverProved, true, "the server proved the token");
    const neu = new FakeHelper(d.url, () => ({ which: "new" }));
    await neu.open();
    assert.equal((await old.waitClosed()).code, 4002);
    assert.equal((await d.bridge.call<any>("frontmost")).which, "new");
  } finally {
    await d.stop();
  }
});

test("link: socket 0600 in a 0700 dir, frames round trip, stale sockets cleared only when ours and dead", async () => {
  const d = await startDesktop();
  try {
    assert.equal(fs.statSync(d.url).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(d.url)).mode & 0o777, 0o700);
    // A second server on a live socket is refused, and leaves it alone.
    await assert.rejects(listenDesktop(d.url, () => {}), /already listening/);
    assert.ok(fs.statSync(d.url).isSocket());
  } finally {
    await d.stop();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbi-sock-"));
  try {
    // Not a socket: never unlinked.
    const file = path.join(dir, "desktop.sock");
    fs.writeFileSync(file, "keep");
    await assert.rejects(listenDesktop(file, () => {}), /not this user's socket/);
    assert.equal(fs.readFileSync(file, "utf8"), "keep");
    fs.rmSync(file);
    // A dead socket of ours (its server was killed, so nothing unlinked
    // it): cleared and reused.
    const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(file)}, () => console.log("up"))`]);
    await new Promise((r) => child.stdout.once("data", r));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    assert.ok(fs.statSync(file).isSocket(), "the stale socket is left behind");
    const again = await listenDesktop(file, () => {});
    await new Promise<void>((r) => again.close(() => r()));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Frames: JSON and binary, split across chunks; bad frames stop the decoder.
  const got: Array<[number, string]> = [];
  const dec = new FrameDecoder((t, p) => got.push([t, t === FRAME_JSON ? p.toString() : p.toString("hex")]));
  const bytes = Buffer.concat([encodeFrame(FRAME_JSON, '{"a":1}'), encodeFrame(FRAME_BINARY, Buffer.from([1, 2]))]);
  for (const b of bytes) assert.equal(dec.push(Buffer.from([b])), true);
  assert.deepEqual(got, [[1, '{"a":1}'], [2, "0102"]]);
  assert.equal(new FrameDecoder(() => {}).push(Buffer.from([0, 0, 0, 0])), false);
  assert.equal(new FrameDecoder(() => {}).push(Buffer.from([0, 0, 0, 2, 9, 0])), false);
});

// ------------------------------------------------------------ lock table

const el = (o: Partial<AXElement>): AXElement => ({ ref: "d1", role: "AXButton", enabled: true, ...o });
const tgt = (element: AXElement | null, bundleId = "com.apple.mail", appName = "Mail", extra: Partial<Target> = {}): Target => ({ element, bundleId, appName, windowTitle: "New Message", ...extra });

test("lock decisions on a table of fake elements", () => {
  const rows: Array<[string, Target, string, string, boolean | undefined, string]> = [
    // name, target, user's words, expected decision, point, expected lock kind
    ["Pay button, even when asked", tgt(el({ title: "Pay" }), "com.example.shop", "Shop"), "pay for it", "ask", false, "order"],
    ["Place order", tgt(el({ title: "Place Order" }), "com.example.shop", "Shop"), "", "ask", false, "order"],
    ["Apple Pay never", tgt(el({ label: "Apple Pay" }), "com.example.shop", "Shop"), "press apple pay", "refuse", false, "express"],
    ["Send in Mail, no ask", tgt(el({ title: "Send" })), "write an email to Sam", "ask", false, "send"],
    ["Send in Mail, asked", tgt(el({ title: "Send" })), "send it", "press", false, "send"],
    ["Send in Mail, hedged", tgt(el({ title: "Send" })), "don't send it yet", "ask", false, "send"],
    ["Move to Trash, asked", tgt(el({ title: "Move to Trash" }), "com.apple.finder", "Finder"), "move it to the trash", "press", false, "delete"],
    ["Install, not asked", tgt(el({ title: "Install" }), "com.apple.installer", "Installer"), "what is this", "ask", false, "install"],
    ["Sign in, asked", tgt(el({ title: "Sign In" }), "com.example.app", "App"), "sign me in", "press", false, "account"],
    ["Don't Send is not send", tgt(el({ title: "Don't Send" }), "com.apple.CrashReporter", "Problem Report"), "", "allow", false, ""],
    ["Plain button", tgt(el({ title: "Bold" }), "com.apple.Notes", "Notes"), "", "allow", false, ""],
    ["Unlabeled point needs a yes", tgt(el({ title: "", label: "" }), "com.apple.Notes", "Notes"), "", "ask", true, ""],
    ["Nothing under the point needs a yes", tgt(null, "com.apple.Notes", "Notes"), "", "ask", true, ""],
    ["A titled window is not a label", tgt(el({ role: "AXWebArea", title: "Inbox" }), "com.apple.mail", "Mail"), "", "ask", true, ""],
    ["Labeled point is fine", tgt(el({ title: "Bold" }), "com.apple.Notes", "Notes"), "", "allow", true, ""],
  ];
  for (const [name, t, words, want, point, kind] of rows) {
    const lock = classifyElement(t.element);
    assert.equal(lock?.kind ?? "", kind, `${name}: lock kind`);
    const d = decidePress(lock, t, { userText: words, danger: false, point });
    assert.equal(d.kind, want, `${name}: decision`);
  }
  // Danger mode lifts the lock, as in the browser.
  assert.equal(decidePress(classifyElement(el({ title: "Send" })), tgt(el({ title: "Send" })), { userText: "", danger: true }).kind, "allow");
  // One direct press per ask.
  const spent = new Set(["send"]);
  assert.equal(decidePress(classifyElement(el({ title: "Send" })), tgt(el({ title: "Send" })), { userText: "send it", spent, danger: false }).kind, "ask");
  // Checkout on the desktop: one press per ask, spent through the browser's
  // own helper, so either path sees the other's press the same way.
  const co = tgt(el({ title: "Proceed to checkout" }));
  const coLock = classifyElement(co.element)!;
  assert.equal(coLock.cls, "checkout");
  const words = new Set<string>();
  assert.equal(decidePress(coLock, co, { userText: "check out", spent: words, danger: false }).kind, "press");
  spendDirect(words, "checkout", coLock.label, 1);
  assert.equal(decidePress(coLock, co, { userText: "check out", spent: words, danger: false }).kind, "ask", "desktop: one press");
  assert.equal(isSpent(words, "checkout", "Checkout"), true, "the browser path sees it spent");
});

test("keys: Return in a chat app's message field sends, cmd+Delete deletes, Return on a default Pay button is locked", () => {
  const ret = keyEffect(parseCombo("Return")!, "com.apple.MobileSMS");
  assert.equal(ret.kind, "activate");
  assert.equal(keyLock({ enter: true }, tgt(el({ role: "AXTextArea", label: "iMessage" }), "com.apple.MobileSMS", "Messages"))?.cls, "send");
  assert.equal(keyLock({ enter: true }, tgt(el({ role: "AXTextField", label: "Name" }), "com.apple.Notes", "Notes")), null);
  assert.equal(keyLock({ enter: true }, tgt(el({ role: "AXTextField", label: "Name" }), "com.example.shop", "Shop", { defaultButton: el({ ref: "d9", title: "Pay now" }) }))?.kind, "order");
  const del = keyEffect(parseCombo("cmd+Delete")!, "com.apple.finder");
  assert.equal(del.kind === "lock" && del.lock.cls, "delete");
  assert.equal(keyEffect(parseCombo("cmd+shift+d")!, "com.apple.mail").kind, "lock");
  assert.equal(keyEffect(parseCombo("cmd+f")!, "com.apple.mail").kind, "none");
  assert.equal(keyEffect(parseCombo("cmd+return")!, "com.apple.Notes").kind, "lock");
  assert.equal(keyEffect(parseCombo("delete")!, "com.apple.mail", el({ role: "AXRow" })).kind, "lock");
  assert.equal(keyEffect(parseCombo("delete")!, "com.apple.mail", el({ role: "AXTextArea" })).kind, "none");
});

test("blocked apps, built in and from the user's file", () => {
  for (const [id, name] of [
    ["com.apple.keychainaccess", "Keychain Access"],
    ["com.1password.1password", "1Password"],
    ["com.apple.systempreferences", "System Settings"],
    ["com.apple.Terminal", "Terminal"],
    ["com.googlecode.iterm2", "iTerm2"],
    ["com.example.rbc", "RBC Mobile Banking"],
    ["com.google.Chrome", "Google Chrome"],
    ["com.microsoft.VSCode", "Visual Studio Code"],
    ["com.apple.Safari", "Safari"],
    ["com.rbc.mobile", ""],
  ]) assert.ok(appBlockReason(id, name, []), `${name} is blocked`);
  assert.match(appBlockReason("com.google.Chrome", "Google Chrome", [])!, /browser tools/);
  assert.equal(appBlockReason("com.apple.Notes", "Notes", []), null);
  assert.ok(appBlockReason("", "Notes", []), "no bundle id is refused");
  assert.ok(appBlockReason("com.apple.Notes", "Notes", ["com.apple.notes"]));
});

test("masking of AX values: secure, card fields, card numbers and keys", () => {
  assert.equal(maskElement(el({ role: "AXSecureTextField", value: "hunter2", secure: true })).value, "[hidden]");
  assert.equal(maskElement(el({ role: "AXTextField", label: "Card number", value: "4111 1111 1111 1111" })).value, "[masked]");
  assert.equal(maskElement(el({ role: "AXTextField", label: "CVC", value: "123" })).value, "[masked]");
  assert.equal(maskElement(el({ role: "AXStaticText", value: "Your card 4242 4242 4242 4242 was charged" })).value, "Your card [masked card number] was charged");
  assert.equal(maskElement(el({ role: "AXTextArea", value: "key: sk-ant-api03-abcdefghijklmnopqrstuvwx" })).value, "key: [masked secret]");
  assert.equal(maskElement(el({ title: "Order 4242424242424242" })).title, "Order [masked card number]");
  assert.equal(maskElement(el({ role: "AXTextField", label: "Subject", value: "Lunch" })).value, "Lunch");
});

test("handshake proofs: fixed vectors (shared with desktop/ Swift tests), constant-time match", () => {
  const token = "ab".repeat(32), hn = "01".repeat(32), sn = "02".repeat(32);
  assert.equal(serverProof(token, hn, sn), SERVER_VECTOR);
  assert.equal(helperProof(token, sn, hn), HELPER_VECTOR);
  assert.equal(proofMatches(SERVER_VECTOR, SERVER_VECTOR), true);
  assert.equal(proofMatches(SERVER_VECTOR, HELPER_VECTOR), false);
  assert.equal(proofMatches(SERVER_VECTOR, "nope"), false);
});

test("token file: created 0600 in a 0700 directory, kept, compared in constant time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbi-token-"));
  const file = path.join(dir, "Orbi", "desktop.token");
  const t = ensureDesktopToken(file);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(ensureDesktopToken(file), t);
  assert.equal(tokenMatches(t, t), true);
  assert.equal(tokenMatches(t, "0".repeat(64)), false);
  assert.equal(tokenMatches(null, t), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("grants are single use and bound to app, window, control and label", () => {
  const g = new DesktopUnlockGate();
  const at = { bundleId: "com.apple.mail", windowTitle: "New Message", ref: "d1", label: "Send", cls: "send" };
  const a = g.issue(at);
  assert.equal(g.consume(a, { ...at, windowTitle: "Other" }), false);
  const b = g.issue(at);
  assert.equal(g.consume(b, at), true);
  assert.equal(g.consume(b, at), false);
});

// ------------------------------------------------------------ the tools

function fakeTools(over: { handler?: (m: string, p: any) => any; words?: string; answer?: string | null; danger?: boolean; vision?: boolean } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const asked: string[] = [];
  const bridge = {
    call: async (method: string, params: any = {}) => {
      calls.push({ method, params });
      return over.handler ? over.handler(method, params) : null;
    },
    overlay: () => {},
    helperInfo: () => ({ connectedAt: 0, permissions: { accessibility: true, screen: true, mic: true }, features: ["expectRef", "exclude"] }),
  };
  const host: DesktopHost = {
    words: () => (over.words ? { text: over.words, spent: new Set() } : null),
    ask: async (q) => (asked.push(q), over.answer ?? null),
    isYes: (t) => /^(yes|yeah|yep)\b/i.test(t.trim()),
    status: () => {},
    danger: () => !!over.danger,
    vision: () => over.vision ?? true,
    acted: () => {},
  };
  const defs = Object.fromEntries(desktopToolDefinitions(host, bridge as any).map((d) => [d.name, d]));
  const acted = () => calls.filter((c) => ["click", "type", "key", "scroll", "app_activate", "ax_tree", "screenshot"].includes(c.method)).map((c) => c.method);
  return { defs, calls, asked, acted };
}

const mail = (element: AXElement | null, bundleId = "com.apple.mail", appName = "Mail") => ({ element, bundleId, appName, windowTitle: "New Message" });

test("tools: Send in Mail asks without a direct ask, and a no presses nothing", async () => {
  const f = fakeTools({ handler: (m) => (m === "element" ? mail(el({ title: "Send" })) : null), words: "write to Sam", answer: "no" });
  const r: any = await f.defs.desktop_click.handler({ ref: "d1" }, {});
  assert.equal(r.isError, true);
  assert.match(f.asked[0], /press Send in Mail/);
  assert.deepEqual(f.acted(), []);
});

test("tools: Send in Mail after 'send it' presses once", async () => {
  const f = fakeTools({ handler: (m) => (m === "element" ? mail(el({ title: "Send" })) : null), words: "send it" });
  const r: any = await f.defs.desktop_click.handler({ ref: "d1" }, {});
  assert.notEqual(r.isError, true);
  assert.equal(f.asked.length, 0);
  assert.deepEqual(f.acted(), ["click"]);
});

test("tools: an unlabeled coordinate click needs a yes; a failed hit test refuses", async () => {
  const blank = fakeTools({ handler: (m) => (m === "element_at" ? mail(el({ ref: "d4", role: "AXGroup" }), "com.apple.Notes", "Notes") : null), answer: "yes" });
  await blank.defs.desktop_click.handler({ x: 10, y: 20 }, {});
  assert.equal(blank.asked.length, 1);
  assert.deepEqual(blank.acted(), ["click"]);
  const broken = fakeTools({
    handler: (m) => {
      if (m === "element_at") throw new DesktopError("internal", "AX failed");
      return null;
    },
    answer: "yes",
  });
  const r: any = await broken.defs.desktop_click.handler({ x: 10, y: 20 }, {});
  assert.equal(r.isError, true);
  assert.deepEqual(broken.acted(), []);
});

test("tools: a blocked app is refused for click, read and type", async () => {
  const f = fakeTools({
    handler: (m) => {
      if (m === "element" || m === "focused") return mail(el({ title: "Unlock" }), "com.apple.keychainaccess", "Keychain Access");
      if (m === "frontmost") return { bundleId: "com.apple.Terminal", appName: "Terminal", windowTitle: "zsh" };
      return null;
    },
    danger: true,
  });
  assert.equal(((await f.defs.desktop_click.handler({ ref: "d1" }, {})) as any).isError, true);
  assert.equal(((await f.defs.desktop_read.handler({}, {})) as any).isError, true);
  assert.equal(((await f.defs.desktop_type.handler({ text: "hi" }, {})) as any).isError, true);
  assert.equal(((await f.defs.desktop_open_app.handler({ bundleId: "com.apple.systempreferences" }, {})) as any).isError, true);
  assert.deepEqual(f.acted(), []);
});

test("tools: typing into a secure field, or a card number, is refused", async () => {
  const secure = fakeTools({ handler: (m) => (m === "focused" ? mail(el({ role: "AXSecureTextField", secure: true }), "com.apple.Notes", "Notes") : null), danger: true });
  const r: any = await secure.defs.desktop_type.handler({ text: "hunter2" }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /password/);
  const field = fakeTools({ handler: (m) => (m === "focused" ? mail(el({ role: "AXTextField", label: "Note" }), "com.apple.Notes", "Notes") : null) });
  assert.equal(((await field.defs.desktop_type.handler({ text: "4242 4242 4242 4242" }, {})) as any).isError, true);
  // In pieces too.
  assert.notEqual(((await field.defs.desktop_type.handler({ text: "4242 4242 " }, {})) as any).isError, true);
  assert.equal(((await field.defs.desktop_type.handler({ text: "4242 4242" }, {})) as any).isError, true);
  assert.deepEqual(field.acted(), ["type"]);
});

test("tools: type needs a text field and no control keys; a yes is spent only on the same control", async () => {
  const button = fakeTools({ handler: (m) => (m === "focused" ? mail(el({ title: "Send" })) : null) });
  assert.equal(((await button.defs.desktop_type.handler({ text: " " }, {})) as any).isError, true);
  const field = fakeTools({ handler: (m) => (m === "focused" ? mail(el({ role: "AXTextArea", label: "Body" })) : null) });
  assert.equal(((await field.defs.desktop_type.handler({ text: "ok\t " }, {})) as any).isError, true);
  assert.deepEqual([...button.acted(), ...field.acted()], []);
  // Yes to Save, but the control is Delete by the time of the press.
  let n = 0;
  const swap = fakeTools({ handler: (m) => (m === "element" ? mail(el({ title: n++ ? "Delete" : "Install" }), "com.apple.Notes", "Notes") : null), answer: "yes" });
  const r: any = await swap.defs.desktop_click.handler({ ref: "d1" }, {});
  assert.equal(r.isError, true);
  assert.deepEqual(swap.acted(), []);
});

test("tools: desktop_read masks values and marks locked controls", async () => {
  const f = fakeTools({
    handler: (m) => {
      if (m === "frontmost") return { bundleId: "com.apple.mail", appName: "Mail", windowTitle: "Inbox" };
      if (m === "ax_tree")
        return {
          bundleId: "com.apple.mail",
          appName: "Mail",
          elements: [el({ ref: "d1", title: "Send" }), el({ ref: "d2", role: "AXSecureTextField", secure: true, value: "pw" }), el({ ref: "d3", role: "AXStaticText", value: "card 4111111111111111" })],
        };
      return null;
    },
  });
  const r: any = await f.defs.desktop_read.handler({}, {});
  const out = r.content[0].text as string;
  assert.match(out, /Button "Send" \[d1\] \[locked\]/);
  assert.doesNotMatch(out, /pw"|4111111111111111/);
  assert.match(out, /\[masked card number\]/);
});

test("tools: a labeled control under a point is clicked by ref; screenshots leave blocked apps out", async () => {
  let echo = true;
  const f = fakeTools({
    handler: (m, p) => {
      if (m === "element_at") return mail(el({ ref: "d7", title: "Bold" }), "com.apple.Notes", "Notes");
      if (m === "frontmost") return { bundleId: "com.apple.Notes", appName: "Notes" };
      if (m === "apps_list") return { apps: [{ bundleId: "com.apple.Notes", name: "Notes" }, { bundleId: "org.mozilla.firefox", name: "Firefox" }] };
      if (m === "screenshot") return { png: "AAAA", width: 10, height: 10, scale: 2, redacted: true, excluded: echo ? p.exclude : [] };
      return null;
    },
  });
  await f.defs.desktop_click.handler({ x: 5, y: 5 }, {});
  assert.deepEqual(f.calls.find((c) => c.method === "click")!.params, { ref: "d7" });
  const r: any = await f.defs.desktop_screenshot.handler({}, {});
  assert.equal(r.content[0].type, "image");
  const shot = f.calls.find((c) => c.method === "screenshot")!.params;
  assert.ok(shot.exclude.includes("org.mozilla.firefox") && !shot.exclude.includes("com.apple.Notes"));
  echo = false;
  assert.equal(((await f.defs.desktop_screenshot.handler({}, {})) as any).isError, true, "a helper that did not leave them out is refused");
});

test("tools: desktop_screenshot needs a vision model", async () => {
  const f = fakeTools({ vision: false });
  const r: any = await f.defs.desktop_screenshot.handler({}, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /can't see images/);
  assert.deepEqual(f.calls, []);
});

// ------------------------------------------------------------ voice

test("voice: push-to-talk turns go through the hub; barge-in stops audio; voice off is text only", async () => {
  const { EventEmitter } = await import("node:events");
  const mk = (voice: boolean) => {
    const bridge = Object.assign(new EventEmitter(), { overlays: [] as any[], stops: 0, audio: [] as Buffer[], connected: () => true });
    (bridge as any).overlay = (o: any) => bridge.overlays.push(o);
    (bridge as any).audioStop = () => bridge.stops++;
    (bridge as any).sendAudio = (b: Buffer) => bridge.audio.push(b);
    const peerLog: string[] = [];
    let hubSend: (m: any) => void = () => {};
    const hub = { join: (send: any) => ((hubSend = send), { interrupt: () => peerLog.push("interrupt"), userText: (t: string) => peerLog.push(`text:${t}`), leave: () => peerLog.push("leave") }) };
    let sttMade = 0;
    let lastStt: any = null;
    class FakeStt {
      sent = 0;
      constructor(public o: any) {
        sttMade++;
        lastStt = this;
      }
      open() {}
      sendAudio() {
        this.sent++;
      }
      finish() {
        this.o.handlers.onFinal("send it");
        this.o.handlers.onClosed();
      }
      abort() {}
    }
    let speaking = false;
    const spoken: string[] = [];
    const v = new DesktopVoice(bridge as any, hub, {
      voice,
      log: () => {},
      getToken: async () => "t",
      Stt: FakeStt as any,
      speaker: () => ({ speak: async (t: string) => void (spoken.push(t), (speaking = true)), stop: () => void (speaking = false), close: () => {}, speaking: () => speaking }),
    }).start();
    bridge.emit("connect", {});
    return { v, bridge, peerLog, hubSend: (m: any) => hubSend(m), spoken, stt: () => ({ made: sttMade, last: lastStt }) };
  };

  const on = mk(true);
  on.bridge.emit("ptt_down");
  on.bridge.emit("audio", Buffer.from([0, 0, 0xff, 0x7f]));
  on.bridge.emit("ptt_up");
  assert.deepEqual(on.peerLog, ["interrupt", "text:send it"]);
  assert.equal(on.stt().last.sent, 1);
  on.hubSend({ type: "agent_text", text: "Sent." });
  assert.deepEqual(on.spoken, ["Sent."]);
  assert.equal(on.bridge.overlays.at(-1).subtitle, "Sent.");
  on.bridge.emit("ptt_down");
  assert.equal(on.bridge.stops, 2, "every press sends audio_stop");
  on.hubSend({ type: "agent_text", text: "rest of the interrupted turn" });
  assert.deepEqual(on.spoken, ["Sent."]);

  const off = mk(false);
  off.bridge.emit("ptt_down");
  assert.equal(off.stt().made, 0);
  assert.equal(off.bridge.overlays.at(-1).subtitle, VOICE_OFF_TEXT);
  off.hubSend({ type: "agent_text", text: "Hello" });
  assert.equal(off.bridge.overlays.at(-1).subtitle, "Hello");
  off.bridge.emit("disconnect", { reason: "closed" });
  assert.equal(off.peerLog.at(-1), "leave");

  const f = new Float32Array(s16ToF32(Buffer.from([0, 0x80, 0xff, 0x7f])));
  assert.equal(f[0], -1);
  assert.ok(f[1] > 0.99);
});

test("voice: an overlay2 helper gets Sonic's lines with their word and phoneme timestamps, done after the audio", async () => {
  const sockets: any[] = [];
  class FakeWs {
    readyState = 1;
    sent: any[] = [];
    onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => this.onopen());
    }
    send(d: string) { this.sent.push(JSON.parse(d)); }
    close() {}
  }
  const events: string[] = [];
  const speech: any[] = [];
  const sp = new SonicSpeaker({
    getToken: async () => "t",
    onAudio: (b) => events.push(`audio:${b.length}`),
    onIdle: () => {},
    onSpeech: (s) => (speech.push(s), events.push(`speech:${Object.keys(s).filter((k) => k !== "id").join(",")}`)),
    log: () => {},
    WebSocketImpl: FakeWs as any,
  });
  await sp.speak("Hi there.");
  const req = sockets[0].sent[0];
  assert.equal(req.add_timestamps, true);
  assert.equal(req.add_phoneme_timestamps, true);
  const id = req.context_id;
  const msg = (m: any) => sockets[0].onmessage({ data: JSON.stringify({ context_id: id, ...m }) });
  msg({ type: "chunk", data: Buffer.alloc(8).toString("base64") });
  msg({ type: "timestamps", word_timestamps: { words: ["Hi", "there."], start: [0, 0.2], end: [0.2, 0.5], extra: 1 } });
  msg({ type: "phoneme_timestamps", phoneme_timestamps: { phonemes: ["h", "aɪ"], start: [0, 0.1], end: [0.1, 0.2] } });
  msg({ type: "done", done: true });
  assert.deepEqual(events, ["speech:text", "audio:8", "speech:timestamps", "speech:phonemes", "speech:done"]);
  assert.deepEqual(speech[0], { id, text: "Hi there." });
  assert.deepEqual(speech[1].timestamps, { words: ["Hi", "there."], start: [0, 0.2], end: [0.2, 0.5] });
  sp.close();

  // The voice sends them on only to a helper that says overlay2.
  const { EventEmitter } = await import("node:events");
  for (const features of [["overlay2"], []]) {
    const overlays: any[] = [];
    let onSpeech: any;
    const bridge = Object.assign(new EventEmitter(), {
      overlay: (o: any) => overlays.push(o), audioStop() {}, sendAudio() {}, connected: () => true,
      helperInfo: () => ({ connectedAt: 0, permissions: { accessibility: true, screen: true, mic: true }, features }),
    });
    let hubSend: any;
    const hub = { join: (send: any) => ((hubSend = send), { interrupt() {}, userText() {}, leave() {} }) };
    new DesktopVoice(bridge as any, hub, {
      voice: true, log: () => {}, getToken: async () => "t",
      Stt: class { constructor(public o: any) {} open() {} sendAudio() {} finish() { this.o.handlers.onFinal("hi"); this.o.handlers.onClosed(); } abort() {} } as any,
      speaker: (o) => ((onSpeech = o.onSpeech), { speak: async (t: string) => o.onSpeech?.({ id: "u1", text: t }), stop() {}, close() {}, speaking: () => false }),
    }).start();
    bridge.emit("ptt_down");
    bridge.emit("ptt_up");
    hubSend({ type: "agent_text", text: "Done." });
    if (features.length) {
      assert.deepEqual(overlays.slice(-2), [{ state: "speaking" }, { speech: { id: "u1", text: "Done." } }]);
    } else {
      assert.deepEqual(overlays.at(-1), { state: "speaking", subtitle: "Done." });
      assert.ok(onSpeech);
    }
  }
});

test.after(() => fs.rmSync(process.env.ORBI_DESKTOP_BLOCKED_APPS!, { force: true }));
