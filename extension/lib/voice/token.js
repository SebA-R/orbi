// Cartesia access token from the agent server (the API key never reaches the
// extension). Cached until 15 s before expiry, like voice/public/js/app.js.
export function createTokenSource({ url, fetchImpl = (...a) => fetch(...a), now = () => Date.now() }) {
  let cached = null; // { token, expiresAt }
  let inflight = null;
  async function mint() {
    const res = await fetchImpl(url(), { cache: "no-store" });
    if (!res.ok) throw new Error(`/cartesia-token returned ${res.status}`);
    const data = await res.json();
    if (!data || !data.token) throw new Error("/cartesia-token returned no token");
    const ttl = Number(data.expires_in) || 60;
    cached = { token: data.token, expiresAt: now() + ttl * 1000 };
    return data.token;
  }
  async function getToken() {
    if (cached && cached.expiresAt - now() > 15000) return cached.token;
    if (!inflight) inflight = mint().finally(() => { inflight = null; });
    return inflight;
  }
  getToken.clear = () => { cached = null; };
  return getToken;
}
