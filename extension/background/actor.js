// Plays the plans from background/humanize.js through CDP, so the agent's
// clicks, typing and scrolls go at a pace the user can watch. Tab work,
// page reads and screenshots never come through here; they stay instant.
//
// The actor keeps the last pointer position per tab, so each move starts
// where the previous one ended. A plan stops early when the user barges in
// (abortAll), switches to another tab in that window, or the tab navigates
// or closes; the call then fails with ERR.INTERRUPTED. A press that was sent
// is always released, so no button is left held down.
//
// Safety checks run at press time, not plan time: click() calls the
// caller's recheck after the pointer arrives and right before the press, and
// type() calls check before every character. Whatever they throw stops the
// plan with nothing pressed or typed.
//
// Cursor hook for an on-page cursor: onPointer(fn) gets
// { tabId, x, y, t, action, phase } for every pointer sample, where action
// is "click", "hover" or "scroll" and phase is "move", "press", "release"
// or "wheel". t is Date.now() when the sample was sent. The "press" event
// also carries rect { x, y, width, height }, the target's box, when known.
// Every "move" carries to { x, y }, where the gesture is headed. Typing
// sends one { action: "type", phase: "type", text } before the first key
// and { action: "type", phase: "key" } after each one, at the last pointer
// position (x and y are null when the tab has none).
// abortAll sends { tabId: null, phase: "stop" }. Coordinates are CSS pixels
// in the top frame's viewport, the space CDP input uses.
//
// Typing always goes through here, key by key, whatever the setting; the
// setting only decides whether clicks and scrolls are paced.

import { BridgeError, ERR } from "../lib/protocol.js";
import { createRng, entryPoint, planClick, planHover, planScroll, planTyping, keyFor } from "./humanize.js";

const MOD_SHIFT = 8;

function interrupted(reason) {
  return Object.assign(new BridgeError(ERR.INTERRUPTED, `stopped: ${reason}`), { noFallback: true });
}

export function createActor({
  cdp,
  rng = createRng(),
  now = () => Date.now(),
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (id) => globalThis.clearTimeout(id),
  // The window a tab is in, so a switch to another tab there stops its plan.
  tabWindow = async (tabId) => (await globalThis.chrome.tabs.get(tabId)).windowId,
} = {}) {
  const pointers = new Map();
  const runs = new Set();
  const listeners = new Set();

  function emit(tabId, x, y, action, phase, extra) {
    if (x != null && y != null) pointers.set(tabId, { x, y });
    tell({ tabId, x, y, t: now(), action, phase, ...extra });
  }

  // One typed character went in.
  function key_(tabId) {
    const at = pointers.get(tabId);
    emit(tabId, at ? at.x : null, at ? at.y : null, "type", "key");
  }

  function tell(ev) {
    for (const fn of listeners) {
      try { fn(ev); } catch {}
    }
  }

  // The last tab activated in each window, with a counter, so a switch
  // while begin() is still looking up the window is not missed.
  let activations = 0;
  const activeIn = new Map();

  // Bumped by abortAll. A caller passes the epoch it read when its call
  // began, so an abort during its own checks, before the run exists here,
  // still stops it.
  let stopEpoch = 0;
  let lastAbort = "the user interrupted";

  async function begin(tabId, epoch) {
    const run = { tabId, kind: null, windowId: null, aborted: null, wake: new Set() };
    runs.add(run);
    if (epoch != null && epoch !== stopEpoch) stop(run, lastAbort);
    const seen = activations;
    try {
      run.windowId = await tabWindow(tabId);
    } catch {}
    const a = run.windowId != null && activeIn.get(run.windowId);
    if (a && a.n > seen && a.tabId !== tabId) stop(run, "the user switched tabs");
    return run;
  }

  function stop(run, reason) {
    if (run.aborted) return;
    run.aborted = reason;
    for (const w of run.wake) w();
  }

  function live(run) {
    if (run.aborted) throw interrupted(run.aborted);
  }

  function sleep(run, ms) {
    live(run);
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimer(id);
        run.wake.delete(done);
        run.aborted ? reject(interrupted(run.aborted)) : resolve();
      };
      const id = setTimer(done, ms);
      run.wake.add(done);
    });
  }

  const mouse = (tabId, params) => cdp.send(tabId, "Input.dispatchMouseEvent", params);

  async function travel(run, path, action) {
    const end = path[path.length - 1];
    const to = end ? { x: end.x, y: end.y } : null;
    for (const p of path) {
      await sleep(run, p.ms);
      await mouse(run.tabId, { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 });
      emit(run.tabId, p.x, p.y, action, "move", { to });
    }
  }

  const startFor = (tabId, to) => pointers.get(tabId) || entryPoint(to, rng);

  async function within(tabId, fn, epoch) {
    const run = await begin(tabId, epoch);
    try {
      return await fn(run);
    } catch (e) {
      // A stopped plan fails as stopped, whatever CDP said (a navigating
      // or closing tab rejects the event in flight), and never falls back.
      if (run.aborted && !(e && e.noFallback)) throw interrupted(run.aborted);
      throw e;
    } finally {
      runs.delete(run);
    }
  }

  // Moves to `to`, rests, re-checks, presses and releases. recheck() runs
  // after the rest and right before the press; it may answer a new point
  // (the target moved), which gets one last small move.
  // `rect` is the target's box, for the press event; recheck may answer
  // { x, y, rect }.
  function click(tabId, to, { size, rect = null, recheck = async () => undefined, epoch } = {}) {
    return within(tabId, async (run) => {
      const plan = planClick(startFor(tabId, to), to, rng, { size });
      await travel(run, plan.path, "click");
      await sleep(run, plan.dwellMs);
      let at = to;
      let box = rect;
      // From here on nothing falls back to a DOM click: the checks run
      // first (press_check takes the lock marker off), and the press may
      // have reached the page even if the call failed.
      try {
        const moved = await recheck();
        if (moved && Number.isFinite(moved.x) && Number.isFinite(moved.y)) at = { x: moved.x, y: moved.y };
        if (moved && moved.rect) box = moved.rect;
        live(run);
        if (at.x !== to.x || at.y !== to.y) {
          await mouse(tabId, { type: "mouseMoved", x: at.x, y: at.y, button: "none", buttons: 0 });
          emit(tabId, at.x, at.y, "click", "move", { to: { x: at.x, y: at.y } });
          live(run);
        }
        const base = { x: at.x, y: at.y, button: "left", clickCount: 1 };
        await mouse(tabId, { ...base, type: "mousePressed", buttons: 1 });
        emit(tabId, at.x, at.y, "click", "press", box ? { rect: { x: box.x, y: box.y, width: box.width, height: box.height } } : {});
        // Released even when stopped mid-hold; the press already happened.
        await new Promise((r) => setTimer(r, plan.holdMs));
        await mouse(tabId, { ...base, type: "mouseReleased", buttons: 0 });
        emit(tabId, at.x, at.y, "click", "release");
      } catch (e) {
        throw Object.assign(e, { noFallback: true });
      }
      return at;
    }, epoch);
  }

  // Glides the pointer to (x, y), then sends the scroll as eased wheel steps.
  function scroll(tabId, { x, y, dx = 0, dy = 0 }, { epoch } = {}) {
    return within(tabId, async (run) => {
      const to = { x, y };
      const plan = planHover(startFor(tabId, to), to, rng, { min: 120, max: 380 });
      await travel(run, plan.path, "scroll");
      for (const step of planScroll(dx, dy, rng)) {
        await sleep(run, step.ms);
        await mouse(tabId, { type: "mouseWheel", x, y, deltaX: step.dx, deltaY: step.dy });
        emit(tabId, x, y, "scroll", "wheel");
      }
    }, epoch);
  }

  // Types text a key at a time, always at a typist's cadence (long text
  // just goes faster). check(ch) runs for every character and answers
  // { keys } (true: the focus is a plain text field) or throws to stop.
  // It runs right before each key goes down, so no key event reaches a
  // focus that moved during the gap (a button a Space would press, a card
  // field), and again after the keydown, since a page handler may move the
  // focus then. In a text field a character is rawKeyDown, the check, a
  // char event that types it, keyUp. Characters with no key (emoji, IME
  // text, newlines), or a focus that is not a text field, go in with
  // insertText.
  function type(tabId, text, { check = async () => ({ keys: false }), epoch } = {}) {
    return within(tabId, async (run) => {
      run.kind = "type";
      const at = pointers.get(tabId);
      emit(tabId, at ? at.x : null, at ? at.y : null, "type", "type", { text: String(text) });
      let spent = 0;
      for (const k of planTyping(text, rng)) {
        // Time spent checking and holding counts toward the next gap.
        await sleep(run, k.gapMs - spent);
        const t0 = now();
        const before = await check(k.ch);
        live(run);
        const key = before && before.keys ? keyFor(k.ch) : null;
        if (!key) {
          // No key for it, or not a text field: no key event at all.
          await cdp.send(tabId, "Input.insertText", { text: k.ch });
          key_(tabId);
          spent = now() - t0;
          continue;
        }
        const ev = { key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, modifiers: key.shift ? MOD_SHIFT : 0 };
        await cdp.send(tabId, "Input.dispatchKeyEvent", { ...ev, type: "rawKeyDown" });
        try {
          const after = await check(k.ch);
          live(run);
          const char = { ...ev, type: "char", text: k.ch, unmodifiedText: k.ch };
          if (after && after.keys) await cdp.send(tabId, "Input.dispatchKeyEvent", char);
          else await cdp.send(tabId, "Input.insertText", { text: k.ch });
        } finally {
          // A key that went down comes up, stopped or not.
          await new Promise((r) => setTimer(r, k.holdMs));
          await cdp.send(tabId, "Input.dispatchKeyEvent", { ...ev, type: "keyUp" });
        }
        key_(tabId);
        spent = now() - t0;
      }
      return { via: "keys" };
    }, epoch);
  }

  function abortAll(reason = "the user interrupted") {
    stopEpoch++;
    lastAbort = reason;
    for (const run of runs) stop(run, reason);
    tell({ tabId: null, x: null, y: null, t: now(), action: null, phase: "stop" });
  }

  function abortTab(tabId, reason) {
    for (const run of runs) if (run.tabId === tabId) stop(run, reason);
  }

  return {
    click,
    scroll,
    type,
    abortAll,
    // Read when a call begins; pass it as { epoch } to stop on any abortAll
    // after that.
    epoch: () => stopEpoch,
    // Listener bodies for the worker.
    onTabActivated({ tabId, windowId } = {}) {
      activeIn.set(windowId, { tabId, n: ++activations });
      for (const run of runs) {
        if (run.tabId !== tabId && run.windowId != null && run.windowId === windowId) stop(run, "the user switched tabs");
      }
    },
    onTabRemoved(tabId) {
      abortTab(tabId, "the tab closed");
      pointers.delete(tabId);
    },
    // The tab started loading (a navigation, reload or form post): stops a
    // click or scroll. Typing is left to its per-character check, which
    // the router fails when the document changed, because some pages load
    // as you type (a search box rewriting the address).
    onTabUpdated(tabId, change = {}) {
      if (change.status !== "loading") return;
      for (const run of runs) if (run.tabId === tabId && run.kind !== "type") stop(run, "the page changed");
      pointers.delete(tabId);
    },
    // An instant click or scroll still moves the pointer.
    notePointer(tabId, x, y) {
      pointers.set(tabId, { x, y });
    },
    pointer: (tabId) => pointers.get(tabId) || null,
    active: () => runs.size,
    onPointer(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
