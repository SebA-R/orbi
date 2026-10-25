// Relays the actor's pointer samples (background/actor.js onPointer) to the
// top frame of the tab they happen in, where content/cursor.js draws
// Clearcart's cursor. Each sample is sent right after its input went to CDP,
// so the cursor moves in step with what the page receives.
//
// The cursor is hidden ({ phase: "hide" }) when the user switches tabs,
// interrupts (the actor's "stop"), the turn ends (voice back to idle) or the
// setting showCursor goes off. Every message carries the voice state, so
// the orb on the cursor wears the same face as the one in the subtitles.
//
// CDP input coordinates are already in the top frame's viewport, so no
// iframe mapping is needed here.

import { RT } from "../lib/protocol.js";

const CAPTION_CHARS = 60;
const ACTIVE = new Set(["listening", "thinking", "speaking"]);

export function createCursorRelay({ chromeApi = globalThis.chrome, enabled = () => true } = {}) {
  let shown = null; // the tab the cursor was last sent to
  let voice = "thinking";

  function post(tabId, msg) {
    try {
      const p = chromeApi.tabs.sendMessage(tabId, { type: RT.CURSOR, voice, ...msg }, { frameId: 0 });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  }

  function hide() {
    if (shown == null) return;
    const tabId = shown;
    shown = null;
    post(tabId, { phase: "hide" });
  }

  function onPointer(ev) {
    if (!ev) return;
    if (ev.phase === "stop") return hide();
    if (ev.tabId == null || !enabled()) return;
    if (shown != null && shown !== ev.tabId) hide();
    shown = ev.tabId;
    const msg = { phase: ev.phase, action: ev.action, x: ev.x, y: ev.y, t: ev.t };
    if (ev.rect) msg.rect = ev.rect;
    if (ev.to) msg.to = ev.to;
    if (typeof ev.text === "string") msg.text = ev.text.replace(/\s+/g, " ").trim().slice(0, CAPTION_CHARS);
    post(ev.tabId, msg);
  }

  return {
    onPointer,
    hide,
    onTabActivated({ tabId } = {}) {
      if (shown != null && tabId !== shown) hide();
    },
    onTabRemoved(tabId) {
      if (tabId === shown) shown = null;
    },
    onVoiceState(state) {
      if (typeof state !== "string") return;
      if (ACTIVE.has(state)) voice = state;
      else hide();
    },
    shownTab: () => shown,
  };
}
