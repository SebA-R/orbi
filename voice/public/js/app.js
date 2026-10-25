import { DEFAULT_VOICE_ID, SPEED_MIN, SPEED_MAX, SPEED_DEFAULT } from './config.js';
import { Mic } from './mic.js';
import { SttSession } from './stt.js';
import { Speaker } from './tts.js';

const $ = (id) => document.getElementById(id);
const els = {
  connection: $('connection'), talk: $('talk'), talkLabel: document.querySelector('.talk-label'),
  partial: $('partial'), speed: $('speed'), speedValue: $('speed-value'), announce: $('announce'),
  stop: $('stop-speaking'), replay: $('replay'), conversation: $('conversation'), events: $('events'),
  receipt: $('receipt'), receiptItem: $('receipt-item'), receiptTotal: $('receipt-total'),
  receiptCard: $('receipt-card'), srAgent: $('sr-agent'), srAlert: $('sr-alert'),
};
const params = new URLSearchParams(location.search);

// ---------- storage (may be unavailable) ----------
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}

// ---------- logging ----------
function logEvent(text) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  els.events.append(li);
  while (els.events.children.length > 200) els.events.firstChild.remove();
}
function addTurn(who, text) {
  const li = document.createElement('li');
  li.className = who === 'You' ? 'user' : 'agent';
  const name = document.createElement('span');
  name.className = 'who';
  name.textContent = `${who}: `;
  li.append(name, document.createTextNode(text));
  els.conversation.append(li);
  li.scrollIntoView({ block: 'nearest' });
}
function announce(region, text) {
  // Clear then set so repeated identical text is still announced.
  region.textContent = '';
  setTimeout(() => { region.textContent = text; }, 50);
}
const alertUser = (text) => { logEvent(text); announce(els.srAlert, text); };

// ---------- settings ----------
function clampSpeed(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, n)) : SPEED_DEFAULT;
}
let speed = clampSpeed(load('clearcart.speed', SPEED_DEFAULT));
function renderSpeed() {
  els.speed.value = String(speed);
  els.speedValue.textContent = `${speed.toFixed(1)}×`;
  els.speed.setAttribute('aria-valuetext', `${speed.toFixed(1)} times`);
}
renderSpeed();
els.speed.addEventListener('input', () => {
  speed = clampSpeed(els.speed.value);
  renderSpeed();
  save('clearcart.speed', speed);
});
els.announce.checked = load('clearcart.announce', 'true') === 'true';
els.announce.addEventListener('change', () => save('clearcart.announce', els.announce.checked));

// ---------- audio ----------
const ctx = new AudioContext();
const resumeAudio = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
// Browsers keep audio suspended until the first key press or click.
addEventListener('keydown', resumeAudio, { capture: true });
addEventListener('pointerdown', resumeAudio, { capture: true });

// One bell-like note: a sine plus a quiet octave, near-instant attack, soft exponential decay.
function chimeNote(freq, at, peak = 0.32) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5000;
  g.connect(lp).connect(ctx.destination);
  for (const [mult, level] of [[1, 1], [2, 0.18]]) {
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    og.gain.value = level;
    osc.connect(og).connect(g);
    osc.start(at);
    osc.stop(at + 0.3);
  }
}

// Two quick notes: rising when the mic opens, falling when it closes.
function earcon(kind) {
  if (ctx.state !== 'running') return;
  const t = ctx.currentTime + 0.005;
  const [first, second] = kind === 'start' ? [659.25, 987.77] : [987.77, 659.25]; // E5 and B5
  chimeNote(first, t);
  chimeNote(second, t + 0.07);
}

// ---------- Cartesia token (minted by our server; the API key never reaches the page) ----------
let cachedToken = null; // { token, expiresAt }
async function getToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 15000) return cachedToken.token;
  const res = await fetch('/cartesia-token', { cache: 'no-store' });
  if (!res.ok) throw new Error(`/cartesia-token returned ${res.status}`);
  const data = await res.json();
  if (!data.token) throw new Error('/cartesia-token returned no token');
  const ttl = Number(data.expires_in) || 60;
  cachedToken = { token: data.token, expiresAt: Date.now() + ttl * 1000 };
  return data.token;
}
const prefetchToken = () => getToken().catch((err) => logEvent(`Token prefetch failed: ${err.message}`));

let lastReply = '';
const speaker = new Speaker({
  ctx,
  getToken,
  getSpeed: () => speed,
  voiceId: params.get('voice') || DEFAULT_VOICE_ID,
  log: logEvent,
  onSpeakingChange: (on) => { els.talk.dataset.speaking = String(on); },
});
const mic = new Mic(ctx);

// ---------- agent session ----------
let agent = null;
let outbox = [];
let retryMs = 500;
let everConnected = false;
const agentUrl = params.get('agent')
  || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/session`;

function setConnection(state, text) {
  els.connection.dataset.state = state;
  els.connection.textContent = text;
}

function connectAgent() {
  const ws = new WebSocket(agentUrl);
  agent = ws;
  ws.onopen = () => {
    retryMs = 500;
    setConnection('open', 'Connected to your shopping assistant.');
    if (everConnected) alertUser('Reconnected to Clearcart.');
    everConnected = true;
    for (const msg of outbox) ws.send(msg);
    outbox = [];
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { logEvent('Agent sent a non-JSON message'); return; }
    handleAgentMessage(m);
  };
  ws.onclose = () => {
    if (agent !== ws) return;
    agent = null;
    if (everConnected && els.connection.dataset.state === 'open') alertUser('Lost connection to Clearcart. Trying again.');
    setConnection('closed', 'Not connected to the shopping assistant. Retrying…');
    setTimeout(connectAgent, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
}

function sendToAgent(obj) {
  const msg = JSON.stringify(obj);
  if (agent && agent.readyState === WebSocket.OPEN) agent.send(msg);
  else outbox.push(msg);
}

function handleAgentMessage(m) {
  switch (m.type) {
    case 'agent_text':
      if (!m.text) return;
      addTurn('Clearcart', m.text);
      if (els.announce.checked) announce(els.srAgent, m.text);
      lastReply = m.text;
      els.replay.disabled = false;
      speaker.speak(m.text);
      break;
    case 'status':
      logEvent(`Agent: ${m.text}`);
      break;
    case 'receipt':
      showReceipt(m);
      break;
    default:
      logEvent(`Unknown agent message type: ${m.type}`);
  }
}

function showReceipt(r) {
  els.receiptItem.textContent = r.item || '';
  els.receiptTotal.textContent = r.total || '';
  els.receiptCard.textContent = r.last4 ? `Visa ending in ${r.last4}` : '';
  els.receipt.hidden = false;
  logEvent(`Receipt: ${r.item} ${r.total} card ending ${r.last4}`);
  // The agent speaks the confirmation; only announce here if replies go to the screen reader too.
  if (els.announce.checked) {
    announce(els.srAgent, `Order placed. ${r.item || ''}, total ${r.total || ''}, Visa ending in ${r.last4 || ''}.`);
  }
}

// ---------- talking ----------
let listening = false;
let session = null;
let sinkOwner = null;

function setListeningUi(on) {
  els.talk.setAttribute('aria-pressed', String(on));
  els.talkLabel.textContent = on ? 'Listening… let go to send' : 'Hold Space to talk';
  if (on) els.partial.textContent = '…';
}

async function startTalking() {
  if (listening) return;
  listening = true;
  speaker.stop(); // barge-in
  resumeAudio();
  setListeningUi(true);
  earcon('start');

  const s = new SttSession({
    getToken,
    sampleRate: ctx.sampleRate,
    log: logEvent,
    handlers: {
      onTurnStart: () => speaker.stop(),
      onPartial: (text) => { els.partial.textContent = text || '…'; },
      onFinal: (text) => {
        els.partial.textContent = text;
        addTurn('You', text);
        sendToAgent({ type: 'user_text', text });
      },
      onError: (msg) => alertUser(msg),
      onClosed: () => {
        if (session === s) session = null;
        prefetchToken();
      },
    },
  });
  session = s;
  sinkOwner = s;
  mic.sink = (chunk) => s.sendAudio(chunk);
  s.open();

  try {
    await mic.start();
  } catch (err) {
    mic.sink = null;
    s.abort();
    listening = false;
    setListeningUi(false);
    alertUser(err.name === 'NotAllowedError'
      ? 'Microphone access is blocked. Allow the microphone for this page, then try again.'
      : `Could not start the microphone: ${err.message}`);
  }
}

function stopTalking() {
  if (!listening) return;
  listening = false;
  setListeningUi(false);
  earcon('stop'); // right on release, so the user knows the mic heard them let go
  const s = session;
  // Keep a short tail of audio so the last word isn't clipped, then let Cartesia finalize.
  setTimeout(() => {
    if (sinkOwner === s) { mic.sink = null; sinkOwner = null; }
    if (s) s.finish();
  }, 300);
}

// Space held anywhere except on other controls (where Space has its own meaning).
const OTHER_CONTROLS = 'input, textarea, select, a, summary, [contenteditable], button:not(#talk)';
let spaceHeld = false;
let lastSpaceUp = 0;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    speaker.stop();
    return;
  }
  if (e.code !== 'Space' || e.target.closest(OTHER_CONTROLS)) return;
  e.preventDefault();
  if (e.repeat || spaceHeld) return;
  spaceHeld = true;
  startTalking();
});
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || !spaceHeld) return;
  e.preventDefault();
  spaceHeld = false;
  lastSpaceUp = performance.now();
  stopTalking();
});
addEventListener('blur', () => {
  if (spaceHeld) { spaceHeld = false; stopTalking(); }
});

// Click, Enter, or a screen reader's activate gesture toggles listening.
els.talk.addEventListener('click', () => {
  if (performance.now() - lastSpaceUp < 400) return; // the click a Space release on the button generates
  if (listening) stopTalking();
  else startTalking();
});

els.stop.addEventListener('click', () => speaker.stop());
els.replay.addEventListener('click', () => {
  if (!lastReply) return;
  speaker.stop();
  speaker.speak(lastReply);
});

// ---------- go ----------
connectAgent();
prefetchToken();
logEvent(`Agent socket: ${agentUrl}`);
