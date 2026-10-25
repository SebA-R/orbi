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
// Cursor hook for a future on-page cursor: onPointer(fn) gets
// { tabId, x, y, t, action, phase } for every pointer sample, where action
// is "click", "hover" or "scroll" and phase is "move", "press", "release"
// or "wheel". t is Date.now() when the sample was sent.

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

  function emit(tabId, x, y, action, phase) {
    pointers.set(tabId, { x, y });
    const ev = { tabId, x, y, t: now(), action, phase };
    for (const fn of listeners) {
      try { fn(ev); } catch {}
    }
  }

  async function begin(tabId) {
    const run = { tabId, windowId: null, aborted: null, wake: new Set() };
    runs.add(run);
    try {
      run.windowId = await tabWindow(tabId);
    } catch {}
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
  function click(tabId, to, { size, recheck = async () => undefined } = {}) {
    return within(tabId, async (run) => {
      const plan = planClick(startFor(tabId, to), to, rng, { size });
      await travel(run, plan.path, "click");
      await sleep(run, plan.dwellMs);
      let at = to;
      try {
        const moved = await recheck();
        if (moved && Number.isFinite(moved.x) && Number.isFinite(moved.y)) at = { x: moved.x, y: moved.y };
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
      await mouse(tabId, { ...base, type: "mousePressed", buttons: 1 });
      emit(tabId, at.x, at.y, "click", "press");
      try {
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

  // Types text a character at a time. check(ch) runs right before every
  // character and answers { keys } (true: the focus is a plain text field,
  // so key events go with the character) or throws to stop. Each character
  // is inserted with insertText, exactly once; the key events around it are
  // rawKeyDown/keyUp, which insert nothing themselves. Text too long to type
  // by hand goes in with one insertText after one check.
  function type(tabId, text, { check = async () => ({ keys: false }) } = {}) {
    return within(tabId, async (run) => {
      const plan = planTyping(text, rng);
      if (plan === null) {
        await check(text);
        live(run);
        await cdp.send(tabId, "Input.insertText", { text });
        return { via: "insertText" };
      }
      let checkMs = 0;
      for (const k of plan) {
        // The check's own time counts toward the gap.
        await sleep(run, k.gapMs - checkMs);
        const t0 = now();
        const focus = await check(k.ch);
        checkMs = now() - t0;
        live(run);
        const key = focus && focus.keys ? keyFor(k.ch) : null;
        if (!key) {
          await cdp.send(tabId, "Input.insertText", { text: k.ch });
          continue;
        }
        const ev = { key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, modifiers: key.shift ? MOD_SHIFT : 0 };
        await cdp.send(tabId, "Input.dispatchKeyEvent", { ...ev, type: "rawKeyDown" });
        try {
          await cdp.send(tabId, "Input.insertText", { text: k.ch });
        } finally {
          // A key that went down comes up, stopped or not.
          await new Promise((r) => setTimer(r, k.holdMs));
          await cdp.send(tabId, "Input.dispatchKeyEvent", { ...ev, type: "keyUp" });
        }
        checkMs += k.holdMs;
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
      for (const run of runs) {
        if (run.tabId !== tabId && run.windowId != null && run.windowId === windowId) stop(run, "the user switched tabs");
      }
    },
    onTabRemoved(tabId) {
      abortTab(tabId, "the tab closed");
      pointers.delete(tabId);
    },
    // A new document loading in the tab. A same-page address change (a
    // search box that rewrites ?q= as you type) is not one.
    onTabUpdated(tabId, change = {}) {
      if (change.status === "loading" && change.url) {
        abortTab(tabId, "the page changed");
        pointers.delete(tabId);
      }
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
