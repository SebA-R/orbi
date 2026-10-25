// macOS Keychain access for the card vault, through /usr/bin/security.
//
// Secrets never go on a command line (other processes can read argv):
// writes go through `security -i`, which reads its command from stdin, and
// reads come back on stdout. Errors are generic: neither stdout nor stderr
// is ever put into a message or a log.

import { execFile, spawn } from "node:child_process";

const TIMEOUT_MS = 30_000;
// `security` exit codes: the item is not there / is there already.
const NOT_FOUND = 44;
const EXISTS = 45;

export class KeychainError extends Error {
  constructor(message = "Could not use the macOS Keychain.") {
    super(message);
    this.name = "KeychainError";
  }
}

function onMac() {
  if (process.platform !== "darwin") throw new KeychainError("Saved cards need the macOS Keychain.");
}

// Names go into a `security -i` command line, so only plain ones.
function plain(s: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(s)) throw new KeychainError();
  return s;
}

// The secret of a generic password item, or null when there is none.
export function readSecret(service: string, account: string): Promise<string | null> {
  onMac();
  return new Promise((resolve, reject) => {
    execFile("security", ["find-generic-password", "-s", plain(service), "-a", plain(account), "-w"], { timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) return (err as { code?: number }).code === NOT_FOUND ? resolve(null) : reject(new KeychainError());
      resolve(String(stdout).replace(/\n$/, ""));
    });
  });
}

// Adds a generic password item; never replaces one. "exists" when the item
// was there already. `secret` must be plain text (hex, base64): it is sent
// on stdin, unquoted.
export function addSecret(service: string, account: string, label: string, secret: string): Promise<"created" | "exists"> {
  onMac();
  if (!/^[A-Za-z0-9+/=]+$/.test(secret)) return Promise.reject(new KeychainError());
  if (!/^[A-Za-z0-9 ._()-]+$/.test(label)) return Promise.reject(new KeychainError());
  return new Promise((resolve, reject) => {
    const p = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => p.kill(), TIMEOUT_MS);
    p.on("error", () => (clearTimeout(timer), reject(new KeychainError())));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve("created");
      else if (code === EXISTS) resolve("exists");
      else reject(new KeychainError());
    });
    p.stdin.on("error", () => {});
    p.stdin.end(`add-generic-password -s ${plain(service)} -a ${plain(account)} -l "${label}" -w ${secret}\n`);
  });
}

export function deleteSecret(service: string, account: string): Promise<boolean> {
  onMac();
  return new Promise((resolve, reject) => {
    execFile("security", ["delete-generic-password", "-s", plain(service), "-a", plain(account)], { timeout: TIMEOUT_MS }, (err) => {
      if (err) return (err as { code?: number }).code === NOT_FOUND ? resolve(false) : reject(new KeychainError());
      resolve(true);
    });
  });
}
