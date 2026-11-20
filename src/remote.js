// Servers over ssh: the remote hook appends one JSON line per event to
// ~/.claude/claude-micro-events.jsonl on that machine, and the helper follows
// the file with `ssh HOST tail -F`. No third-party relay, no message limits.
// The list of hosts (ssh aliases) lives in state/remotes.json, git-ignored.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { STATE_DIR } from "./sessions.js";

export const REMOTES_PATH = STATE_DIR + "remotes.json";
export const REMOTE_EVENTS = "$HOME/.claude/claude-micro-events.jsonl";
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60000;
const CATCH_UP_LINES = 200;
const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

export function loadRemotes() {
  if (!existsSync(REMOTES_PATH)) return [];
  try {
    const list = JSON.parse(readFileSync(REMOTES_PATH, "utf8"));
    return Array.isArray(list) ? list.filter((r) => r && typeof r.ssh === "string" && r.ssh) : [];
  } catch {
    return [];
  }
}

export function saveRemotes(list) {
  writeFileSync(REMOTES_PATH, JSON.stringify(list, null, 2) + "\n");
}

export const sshArgs = (host, command) => [...SSH_OPTIONS, host, command];

/**
 * Follows one host's event file forever, reconnecting with backoff. The first
 * connection starts at the end of the file; a reconnection replays recent
 * lines it has not seen, so a session that finished during the gap does not
 * stay lit as working. Returns { state, stop }.
 */
export function follow(host, onEvent, log) {
  let stopped = false;
  let child = null;
  let delay = RETRY_MIN_MS;
  let first = true;
  let lostAt = 0;
  const seen = new Set();
  const state = { host, connected: false, lastMessageAt: null, lastError: null };

  const remember = (line) => {
    seen.add(line);
    if (seen.size > CATCH_UP_LINES * 2) seen.delete(seen.values().next().value);
  };

  const connect = () => {
    if (stopped) return;
    const lines = first ? 0 : CATCH_UP_LINES;
    const since = first ? 0 : Math.floor(lostAt / 1000) - 5;
    const command = `f="${REMOTE_EVENTS}"; mkdir -p "$HOME/.claude"; touch "$f"; echo claude-micro-ready; exec tail -n ${lines} -F "$f" 2>/dev/null`;
    child = spawn("ssh", sshArgs(host, command), { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-400)));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (line === "claude-micro-ready") {
          state.connected = true;
          state.lastError = null;
          delay = RETRY_MIN_MS;
          log(`ssh ${host}: following server events`);
          continue;
        }
        if (seen.has(line)) continue;
        remember(line);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (since && Number(message.t) < since) continue;
        state.lastMessageAt = Date.now();
        try {
          onEvent(message);
        } catch (e) {
          log(`ssh ${host}: bad event: ${e.message}`);
        }
      }
    });
    child.on("close", (code) => {
      child = null;
      if (state.connected) lostAt = Date.now();
      else if (!lostAt) lostAt = Date.now();
      state.connected = false;
      first = false;
      if (stopped) return;
      state.lastError = stderr.trim().split("\n").pop() || `ssh exited with code ${code}`;
      log(`ssh ${host}: disconnected (${state.lastError}); retrying in ${Math.round(delay / 1000)} s`);
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    });
    child.on("error", (e) => (state.lastError = e.message));
  };

  connect();
  return {
    state,
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}

/** `claude-micro remote add|remove|list`. */
export async function run(sub, host) {
  const list = loadRemotes();
  if (sub === "list" || !sub) {
    if (!list.length) console.log("no servers; add one with: node bin/claude-micro.js remote add <ssh-alias>");
    for (const r of list) console.log(r.ssh);
    return;
  }
  if (!host || !/^[A-Za-z0-9._@-]+$/.test(host)) {
    console.log("usage: claude-micro remote <add|remove> <ssh-alias>");
    process.exit(2);
  }
  if (sub === "add") {
    const { remoteInstaller } = await import("./cloud.js");
    console.log(`installing the hook on ${host} over ssh (its ~/.claude/settings.json is backed up first)…`);
    const code = await new Promise((resolve) => {
      const child = spawn("ssh", [...SSH_OPTIONS, host, "sh -s"], { stdio: ["pipe", "inherit", "inherit"] });
      child.on("close", resolve);
      child.on("error", () => resolve(1));
      child.stdin.end(remoteInstaller(""));
    });
    if (code !== 0) {
      console.log(`ssh ${host} failed (exit ${code}). It must work without a password prompt: try  ssh -o BatchMode=yes ${host} true`);
      process.exit(1);
    }
    if (!list.some((r) => r.ssh === host)) saveRemotes([...list, { ssh: host }]);
    console.log(`added ${host}. Restart the helper to start following it: launchctl kickstart -k gui/$(id -u)/com.claude-micro.helper`);
    return;
  }
  if (sub === "remove") {
    saveRemotes(list.filter((r) => r.ssh !== host));
    console.log(`removed ${host} from this Mac's list; its hook stays installed on the server (uninstall there by deleting the claude-micro-cloud-hook.sh entries from ~/.claude/settings.json).`);
    return;
  }
  console.log("usage: claude-micro remote <add|remove|list> [ssh-alias]");
  process.exit(2);
}
