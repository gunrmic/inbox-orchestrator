import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "../config/paths.js";

const run = promisify(execFile);
export const LABEL = "dev.omermichaeli.inbox-orchestrator";
export const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderPlist(nodePath: string, cliPath: string, envPath: string, extraEnv: Record<string, string> = {}): string {
  const extra = Object.entries(extraEnv)
    .map(([k, v]) => `\n    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(cliPath)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(envPath)}</string>${extra}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(join(paths.logs, "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(paths.logs, "daemon.err.log"))}</string>
</dict>
</plist>
`;
}

/** Installs a per-user LaunchAgent so the daemon starts at login and restarts if it crashes. */
export async function installAgent(cliPath: string): Promise<string> {
  if (platform() !== "darwin") throw new Error("Background install uses launchd and is macOS only. Run `ibo start` instead.");
  const file = plistPath();
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  // Keep the user's PATH so `claude`, `git` and MCP server commands (npx, uvx) resolve.
  // Inside the .dmg app the "node" binary is Electron, which runs scripts only with this flag.
  const extra: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  writeFileSync(file, renderPlist(process.execPath, cliPath, process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", extra));
  const uid = process.getuid?.() ?? 501;
  await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => undefined);
  await run("launchctl", ["bootstrap", `gui/${uid}`, file]);
  return file;
}

export async function uninstallAgent(): Promise<void> {
  const uid = process.getuid?.() ?? 501;
  await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => undefined);
  if (existsSync(plistPath())) unlinkSync(plistPath());
}
