import { test } from "node:test";
import assert from "node:assert/strict";

import { createActor } from "../../../extension/background/actor.js";
import { createRng } from "../../../extension/background/humanize.js";
import { createRouter } from "../../../extension/background/router.js";

const flush = () => new Promise((r) => setImmediate(r));

// Virtual timers: nothing waits on the wall clock. run(p) fires timers in
// order until p settles.
function fakeClock() {
  let t = 0;
  const q = [];
  const clock = {
    timers: 0,
    now: () => t,
    setTimer(fn, ms) {
      clock.timers++;
      const id = { fn, at: t + Math.max(0, ms || 0) };
      q.push(id);
      return id;
    },
    clearTimer(id) {
      const i = q.indexOf(id);
      if (i >= 0) q.splice(i, 1);
    },
    // Calls hook(t) after each timer fires.
    async run(promise, hook = () => {}) {
      let state = null;
      promise.then((v) => (state = { v }), (e) => (state = { e }));
      for (let idle = 0; ; ) {
        await flush();
        if (state) break;
        if (!q.length) {
          if (++idle > 20) throw new Error("stuck: nothing scheduled");
          continue;
        }
        idle = 0;
        q.sort((a, b) => a.at - b.at);
        const next = q.shift();
        t = next.at;
        next.fn();
        hook(t);
      }
      if (state.e) throw state.e;
      return state.v;
    },
  };
  return clock;
}

function fakeCdp(clock) {
  const sent = [];
  return {
    sent,
    send: async (tabId, method, params) => void sent.push({ t: clock.now(), tabId, method, ...params }),
    click: async (o) => void sent.push({ t: clock.now(), method: "cdp.click", ...o }),
    type: async (o) => void sent.push({ t: clock.now(), method: "cdp.type", ...o }),
    scroll: async (o) => void sent.push({ t: clock.now(), method: "cdp.scroll", ...o }),
    screenshot: async () => ({ data: "x", mimeType: "image/jpeg" }),
  };
}

function setup(seed = 1) {
  const clock = fakeClock();
  const cdp = fakeCdp(clock);
  const actor = createActor({ cdp, rng: createRng(seed), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, tabWindow: async () => 1 });
  return { clock, cdp, actor };
}

const mouse = (sent, type) => sent.filter((s) => s.method === "Input.dispatchMouseEvent" && (!type || s.type === type));

test("a click moves along a path, rests, then presses and releases on the target", async () => {
  const { clock, cdp, actor } = setup();
  const events = [];
  actor.onPointer((e) => events.push(e));
  await clock.run(actor.click(5, { x: 400, y: 300 }));
  const moves = mouse(cdp.sent, "mouseMoved");
  const [press] = mouse(cdp.sent, "mousePressed");
  const [release] = mouse(cdp.sent, "mouseReleased");
  assert.ok(moves.length >= 10, `${moves.length} moves`);
  assert.deepEqual([moves.at(-1).x, moves.at(-1).y, press.x, press.y, release.x, release.y], [400, 300, 400, 300, 400, 300]);
  assert.ok(press.t - moves.at(-1).t >= 110, "rests on the target before pressing");
  assert.ok(release.t - press.t >= 55, "holds the button");
  assert.ok(release.t >= 400 && release.t <= 1200, `${release.t} ms in all`);
  assert.deepEqual(actor.pointer(5), { x: 400, y: 300 });
  // The hook: every sample, with the action and phase.
  assert.equal(events.length, moves.length + 2);
  assert.deepEqual(Object.keys(events[0]).sort(), ["action", "phase", "t", "tabId", "x", "y"]);
  assert.deepEqual(events.slice(-2).map((e) => e.phase), ["press", "release"]);
  assert.ok(events.every((e) => e.action === "click" && e.tabId === 5));
});

test("the next move starts where the last one ended, per tab", async () => {
  const { clock, cdp, actor } = setup(2);
  await clock.run(actor.click(5, { x: 400, y: 300 }));
  cdp.sent.length = 0;
  await clock.run(actor.click(5, { x: 100, y: 120 }));
  const first = mouse(cdp.sent, "mouseMoved")[0];
  assert.ok(Math.hypot(first.x - 400, first.y - 300) < 60, `starts near the last point (${first.x}, ${first.y})`);
  assert.equal(actor.pointer(6), null);
  actor.notePointer(6, 10, 10);
  assert.deepEqual(actor.pointer(6), { x: 10, y: 10 });
});

// What a page receives as typed text: insertText and char events.
const typedText = (sent) => sent.filter((s) => s.method === "Input.insertText" || s.type === "char").map((s) => s.text).join("");

test("typing in a text field: rawKeyDown, check, char, keyUp per key, at a typist's pace", async () => {
  const { clock, cdp, actor } = setup(3);
  const checks = [];
  await clock.run(actor.type(5, "Hi milk!", { focus: { keys: true }, check: async (ch) => (checks.push([ch, cdp.sent.length]), { keys: true }) }));
  assert.deepEqual(checks.map((c) => c[0]), [..."Hi milk!"], "checked for every character");
  const seq = cdp.sent.map((s) => (s.method === "Input.insertText" ? "T" : s.type === "rawKeyDown" ? "D" : s.type === "char" ? "C" : "U")).join("");
  assert.match(seq, /^(DCU)+$/);
  // Each check runs after its keydown and before its char.
  checks.forEach(([, at], i) => assert.equal(at, i * 3 + 1));
  assert.equal(typedText(cdp.sent), "Hi milk!");
  const downs = cdp.sent.filter((s) => s.type === "rawKeyDown");
  assert.ok(downs.every((d) => !("text" in d)), "key downs insert nothing themselves");
  assert.equal(downs[0].modifiers, 8, "shift for H");
  const span = downs.at(-1).t - downs[0].t;
  const cps = ((downs.length - 1) / span) * 1000;
  assert.ok(cps >= 6 && cps <= 16, `${cps.toFixed(1)} chars/s`);
});

test("insertText only for characters with no key, or outside a text field", async () => {
  const { clock, cdp, actor } = setup(4);
  await clock.run(actor.type(5, "ok é😀\nz", { focus: { keys: true }, check: async () => ({ keys: true }) }));
  assert.deepEqual(cdp.sent.filter((s) => s.method === "Input.insertText").map((s) => s.text), ["é", "😀", "\n"]);
  assert.deepEqual(cdp.sent.filter((s) => s.type === "char").map((s) => s.text), ["o", "k", " ", "z"]);
  cdp.sent.length = 0;
  await clock.run(actor.type(5, "ok", { check: async () => ({ keys: false }) }));
  assert.ok(cdp.sent.every((s) => s.method === "Input.insertText"), "no key events off a text field");
});

test("long text is still typed key by key, faster but varied", async () => {
  const { clock, cdp, actor } = setup(4);
  const long = "two percent milk and a dozen eggs please ".repeat(12);
  const t0 = clock.now();
  await clock.run(actor.type(5, long, { focus: { keys: true }, check: async () => ({ keys: true }) }));
  assert.equal(typedText(cdp.sent), long);
  assert.equal(cdp.sent.filter((s) => s.method === "Input.insertText").length, 0, "no insertText shortcut");
  const downs = cdp.sent.filter((s) => s.type === "rawKeyDown");
  assert.equal(downs.length, long.length);
  const gaps = downs.slice(1).map((d, i) => d.t - downs[i].t);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(mean >= 18 && mean <= 40, `${mean.toFixed(1)} ms a key`);
  assert.ok(new Set(gaps).size > 10, "the cadence still varies");
  assert.ok(clock.now() - t0 < 15_000);
});

test("a scroll glides to the point, then sends wheel steps that add up", async () => {
  const { clock, cdp, actor } = setup(5);
  await clock.run(actor.scroll(5, { x: 300, y: 400, dx: 0, dy: 600 }));
  const wheels = mouse(cdp.sent, "mouseWheel");
  assert.ok(wheels.length >= 3);
  assert.equal(wheels.reduce((a, w) => a + w.deltaY, 0), 600);
  assert.ok(wheels.every((w) => w.x === 300 && w.y === 400));
  assert.ok(mouse(cdp.sent, "mouseMoved").length > 0, "the pointer goes there first");
  assert.ok(wheels.at(-1).t > wheels[0].t, "spread over time");
});

test("abortAll mid-path stops the click before the press", async () => {
  const { clock, cdp, actor } = setup(6);
  const p = actor.click(5, { x: 900, y: 600 });
  await assert.rejects(clock.run(p, (t) => t > 120 && actor.abortAll("the user started talking")), (e) => e.code === "interrupted" && e.noFallback === true);
  assert.ok(mouse(cdp.sent, "mouseMoved").length > 0);
  assert.equal(mouse(cdp.sent, "mousePressed").length, 0);
  assert.equal(actor.active(), 0);
});

test("switching to another tab in that window, or the page loading, stops the plan", async () => {
  const { clock, cdp, actor } = setup(7);
  // Activating the same tab (follow) changes nothing.
  let fired = false;
  await clock.run(actor.click(5, { x: 300, y: 300 }), () => { if (!fired) { fired = true; actor.onTabActivated({ tabId: 5, windowId: 1 }); } });
  assert.equal(mouse(cdp.sent, "mouseReleased").length, 1);
  cdp.sent.length = 0;
  await assert.rejects(clock.run(actor.click(5, { x: 50, y: 50 }), () => actor.onTabActivated({ tabId: 9, windowId: 1 })), /switched tabs/);
  assert.equal(mouse(cdp.sent, "mousePressed").length, 0);
  // Another window's tab switch does not.
  await clock.run(actor.click(5, { x: 80, y: 80 }), () => actor.onTabActivated({ tabId: 9, windowId: 2 }));
  await assert.rejects(clock.run(actor.scroll(5, { x: 1, y: 1, dy: 900 }), () => actor.onTabUpdated(5, { status: "loading", url: "https://x.test/" })), /page changed/);
  // A same-page address change (no load) does not.
  await clock.run(actor.scroll(5, { x: 1, y: 1, dy: 300 }), () => actor.onTabUpdated(5, { url: "https://x.test/?q=m" }));
  // A reload (loading, no url) stops a scroll too, but not typing: typing
  // has its own per-character document check in the router.
  await assert.rejects(clock.run(actor.scroll(5, { x: 1, y: 1, dy: 900 }), () => actor.onTabUpdated(5, { status: "loading" })), /page changed/);
  await clock.run(actor.type(5, "milk", { check: async () => ({ keys: true }) }), () => actor.onTabUpdated(5, { status: "loading" }));
});

test("a tab switch while the window is still being looked up is not missed", async () => {
  const clock = fakeClock();
  const cdp = fakeCdp(clock);
  let release;
  const actor = createActor({ cdp, rng: createRng(1), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, tabWindow: () => new Promise((r) => (release = () => r(1))) });
  const p = actor.click(5, { x: 50, y: 50 });
  await flush();
  actor.onTabActivated({ tabId: 9, windowId: 1 });
  release();
  await assert.rejects(clock.run(p), /switched tabs/);
  assert.equal(cdp.sent.length, 0);
});

test("an interrupt mid-typing stops the rest, and a key that went down comes up", async () => {
  const { clock, cdp, actor } = setup(8);
  let n = 0;
  const p = actor.type(5, "organic bananas", {
    focus: { keys: true },
    check: async () => {
      if (++n === 4) actor.abortAll("the user started talking");
      return { keys: true };
    },
  });
  await assert.rejects(clock.run(p), (e) => e.code === "interrupted");
  assert.equal(typedText(cdp.sent), "org");
  const downs = cdp.sent.filter((s) => s.type === "rawKeyDown").length;
  const ups = cdp.sent.filter((s) => s.type === "keyUp").length;
  assert.equal(downs, ups);
});

test("a failing check stops typing before that character", async () => {
  const { clock, cdp, actor } = setup(9);
  let n = 0;
  const p = actor.type(5, "hello", {
    focus: { keys: true },
    check: async () => {
      if (++n === 3) throw Object.assign(new Error("password field"), { code: "payment_field" });
      return { keys: true };
    },
  });
  await assert.rejects(clock.run(p), (e) => e.code === "payment_field");
  assert.equal(typedText(cdp.sent), "he");
  // The third key went down before its check failed, and came back up.
  assert.equal(cdp.sent.filter((s) => s.type === "rawKeyDown").length, cdp.sent.filter((s) => s.type === "keyUp").length);
});

// ------------------------------------------------------------- router

const RECT = { x: 10, y: 20, width: 100, height: 40 };

function routerFakes({
  watchable = true,
  guard = () => ({ ok: true, result: RECT }),
  focus = () => ({ kind: "text", payment: false, text: true }),
  // documentId answered for the nth injection.
  doc = () => "d",
  // Throws for a CDP call when it answers true.
  cdpFails = () => false,
} = {}) {
  const clock = fakeClock();
  const cdp = fakeCdp(clock);
  const send = cdp.send;
  cdp.send = async (tabId, method, params) => {
    if (cdpFails(method, params)) throw Object.assign(new Error("debugger detached"), { code: "internal" });
    return send(tabId, method, params);
  };
  const pages = [];
  let injections = 0;
  const count = (m) => pages.filter((p) => p.method === m).length;
  const chromeApi = {
    scripting: { executeScript: async () => [{ frameId: 0, documentId: doc(++injections) }] },
    tabs: {
      get: async (id) => ({ id, windowId: 1 }),
      sendMessage: async (tabId, msg) => {
        pages.push({ t: clock.now(), method: msg.method, params: msg.params, at: cdp.sent.length });
        if (msg.method === "focused_field") return { ok: true, result: focus(count("focused_field")) };
        if (msg.method === "guard_ref" || msg.method === "guard_point") return guard(count(msg.method), msg);
        if (msg.method === "rect" || msg.method === "press_check") return { ok: true, result: RECT };
        return { ok: true, result: { ok: true } };
      },
    },
  };
  const tabs = {
    resolveAllowedTab: async (id) => id ?? 7,
    assertPageAllowed: async () => {},
    tabInfo: async ({ tabId }) => ({ tabId, url: "http://localhost:4000/checkout" }),
    isPaySite: async () => true,
    tabsCreate: async ({ url, onCreated }) => (onCreated?.(11), { tabId: 11, url }),
    navigate: async ({ tabId, url }) => ({ tabId, url }),
    tabsClose: async ({ tabId }) => ({ tabId }),
    tabsActivate: async ({ tabId }) => ({ tabId }),
    tabsContext: async () => ({ tabs: [] }),
  };
  const follow = { to: async () => {}, own: (fn) => fn(), forget() {}, claim() {}, newTurn() {} };
  const actor = createActor({ cdp, rng: createRng(1), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, tabWindow: async () => 1 });
  let n = 0;
  const router = createRouter({ chromeApi, tabs, cdp, follow, actor, watchable: async () => watchable, now: () => 0, newNonce: () => `n${++n}` });
  return { clock, cdp, pages, router, actor };
}

test("router: the hit-test and lock check run again at press time", async () => {
  const f = routerFakes();
  const events = [];
  f.actor.onPointer((e) => events.push(e));
  const r = await f.clock.run(f.router.route("click", { tabId: 3, ref: "e4" }));
  assert.deepEqual(r, { ok: true, via: "cdp" });
  const guards = f.pages.filter((p) => p.method === "guard_ref");
  assert.equal(guards.length, 2);
  const moves = mouse(f.cdp.sent, "mouseMoved");
  const pressAt = f.cdp.sent.findIndex((s) => s.type === "mousePressed");
  assert.ok(guards[1].at >= f.cdp.sent.indexOf(moves.at(-1)) + 1, "second check after the pointer arrived");
  assert.equal(guards[1].at, pressAt, "and right before the press");
  assert.deepEqual([f.cdp.sent[pressAt].x, f.cdp.sent[pressAt].y], [60, 40]);
  // The cursor hook: the press carries the target's box.
  const press = events.find((e) => e.phase === "press");
  assert.deepEqual(press.rect, RECT);
  assert.equal(press.action, "click");
});

test("router: a control that turns locked during the approach is not pressed, and no DOM click", async () => {
  const f = routerFakes({ guard: (n) => (n === 1 ? { ok: true, result: RECT } : { ok: false, error: { code: "locked", message: "Locked: place order" } }) });
  await assert.rejects(f.clock.run(f.router.route("click", { tabId: 3, ref: "e4" })), (e) => e.code === "locked");
  assert.equal(mouse(f.cdp.sent, "mousePressed").length, 0);
  assert.equal(f.pages.filter((p) => p.method === "click_ref").length, 0);
});

test("router: a target that moved is pressed where it is now, after its new check", async () => {
  const f = routerFakes({ guard: (n) => ({ ok: true, result: n === 1 ? RECT : { x: 210, y: 20, width: 100, height: 40 } }) });
  await f.clock.run(f.router.route("click", { tabId: 3, ref: "e4" }));
  const [press] = mouse(f.cdp.sent, "mousePressed");
  assert.deepEqual([press.x, press.y], [260, 40]);
});

test("router: a point click re-runs guard_point before the press", async () => {
  const f = routerFakes({ guard: (n) => (n === 1 ? { ok: true, result: { ok: true } } : { ok: false, error: { code: "locked", message: "Locked" } }) });
  await assert.rejects(f.clock.run(f.router.route("click", { tabId: 3, x: 50, y: 60 })), (e) => e.code === "locked");
  assert.equal(f.pages.filter((p) => p.method === "guard_point").length, 2);
  assert.equal(mouse(f.cdp.sent, "mousePressed").length, 0);
});

test("router: a click whose page changed during the approach is not pressed", async () => {
  const f = routerFakes({ doc: (n) => (n === 1 ? "d1" : "d2") });
  await assert.rejects(f.clock.run(f.router.route("click", { tabId: 3, x: 50, y: 60 })), (e) => e.code === "interrupted");
  assert.equal(mouse(f.cdp.sent, "mousePressed").length, 0);
});

test("router: a failed press never falls back to a DOM click", async () => {
  const f = routerFakes({ cdpFails: (m, p) => p?.type === "mousePressed" });
  await assert.rejects(f.clock.run(f.router.route("click", { tabId: 3, ref: "e4" })));
  assert.equal(f.pages.filter((p) => p.method === "click_ref").length, 0);
});

test("router: a CDP failure during the approach falls back to the DOM click", async () => {
  const f = routerFakes({ cdpFails: (m, p) => p?.type === "mouseMoved" });
  const r = await f.clock.run(f.router.route("click", { tabId: 3, ref: "e4" }));
  assert.deepEqual(r, { ok: true, via: "dom" });
});

test("router: a paced press_protected that falls back runs press_check first", async () => {
  const f = routerFakes({ cdpFails: (m, p) => p?.type === "mouseMoved" });
  const { nonce } = await f.router.route("lock_arm", { tabId: 3 });
  const r = await f.clock.run(f.router.route("press_protected", { tabId: 3, ref: "e9", nonce }));
  assert.deepEqual(r, { ok: true, via: "dom" });
  const order = f.pages.map((p) => p.method).filter((m) => m === "press_check" || m === "press_ref");
  assert.deepEqual(order, ["press_check", "press_ref"]);
});

test("router: a paced press_protected checks on arrival, right before the press", async () => {
  const f = routerFakes();
  const { nonce } = await f.router.route("lock_arm", { tabId: 3 });
  await f.clock.run(f.router.route("press_protected", { tabId: 3, ref: "e9", nonce }));
  const check = f.pages.find((p) => p.method === "press_check");
  assert.equal(check.at, f.cdp.sent.findIndex((s) => s.type === "mousePressed"));
});

test("router: typing stops when the focus moves to a password field", async () => {
  const f = routerFakes({ focus: (n) => (n <= 4 ? { kind: "text", payment: false, text: true } : { kind: "text", payment: false, password: true, text: false }) });
  await assert.rejects(f.clock.run(f.router.route("type", { tabId: 3, text: "hunter2" })), (e) => e.code === "payment_field");
  // One check up front, then one per character: three characters went in.
  assert.equal(typedText(f.cdp.sent), "hun");
  assert.equal(f.cdp.sent.filter((s) => s.type === "rawKeyDown").length, f.cdp.sent.filter((s) => s.type === "keyUp").length);
});

test("router: typing stops when the page is a new document", async () => {
  const f = routerFakes({ doc: (n) => (n <= 3 ? "d1" : "d2") });
  await assert.rejects(f.clock.run(f.router.route("type", { tabId: 3, text: "bananas" })), (e) => e.code === "interrupted");
  assert.equal(typedText(f.cdp.sent), "ba");
});

test("router: card numbers and card fields are still refused before anything is typed", async () => {
  const f = routerFakes();
  await assert.rejects(f.clock.run(f.router.route("type", { tabId: 3, text: "4111 1111 1111 1111" })), (e) => e.code === "payment_field");
  const g = routerFakes({ focus: () => ({ kind: "cc-number", payment: true, text: true }) });
  await assert.rejects(g.clock.run(g.router.route("type", { tabId: 3, text: "abc" })), (e) => e.code === "payment_field");
  assert.equal(f.cdp.sent.length + g.cdp.sent.length, 0);
});

test("router: a typed newline is checked against the lock again when it is typed", async () => {
  const f = routerFakes();
  await f.clock.run(f.router.route("type", { tabId: 3, text: "ab\n" }));
  assert.equal(f.pages.filter((p) => p.method === "guard_key").length, 2, "once up front, once at the newline");
});

test("router: setting off makes clicks and scrolls instant; typing stays key by key", async () => {
  const f = routerFakes({ watchable: false });
  await f.clock.run(f.router.route("click", { tabId: 3, ref: "e4" }));
  await f.clock.run(f.router.route("scroll", { tabId: 3, x: 5, y: 5, dy: 400 }));
  assert.deepEqual(f.cdp.sent.map((s) => s.method), ["cdp.click", "cdp.scroll"]);
  assert.equal(f.clock.timers, 0, "no timers for clicks and scrolls");
  assert.equal(f.pages.filter((p) => p.method === "guard_ref").length, 1);
  f.cdp.sent.length = 0;
  await f.clock.run(f.router.route("type", { tabId: 3, text: "milk" }));
  assert.equal(typedText(f.cdp.sent), "milk");
  assert.equal(f.cdp.sent.filter((s) => s.type === "rawKeyDown").length, 4);
  assert.ok(f.clock.now() > 150, "at a typist's cadence");
});

test("router: tab work, reads and screenshots stay instant with the setting on", async () => {
  const f = routerFakes();
  await f.router.route("tabs_create", { url: "https://x.test/" });
  await f.router.route("navigate", { tabId: 3, url: "https://x.test/a" });
  await f.router.route("tabs_activate", { tabId: 3 });
  await f.router.route("tabs_close", { tabId: 3 });
  await f.router.route("screenshot", { tabId: 3 });
  await f.router.route("find", { tabId: 3, query: "milk" });
  assert.equal(f.clock.timers, 0);
  assert.equal(f.cdp.sent.length, 0);
});

test("router: scroll at watchable pace checks its numbers", async () => {
  const f = routerFakes();
  await assert.rejects(f.router.route("scroll", { tabId: 3, x: "a", y: 1, dy: 3 }), (e) => e.code === "bad_request");
});

test("router: actions_stop at turn end stops a paced click and typing, and answers at once", async () => {
  const f = routerFakes();
  let stopped = null;
  const hook = (t) => { if (t > 120 && !stopped) stopped = f.router.route("actions_stop", {}); };
  await assert.rejects(f.clock.run(f.router.route("click", { tabId: 3, ref: "e4" }), hook), (e) => e.code === "interrupted");
  assert.deepEqual(await stopped, { ok: true });
  assert.equal(mouse(f.cdp.sent, "mousePressed").length, 0);
  assert.equal(f.pages.filter((p) => p.method === "click_ref").length, 0, "no DOM click after a stop");

  stopped = null;
  const before = f.cdp.sent.length;
  await assert.rejects(f.clock.run(f.router.route("type", { tabId: 3, text: "a fairly long line of text" }), (t) => { if (!stopped && f.cdp.sent.length - before > 6) stopped = f.router.route("actions_stop", {}); }), (e) => e.code === "interrupted");
  const typed = f.cdp.sent.slice(before).filter((s) => s.type === "char").length;
  assert.ok(typed > 0 && typed < 26, `stopped part way (${typed} chars)`);
  assert.equal(f.actor.active(), 0);
});
