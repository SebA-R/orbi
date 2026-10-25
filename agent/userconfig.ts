// Where `npm run setup` (scripts/orbi.mjs) keeps the user's keys and
// options: one dotenv file outside the repo, mode 0600. Keep this in step
// with configPath() in scripts/orbi/paths.mjs (test/userconfig.test.ts
// checks they agree).
//
//   ORBI_CONFIG set        that file
//   Windows                %APPDATA%\Orbi\config.env
//   macOS and Linux        $XDG_CONFIG_HOME/orbi/config.env, else ~/.config/orbi/config.env
//
// server.ts loads it after the repo's .env, and dotenv never overrides a
// value already set, so the order is: the process environment, then .env,
// then this file.

import os from "node:os";
import path from "node:path";

export function orbiConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (env.ORBI_CONFIG?.trim()) return path.resolve(env.ORBI_CONFIG.trim());
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Orbi", "config.env");
  const base = env.XDG_CONFIG_HOME?.trim() ? env.XDG_CONFIG_HOME.trim() : path.join(home, ".config");
  return path.join(base, "orbi", "config.env");
}
