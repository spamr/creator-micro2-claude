// The login item: a per-user LaunchAgent that starts the helper at login and
// restarts it if it exits. Output goes to state/helper.log. A manually started
// helper takes precedence: the agent's copy exits (code 3) while one runs and
// launchd retries it every 15 s, so stopping the manual copy hands back.
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { STATE_DIR } from "./sessions.js";

export const LABEL = "com.claude-micro.helper";
export const PLIST_PATH = `${homedir()}/Library/LaunchAgents/${LABEL}.plist`;
export const LOG_PATH = STATE_DIR + "helper.log";
const ENTRY = fileURLToPath(new URL("../bin/claude-micro.js", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function plist(nodePath = process.execPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(nodePath)}</string>
    <string>${escape(ENTRY)}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${escape(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${escape(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${escape(LOG_PATH)}</string>
</dict>
</plist>
`;
}

const uid = () => process.getuid();
const launchctl = (...args) => spawnSync("launchctl", args, { encoding: "utf8" });

export function loaded() {
  return launchctl("print", `gui/${uid()}/${LABEL}`).status === 0;
}

export function install(nodePath) {
  writeFileSync(PLIST_PATH, plist(nodePath));
  if (loaded()) launchctl("bootout", `gui/${uid()}/${LABEL}`);
  const result = launchctl("bootstrap", `gui/${uid()}`, PLIST_PATH);
  if (result.status !== 0) throw new Error(`launchctl bootstrap failed: ${(result.stderr || result.stdout).trim()}`);
  launchctl("kickstart", "-k", `gui/${uid()}/${LABEL}`);
  return { plist: PLIST_PATH, log: LOG_PATH, node: nodePath ?? process.execPath };
}

export function uninstall() {
  if (loaded()) launchctl("bootout", `gui/${uid()}/${LABEL}`);
  if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
}

export function status() {
  const result = launchctl("print", `gui/${uid()}/${LABEL}`);
  if (result.status !== 0) return { installed: existsSync(PLIST_PATH), loaded: false };
  const pid = /pid = (\d+)/.exec(result.stdout)?.[1];
  const state = /state = (\w+)/.exec(result.stdout)?.[1];
  return { installed: true, loaded: true, pid: pid ? Number(pid) : null, state };
}
