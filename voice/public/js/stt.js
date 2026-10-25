import { CARTESIA_VERSION, STT_URL, STT_MODEL, STT_ENCODING, STT_TURN_PARAMS, STT_KEYTERMS } from './config.js';

// One Ink 2 turns-websocket connection per press of the talk control.
// handlers: onTurnStart(), onPartial(text), onFinal(text), onError(msg), onClosed()
export class SttSession {
  constructor({ getToken, sampleRate, handlers, log }) {
    this.getToken = getToken;
    this.sampleRate = sampleRate;
    this.h = handlers;
    this.log = log;
    this.ws = null;
    this.pending = [];
    this.openText = ''; // transcript of a turn that has not seen turn.end yet
    this.finishing = false;
    this.closed = false;
  }

  async open() {
    let token;
    try {
      token = await this.getToken();
    } catch (err) {
      this.#fail(`Could not get a speech token: ${err.message}`);
      return;
    }
    if (this.closed) return;
    const url = new URL(STT_URL);
    url.searchParams.set('model', STT_MODEL);
    url.searchParams.set('encoding', STT_ENCODING);
    url.searchParams.set('sample_rate', String(this.sampleRate));
    url.searchParams.set('cartesia_version', CARTESIA_VERSION);
    for (const [k, v] of Object.entries(STT_TURN_PARAMS)) url.searchParams.set(k, v);
    for (const term of STT_KEYTERMS) url.searchParams.append('keyterm', term);
    url.searchParams.set('access_token', token);

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      for (const chunk of this.pending) ws.send(chunk);
      this.pending = [];
      if (this.finishing) this.#sendClose();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      switch (m.type) {
        case 'connected':
          this.log(`STT connected (request ${m.request_id})`);
          break;
        case 'turn.start':
          this.h.onTurnStart();
          break;
        case 'turn.update':
        case 'turn.eager_end':
          this.openText = m.transcript || '';
          this.h.onPartial(this.openText);
          break;
        case 'turn.resume':
          break;
        case 'turn.end':
          this.openText = '';
          if (m.transcript && m.transcript.trim()) this.h.onFinal(m.transcript.trim());
          break;
        case 'error':
          this.h.onError(`${m.title || 'Speech recognition error'}: ${m.message || ''}`.trim());
          break;
      }
    };
    ws.onerror = () => this.log('STT socket error');
    ws.onclose = (e) => {
      if (e.code !== 1000 && e.code !== 1005) this.log(`STT closed (${e.code}${e.reason ? ` ${e.reason}` : ''})`);
      this.#done();
    };
  }

  sendAudio(chunk) {
    if (this.closed || this.finishing) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk);
    else this.pending.push(chunk);
  }

  // Ask the server to process buffered audio and emit the last events, then it closes the socket.
  finish() {
    if (this.closed || this.finishing) return;
    this.finishing = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.#sendClose();
    // If the server never closes, don't hang: give up and keep whatever we heard.
    this.finishTimer = setTimeout(() => {
      if (this.ws) try { this.ws.close(); } catch {}
      this.#done();
    }, 6000);
  }

  abort() {
    this.openText = '';
    this.finishing = true;
    if (this.ws) try { this.ws.close(); } catch {}
    this.#done();
  }

  #sendClose() {
    this.ws.send(JSON.stringify({ type: 'close' }));
  }

  #fail(msg) {
    this.h.onError(msg);
    this.#done();
  }

  #done() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.finishTimer);
    // A turn still open when the session ends (no turn.end arrived) still counts as a turn.
    const leftover = this.openText.trim();
    this.openText = '';
    if (leftover) this.h.onFinal(leftover);
    this.h.onClosed();
  }
}
