#!/usr/bin/env node
// Orbi's installer and server control. Plain Node, no dependencies, so it
// runs before anything is installed:
//
//   npm run setup              (from a clone)   or   npx github:SebA-R/orbi setup
//   ./orbi setup --autostart   also start the server when you log in (macOS)
//   ./orbi start | stop | status | uninstall
//
// Keys are read with typing hidden, saved only to the config file (mode
// 0600, outside the repo) and never printed or logged. Run from npx, the
// package holds only this script: it clones the full repo to ~/Orbi (or
// $ORBI_HOME) and runs that copy's setup, so the extension folder and the
// server live somewhere that stays put.
//
// Test hooks: ORBI_NO_LAUNCHCTL=1 never calls launchctl; ORBI_REPO_URL and
// ORBI_HOME change where the npx path clones from and to.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";

import { KEYS, SAFE_VALUE, describeKey, readConfig, writeConfig } from "./orbi/config.mjs";
import { buildPlist, serverCommand } from "./orbi/launchd.mjs";
import { LABEL, REPO_URL, ROOT, configPath, logDir, pidPath, plistPath, port } from "./orbi/paths.mjs";

const MIN_NODE = 20;
const DEFAULT_LOCAL_URL = "http://localhost:11434/v1";
const DEFAULT_LOCAL_MODEL = "llama3.1:8b";
const IS_MAC = process.platform === "darwin";
const LAUNCHCTL = IS_MAC && process.env.ORBI_NO_LAUNCHCTL !== "1";

const say = (s = "") => process.stdout.write(s + "\n");
const fail = (s) => {
  process.stderr.write(`Orbi: ${s}\n`);
  process.exit(1);
};
const tilde = (p) => {
  const h = process.env.HOME || os.homedir();
  return h && p.startsWith(h + path.sep) ? "~" + p.slice(h.length) : p;
};

// ---- prompts ---------------------------------------------------------------

// One readline over stdin for the whole run, so piped answers (tests) are
// never lost between questions. Hidden prompts mute the echo.
let rl = null;
let lines = null;
let muted = false;
const out = new Writable({
  write(chunk, _enc, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});

function reader() {
  if (!rl) {
    // historySize 0: a hidden key must never come back with the up arrow.
    rl = readline.createInterface({ input: process.stdin, output: out, terminal: !!process.stdin.isTTY, historySize: 0 });
    // Ctrl+C stops setup before anything is saved or started.
    rl.on("SIGINT", () => {
      muted = false;
      process.stdout.write("\nSetup stopped. Nothing more was saved.\n");
      process.exit(130);
    });
    lines = rl[Symbol.asyncIterator]();
  }
  return lines;
}

async function ask(question, { hidden = false } = {}) {
  const it = reader();
  process.stdout.write(question);
  muted = hidden;
  let r;
  try {
    r = await it.next();
  } finally {
    muted = false;
  }
  if (hidden || !process.stdin.isTTY) process.stdout.write("\n");
  // Input closed (Ctrl+D) at a terminal: stop rather than take every default.
  if (r.done && process.stdin.isTTY) {
    process.stdout.write("Setup stopped. Nothing more was saved.\n");
    process.exit(130);
  }
  return r.done ? "" : String(r.value).trim();
}

async function yesNo(question, def) {
  const a = (await ask(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}

function closePrompts() {
  if (rl) rl.close();
  rl = null;
}

// ---- helpers ---------------------------------------------------------------

function nodeOk() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE) fail(`Orbi needs Node ${MIN_NODE} or newer. You have ${process.versions.node}. Get it from https://nodejs.org and run setup again.`);
}

const npmCmd = () => (process.platform === "win32" ? "npm.cmd" : "npm");

function installAgent() {
  say("Installing the agent server's packages (this can take a minute)...");
  const agent = path.join(ROOT, "agent");
  const opts = { cwd: agent, stdio: "inherit", shell: process.platform === "win32" };
  let r = spawnSync(npmCmd(), ["ci", "--no-audit", "--no-fund"], opts);
  if (r.status !== 0) r = spawnSync(npmCmd(), ["install", "--no-audit", "--no-fund"], opts);
  if (r.status !== 0) fail("npm could not install the agent server's packages. Check the messages above and run setup again.");
}

function health(p = port(), timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: p, path: "/healthz", headers: { Host: `localhost:${p}` }, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loopbackUrl(v) {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && SAFE_VALUE.test(v);
  } catch {
    return false;
  }
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(pidPath(), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Our server, not some other process that got the same id later.
function isOurServer(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  const [, tsx] = serverCommand({ root: ROOT });
  return r.status === 0 && r.stdout.includes(tsx) && r.stdout.includes("server.ts");
}

function launchctl(args) {
  if (!LAUNCHCTL) return { status: 1, stdout: "", stderr: "" };
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

const domain = () => `gui/${process.getuid()}`;
const agentLoaded = () => launchctl(["print", `${domain()}/${LABEL}`]).status === 0;

// ---- the npx path ------------------------------------------------------------

// From npx the package is only this script (package.json "files"): clone
// the full repo to a folder that stays put, then hand over to its copy.
function bootstrap(argv) {
  const target = path.resolve(process.env.ORBI_HOME || path.join(process.env.HOME || os.homedir(), "Orbi"));
  const isOrbi = fs.existsSync(path.join(target, "agent", "package.json")) && fs.existsSync(path.join(target, "extension", "manifest.json"));
  if (isOrbi) {
    say(`Using your Orbi folder at ${tilde(target)}.`);
    if (fs.existsSync(path.join(target, ".git"))) spawnSync("git", ["-C", target, "pull", "--ff-only", "--quiet"], { stdio: "ignore" });
  } else {
    if (argv[0] && argv[0] !== "setup") fail("Orbi is not set up yet. Run: npx github:SebA-R/orbi setup");
    if (fs.existsSync(target) && fs.readdirSync(target).length) fail(`${target} already exists and is not an Orbi folder. Set ORBI_HOME to another folder and try again.`);
    if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) fail("Setup needs git to download Orbi. Install git (on macOS: xcode-select --install) and try again.");
    say(`Downloading Orbi to ${tilde(target)}...`);
    const r = spawnSync("git", ["clone", "--depth", "1", "--quiet", process.env.ORBI_REPO_URL || REPO_URL, target], { stdio: "inherit" });
    if (r.status !== 0) fail("git could not download Orbi. Check your connection and try again.");
  }
  const script = path.join(target, "scripts", "orbi.mjs");
  if (!fs.existsSync(script)) fail(`Your Orbi folder at ${target} is from before the setup command and could not be updated. Run git pull in it, or set ORBI_HOME to a new folder.`);
  const r = spawnSync(process.execPath, [script, ...argv], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// ---- commands ----------------------------------------------------------------

async function setup(flags) {
  say("Orbi setup");
  say("");
  nodeOk();
  if (!flags.has("--skip-install")) installAgent();

  const file = configPath();
  const saved = readConfig(file);
  const next = { ...saved };

  say("");
  say("How should Orbi think?");
  say("  1) Claude, with your Anthropic API key (recommended)");
  say("  2) A model on this computer with Ollama or LM Studio (no Claude key needed)");
  say("Claude Code and Claude.ai logins can't be used here: Anthropic only allows API keys for apps like Orbi.");
  const was = saved.CLEARCART_PROVIDER === "local" ? "2" : "1";
  const choice = (await ask(`Choose 1 or 2 [${was}]: `)) || was;
  const local = choice === "2";

  if (!local) {
    next.CLEARCART_PROVIDER = "claude";
    const key = await askKey({
      label: "Anthropic API key (get one at https://console.anthropic.com/settings/keys)",
      saved: saved.ANTHROPIC_API_KEY,
      expect: "sk-ant-",
      required: true,
    });
    if (key !== undefined) next.ANTHROPIC_API_KEY = key;
    if (!next.ANTHROPIC_API_KEY) say("No Anthropic key saved. Orbi can't answer until you add one: run setup again.");
  } else {
    next.CLEARCART_PROVIDER = "local";
    let url = (await ask(`Local model address [${saved.CLEARCART_LOCAL_URL || DEFAULT_LOCAL_URL}]: `)) || saved.CLEARCART_LOCAL_URL || DEFAULT_LOCAL_URL;
    while (!loopbackUrl(url)) url = (await ask("The address must be on this computer, like http://localhost:11434/v1. Address: ")) || DEFAULT_LOCAL_URL;
    next.CLEARCART_LOCAL_URL = url;
    let model = (await ask(`Model name [${saved.CLEARCART_LOCAL_MODEL || DEFAULT_LOCAL_MODEL}]: `)) || saved.CLEARCART_LOCAL_MODEL || DEFAULT_LOCAL_MODEL;
    while (!/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/.test(model)) model = (await ask("That name has characters a model name can't have. Model name: ")) || DEFAULT_LOCAL_MODEL;
    next.CLEARCART_LOCAL_MODEL = model;
  }

  say("");
  say("Voice: with a Cartesia key Orbi uses Cartesia's natural voice and speech recognition.");
  say("Without one it uses Chrome's built-in voice (basic voice), and you can type instead of talking.");
  const cartesia = await askKey({
    label: "Cartesia API key (get one at https://play.cartesia.ai/keys), or press Enter to skip",
    saved: saved.CARTESIA_API_KEY,
    expect: "",
    required: false,
  });
  if (cartesia !== undefined) next.CARTESIA_API_KEY = cartesia;

  next.CLEARCART_BROWSER = "ext";
  next.CLEARCART_VOICE = saved.CLEARCART_VOICE || "true";
  writeConfig(file, next);
  say("");
  say(`Saved your settings to ${tilde(file)} (only your user account can read it).`);

  if (flags.has("--autostart")) autostart();

  say("");
  say("Load the extension in Chrome:");
  say("  1. Open chrome://extensions");
  say("  2. Turn on Developer mode (top right)");
  say("  3. Press Load unpacked and choose this folder:");
  say(`       ${path.join(ROOT, "extension")}`);
  say("  4. Finish the Orbi setup page that opens, and allow the microphone.");
  if (local) say("  5. In Orbi's settings, set Model provider to Local and pick your model.");
  say("");

  if (!(flags.has("--autostart") && IS_MAC)) {
    const up = await health();
    if (up) say(`Orbi is already running on port ${port()}.`);
    else if (await yesNo("Start Orbi now?", true)) await start();
    else say("Start it later with: npm start (or ./orbi start to run it in the background)");
  }
  say("");
  say("Then hold Space on any web page and talk to Orbi.");
}

// Returns the new value, "" to remove the saved one, or undefined to keep it.
async function askKey({ label, saved, expect, required }) {
  const keep = saved ? " Press Enter to keep the saved key" + (required ? "" : ", or type none to remove it") + "." : "";
  for (let tries = 0; tries < 3; tries++) {
    const v = await ask(`${label}.${keep} Typing is hidden: `, { hidden: true });
    if (!v) {
      if (saved) return undefined;
      if (!required) return "";
      if (tries < 2) {
        say("A key is needed for Claude. Paste it and press Enter, or choose option 2 for a local model next time.");
        continue;
      }
      return "";
    }
    if (!required && saved && v.toLowerCase() === "none") return "";
    if (!SAFE_VALUE.test(v)) {
      say("That doesn't look like an API key (it has spaces or symbols keys don't have). Try again.");
      continue;
    }
    if (expect && !v.startsWith(expect)) say(`Note: Anthropic keys usually start with ${expect}. Saving it anyway.`);
    return v;
  }
  return saved ? undefined : "";
}

function autostart() {
  say("");
  if (!IS_MAC) {
    say("Start on login is only set up automatically on macOS. To run Orbi on this computer:");
    say(`  cd "${ROOT}" && npm start`);
    say("Add that command to your system's startup programs to start Orbi when you log in.");
    return;
  }
  const logs = logDir();
  fs.mkdirSync(logs, { recursive: true });
  const plist = plistPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, buildPlist({ root: ROOT, logs, config: configPath(), port: process.env.AGENT_PORT ? port() : undefined }), { mode: 0o644 });
  say(`Orbi will start when you log in (${tilde(plist)}). Logs go to ${tilde(logs)}.`);
  say("If you change or upgrade Node, run setup --autostart again so it points at the new one.");
  if (!LAUNCHCTL) return;
  launchctl(["bootout", `${domain()}/${LABEL}`]);
  const r = launchctl(["bootstrap", domain(), plist]);
  say(r.status === 0 ? "Started Orbi in the background." : "Could not start it now; it will start the next time you log in. Or run ./orbi start.");
}

async function start() {
  if (await health()) return say(`Orbi is already running on port ${port()}.`);
  if (IS_MAC && fs.existsSync(plistPath()) && LAUNCHCTL) {
    if (!agentLoaded()) launchctl(["bootstrap", domain(), plistPath()]);
    else launchctl(["kickstart", `${domain()}/${LABEL}`]);
  } else {
    const [node, ...args] = serverCommand({ root: ROOT });
    if (!fs.existsSync(args[0])) fail("The agent server's packages are missing. Run setup first.");
    const logs = logDir();
    fs.mkdirSync(logs, { recursive: true });
    const outFd = fs.openSync(path.join(logs, "agent.log"), "a");
    const errFd = fs.openSync(path.join(logs, "agent.err.log"), "a");
    const child = spawn(node, args, { cwd: path.join(ROOT, "agent"), detached: true, stdio: ["ignore", outFd, errFd], windowsHide: true });
    child.unref();
    fs.mkdirSync(path.dirname(pidPath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pidPath(), `${child.pid}\n`, { mode: 0o600 });
  }
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    if (await health()) return say(`Orbi is running on http://localhost:${port()}. Logs: ${tilde(logDir())}`);
  }
  say(`Orbi did not answer yet. Check the logs in ${tilde(logDir())}.`);
}

async function stop({ quiet = false } = {}) {
  let stopped = false;
  if (IS_MAC && LAUNCHCTL && agentLoaded()) {
    stopped = launchctl(["bootout", `${domain()}/${LABEL}`]).status === 0 || stopped;
  }
  const pid = readPid();
  if (pid && isOurServer(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
    } catch {}
  }
  try { fs.unlinkSync(pidPath()); } catch {}
  for (let i = 0; i < 10 && stopped && (await health(port(), 300)); i++) await sleep(200);
  if (quiet) return stopped;
  if (stopped) say(fs.existsSync(plistPath()) ? "Stopped Orbi. It starts again when you log in; ./orbi uninstall turns that off." : "Stopped Orbi.");
  else if (await health()) say(`Something else is still running Orbi on port ${port()}. If you started it with npm start, press Ctrl+C in that window.`);
  else say("Orbi is not running.");
  return stopped;
}

async function status() {
  const file = configPath();
  const cfg = readConfig(file);
  const env = { ...cfg, ...Object.fromEntries(KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k]])) };
  let mode = "";
  try {
    mode = (fs.statSync(file).mode & 0o777).toString(8);
  } catch {}
  say(`Config:        ${fs.existsSync(file) ? `${tilde(file)}${mode && mode !== "600" ? ` (mode ${mode}: run setup again to fix)` : ""}` : "not set up (run npm run setup)"}`);
  say(`Model:         ${env.CLEARCART_PROVIDER === "local" ? `Local (${env.CLEARCART_LOCAL_MODEL || DEFAULT_LOCAL_MODEL})` : "Claude"}`);
  say(`Anthropic key: ${describeKey(env.ANTHROPIC_API_KEY)}`);
  say(`Cartesia key:  ${describeKey(env.CARTESIA_API_KEY)}${env.CARTESIA_API_KEY ? "" : " (basic voice)"}`);
  if (IS_MAC) say(`Autostart:     ${fs.existsSync(plistPath()) ? (LAUNCHCTL && agentLoaded() ? "on, loaded" : "on") : "off"}`);
  const h = await health();
  say(`Server:        ${h ? `running on port ${port()}${h.extension === true ? ", extension connected" : h.extension === false ? ", extension not connected" : ""}` : "not running"}`);
  say(`Logs:          ${tilde(logDir())}`);
}

async function uninstall(flags) {
  await stop({ quiet: true });
  if (fs.existsSync(plistPath())) {
    fs.unlinkSync(plistPath());
    say("Removed start on login.");
  }
  const file = configPath();
  if (fs.existsSync(file)) {
    let del = flags.has("--delete-config");
    if (!del && !flags.has("--keep-config") && process.stdin.isTTY) del = await yesNo(`Delete your saved keys (${tilde(file)})?`, false);
    if (del) {
      fs.unlinkSync(file);
      say("Deleted your saved keys.");
    } else say(`Kept your saved keys in ${tilde(file)}.`);
  }
  say("Orbi's server is stopped and will not start on login.");
  say("To remove the extension, open chrome://extensions and press Remove on Orbi.");
  say(`To delete Orbi itself, delete ${ROOT}. Logs are in ${tilde(logDir())}.`);
}

function help() {
  say("Usage: ./orbi <command>   (or: node scripts/orbi.mjs <command>)");
  say("  setup [--autostart]   install, save your keys, show how to load the extension");
  say("  start                 run the server in the background");
  say("  stop                  stop the background server");
  say("  status                show what is set up and running (keys show as set or not set)");
  say("  uninstall             stop Orbi, turn off start on login, optionally delete saved keys");
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const flags = new Set(rest);
  if (!fs.existsSync(path.join(ROOT, "agent", "package.json"))) return bootstrap(process.argv.slice(2));
  try {
    if (cmd === "setup") await setup(flags);
    else if (cmd === "start") await start();
    else if (cmd === "stop") await stop();
    else if (cmd === "status") await status();
    else if (cmd === "uninstall") await uninstall(flags);
    else help();
  } finally {
    closePrompts();
  }
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
