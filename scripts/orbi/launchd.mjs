// macOS start-on-login: a LaunchAgent plist for the agent server. No keys
// go in the plist; the server reads them from the config file itself.
import path from "node:path";
import { LABEL } from "./paths.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The command that runs the server without a shell or PATH lookup: this
// Node, tsx's own entry file, server.ts.
export function serverCommand({ root, node = process.execPath }) {
  return [node, path.join(root, "agent", "node_modules", "tsx", "dist", "cli.mjs"), "server.ts"];
}

// config: the config file setup wrote, so the server reads that one even
// when the login session lacks the shell's XDG_CONFIG_HOME or ORBI_CONFIG.
export function buildPlist({ root, logs, node = process.execPath, port, config }) {
  const args = serverCommand({ root, node });
  const env = {
    // launchd starts with a bare PATH; the Agent SDK and the Keychain
    // helper need node and the system tools.
    PATH: [path.dirname(node), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    ...(config ? { ORBI_CONFIG: config } : {}),
    ...(port ? { AGENT_PORT: String(port) } : {}),
  };
  const kv = (k, v) => `\t\t<key>${esc(k)}</key>\n\t\t<string>${esc(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${esc(LABEL)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args.map((a) => `\t\t<string>${esc(a)}</string>`).join("\n")}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${esc(path.join(root, "agent"))}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${Object.entries(env).map(([k, v]) => kv(k, v)).join("\n")}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>StandardOutPath</key>
\t<string>${esc(path.join(logs, "agent.log"))}</string>
\t<key>StandardErrorPath</key>
\t<string>${esc(path.join(logs, "agent.err.log"))}</string>
</dict>
</plist>
`;
}
