// Claude Code hook entries for ~/.claude/settings.json: print the proposed
// change as a diff, install it (after backing the file up), or remove it.
// Only entries that run hooks/claude-micro-hook.sh are ever added or removed;
// everything else in the file is left exactly as it was.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const SETTINGS_PATH = `${homedir()}/.claude/settings.json`;
export const BACKUP_PATH = `${SETTINGS_PATH}.claude-micro-backup`;
export const HOOK_SCRIPT = fileURLToPath(new URL("../hooks/claude-micro-hook.sh", import.meta.url));
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"];
const MARK = "claude-micro-hook.sh";

function readSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  const text = readFileSync(SETTINGS_PATH, "utf8");
  return text.trim() ? JSON.parse(text) : {};
}

const isOurs = (entry) => (entry.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK));

/** Settings with our hook entries added (or refreshed) for every event. */
export function withHooks(settings) {
  const out = structuredClone(settings);
  out.hooks = out.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    const kept = (out.hooks[event] ?? []).filter((e) => !isOurs(e));
    kept.push({ hooks: [{ type: "command", command: JSON.stringify(HOOK_SCRIPT), timeout: 5 }] });
    out.hooks[event] = kept;
  }
  return out;
}

/** Settings with our hook entries removed; an emptied hooks object goes too. */
export function withoutHooks(settings) {
  const out = structuredClone(settings);
  if (!out.hooks) return out;
  for (const event of Object.keys(out.hooks)) {
    out.hooks[event] = (out.hooks[event] ?? []).filter((e) => !isOurs(e));
    if (out.hooks[event].length === 0) delete out.hooks[event];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

const render = (obj) => JSON.stringify(obj, null, 2) + "\n";

export function diff(before, after) {
  const dir = process.env.TMPDIR ?? "/tmp";
  const a = `${dir}/claude-micro-settings-current.json`;
  const b = `${dir}/claude-micro-settings-proposed.json`;
  writeFileSync(a, before);
  writeFileSync(b, after);
  const result = spawnSync("diff", ["-u", "--label", "settings.json (current)", "--label", "settings.json (proposed)", a, b], { encoding: "utf8" });
  return result.stdout || "(no changes)\n";
}

export function installed() {
  const settings = readSettings();
  return HOOK_EVENTS.every((event) => (settings.hooks?.[event] ?? []).some(isOurs));
}

export function hookScriptOk() {
  return existsSync(HOOK_SCRIPT);
}

export function printDiff() {
  const current = readSettings();
  process.stdout.write(diff(render(current), render(withHooks(current))));
}

export function install() {
  const current = readSettings();
  const next = render(withHooks(current));
  if (existsSync(SETTINGS_PATH)) {
    // Keep the first backup forever (the pristine file); refresh a dated copy each time.
    if (!existsSync(BACKUP_PATH)) copyFileSync(SETTINGS_PATH, BACKUP_PATH);
    copyFileSync(SETTINGS_PATH, `${BACKUP_PATH}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
  }
  writeFileSync(SETTINGS_PATH, next);
  return { backup: BACKUP_PATH };
}

export function uninstall() {
  const current = readSettings();
  writeFileSync(SETTINGS_PATH, render(withoutHooks(current)));
}
