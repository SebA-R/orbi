// The shared secret Orbi Desktop proves itself with. The server creates it
// once; the helper reads it and sends it in hello.token. Only a process
// that can read this user's file (mode 0600, in a 0700 directory) can be
// the helper: other users, sandboxed apps and web pages can't pose as it.
// A program running unsandboxed as this same user can read the file, so
// it does not stop that (such a program can already reach /session too).
//
//   ORBI_DESKTOP_TOKEN_FILE set   that file (tests)
//   otherwise                     ~/Library/Application Support/Orbi/desktop.token
//
// Never logged: only its path.

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN = /^[0-9a-f]{64}$/;

export function desktopTokenPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.ORBI_DESKTOP_TOKEN_FILE?.trim()) return path.resolve(env.ORBI_DESKTOP_TOKEN_FILE.trim());
  return path.join(home, "Library", "Application Support", "Orbi", "desktop.token");
}

// The token, created if the file is missing or does not hold one. The
// directory is made 0700 and the file 0600 every time.
export function ensureDesktopToken(file: string = desktopTokenPath()): string {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  let token = "";
  try {
    token = fs.readFileSync(file, "utf8").trim();
  } catch {}
  if (!TOKEN.test(token)) {
    token = randomBytes(32).toString("hex");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, token + "\n", { mode: 0o600, flag: "w" });
    fs.renameSync(tmp, file);
  }
  fs.chmodSync(file, 0o600);
  return token;
}

// Constant time, and false for anything that is not a well formed token.
export function tokenMatches(expected: string | null | undefined, sent: unknown): boolean {
  if (!expected || !TOKEN.test(expected) || typeof sent !== "string" || !TOKEN.test(sent.trim())) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(sent.trim(), "utf8"));
}
