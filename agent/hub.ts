// One voice session for every Orbi window.
//
// Each window that talks to Orbi (the extension's offscreen document,
// the voice console page) opens its own /session socket, but they share one
// Session: one Claude conversation driving one browser. (Before, every
// socket got its own Session, so two windows meant two agents in the same
// tabs, and one "yes" heard by both mics could confirm two checkouts.)
//
// The socket that owns the session is the one the user last talked into:
//   - {type:"interrupt"}, sent when the talk key goes down, claims it.
//     {type:"user_text"} claims it too, except from a socket that lost the
//     session since it last claimed while another one still owns it: those
//     words were said before the user moved to another window, so they are
//     dropped and the socket is told.
//   - Opening a socket never claims, so opening the console, or a reconnect
//     after a server restart, takes nothing from the window in use.
//   - Replies, read-backs, statuses and receipts go to the owner only.
//     A {type:"busy"} message carries seq: the number of user_text messages
//     that socket has sent, counted here (stale ones too), so its client
//     can match it against its own count whichever session answers.
//   - When the owner changes or goes away the Session hands off
//     (Session.handOff): a read-back or unlock question still waiting is
//     declined, never confirmed, so only the window that heard it can answer
//     it; a yes not used for paying yet is withdrawn; the turn in progress
//     stops talking. The old owner gets
//     {type:"standby", reason:"moved"} and stops speaking and listening.
//   - The Session ends when the last socket closes, or when its agent loop
//     stops; the next message starts a fresh one. Messages from a Session
//     that has ended reach nobody.
//   - When the user switches the agent between Claude and a local model
//     (switchBackend), the Session is retired the same way as a hand-off
//     (nothing waiting is confirmed, an unused yes is withdrawn) and a
//     fresh one starts on the new backend. The window in use keeps it. A
//     payment under way finishes first, and so does a turn the agent is
//     working on (its tool calls and reply are not cut off); a turn only
//     waiting for the user's answer is retired, which declines it. The
//     browser's fail-closed state (card values in a form, a failed tab
//     sweep) carries over. A switch back before it happened cancels it.

import type { ServerMessage } from "./session.ts";

export type Standby = { type: "standby"; reason: "moved" | "stale"; text: string };
export type HubMessage = ServerMessage | Standby;

export interface HubSession {
  userText(text: string): unknown;
  interrupt(): void;
  handOff(): void;
  close(): void;
  // What its agent runs on (local/config.ts backendKey); none in echo mode.
  backend?: string;
  // handOff() and close() in one, for a session being replaced.
  retire?(why: string): void;
  // Not to be replaced right now (a payment is under way).
  busy?(): boolean;
  // The agent is working on a turn: a switch waits for it to end.
  midTurn?(): boolean;
  // What the session that replaces it must start with (session.ts
  // SessionCarry).
  carry?(): unknown;
}

// A new session whose messages go out through send. It calls ended() when
// its agent loop has stopped for good. carry: what the session it replaces
// handed over, if it replaces one.
export type CreateSession = (send: (m: ServerMessage) => void, ended: () => void, carry?: unknown) => HubSession;

// How often a switch waiting for a payment or a turn to finish checks again.
export const SWITCH_RETRY_MS = 250;
// The longest a switch waits for a turn in progress (not a payment).
export const SWITCH_TURN_MAX_MS = 120_000;

export const ELSEWHERE_TEXT = "Orbi is in use in another window. Talk here to use it here.";
export const MOVED_TEXT = "Orbi moved to another window. Talk here to bring it back.";
export const STALE_TEXT = "Not sent: Orbi is in use in another window. Talk here again to use it here.";

type Peer = { send: (m: HubMessage) => void; lost: boolean; seq: number };

export type HubPeer = {
  interrupt(): void;
  userText(text: string): void;
  leave(): void;
};

export class SessionHub {
  private peers = new Set<Peer>();
  private owner: Peer | null = null;
  private session: HubSession | null = null;
  // A backend switch waiting for the session's payment or turn to finish.
  private pendingSwitch: NodeJS.Timeout | null = null;
  // That switch: when it was asked for, whether the window was told it
  // waits, and whether the log has said so.
  private waiting: { since: number; told: boolean; logged: boolean } | null = null;

  constructor(private create: CreateSession, private log: (line: string) => void = () => {}) {}

  // A socket opened. Starts the session if there is none yet (so the agent
  // warms up), but takes nothing from the window that owns it.
  join(send: (m: HubMessage) => void): HubPeer {
    const peer: Peer = { send, lost: false, seq: 0 };
    this.peers.add(peer);
    if (this.owner) send({ type: "status", text: ELSEWHERE_TEXT });
    this.ensure();
    return {
      interrupt: () => this.interrupt(peer),
      userText: (text) => this.userText(peer, text),
      leave: () => this.leave(peer),
    };
  }

  private ensure(carry?: unknown): HubSession {
    if (this.session) return this.session;
    let s: HubSession | null = null;
    const live = () => s !== null && this.session === s;
    s = this.create(
      (m) => {
        if (!live() || !this.owner) return;
        this.owner.send(m.type === "busy" ? { ...m, seq: this.owner.seq } : m);
      },
      () => {
        if (!live()) return;
        this.session = null;
        s!.close();
        this.log("voice session ended (agent stopped)");
      },
      carry
    );
    this.session = s;
    this.log("voice session started");
    return s;
  }

  // The user acted in this window: it owns the session from now on.
  private claim(peer: Peer): HubSession {
    const s = this.ensure();
    if (this.owner === peer) return s;
    const prev = this.owner;
    this.owner = peer;
    peer.lost = false;
    if (prev) {
      prev.lost = true;
      prev.send({ type: "standby", reason: "moved", text: MOVED_TEXT });
    }
    s.handOff();
    this.log(prev ? "voice session moved to another window" : "voice session claimed");
    return s;
  }

  // The agent's provider setting changed. A session on another backend is
  // retired: a read-back or unlock question still waiting is declined,
  // never confirmed, a yes pay_with_saved_card has not used is withdrawn, and nothing
  // it says afterwards reaches anyone. A new session on the new backend
  // starts if a window is open, with the old one's fail-closed browser
  // state (carry). While a payment is under way the switch waits for it:
  // its card may be in the form, and its receipt must reach the window.
  // While the agent is working on a turn it waits too, so the turn's tool
  // calls and reply are not cut off. Returns whether it switched now.
  switchBackend(backend: string, label = backend): boolean {
    return this.trySwitch(backend, label, true);
  }

  private trySwitch(backend: string, label: string, first: boolean): boolean {
    if (this.pendingSwitch) clearTimeout(this.pendingSwitch);
    this.pendingSwitch = null;
    const waited = first ? null : this.waiting;
    if (first) {
      // A newer setting: a switch still waiting is replaced (or cancelled
      // below, when this one is the backend the session already runs on).
      const prev = this.waiting;
      this.waiting = null;
      const s = this.session;
      if (prev?.told && s && s.backend === backend) this.owner?.send({ type: "status", text: `Staying on ${label}.` });
    }
    const s = this.session;
    if (!s || s.backend === undefined || s.backend === backend) return false;
    const w = waited ?? { since: Date.now(), told: false, logged: false };
    this.waiting = w;
    const paying = s.busy?.() === true;
    // A payment always finishes first. A turn is waited for up to
    // SWITCH_TURN_MAX_MS, so a turn that never reports its end can't keep
    // the old backend forever.
    const turn = !paying && s.midTurn?.() === true && Date.now() - w.since < SWITCH_TURN_MAX_MS;
    if (paying || turn) {
      if (!w.logged) {
        w.logged = true;
        this.log(`voice session switch to ${label} waits for the ${paying ? "payment under way" : "turn in progress"}`);
      }
      if (turn && !w.told) {
        w.told = true;
        this.owner?.send({ type: "status", text: `Switching to ${label} when this turn ends.` });
      }
      this.pendingSwitch = setTimeout(() => this.trySwitch(backend, label, false), SWITCH_RETRY_MS);
      this.pendingSwitch.unref?.();
      return false;
    }
    this.waiting = null;
    const why = `switched to ${label}`;
    const carry = s.carry?.();
    if (s.retire) s.retire(why);
    else {
      s.handOff();
      s.close();
    }
    if (this.session === s) this.session = null;
    this.log(`voice session restarted (${why})`);
    if (this.peers.size) this.ensure(carry);
    this.owner?.send({ type: "status", text: `Switched to ${label}. Starting a new conversation.` });
    return true;
  }

  private interrupt(peer: Peer) {
    if (!this.peers.has(peer)) return;
    this.claim(peer).interrupt();
  }

  private userText(peer: Peer, text: string) {
    if (!this.peers.has(peer)) return;
    peer.seq++;
    if (peer.lost) {
      peer.send({ type: "standby", reason: "stale", text: STALE_TEXT });
      return;
    }
    this.claim(peer).userText(text);
  }

  private leave(peer: Peer) {
    if (!this.peers.delete(peer)) return;
    if (this.owner === peer) {
      this.owner = null;
      this.session?.handOff();
      // Nobody owns it now, so no window is "elsewhere": the next words from
      // any of them claim it (a client that only sends user_text included).
      for (const p of this.peers) p.lost = false;
    }
    if (!this.peers.size && this.session) {
      const s = this.session;
      this.session = null;
      s.close();
      this.log("voice session ended (no window left)");
    }
  }
}

// AGENT_MODE=echo: answers each user_text with "You said: ...", no Claude.
// It goes through the hub too, so echo mode has the same one-owner rules.
export function echoSession(send: (m: ServerMessage) => void): HubSession {
  return {
    userText: (text) => send({ type: "agent_text", text: `You said: ${text}` }),
    interrupt() {},
    handOff() {},
    close() {},
  };
}
