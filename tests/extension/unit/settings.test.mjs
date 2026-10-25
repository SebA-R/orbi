import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULTS, endpoints, loadSettings, normalize, normalizeAgentUrl, normalizeOrigin, parseOriginLines, saveSettings, seedBlocklist,
  SPEAK_REPLIES_COPY, replyWarning, speakRepliesNote,
} from "../../../extension/lib/settings.js";
import { SUGGESTED_BLOCKLIST } from "../../../extension/lib/blocklist.js";

function memoryStorage(init = {}) {
  const data = { ...init };
  return {
    data,
    async get(keys) {
      return Object.fromEntries([keys].flat().filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(obj) {
      Object.assign(data, obj);
    },
  };
}

test("agent URL must be a ws(s) URL on this machine", () => {
  assert.equal(normalizeAgentUrl("ws://localhost:5050/"), "ws://localhost:5050");
  assert.equal(normalizeAgentUrl("ws://127.0.0.1:6000/ext"), "ws://127.0.0.1:6000");
  assert.equal(normalizeAgentUrl("http://localhost:5050"), null);
  assert.equal(normalizeAgentUrl("ws://evil.example:5050"), null);
  assert.equal(normalizeAgentUrl("ws://localhost.evil.example"), null);
  assert.equal(normalizeAgentUrl("nonsense"), null);
});

test("origins are parsed and credentials are refused", () => {
  assert.equal(normalizeOrigin("http://localhost:4000/cart"), "http://localhost:4000");
  assert.equal(normalizeOrigin("http://localhost:4000@evil.example/"), null);
  assert.equal(normalizeOrigin("javascript:alert(1)"), null);
});

test("normalize falls back to defaults for bad values", () => {
  assert.deepEqual(normalize({}), { ...DEFAULTS, allowlist: ["http://localhost:4000"], blocklist: [...SUGGESTED_BLOCKLIST] });
  const s = normalize({ agentUrl: "ws://x.example", hotkey: "Nope", speed: 9, subtitles: "yes", allowlist: ["bad"] });
  assert.equal(s.agentUrl, DEFAULTS.agentUrl);
  assert.equal(s.hotkey, DEFAULTS.hotkey);
  assert.equal(s.speed, 2);
  assert.equal(s.subtitles, true);
  assert.deepEqual(s.allowlist, ["http://localhost:4000"]);
  assert.deepEqual(normalize({ allowlist: ["http://localhost:4100/", "http://localhost:4100"] }).allowlist, ["http://localhost:4100"]);
});

test("the Clearcart new tab page is on by default; only a stored boolean changes it", () => {
  assert.equal(DEFAULTS.newTabPage, true);
  assert.equal(normalize({ newTabPage: "no" }).newTabPage, true);
  assert.equal(normalize({ newTabPage: false }).newTabPage, false);
  assert.equal(DEFAULTS.errorPages, true);
  assert.equal(normalize({ errorPages: "no" }).errorPages, true);
  assert.equal(normalize({ errorPages: false }).errorPages, false);
});

test("endpoints derive the bridge, session and token URLs", () => {
  assert.deepEqual(endpoints("ws://localhost:5150"), {
    ext: "ws://localhost:5150/ext",
    session: "ws://localhost:5150/session",
    http: "http://localhost:5150",
    token: "http://localhost:5150/cartesia-token",
  });
});

test("load and save round-trip through storage with validation", async () => {
  const st = memoryStorage({ speed: 1.4 });
  assert.equal((await loadSettings(st)).speed, 1.4);
  const next = await saveSettings({ hotkey: "F9", agentUrl: "ws://evil.example" }, st);
  assert.equal(next.hotkey, "F9");
  assert.equal(st.data.agentUrl, DEFAULTS.agentUrl);
});

test("browse mode defaults to open and only takes known values", () => {
  assert.equal(DEFAULTS.browseMode, "open");
  assert.equal(normalize({}).browseMode, "open");
  assert.equal(normalize({ browseMode: "allowlist" }).browseMode, "allowlist");
  assert.equal(normalize({ browseMode: "anything" }).browseMode, "open");
});

test("the blocklist keeps valid entries and comments, and may be empty", () => {
  assert.deepEqual(
    normalize({ blocklist: ["# mine", "https://shop.example/x", "bad", "https://u:p@x.example", "SHOP.example/x", "*bank*"] }).blocklist,
    ["# mine", "shop.example/x", "*bank*"]
  );
  assert.deepEqual(normalize({ blocklist: [] }).blocklist, [], "an emptied list stays empty");
  assert.deepEqual(normalize({}).blocklist, [...SUGGESTED_BLOCKLIST], "no stored list: the suggested one");
});

test("first install seeds the suggested list once; a stored list is left alone", async () => {
  const st = memoryStorage();
  assert.equal(await seedBlocklist(st), true);
  assert.deepEqual(st.data.blocklist, [...SUGGESTED_BLOCKLIST]);
  st.data.blocklist = ["etsy.com"];
  assert.equal(await seedBlocklist(st), false);
  assert.deepEqual(st.data.blocklist, ["etsy.com"]);
  const empty = memoryStorage({ blocklist: [] });
  assert.equal(await seedBlocklist(empty), false);
  assert.deepEqual(empty.data.blocklist, []);
});

test("parseOriginLines takes one site per line and reports bad lines", () => {
  const r = parseOriginLines("https://www.etsy.com/c/home\nwww.aritzia.com\n\n  http://localhost:4000 \njavascript:alert(1)\nhttps://me:pw@shop.example\nhttps://www.etsy.com");
  assert.deepEqual(r.origins, ["https://www.etsy.com", "https://www.aritzia.com", "http://localhost:4000"]);
  assert.deepEqual(r.bad, ["javascript:alert(1)", "https://me:pw@shop.example"]);
});

test("sounds defaults on and keeps a stored false", () => {
  assert.equal(DEFAULTS.sounds, true);
  assert.equal(normalize({}).sounds, true);
  assert.equal(normalize({ sounds: false }).sounds, false);
  assert.equal(normalize({ sounds: "off" }).sounds, true);
});

test("guidedMode defaults on, keeps booleans only, and round-trips through storage", async () => {
  assert.equal(DEFAULTS.guidedMode, true);
  assert.equal(normalize({}).guidedMode, true);
  assert.equal(normalize({ guidedMode: "false" }).guidedMode, true, "non-boolean falls back");
  assert.equal(normalize({ guidedMode: false }).guidedMode, false);
  const store = memoryStorage();
  assert.equal((await loadSettings(store)).guidedMode, true);
  assert.equal((await saveSettings({ guidedMode: false }, store)).guidedMode, false);
  assert.equal(store.data.guidedMode, false);
  assert.equal((await loadSettings(store)).guidedMode, false);
  assert.equal((await saveSettings({ guidedMode: true }, store)).guidedMode, true);
});

test("speakReplies defaults on and keeps a stored false only", () => {
  assert.equal(DEFAULTS.speakReplies, true);
  assert.equal(normalize({}).speakReplies, true);
  assert.equal(normalize({ speakReplies: false }).speakReplies, false);
  assert.equal(normalize({ speakReplies: "false" }).speakReplies, true, "non-boolean falls back");
});

test("both off: the popup and options warn that replies won't be shown or spoken", () => {
  assert.equal(replyWarning({ speakReplies: true, subtitles: false }), null);
  assert.equal(replyWarning({ speakReplies: false, subtitles: true }), null);
  assert.match(replyWarning({ speakReplies: false, subtitles: false }), /won't be shown or spoken.*Turn on Speak replies or subtitles/);
  // Voice off on the server counts as not speaking.
  assert.match(replyWarning({ speakReplies: true, subtitles: false }, false), /won't be shown or spoken/);
  assert.equal(speakRepliesNote(normalize({})), "");
  assert.equal(speakRepliesNote(normalize({}), false), "Voice is off on the server.");
  assert.match(speakRepliesNote({ speakReplies: false, subtitles: false }, true), /^Clearcart's replies won't/);
  assert.match(SPEAK_REPLIES_COPY, /^Speak replies\. Turn off to read Clearcart's answers in the subtitles without hearing them\.$/);
});

test("Speak replies: one popup switch with the full copy, one options row in the Voice group", async () => {
  const fs = await import("node:fs");
  const read = (f) => fs.readFileSync(new URL(`../../../extension/${f}`, import.meta.url), "utf8");
  const popup = read("popup/popup.html");
  assert.ok(popup.includes(SPEAK_REPLIES_COPY));
  assert.equal(popup.match(/id="speak-replies"/g).length, 1);
  const options = read("options/options.html");
  const voice = options.slice(options.indexOf('id="voice"'), options.indexOf('id="sites"'));
  assert.equal(voice.match(/data-setting="speakReplies"/g).length, 1);
  assert.ok(voice.includes(">Speak replies<") && voice.includes(SPEAK_REPLIES_COPY.replace(/^Speak replies\. /, "")));
  assert.doesNotMatch(SPEAK_REPLIES_COPY + replyWarning({ speakReplies: false, subtitles: false }), /\u2014/);
});
