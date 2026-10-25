// focused_field (jsdom): what the typing guard sees for canvas editors,
// whose keyboard input goes to a hidden same-origin frame (Google Docs'
// .docs-texteventtarget-iframe), and for a page with nothing focused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPage } from "./harness.js";

const focused = async (p) => (await p.call("focused_field")).result;

test("nothing focused is nothing; the Docs-style text frame is a text field", async () => {
  const p = loadPage(`<canvas></canvas><iframe class="docs-texteventtarget-iframe"></iframe>`);
  assert.equal((await focused(p)).nothing, true);
  const frame = p.document.querySelector("iframe");
  frame.contentDocument.body.innerHTML = '<div contenteditable="true" role="textbox" aria-label="Document content"></div>';
  const box = frame.contentDocument.querySelector("div");
  // jsdom has no isContentEditable.
  Object.defineProperty(box, "isContentEditable", { get: () => true });
  box.focus();
  const f = await focused(p);
  assert.equal(f.text, true);
  assert.equal(f.payment, false);
  assert.equal(f.nothing, undefined);
});

test("a frame whose page is focused is nothing, unless it is in designMode", async () => {
  const p = loadPage(`<iframe></iframe>`);
  const frame = p.document.querySelector("iframe");
  frame.focus();
  assert.equal((await focused(p)).nothing, true);
  frame.contentDocument.designMode = "on";
  const f = await focused(p);
  assert.equal(f.text, true);
  assert.equal(f.nothing, undefined);
});
