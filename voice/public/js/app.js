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
  statusLine: $('status-line'), agentCaption: $('agent-caption'), hintText: $('hint-text'), orb: $('orb'),
  statusDetail: $('status-detail'),
  confirm: $('confirm'), confirmItem: $('confirm-item'), confirmTotal: $('confirm-total'),
  confirmChangeRow: $('confirm-change-row'), confirmChange: $('confirm-change'),
  confirmTalk: $('confirm-talk'),
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
// Split text into word spans that fade in one after another (decorative; the text reads normally).
function appendWords(el, text) {
  let i = 0;
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { el.append(' '); continue; }
    const w = document.createElement('span');
    w.className = 'w';
    w.style.setProperty('--i', String(Math.min(i++, 60)));
    w.textContent = part;
    el.append(w);
  }
}
const splitLayout = matchMedia('(min-width: 900px)');
function addTurn(who, text) {
  const li = document.createElement('li');
  li.className = who === 'You' ? 'user' : 'agent';
  const name = document.createElement('span');
  name.className = 'who';
  name.textContent = `${who}: `;
  li.append(name);
  if (who === 'You') li.append(document.createTextNode(text));
  else appendWords(li, text);
  els.conversation.append(li);
  // Desktop: keep the newest turn in view. Phones: the reply already shows under the orb; don't scroll away.
  if (splitLayout.matches && li.getBoundingClientRect().bottom > innerHeight) {
    li.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest' });
  }
}
function announce(region, text) {
  // Clear then set so repeated identical text is still announced.
  region.textContent = '';
  setTimeout(() => { region.textContent = text; }, 50);
}
const alertUser = (text) => { logEvent(text); announce(els.srAlert, text); };

// ---------- on-screen state (orb, status line, captions) ----------
// Visual only: everything here is also available as text, the conversation list, or a live region.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const ui = {
  listening: false, speaking: false, thinking: false, awaitingYes: false, status: '', detail: '', forced: null,
  confirm: null,   // the read-back being answered: { item, total, changes, state }
  receipt: false,  // an order was just placed
};
let thinkingTimer = 0;

function uiState() {
  if (ui.forced) return ui.forced;
  if (ui.listening) return 'listening';
  if (ui.speaking) return 'speaking';
  if (ui.thinking) return 'thinking';
  return 'idle';
}
const HINT_TALK = '<span class="hint-key">Hold <kbd class="keycap">space</kbd> to talk</span><span class="hint-touch">Tap the circle to talk</span>';
const HINT_SEND = '<span class="hint-key">Let go of <kbd class="keycap">space</kbd> to send</span><span class="hint-touch">Tap again to send</span>';
function setText(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('fresh');
  void el.offsetWidth; // restart the fade
  el.classList.add('fresh');
}
function renderUi() {
  const state = uiState();
  document.body.dataset.ui = state;
  document.body.dataset.phase = ui.confirm ? 'confirm' : ui.receipt ? 'receipt' : '';
  let line;
  if (state === 'listening') line = 'Listening';
  else if (state === 'speaking') line = 'Speaking';
  else if (state === 'thinking') line = ui.status || 'Thinking';
  else if (ui.receipt) line = 'Order placed';
  else line = ui.awaitingYes ? 'Waiting for your yes' : 'Ready when you are';
  setText(els.statusLine, line);
  setText(els.statusDetail, state === 'thinking' ? ui.detail : '');
  const hint = state === 'listening' ? HINT_SEND : HINT_TALK;
  if (els.hintText.innerHTML !== hint) els.hintText.innerHTML = hint;
  clearTimeout(thinkingTimer);
  if (ui.thinking) thinkingTimer = setTimeout(() => { ui.thinking = false; renderUi(); }, 90000);
}

// Turn the agent's raw tool/status messages into a few plain phrases.
function friendlyStatus(text) {
  const t = text.toLowerCase();
  if (t.includes('request_checkout')) return 'Waiting for your yes';
  if (t.includes('pay_with_saved_card') || t === 'paying') return 'Paying securely';
  if (t === 'order placed') return 'Order placed';
  if (t === 'checkout confirmed') return 'Confirmed';
  if (t === 'checkout declined') return 'Okay, not paying';
  if (t.startsWith('navigate')) {
    if (t.includes('/search') || t.includes('?q=')) return 'Searching';
    if (t.includes('/product')) return 'Looking at a product';
    if (t.includes('/cart')) return 'Checking your cart';
    if (t.includes('/checkout')) return 'Opening checkout';
    return 'Opening a page';
  }
  if (/^(computer|find|read_page|get_page_text|form_input)/.test(t)) return 'Reading the page';
  return '';
}
// A second, quieter line under the status, for example what is being searched for.
function statusDetail(text) {
  const m = /^navigate\s+(\S+)/i.exec(text);
  if (!m) return '';
  try {
    const u = new URL(m[1], location.href);
    const q = (u.searchParams.get('q') || '').trim();
    if (q) return `Looking for "${q.slice(0, 60)}"`;
  } catch {}
  return '';
}
function onStatus(text) {
  const t = text.toLowerCase();
  if (t === 'checkout confirmed' && ui.confirm) {
    ui.confirm.state = 'confirmed';
    els.confirm.dataset.state = 'confirmed';
  }
  const nice = friendlyStatus(text);
  if (!nice) { renderUi(); return; }
  if (nice === 'Waiting for your yes') ui.awaitingYes = true;
  ui.status = nice;
  ui.detail = statusDetail(text);
  renderUi();
}

// ---------- read-back (say yes to pay) ----------
// The agent sends { type: "confirm", item, quantity, total, changes } just before it speaks the
// read-back, and { type: "confirm_done", outcome } when the checkout ends. The card is built from
// that message only; the spoken sentence just reads in the conversation.
function readBackFrom(m) {
  const name = String(m.item || '').replace(/^\w/, (x) => x.toUpperCase());
  const qty = Number(m.quantity) || 1;
  return { item: qty === 1 ? name : `${qty} × ${name}`, total: String(m.total || ''), changes: String(m.changes || '').trim(), state: 'pending' };
}
function showConfirm(rb) {
  ui.confirm = rb;
  ui.awaitingYes = true;
  ui.receipt = false;
  els.receipt.hidden = true;
  els.confirmItem.textContent = rb.item;
  els.confirmTotal.textContent = rb.total;
  els.confirmChangeRow.hidden = !rb.changes;
  els.confirmChange.textContent = rb.changes;
  els.confirm.dataset.state = rb.state;
  els.confirm.hidden = false;
  els.confirm.classList.remove('enter');
  void els.confirm.offsetWidth;
  els.confirm.classList.add('enter');
  els.confirm.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest' });
  renderUi();
}
function hideConfirm() {
  // Don't strand keyboard focus on a hidden card: move it to the receipt if one is showing, else Talk.
  if (els.confirm.contains(document.activeElement)) (els.receipt.hidden ? els.talk : els.receipt).focus();
  els.confirm.hidden = true;
  els.confirm.classList.remove('enter');
}

// The checkout ended without a receipt (declined, payment failed, agent error, connection lost).
function endConfirm() {
  if (!ui.confirm && els.confirm.hidden) return;
  ui.confirm = null;
  ui.awaitingYes = false;
  hideConfirm();
  renderUi();
}

function setUserCaption(text) {
  const el = els.partial;
  const fresh = !el.textContent || el.textContent === '…';
  el.textContent = text;
  if (fresh && text && text !== '…') {
    el.classList.remove('fresh');
    void el.offsetWidth;
    el.classList.add('fresh');
  }
}
// Reveal the reply word by word (the full text is already in the conversation list and live region).
function showAgentCaption(text) {
  const el = els.agentCaption;
  el.textContent = '';
  el.classList.toggle('long', text.length > 140);
  appendWords(el, text);
}

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
  onSpeakingChange: (on) => { els.talk.dataset.speaking = String(on); ui.speaking = on; renderUi(); },
});
const mic = new Mic(ctx);

// ---------- orb levels ----------
// Passive taps for the visuals only: an analyser hanging off the speaker's output gain, and a
// second, unconnected source on the mic stream. Neither changes what is heard or sent.
const outAnalyser = ctx.createAnalyser();
outAnalyser.fftSize = 512;
speaker.out.connect(outAnalyser);
let micAnalyser = null;
function tapMicLevel() {
  if (micAnalyser || !mic.stream) return;
  micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 512;
  ctx.createMediaStreamSource(mic.stream).connect(micAnalyser);
}
const levelBuf = new Float32Array(512);
function rms(an) {
  an.getFloatTimeDomainData(levelBuf);
  let sum = 0;
  for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
  return Math.sqrt(sum / levelBuf.length);
}

const orbParts = {
  aura: els.orb.querySelector('.orb-aura'),
  ring: els.orb.querySelector('.orb-ring'),
  sheen: els.orb.querySelector('.orb-sheen'),
};
// Degrees per second for the conic ring; thinking is one turn every 1.6 s. The halo turns at half speed.
const SPIN = { idle: 14, listening: 52, thinking: 225, speaking: 30 };
let level = 0, angle = 0, spin = SPIN.idle, lastFrame = performance.now();
let demoLevel = null; // set by the debug hook to fake audio
// Only touch the DOM when a value actually changes, so an idle page does no style work per frame.
const written = new Map();
function put(el, prop, value) {
  if (written.get(el)?.[prop] === value) return;
  const w = written.get(el) || {};
  w[prop] = value;
  written.set(el, w);
  if (prop === '--level') el.style.setProperty(prop, value);
  else el.style[prop] = value;
}
// --level lives on the orb: writing a custom property inline on <body> makes Chrome lay out the whole
// page every frame. The ambient look glows from body::before, so it alone keeps it on <body>.
const levelHost = document.documentElement.dataset.look === 'ambient' ? document.body : els.orb;
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const state = uiState();
  let target = 0;
  if (demoLevel !== null && (state === 'listening' || state === 'speaking')) {
    target = demoLevel * (0.65 + 0.35 * Math.sin(now / 130) * Math.sin(now / 370));
  } else if (state === 'listening' && micAnalyser) target = Math.min(1, rms(micAnalyser) * 7);
  else if (state === 'speaking') target = Math.min(1, rms(outAnalyser) * 5);
  // Fast attack, slower release, like a VU meter.
  level += (target - level) * (target > level ? 0.35 : 0.08);
  spin += (SPIN[state] - spin) * 0.04;
  if (level < 0.002) level = 0;
  put(levelHost, '--level', reducedMotion.matches ? '0' : level.toFixed(2));
  if (reducedMotion.matches) {
    put(orbParts.aura, 'transform', '');
    put(orbParts.ring, 'transform', '');
    put(orbParts.sheen, 'transform', '');
    put(els.orb, 'transform', '');
  } else {
    angle = (angle + spin * dt) % 720;
    put(els.orb, 'transform', `scale(${(1 + level * 0.1).toFixed(3)})`);
    put(orbParts.aura, 'transform', `rotate(${(angle * 0.5).toFixed(1)}deg) scale(${(1 + level * 0.22).toFixed(3)})`);
    put(orbParts.ring, 'transform', `rotate(${angle.toFixed(1)}deg)`);
    put(orbParts.sheen, 'transform', state === 'thinking' ? '' : `rotate(${(angle * 0.35).toFixed(1)}deg)`);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Debug hook for demos and screenshots without a mic:
//   __clearcartDemoState('listening' | 'thinking' | 'speaking' | 'idle' | null, { level, status, user, agent })
window.__clearcartDemoState = (state, opts = {}) => {
  ui.forced = state || null;
  demoLevel = typeof opts.level === 'number' ? opts.level : (state === 'listening' || state === 'speaking' ? 0.6 : null);
  if (opts.status !== undefined) ui.status = opts.status;
  if (opts.detail !== undefined) ui.detail = opts.detail;
  if (opts.awaitingYes !== undefined) ui.awaitingYes = opts.awaitingYes;
  if (opts.user !== undefined) setUserCaption(opts.user);
  if (opts.agent !== undefined) showAgentCaption(opts.agent);
  renderUi();
  return uiState();
};
window.__clearcartDemoReceipt = (r = { item: 'Blue ceramic mug, 12 oz', total: '$12.96', last4: '1111' }) => showReceipt(r);
// Same hooks grouped, plus conversation turns and the read-back card (used by index.html ?demo=).
window.__clearcartDemo = {
  state: window.__clearcartDemoState,
  receipt: window.__clearcartDemoReceipt,
  turn: (who, text) => addTurn(who, text),
  confirm: (order) => showConfirm(readBackFrom(order)),
};

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
  let opened = false;
  ws.onopen = () => {
    opened = true;
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
    // A lost session can't finish the checkout, so drop its card. (A socket that never opened,
    // as in the ?demo= previews, had no card from the agent.)
    if (opened) endConfirm();
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

// After a barge-in, agent_text from the interrupted turn (sent before the agent saw our
// interrupt) is logged, not spoken, until our next user_text starts a fresh turn.
let muted = false;

function handleAgentMessage(m) {
  switch (m.type) {
    case 'agent_text':
      if (!m.text) return;
      if (muted) {
        logEvent(`Agent (not spoken): ${m.text}`);
        return;
      }
      addTurn('Clearcart', m.text);
      showAgentCaption(m.text);
      ui.thinking = false;
      renderUi();
      if (els.announce.checked) announce(els.srAgent, m.text);
      lastReply = m.text;
      els.replay.disabled = false;
      speaker.speak(m.text);
      break;
    case 'status':
      logEvent(`Agent: ${m.text}`);
      onStatus(m.text || '');
      break;
    case 'receipt':
      showReceipt(m);
      break;
    case 'confirm':
      showConfirm(readBackFrom(m));
      break;
    case 'confirm_done':
      logEvent(`Checkout ${m.outcome}`);
      if (m.outcome !== 'paid') endConfirm();
      break;
    case 'standby':
      standby(m);
      break;
    default:
      logEvent(`Unknown agent message type: ${m.type}`);
  }
}

// The agent server keeps one conversation for every Clearcart window and the
// one the user last talked into owns it. "moved": another window (or the
// extension) just took it, so stop talking and listening here, unsent.
// "stale": what we just sent was dropped; a newer press here is left alone.
function standby(m) {
  speaker.stop();
  muted = true;
  if (m.reason === 'moved' && listening) {
    listening = false;
    spaceHeld = false;
    setListeningUi(false);
    const s = session;
    session = null;
    if (sinkOwner === s) { mic.sink = null; sinkOwner = null; }
    if (s) s.abort();
  }
  endConfirm();
  ui.thinking = false;
  renderUi();
  const text = m.text || 'Clearcart is in use in another window. Talk here to use it here.';
  setConnection('standby', text);
  alertUser(text);
}

function showReceipt(r) {
  els.receiptItem.textContent = r.item || '';
  els.receiptTotal.textContent = r.total || '';
  els.receiptCard.textContent = r.last4 ? `Visa ending in ${r.last4}` : '';
  ui.confirm = null;
  ui.receipt = true;
  els.receipt.hidden = false;
  hideConfirm();
  els.receipt.classList.remove('enter');
  void els.receipt.offsetWidth; // restart the entrance animation
  els.receipt.classList.add('enter');
  els.receipt.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest' });
  ui.thinking = false;
  ui.awaitingYes = false;
  renderUi();
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
  $('confirm-talk-label').textContent = on ? 'Listening. Say yes or no' : 'Say yes to pay';
  if (on) { setUserCaption('…'); els.agentCaption.textContent = ''; }
  ui.listening = on;
  renderUi();
}

async function startTalking() {
  if (listening) return;
  listening = true;
  speaker.stop(); // barge-in: silence now, and tell the agent to drop the rest of its turn
  muted = true;
  sendToAgent({ type: 'interrupt' }); // also takes the conversation back to this window
  if (els.connection.dataset.state === 'standby') setConnection('open', 'Connected to your shopping assistant.');
  resumeAudio();
  setListeningUi(true);
  earcon('start');

  const s = new SttSession({
    getToken,
    sampleRate: ctx.sampleRate,
    log: logEvent,
    handlers: {
      onTurnStart: () => speaker.stop(),
      onPartial: (text) => { setUserCaption(text || '…'); },
      onFinal: (text) => {
        setUserCaption(text);
        addTurn('You', text);
        muted = false;
        sendToAgent({ type: 'user_text', text });
        ui.thinking = true;
        ui.awaitingYes = false;
        ui.receipt = false;
        ui.status = '';
        renderUi();
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
    tapMicLevel();
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
const OTHER_CONTROLS = 'input, textarea, select, a, summary, [contenteditable], button:not(#talk):not(#confirm-talk)';
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

// Click, Enter, or a screen reader's activate gesture toggles listening. The read-back card's
// "Say yes to pay" button is a second, bigger talk button: it opens the mic, it never pays by itself.
function toggleTalk() {
  if (performance.now() - lastSpaceUp < 400) return; // the click a Space release on the button generates
  if (listening) stopTalking();
  else startTalking();
}
els.talk.addEventListener('click', toggleTalk);
els.confirmTalk.addEventListener('click', toggleTalk);

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
