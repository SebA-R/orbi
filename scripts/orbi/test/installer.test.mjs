// The installer: the config file is private, keys never reach the
// terminal or the logs, and the LaunchAgent is only written, never loaded
// (ORBI_NO_LAUNCHCTL=1). Every run uses a throwaway HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readConfig, serialize, writeConfig } from "../config.mjs";
import { buildPlist } from "../launchd.mjs";
import { configPath } from "../paths.mjs";
import { orbiConfigPath } from "../../../agent/userconfig.ts";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "orbi.mjs");
const ANTHROPIC = "sk-ant-api03-FAKEtestKEY0000000000000000";
const CARTESIA = "sk_car_FAKEtestKEY1111111111111111";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbi-home-"));
}

function run(home, args, input) {
  const env = { PATH: process.env.PATH, HOME: home, ORBI_NO_LAUNCHCTL: "1", AGENT_PORT: "5987" };
  return spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8", timeout: 30_000 });
}

test("the config file is mode 0600 in a 0700 folder and round-trips", () => {
  const home = tempHome();
  const file = path.join(home, "cfg", "orbi", "config.env");
  writeConfig(file, { ANTHROPIC_API_KEY: ANTHROPIC, CLEARCART_BROWSER: "ext" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(readConfig(file), { ANTHROPIC_API_KEY: ANTHROPIC, CLEARCART_BROWSER: "ext" });
  // A value that would break out of its line is refused, not written.
  assert.throws(() => serialize({ ANTHROPIC_API_KEY: "sk-ant-x\nCLEARCART_PROVIDER=local" }), /can't save/);
});

test("the server and the installer agree on where the config lives", () => {
  for (const env of [{ HOME: "/h" }, { HOME: "/h", XDG_CONFIG_HOME: "/x" }, { HOME: "/h", ORBI_CONFIG: "/c/o.env" }]) {
    assert.equal(orbiConfigPath(env, "darwin", "/h"), configPath(env, "darwin"));
    assert.equal(orbiConfigPath(env, "linux", "/h"), configPath(env, "linux"));
  }
});

test("setup saves both keys privately and never prints them", () => {
  const home = tempHome();
  const r = run(home, ["setup", "--skip-install"], `1\n${ANTHROPIC}\n${CARTESIA}\nn\n`);
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(home, ".config", "orbi", "config.env");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const cfg = readConfig(file);
  assert.equal(cfg.ANTHROPIC_API_KEY, ANTHROPIC);
  assert.equal(cfg.CARTESIA_API_KEY, CARTESIA);
  assert.equal(cfg.CLEARCART_BROWSER, "ext");
  for (const key of [ANTHROPIC, CARTESIA]) {
    assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key), "a key reached the terminal");
  }
  assert.match(r.stdout, /chrome:\/\/extensions/);
  assert.match(r.stdout, new RegExp(path.join("extension").replace(/\//g, "\\/")));

  const s = run(home, ["status"], "");
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /Anthropic key: set/);
  assert.ok(!s.stdout.includes(ANTHROPIC) && !s.stdout.includes(CARTESIA));
});

test("local model, no Cartesia: no keys needed, basic voice", () => {
  const home = tempHome();
  const r = run(home, ["setup", "--skip-install"], "2\n\n\n\nn\n");
  assert.equal(r.status, 0, r.stderr);
  const cfg = readConfig(path.join(home, ".config", "orbi", "config.env"));
  assert.equal(cfg.CLEARCART_PROVIDER, "local");
  assert.equal(cfg.CLEARCART_LOCAL_URL, "http://localhost:11434/v1");
  assert.equal(cfg.ANTHROPIC_API_KEY, undefined);
  assert.equal(cfg.CARTESIA_API_KEY, undefined);
  assert.match(r.stdout, /Model provider to Local/);
  assert.match(run(home, ["status"], "").stdout, /Cartesia key: {2}not set \(basic voice\)/);
});

test("--autostart writes a LaunchAgent with no keys in it, and logs to ~/Library/Logs/Orbi", { skip: process.platform !== "darwin" }, () => {
  const home = tempHome();
  const r = run(home, ["setup", "--skip-install", "--autostart"], `1\n${ANTHROPIC}\n\n`);
  assert.equal(r.status, 0, r.stderr);
  const plist = path.join(home, "Library", "LaunchAgents", "io.github.seba-r.orbi.plist");
  const text = fs.readFileSync(plist, "utf8");
  assert.ok(!text.includes(ANTHROPIC));
  assert.match(text, /Library\/Logs\/Orbi\/agent\.log/);
  assert.match(text, /<string>server\.ts<\/string>/);
  assert.match(text, /<key>ORBI_CONFIG<\/key>\s*<string>[^<]*\.config\/orbi\/config\.env<\/string>/);
  assert.equal(spawnSync("plutil", ["-lint", plist]).status, 0);
  assert.ok(!r.stdout.includes(ANTHROPIC));
  const u = run(home, ["uninstall", "--delete-config"], "");
  assert.equal(u.status, 0, u.stderr);
  assert.ok(!fs.existsSync(plist));
  assert.ok(!fs.existsSync(path.join(home, ".config", "orbi", "config.env")));
});

test("plist values are XML-escaped", () => {
  const xml = buildPlist({ root: "/a&b/<orbi>", logs: "/l", node: "/n/node" });
  assert.match(xml, /\/a&amp;b\/&lt;orbi&gt;\/agent/);
});
