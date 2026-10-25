import { test } from "node:test";
import assert from "node:assert/strict";

import { editNote, exportText, googleFileOf } from "../../../extension/background/gdocs.js";

const ID = "1jfHEhSnJs75Jd188KNDu0UE-SKfh7QSgtpYzw1LElUc";

test("googleFileOf finds Docs, Sheets and Slides files and their export links", () => {
  assert.deepEqual(googleFileOf(`https://docs.google.com/document/d/${ID}/edit?tab=t.0`), {
    app: "document", id: ID, exportUrl: `https://docs.google.com/document/d/${ID}/export?format=txt`,
  });
  assert.equal(googleFileOf(`https://docs.google.com/document/u/1/d/${ID}/edit`).exportUrl, `https://docs.google.com/document/u/1/d/${ID}/export?format=txt`);
  assert.equal(googleFileOf(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42`).exportUrl, `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=42`);
  assert.equal(googleFileOf(`https://docs.google.com/spreadsheets/d/${ID}/edit`).exportUrl, `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv`);
  assert.equal(googleFileOf(`https://docs.google.com/presentation/d/${ID}/edit`).exportUrl, `https://docs.google.com/presentation/d/${ID}/export?format=txt`);
  // Not a file: published pages (/d/e/...), other hosts, plain http, home.
  assert.equal(googleFileOf("https://docs.google.com/document/d/e/2PACX-1vQ/pub"), null);
  assert.equal(googleFileOf(`https://docs.google.com.evil.test/document/d/${ID}/edit`), null);
  assert.equal(googleFileOf(`http://docs.google.com/document/d/${ID}/edit`), null);
  assert.equal(googleFileOf("https://docs.google.com/document/u/0/"), null);
  assert.equal(googleFileOf("not a url"), null);
});

function res({ status = 200, url = "https://doc-0s-docstext.googleusercontent.com/export/x", type = "text/plain; charset=utf-8", body = "" } = {}) {
  return { ok: status >= 200 && status < 300, status, url, headers: { get: (h) => (h === "content-type" ? type : null) }, text: async () => body };
}

test("exportText answers the file's text with the session, card numbers masked", async () => {
  let asked;
  const fetchImpl = async (url, opts) => ((asked = { url, opts }), res({ body: "﻿Title\r\n\r\n\r\n\r\nPaid with 4111 1111 1111 1111, order 12345" }));
  const text = await exportText(googleFileOf(`https://docs.google.com/document/d/${ID}/edit`), { fetchImpl });
  assert.equal(text, "Title\n\nPaid with [masked card number], order 12345");
  assert.equal(asked.url, `https://docs.google.com/document/d/${ID}/export?format=txt`);
  assert.equal(asked.opts.credentials, "include");
});

test("exportText gives up on a sign-in page, an error, another host or a throw", async () => {
  const file = googleFileOf(`https://docs.google.com/document/d/${ID}/edit`);
  const answers = [
    res({ type: "text/html; charset=utf-8", body: "<html>Sign in</html>" }),
    res({ status: 403, body: "no" }),
    res({ url: "https://evil.test/export", body: "text" }),
  ];
  for (const a of answers) assert.equal(await exportText(file, { fetchImpl: async () => a }), null);
  assert.equal(await exportText(file, { fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(await exportText(null, { fetchImpl: async () => res({ body: "x" }) }), null);
});

test("editNote tells the agent to click into the canvas before typing", () => {
  assert.match(editNote("document"), /click in the document/);
  assert.match(editNote("spreadsheets"), /Google Sheets/);
  assert.equal(editNote("other"), "");
});

test("exportText reads a big answer in chunks and stops at the cap", async () => {
  const file = googleFileOf(`https://docs.google.com/document/d/${ID}/edit`);
  let cancelled = false;
  let reads = 0;
  const chunk = new TextEncoder().encode("a".repeat(400_000));
  const body = { getReader: () => ({ read: async () => (reads++ < 10 ? { done: false, value: chunk } : { done: true }), cancel: async () => { cancelled = true; } }) };
  const r = { ...res(), body, text: async () => { throw new Error("read whole"); } };
  const text = await exportText(file, { fetchImpl: async () => r });
  assert.equal(text.length, 1_000_000);
  assert.equal(cancelled, true);
  assert.ok(reads <= 4);
});
