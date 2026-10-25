# `GET /cartesia-token` for the agent server

The voice console calls `GET /cartesia-token` on the same origin before it opens each Cartesia websocket.
It expects JSON `{ "token": "...", "expires_in": <seconds> }` (it refreshes the token 15 s before `expires_in`;
if `expires_in` is missing it assumes 60).

Endpoint per docs.cartesia.ai (checked 2026-10-24): `POST https://api.cartesia.ai/access-token`, headers
`Authorization: Bearer <CARTESIA_API_KEY>`, `Cartesia-Version: 2026-08-14`, `Content-Type: application/json`,
body `{ grants: { tts, stt }, expires_in }`. `expires_in` is in seconds, max 3600. Response is `{ token }`.

Node 20+ (global `fetch`), e.g. in an Express/`http` handler:

```js
async function mintCartesiaToken() {
  const key = process.env.CARTESIA_API_KEY;
  if (!key) throw new Error('CARTESIA_API_KEY is not set');
  const expiresIn = 300; // 5 minutes
  const res = await fetch('https://api.cartesia.ai/access-token', {
    method: 'POST',
    headers: {
      'Cartesia-Version': '2026-08-14',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ grants: { tts: true, stt: true }, expires_in: expiresIn }),
  });
  // Don't log the key or the token.
  if (!res.ok) throw new Error(`Cartesia /access-token returned ${res.status}`);
  const { token } = await res.json();
  return { token, expires_in: expiresIn };
}

// Express:
app.get('/cartesia-token', async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json(await mintCartesiaToken());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

Also serve `voice/public/` as static files at `/` (e.g. `app.use(express.static(path.join(repoRoot, 'voice/public')))`).
`voice/dev-server.mjs` has the same thing with plain `node:http` if you want to copy that instead.
