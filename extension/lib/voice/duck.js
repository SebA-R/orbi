// Quiets other tabs while the user talks to Clearcart and while it answers.
//
//   duck()          listening confirmed, or any non-idle voice state: every
//                   audible tab the user hasn't muted gets its <video> and
//                   <audio> faded to 0 (FADE_OUT_MS), then a tab mute, which
//                   also covers WebAudio and frames the fade can't reach.
//   onState(state)  "idle" restores after GRACE_MS, so back-to-back turns
//                   don't flap; anything else ducks (and cancels a pending
//                   restore).
//   restore()       only the tabs we muted, and only while Chrome still says
//                   this extension muted them: unmute, then fade the saved
//                   volumes back in (FADE_IN_MS).
//
// The ducked tab ids live in chrome.storage.session, so a worker restart can
// still restore them. Clearcart's own audio plays in the offscreen document,
// which is not a tab, so it is never touched. A quick tap never reaches here.
import { loadSettings } from "../settings.js";

export const GRACE_MS = 600;
export const FADE_OUT_MS = 200;
export const FADE_IN_MS = 300;
export const STORE_KEY = "duckedTabs";

// Injected into every frame of a ducked tab (isolated world, which persists
// per document, so the saved volumes survive between the two calls).
// down saves each element's volume and ramps it to 0; otherwise it ramps
// saved elements back up, unless the page changed the volume meanwhile.
export function fadeMedia(down, ms) {
  const saved = (globalThis.__clearcartDuck ||= new WeakMap());
  const els = [...document.querySelectorAll("video, audio")];
  return Promise.all(els.map((el) => new Promise((done) => {
    let to;
    if (down) {
      if (!saved.has(el)) saved.set(el, el.volume);
      to = 0;
    } else {
      if (!saved.has(el)) return done();
      to = saved.get(el);
      saved.delete(el);
      if (el.volume > 0.01) return done(); // the page or the user set it again
    }
    const from = el.volume;
    const start = Date.now();
    // Timers, not requestAnimationFrame: background tabs get no frames, and
    // audible tabs are not timer-throttled.
    const step = () => {
      const k = Math.min(1, (Date.now() - start) / ms);
      try { el.volume = from + (to - from) * k; } catch {}
      if (k < 1) setTimeout(step, 16);
      else done();
    };
    step();
  }))).then(() => els.length);
}

export function createDucker({
  chromeApi = globalThis.chrome,
  getSettings = () => loadSettings(chromeApi.storage.local),
  graceMs = GRACE_MS,
  fadeOutMs = FADE_OUT_MS,
  fadeInMs = FADE_IN_MS,
  timers = globalThis,
  log = () => {},
} = {}) {
  const store = chromeApi.storage.session;
  let chain = Promise.resolve();
  let restoreTimer = null;
  const queue = (fn) => {
    chain = chain.then(fn, fn).catch((err) => log(`duck: ${err && err.message}`));
    return chain;
  };

  const tracked = async () => (await store.get(STORE_KEY))[STORE_KEY] || [];
  const setTracked = (ids) => store.set({ [STORE_KEY]: ids });

  async function fade(tabId, down, ms) {
    const run = chromeApi.scripting.executeScript({ target: { tabId, allFrames: true }, func: fadeMedia, args: [down, ms] });
    const cap = new Promise((r) => timers.setTimeout(r, ms + 400)); // never wait on a stuck frame
    try {
      await Promise.race([run, cap]);
    } catch {
      // chrome:// pages, PDF viewers, the Web Store: no fade, the mute still works.
    }
  }

  function cancelRestore() {
    if (restoreTimer != null) timers.clearTimeout(restoreTimer);
    restoreTimer = null;
  }

  async function duckNow() {
    if (!(await getSettings()).quietTabs) return;
    const tabs = await chromeApi.tabs.query({ audible: true });
    const targets = tabs.filter((t) => t.id != null && !(t.mutedInfo && t.mutedInfo.muted));
    if (!targets.length) return;
    const ids = targets.map((t) => t.id);
    await setTracked([...new Set([...(await tracked()), ...ids])]);
    await Promise.all(ids.map((id) => fade(id, true, fadeOutMs)));
    await Promise.all(ids.map((id) => chromeApi.tabs.update(id, { muted: true }).catch(() => {})));
  }

  const ours = (info) => !!info && info.muted && info.reason === "extension" && info.extensionId === chromeApi.runtime.id;

  async function restoreNow() {
    const ids = await tracked();
    if (!ids.length) return;
    await setTracked([]);
    await Promise.all(ids.map(async (id) => {
      let tab;
      try { tab = await chromeApi.tabs.get(id); } catch { return; } // closed
      // The user muted or unmuted it since: their call, leave the mute alone.
      if (ours(tab.mutedInfo)) await chromeApi.tabs.update(id, { muted: false }).catch(() => {});
      // The faded volumes are ours either way; a page with nothing saved is a no-op.
      await fade(id, false, fadeInMs);
    }));
  }

  function duck() {
    cancelRestore();
    return queue(duckNow);
  }

  function restore() {
    cancelRestore();
    return queue(restoreNow);
  }

  function scheduleRestore() {
    cancelRestore();
    restoreTimer = timers.setTimeout(() => { restoreTimer = null; queue(restoreNow); }, graceMs);
  }

  function onState(state) {
    if (state === "idle") scheduleRestore();
    else if (state) duck();
  }

  // After a worker restart nobody knows the voice state; restore whatever
  // is still tracked unless a new turn starts within the grace.
  async function recover() {
    if ((await tracked()).length) scheduleRestore();
  }

  return { duck, restore, onState, recover, idle: () => chain };
}
