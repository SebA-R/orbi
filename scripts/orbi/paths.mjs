// Where the Orbi installer keeps things. configPath() must match
// orbiConfigPath() in agent/userconfig.ts, which the server reads.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LABEL = "io.github.seba-r.orbi";
export const DEFAULT_PORT = 5050;
export const REPO_URL = "https://github.com/SebA-R/orbi.git";

const home = (env) => env.HOME || os.homedir();

export function configPath(env = process.env, platform = process.platform) {
  if (env.ORBI_CONFIG?.trim()) return path.resolve(env.ORBI_CONFIG.trim());
  if (platform === "win32") return path.join(env.APPDATA || path.join(home(env), "AppData", "Roaming"), "Orbi", "config.env");
  const base = env.XDG_CONFIG_HOME?.trim() ? env.XDG_CONFIG_HOME.trim() : path.join(home(env), ".config");
  return path.join(base, "orbi", "config.env");
}

// Server logs: ~/Library/Logs/Orbi on macOS, the XDG state folder elsewhere.
export function logDir(env = process.env, platform = process.platform) {
  if (platform === "darwin") return path.join(home(env), "Library", "Logs", "Orbi");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home(env), "AppData", "Local"), "Orbi", "Logs");
  const base = env.XDG_STATE_HOME?.trim() ? env.XDG_STATE_HOME.trim() : path.join(home(env), ".local", "state");
  return path.join(base, "orbi", "logs");
}

// The background server's process id, next to the config.
export const pidPath = (env = process.env, platform = process.platform) => path.join(path.dirname(configPath(env, platform)), "server.pid");

export const plistPath = (env = process.env) => path.join(home(env), "Library", "LaunchAgents", `${LABEL}.plist`);

export const port = (env = process.env) => Number(env.AGENT_PORT) || DEFAULT_PORT;
