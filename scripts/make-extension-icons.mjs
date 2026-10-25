// Draws the Clearcart toolbar icons (an orb with a soft spectrum, like the
// voice console's talk button) and writes them as PNGs. No dependencies.
//
//   node scripts/make-extension-icons.mjs   -> extension/icons/icon{16,32,48,128}.png

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
const SIZES = [16, 32, 48, 128];
const SPECTRUM = [
  [0x2e, 0x8b, 0xff],
  [0xb6, 0x5c, 0xff],
  [0xff, 0x4d, 0x7a],
  [0xff, 0xa1, 0x4a],
];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function spectrumAt(angle) {
  const t = ((angle / (2 * Math.PI)) % 1 + 1) % 1 * SPECTRUM.length;
  const i = Math.floor(t);
  const f = t - i;
  const a = SPECTRUM[i % SPECTRUM.length];
  const b = SPECTRUM[(i + 1) % SPECTRUM.length];
  return a.map((v, k) => v + (b[k] - v) * f);
}

// Color of one sample point in unit coordinates (-1..1), or null if outside.
function sample(x, y) {
  const r = Math.hypot(x, y);
  if (r > 0.94) return null;
  const ring = spectrumAt(Math.atan2(y, x));
  if (r > 0.62) return ring; // spectrum ring
  // Pale core with a soft highlight toward the top left.
  const light = 1 - 0.18 * Math.hypot(x + 0.3, y + 0.35);
  const core = [250, 250, 252].map((v) => v * Math.max(0.82, light));
  if (r > 0.55) {
    const f = (r - 0.55) / 0.07;
    return core.map((v, k) => v + (ring[k] - v) * f);
  }
  return core;
}

function draw(size) {
  const ss = 4; // supersampling per axis
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rr = 0, gg = 0, bb = 0, hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) / ss) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / ss) / size) * 2 - 1;
          const c = sample(x, y);
          if (!c) continue;
          rr += c[0]; gg += c[1]; bb += c[2]; hits++;
        }
      }
      const o = (py * size + px) * 4;
      if (!hits) continue;
      out[o] = Math.round(rr / hits);
      out[o + 1] = Math.round(gg / hits);
      out[o + 2] = Math.round(bb / hits);
      out[o + 3] = Math.round((255 * hits) / (ss * ss));
    }
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, png(size, draw(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
