# vault

The card vault (`vault/index.ts`): cards the user saves in the extension's settings (Payment cards), encrypted on this computer so the pay flow can fill one at checkout and the AI never sees it.

- File: `agent/.data/cards.json` (or `$CLEARCART_DATA_DIR/cards.json`), mode 0600, gitignored. Each card's name, number, expiry, security code and billing ZIP are one AES-256-GCM record with a random IV; the card's id, brand and last 4 are its additional data. Only the nickname, brand and last 4 are stored in the clear.
- Key: 256 random bits, made once and kept in the macOS login Keychain (generic password, service `clearcart-vault-key`), written through `security -i` on stdin, never on a command line (`vault/keychain.ts`). Tests use `memoryKeys()` instead.
- Only `withCard()` decrypts, for one fill (`agent/pay.ts`), and drops the fields after. Nothing logs or returns a card field.
- Settings page API: `agent/cards.ts` (`/cards`, extension origin and loopback only).
- An earlier single demo card (service `clearcart-card`) moves in once, the first time the settings page lists cards or a payment starts, and the old Keychain item is removed.

Add the Visa test card: `./vault/setup-test-card.sh` (or `npm --prefix agent run add-test-card`).
