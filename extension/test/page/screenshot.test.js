// cdp.js screenshot() against real headless Chromium at device scale 2:
// the image is the visible viewport in CSS pixels, so a point read off it
// is the point to click, scrolled or not.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { _resetForTests, jpegSize, screenshot } from "../../background/cdp.js";

const browser = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2"] });
after(() => browser.close());

// The colour of image pixel (x, y), decoded by the browser.
async function pixel(page, data, x, y) {
  return page.evaluate(
    async ({ data, x, y }) => {
      const img = new Image();
      img.src = "data:image/jpeg;base64," + data;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const [r, gr, b] = g.getImageData(x, y, 1, 1).data;
      return r > 200 && gr < 60 && b < 60 ? "red" : b > 200 && r < 60 && gr < 60 ? "blue" : "other";
    },
    { data, x, y }
  );
}

test("a 2x screen gives a CSS-pixel image of the visible, scrolled viewport", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.setContent(`<body style="margin:0;height:5000px;background:#fff">
    <div style="position:absolute;left:1000px;top:1500px;width:60px;height:40px;background:#f00"></div>
    <div style="position:fixed;left:20px;top:20px;width:50px;height:50px;background:#00f"></div></body>`);
  await page.evaluate(() => scrollTo(0, 1000));
  const cdp = await ctx.newCDPSession(page);
  const saved = globalThis.chrome;
  globalThis.chrome = { debugger: { attach: async () => {}, sendCommand: (_t, m, p) => cdp.send(m, p) } };
  _resetForTests();
  try {
    const r = await screenshot({ tabId: 1 });
    assert.deepEqual([r.width, r.height, r.scale], [1440, 900, 1]);
    assert.deepEqual(jpegSize(r.data), { width: 1440, height: 900 });
    // The red box is at page y 1500, viewport y 500 after the scroll.
    assert.equal(await pixel(page, r.data, 1030, 520), "red");
    assert.equal(await pixel(page, r.data, 1030, 470), "other");
    assert.equal(await pixel(page, r.data, 45, 45), "blue", "fixed elements where they show");
    // The same point is what the page has there.
    assert.equal(await page.evaluate(() => getComputedStyle(document.elementFromPoint(1030, 520)).backgroundColor), "rgb(255, 0, 0)");
  } finally {
    globalThis.chrome = saved;
    _resetForTests();
    await ctx.close();
  }
});
