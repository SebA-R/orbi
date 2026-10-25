// Saves the Visa test card (the published test number 4111 1111 1111 1111)
// in the card vault, encrypted with the Keychain key, so pay_with_saved_card
// has a card to use:
//
//   npm --prefix agent run add-test-card            (name on card: Demo Shopper)
//   npm --prefix agent run add-test-card -- "Ada Lovelace"
//
// The settings page (Payment cards) does the same for any card. Prints
// only the nickname, brand and last 4.

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { cardLabel } from "../vault/index.ts";
import { cardVault } from "./cards.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, "..", ".env"), quiet: true });

const NICKNAME = "Test Visa";
const vault = cardVault();
const there = vault.list().cards.find((c) => c.nickname === NICKNAME);
if (there) {
  console.log(`Already saved: ${there.nickname}, ${cardLabel(there)}.`);
} else {
  const r = await vault.add({ nickname: NICKNAME, name: process.argv[2] || "Demo Shopper", number: "4111111111111111", exp: "12/30", csc: "123" });
  if (!r.ok) {
    console.error(`Not saved: ${r.error}`);
    process.exit(1);
  }
  console.log(`Saved ${r.card.nickname}, ${cardLabel(r.card)}. It is encrypted on this computer; the key is in your Keychain.`);
}
