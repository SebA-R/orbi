// Google Docs, Sheets and Slides draw their content on a canvas, so the
// page script only sees the menus and toolbar. get_page_text reads the
// file's own text instead, from the export link the editor itself offers
// (File > Download), fetched by the worker with the user's Google session:
// the same file the tab shows, and nothing the user could not download.
// The text is the last saved version, a second or two behind typing.
//
// Only docs.google.com addresses of a file (…/d/<id>/…) count, and the
// answer must come from docs.google.com or Google's download host
// (*.googleusercontent.com) as plain text or CSV. Anything else (a sign-in
// page, an owner who turned off downloads, a timeout) answers null, and the
// caller keeps the page's own text. Card numbers are masked like every page
// read (content/mask.js).

import { luhnValid } from "../lib/log.js";

const FILE_PATH = /^\/(document|spreadsheets|presentation)((?:\/u\/\d+)?)\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/;

export const APPS = Object.freeze({
  document: { name: "Google Docs", what: "document" },
  spreadsheets: { name: "Google Sheets", what: "spreadsheet" },
  presentation: { name: "Google Slides", what: "presentation" },
});

export const EXPORT_TIMEOUT_MS = 8_000;
const MAX_BYTES = 2_000_000;

// { app, id, exportUrl } for a Google Docs, Sheets or Slides file address,
// else null. A sheet exports the tab shown (gid in the hash or query).
export function googleFileOf(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return null;
  const m = FILE_PATH.exec(u.pathname);
  if (!m) return null;
  const [, app, account, id] = m;
  const base = `https://docs.google.com/${app}${account}/d/${id}`;
  if (app !== "spreadsheets") return { app, id, exportUrl: `${base}/export?format=txt` };
  const gid = /[#&?]gid=(\d+)/.exec(u.hash) || /[#&?]gid=(\d+)/.exec(u.search);
  return { app, id, exportUrl: `${base}/export?format=csv${gid ? `&gid=${gid[1]}` : ""}` };
}

function fromGoogle(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "docs.google.com" || u.hostname.endsWith(".googleusercontent.com"));
  } catch {
    return false;
  }
}

const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g;
export function maskCardRuns(text) {
  return String(text).replace(DIGIT_RUN, (run) => {
    const d = run.replace(/[ -]/g, "");
    return d.length >= 13 && luhnValid(d) ? "[masked card number]" : run;
  });
}

// The file's text, or null. fetchImpl is fetch (tests pass a fake).
export async function exportText(file, { fetchImpl = globalThis.fetch, timeoutMs = EXPORT_TIMEOUT_MS } = {}) {
  if (!file || typeof fetchImpl !== "function") return null;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(file.exportUrl, { credentials: "include", redirect: "follow", cache: "no-store", signal: ctl?.signal });
    if (!res || !res.ok || !fromGoogle(res.url || file.exportUrl)) return null;
    const type = String(res.headers?.get?.("content-type") || "").toLowerCase();
    if (!/^text\/(plain|csv)\b/.test(type)) return null;
    const len = Number(res.headers?.get?.("content-length"));
    if (len > MAX_BYTES) return null;
    const text = await res.text();
    return maskCardRuns(text.slice(0, MAX_BYTES).replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// What the agent should know about editing one of these files.
export function editNote(app) {
  const a = APPS[app];
  if (!a) return "";
  return `${a.name} draws the ${a.what} on a canvas, so its text is not in the page tree. get_page_text returns the ${a.what}'s saved text. To edit: take a screenshot, click in the ${a.what} where the cursor should go, then type; key works for Enter, Backspace, arrows and shortcuts. If the page says view only, it can't be edited.`;
}
