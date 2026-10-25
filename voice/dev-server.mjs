// Standalone dev server for the voice console (port 5051), so it can be tested without the agent server.
//   GET  /               static files from voice/public/
//   GET  /cartesia-token short-lived Cartesia access token, minted from CARTESIA_API_KEY in the repo-root .env
//   WS   /session        echo agent: replies {type:"agent_text", text:"You said: ..."};
//                        say "receipt" to get a fake {type:"receipt"} back.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const PORT = Number(process.env.VOICE_DEV_PORT) || 5051;

try { process.loadEnvFile(path.join(here, '..', '.env')); } catch { /* no .env; token route will say so */ }

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
};

async function mintCartesiaToken() {
  const key = process.env.CARTESIA_API_KEY;
  if (!key) throw new Error('CARTESIA_API_KEY is not set in the repo-root .env');
  const expiresIn = 300;
  const res = await fetch('https://api.cartesia.ai/access-token', {
    method: 'POST',
    headers: {
      'Cartesia-Version': '2026-08-14',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ grants: { tts: true, stt: true }, expires_in: expiresIn }),
  });
  if (!res.ok) throw new Error(`Cartesia /access-token returned ${res.status}`);
  const { token } = await res.json();
  return { token, expires_in: expiresIn };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/cartesia-token') {
    try {
      const body = await mintCartesiaToken();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    } catch (err) {
      console.error(`token: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/session' });
wss.on('connection', (ws) => {
  const send = (obj) => ws.send(JSON.stringify(obj));
  send({ type: 'status', text: 'echo agent connected' });
  send({ type: 'agent_text', text: 'Hi, this is the Clearcart test echo. Hold Space and say something.' });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type !== 'user_text') return;
    console.log(`user_text: ${m.text}`);
    if (/receipt/i.test(m.text)) {
      send({ type: 'agent_text', text: 'Your order is placed. Store brand cetirizine, 90 count, for $18.49 on the Visa ending in 1111.' });
      send({ type: 'receipt', item: 'Store brand cetirizine 10mg, 90 count', total: '$18.49', last4: '1111' });
      return;
    }
    send({ type: 'status', text: `echoing ${m.text.length} characters` });
    send({ type: 'agent_text', text: `You said: ${m.text}` });
  });
});

server.listen(PORT, () => console.log(`voice dev server: http://localhost:${PORT}/`));
