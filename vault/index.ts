// Card vault for the agent server. Reads the card JSON stored by
// setup-test-card.sh from the macOS Keychain. Never log the returned value.

import { execFile } from "node:child_process";

export type Card = { name: string; number: string; exp: string; csc: string };

const SERVICE = "clearcart-card";
const ACCOUNT = "demo";

export function getCard(): Promise<Card> {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      { timeout: 30_000 },
      (err, stdout) => {
        // Deliberately generic: neither stdout nor stderr goes into the error.
        if (err) {
          reject(new Error("No card in the vault. Run vault/setup-test-card.sh first."));
          return;
        }
        try {
          const card = JSON.parse(stdout.trim()) as Partial<Card>;
          if (!card.name || !card.number || !card.exp || !card.csc) {
            throw new Error("incomplete");
          }
          resolve({
            name: String(card.name),
            number: String(card.number).replace(/[\s-]/g, ""),
            exp: String(card.exp),
            csc: String(card.csc),
          });
        } catch {
          reject(new Error("The vault entry is not valid card JSON. Run vault/setup-test-card.sh again."));
        }
      }
    );
  });
}

export function last4(number: string): string {
  return number.replace(/\D/g, "").slice(-4);
}
