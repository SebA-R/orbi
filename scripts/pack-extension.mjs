#!/usr/bin/env node
// npm run pack:extension: zips extension/ for a GitHub Release, without
// tests, node_modules or local clutter. Writes dist/orbi-extension-v<version>.zip
// (the manifest's version, or the tag given as the first argument) and
// prints its path. Uses the system zip (macOS, Linux, GitHub's runners).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const tag = (process.argv[2] || `v${manifest.version}`).replace(/[^A-Za-z0-9._-]/g, "");
const dist = path.join(ROOT, "dist");
const out = path.join(dist, `orbi-extension-${tag}.zip`);

export const EXCLUDE = ["test/*", "*/node_modules/*", "node_modules/*", "*.test.*", "*/.DS_Store", ".DS_Store", "*.map", "CONTRACT.md"];

fs.mkdirSync(dist, { recursive: true });
fs.rmSync(out, { force: true });
const r = spawnSync("zip", ["-r", "-X", "-q", out, ".", "-x", ...EXCLUDE], { cwd: EXT, stdio: "inherit" });
if (r.error || r.status !== 0) {
  process.stderr.write("pack:extension needs the zip command.\n");
  process.exit(1);
}
process.stdout.write(`${path.relative(ROOT, out)}\n`);
