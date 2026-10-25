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
    pointers.set(tabId, { x, y });
    const ev = { tabId, x, y, t: now(), action, phase, ...extra };
    for (const fn of listeners) {
      try { fn(ev); } catch {}
    }
  }

  // The last tab activated in each window, with a counter, so a switch
  // while begin() is still looking up the window is not missed.
  let activations = 0;
  const activeIn = new Map();

  async function begin(tabId) {
    const run = { tabId, kind: null, windowId: null, aborted: null, wake: new Set() };
    runs.add(run);
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
    for (const p of path) {
      await sleep(run, p.ms);
      await mouse(run.tabId, { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 });
      emit(run.tabId, p.x, p.y, action, "move");
    }
  }

  const startFor = (tabId, to) => pointers.get(tabId) || entryPoint(to, rng);

  async function within(tabId, fn) {
    const run = await begin(tabId);
    try {
      return await fn(run);
    } finally {
      runs.delete(run);
    }
  }

  // Moves to `to`, rests, re-checks, presses and releases. recheck() runs
  // after the rest and right before the press; it may answer a new point
  // (the target moved), which gets one last small move.
  // `rect` is the target's box, for the press event; recheck may answer
  // { x, y, rect }.
  function click(tabId, to, { size, rect = null, recheck = async () => undefined } = {}) {
    return within(tabId, async (run) => {
      const plan = planClick(startFor(tabId, to), to, rng, { size });
      await travel(run, plan.path, "click");
      await sleep(run, plan.dwellMs);
      let at = to;
      let box = rect;
      try {
        const moved = await recheck();
        if (moved && Number.isFinite(moved.x) && Number.isFinite(moved.y)) at = { x: moved.x, y: moved.y };
        if (moved && moved.rect) box = moved.rect;
      } catch (e) {
        throw Object.assign(e, { noFallback: true });
      }
      live(run);
      if (at.x !== to.x || at.y !== to.y) {
        await mouse(tabId, { type: "mouseMoved", x: at.x, y: at.y, button: "none", buttons: 0 });
        emit(tabId, at.x, at.y, "click", "move");
        live(run);
      }
      const base = { x: at.x, y: at.y, button: "left", clickCount: 1 };
      // From here on nothing falls back to a DOM click: the press may have
      // reached the page even if the call failed.
      try {
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
    });
  }

  function hover(tabId, to, { size } = {}) {
    return within(tabId, async (run) => {
      const plan = planHover(startFor(tabId, to), to, rng, { size });
      await travel(run, plan.path, "hover");
      await sleep(run, plan.dwellMs);
    });
  }

  // Glides the pointer to (x, y), then sends the scroll as eased wheel steps.
  function scroll(tabId, { x, y, dx = 0, dy = 0 }) {
    return within(tabId, async (run) => {
      const to = { x, y };
      const plan = planHover(startFor(tabId, to), to, rng, { min: 120, max: 380 });
      await travel(run, plan.path, "scroll");
      for (const step of planScroll(dx, dy, rng)) {
        await sleep(run, step.ms);
        await mouse(tabId, { type: "mouseWheel", x, y, deltaX: step.dx, deltaY: step.dy });
        emit(tabId, x, y, "scroll", "wheel");
      }
    });
  }

  // Types text a key at a time, always at a typist's cadence (long text
  // just goes faster). check(ch) runs for every character and answers
  // { keys } (true: the focus is a plain text field) or throws to stop.
  // In a text field a character is rawKeyDown, the check, a char event
  // that types it, keyUp. Characters with no key (emoji, IME text,
  // newlines), or a focus that is not a text field, go in with insertText.
  // `focus` is the caller's check from just before (answers like check).
  function type(tabId, text, { check = async () => ({ keys: false }), focus: first = { keys: false } } = {}) {
    return within(tabId, async (run) => {
      run.kind = "type";
      let last = first;
      let spent = 0;
      for (const k of planTyping(text, rng)) {
        // Time spent checking and holding counts toward the next gap.
        await sleep(run, k.gapMs - spent);
        const t0 = now();
        // Key events only when the last check found a plain text field, so
        // no key goes to a button, a select or the page.
        const key = last && last.keys ? keyFor(k.ch) : null;
        if (!key) {
          last = await check(k.ch);
          live(run);
          // No key for it (emoji, IME text, newline) or not a text field.
          await cdp.send(tabId, "Input.insertText", { text: k.ch });
          spent = now() - t0;
          continue;
        }
        const ev = { key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, modifiers: key.shift ? MOD_SHIFT : 0 };
        await cdp.send(tabId, "Input.dispatchKeyEvent", { ...ev, type: "rawKeyDown" });
        try {
          // Checked after the keydown: a page handler may have moved the
          // focus (into a card field, say) and the character must not follow.
          last = await check(k.ch);
          live(run);
          const char = { ...ev, type: "char", text: k.ch, unmodifiedText: k.ch };
          if (last && last.keys) await cdp.send(tabId, "Input.dispatchKeyEvent", char);
          else await cdp.send(tabId, "Input.insertText", { text: k.ch });
        } finally {
          // A key that went down comes up, stopped or not.
          await new Promise((r) => setTimer(r, k.holdMs));
          await cdp.send(tabId, "Input.dispatchKeyEvent", { ...ev, type: "keyUp" });
        }
        spent = now() - t0;
      }
      return { via: "keys" };
    });
  }

  function abortAll(reason = "the user interrupted") {
    for (const run of runs) stop(run, reason);
  }

  function abortTab(tabId, reason) {
    for (const run of runs) if (run.tabId === tabId) stop(run, reason);
  }

  return {
    click,
    hover,
    scroll,
    type,
    abortAll,
    abortTab,
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
