# Raw demo footage: Clearcart on real retail sites

**AI-to-AI simulation: the shopper is an AI playing a blind user, not a real tester; runs stopped at the cart; no purchases.**

Recorded 2026-10-24 against a second Clearcart agent instance (port 5060, `CLEARCART_ALLOWED_ORIGINS` set to the retail origins). The shopper side was a separate Claude call role-playing a blind screen-reader user; it sent its lines to Clearcart as `user_text` over the `/session` WebSocket, exactly where the voice console would send transcribed speech. No microphone or speech-to-text was involved. Both sides were voiced afterwards with Cartesia Sonic (`sonic-3.6`) from the logged text.

On every site Clearcart stopped once the item was in the bag and the bag page was open. It never started checkout, never logged in, and entered no personal data. `pay_now` only works on the local demo store, so no payment was possible.

See `MANIFEST.md` for the per-site summary and the file layout.
