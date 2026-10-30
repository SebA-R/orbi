// Turn timing, off unless ORBI_TIMING=1: one console line per mark of the
// turn in progress, in ms since the user let go of the talk key (or since
// user_text arrived when the client did not say), so a run shows where a
// turn's time goes:
//
//   [timing] +    0 released          (client: the talk key came up)
//   [timing] +  412 stt_final         (client: the last Ink final it used)
//   [timing] +  431 user_text         (this server got it)
//   [timing] +  460 context           (page_context back, turn handed to Claude)
//   [timing] + 2210 first_token       (first model output: thinking, text or tool)
//   [timing] + 2890 tool_start find
//   [timing] + 3011 tool_end find 121ms
//   [timing] + 4720 first_speech say  (first agent_text out: say or the reply)
//   [timing] + 5010 first_audio       (client: Sonic's first chunk starts playing)
//   [timing] + 9400 turn_end 3 steps, 8000 in / 4100 cached / 200 out
//
// Clients send their marks as epoch ms (Date.now() on the same machine).
// Nothing here changes what a turn does; with the flag off every call is a
// no-op.

// Read on every call: server.ts loads .env after the modules are imported.
export function timingOn(): boolean {
  return /^(1|true|on|yes)$/i.test(process.env.ORBI_TIMING?.trim() || "");
}

type Turn = { t0: number; seen: Set<string>; tools: Map<string, { name: string; at: number }> };
let turn: Turn | null = null;

function line(t: Turn, label: string, at = Date.now()) {
  console.log(`[timing] +${String(Math.round(at - t.t0)).padStart(5)} ${label}`);
}

function epoch(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 1e12 ? v : null;
}

// A user_text arrived. client: its {releasedAt, finalAt} marks, if any.
export function beginTurn(client?: unknown) {
  if (!timingOn()) return;
  const now = Date.now();
  const c = (client && typeof client === "object" ? client : {}) as Record<string, unknown>;
  const released = epoch(c.releasedAt);
  // A clock mark from the future or minutes old is not this turn's.
  const t0 = released && released <= now && now - released < 60_000 ? released : now;
  const t: Turn = { t0, seen: new Set(), tools: new Map() };
  turn = t;
  console.log("[timing] ---- turn");
  if (t0 !== now) line(t, "released", t0);
  const fin = epoch(c.finalAt);
  if (fin && fin >= t0 && fin <= now) line(t, "stt_final", fin);
  line(t, "user_text", now);
}

// A mark of the turn in progress. once: only its first occurrence counts.
export function mark(label: string, { once = false, detail = "" } = {}) {
  if (!timingOn() || !turn) return;
  if (once) {
    if (turn.seen.has(label)) return;
    turn.seen.add(label);
  }
  line(turn, detail ? `${label} ${detail}` : label);
}

export function toolStart(id: string, name: string) {
  if (!timingOn() || !turn) return;
  turn.tools.set(id, { name, at: Date.now() });
  line(turn, `tool_start ${name}`);
}

export function toolEnd(id: string) {
  if (!timingOn() || !turn) return;
  const s = turn.tools.get(id);
  if (!s) return;
  turn.tools.delete(id);
  line(turn, `tool_end ${s.name} ${Date.now() - s.at}ms`);
}

// A line outside any turn (the local model's warm-up).
export function note(label: string) {
  if (timingOn()) console.log(`[timing] ${label}`);
}

// A mark the client measured: {type:"timing", event, at}.
export function clientMark(event: unknown, at: unknown) {
  if (!timingOn() || !turn || typeof event !== "string" || !/^[a-z_]{1,32}$/.test(event)) return;
  const when = epoch(at) ?? Date.now();
  if (turn.seen.has(`client:${event}`)) return;
  turn.seen.add(`client:${event}`);
  line(turn, event, when);
}
