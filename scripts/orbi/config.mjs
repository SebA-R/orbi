// Reads and writes the Orbi config file (a small dotenv file). Written
// with mode 0600 in a 0700 folder, through a temp file and a rename, so it
// is never readable by other users, not even for a moment. Nothing here
// prints a value.
import fs from "node:fs";
import path from "node:path";

// The keys the installer owns, in the order they are written.
export const KEYS = ["ANTHROPIC_API_KEY", "CARTESIA_API_KEY", "CLEARCART_PROVIDER", "CLEARCART_LOCAL_URL", "CLEARCART_LOCAL_MODEL", "CLEARCART_BROWSER", "CLEARCART_VOICE"];

// A value that can sit on one dotenv line unquoted: no spaces, quotes,
// #, backslashes or line breaks. API keys and local URLs all fit.
export const SAFE_VALUE = /^[A-Za-z0-9._:/@+=%,~-]{1,512}$/;

export function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function serialize(values) {
  const lines = ["# Orbi settings, written by `npm run setup`. Keep this file private.", ""];
  const names = [...KEYS, ...Object.keys(values).filter((k) => !KEYS.includes(k)).sort()];
  for (const k of names) {
    const v = values[k];
    if (v === undefined || v === null || v === "") continue;
    if (!/^[A-Z0-9_]+$/.test(k)) throw new Error(`bad setting name ${k}`);
    if (!SAFE_VALUE.test(String(v))) throw new Error(`The value for ${k} has characters Orbi can't save`);
    lines.push(`${k}=${v}`);
  }
  return lines.join("\n") + "\n";
}

export function writeConfig(file, values) {
  const dir = path.dirname(file);
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Tighten only a folder that is Orbi's own (new, or named orbi/Orbi),
  // never a home folder or repo that ORBI_CONFIG happens to point into.
  if (!existed || /^orbi$/i.test(path.basename(dir))) try { fs.chmodSync(dir, 0o700); } catch {}
  const tmp = path.join(dir, `.config.env.${process.pid}.tmp`);
  try { fs.unlinkSync(tmp); } catch {}
  const fd = fs.openSync(tmp, "wx", 0o600); // a fresh file, so the mode applies
  try {
    fs.writeSync(fd, serialize(values));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

// "set" or "not set": the only thing ever shown about a key.
export const describeKey = (v) => (v && String(v).trim() ? "set" : "not set");
