// DNS rebinding defense for the agent server. A page on any site can point
// its own host name at 127.0.0.1 and then read this server as same origin
// (the voice token at /cartesia-token, the /session socket). The browser
// still sends that site's name in the Host header, so every HTTP request
// and WebSocket upgrade must name this computer and this server's port.

const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function hostAllowed(host: string | string[] | undefined, port: number): boolean {
  if (typeof host !== "string") return false;
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host.trim().toLowerCase());
  return !!m && LOCAL_NAMES.has(m[1]) && Number(m[2]) === port;
}
