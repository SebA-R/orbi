// Draws the Orbi toolbar icons: the orb face (F1 idle, content/orb-face.js)
// wearing the R1 "Spectrum hairline" ring, as one SVG per size, then renders
// each to a transparent PNG with headless Chrome. No npm dependencies.
//
//   node scripts/make-extension-icons.mjs
//     -> extension/icons/icon.svg (the master, at 128) and icon{16,32,48,128}.png
//
// CHROME=/path/to/chrome overrides the browser. The ring sits at .62em around
// the .5em orb as on the board, but is drawn thicker (about S/16 + 1 px) so it
// reads in the toolbar, and below 48 px the face's eyes and smile are bolder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
const SIZES = [16, 32, 48, 128];
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const INK = "#22264f";
const n = (v) => Number(v.toFixed(3));

// Face features in the orb's own 100 x 100 box (as in orb-face.js).
// Full is F1 exactly; the small sizes enlarge the dots and thicken the smile.
const FACES = {
  full: { eyeR: 5.5, eyeY: 43.5, eyeX: 14.5, smileW: 8.25, smileD: 6.25, smileY: 60, stroke: 3.5 },
  32: { eyeR: 7.5, eyeY: 42, eyeX: 15.5, smileW: 10, smileD: 7, smileY: 60, stroke: 6 },
  16: { eyeR: 10, eyeY: 41, eyeX: 17, smileW: 13, smileD: 9, smileY: 61, stroke: 11 },
};

function svg(S) {
  const c = S / 2;
  const w = S / 16 + 1; // ring stroke: 2 px at 16, 3 at 32, 4 at 48, 9 at 128
  const margin = S <= 16 ? 0 : Math.round(S * 0.02);
  const ringR = c - w / 2 - margin;
  const gap = Math.max(1, S * 0.03);
  const orbR = Math.min(ringR / 1.24, ringR - w / 2 - gap); // ring at .62em, orb .5em
  const f = FACES[S] || FACES.full;
  const k = (2 * orbR) / 100; // face box units to px
  const ox = c - orbR, oy = c - orbR;
  const X = (u) => n(ox + u * k), Y = (u) => n(oy + u * k);
  const sx1 = 50 - f.smileW, sx2 = 50 + f.smileW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <radialGradient id="body" cx=".35" cy=".3" r=".955" fx=".35" fy=".3">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset=".4" stop-color="#c9b8ff"/>
      <stop offset=".75" stop-color="#5e8bff"/>
    </radialGradient>
    <linearGradient id="spec" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff9f6b"/>
      <stop offset=".25" stop-color="#ff5f8f"/>
      <stop offset=".5" stop-color="#b56cff"/>
      <stop offset=".75" stop-color="#5e8bff"/>
      <stop offset="1" stop-color="#4fd1ff"/>
    </linearGradient>
  </defs>
  <circle cx="${c}" cy="${c}" r="${n(ringR)}" fill="none" stroke="url(#spec)" stroke-width="${n(w)}" stroke-linecap="round"/>
  <circle cx="${c}" cy="${c}" r="${n(orbR)}" fill="url(#body)"/>
  <circle cx="${X(50 - f.eyeX)}" cy="${Y(f.eyeY)}" r="${n(f.eyeR * k)}" fill="${INK}"/>
  <circle cx="${X(50 + f.eyeX)}" cy="${Y(f.eyeY)}" r="${n(f.eyeR * k)}" fill="${INK}"/>
  <path d="M${X(sx1)} ${Y(f.smileY)}A${n(f.smileW * k)} ${n(f.smileD * k)} 0 0 0 ${X(sx2)} ${Y(f.smileY)}" fill="none" stroke="${INK}" stroke-width="${n(f.stroke * k)}" stroke-linecap="round"/>
</svg>
`;
}

function render(svgFile, pngFile, S) {
  const html = svgFile.replace(/\.svg$/, ".html");
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent"><img src="${path.basename(svgFile)}" width="${S}" height="${S}" style="display:block"></body></html>`);
  execFileSync(CHROME, [
    "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    `--user-data-dir=${path.join(path.dirname(svgFile), "profile")}`,
    "--default-background-color=00000000", "--force-device-scale-factor=1",
    `--window-size=${S},${S}`, `--screenshot=${pngFile}`, `file://${html}`,
  ], { stdio: "ignore" });
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "icon.svg"), svg(128));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbi-icons-"));
for (const S of SIZES) {
  const file = path.join(tmp, `icon${S}.svg`);
  fs.writeFileSync(file, svg(S));
  const out = path.join(OUT, `icon${S}.png`);
  render(file, out, S);
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
