// `claude-micro cloud …`: set up and test the relay for cloud sessions.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureRelay, loadRelay, publishUrl, publish } from "./relay.js";

const HOOK_TEMPLATE = fileURLToPath(new URL("../hooks/claude-micro-cloud-hook.sh", import.meta.url));
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"];

function hookScript(url) {
  return readFileSync(HOOK_TEMPLATE, "utf8").replace("__RELAY_URL__", url);
}

function settingsJson(command) {
  const hooks = {};
  for (const event of EVENTS) hooks[event] = [{ hooks: [{ type: "command", command, timeout: 5 }] }];
  return JSON.stringify({ hooks }, null, 2);
}

/** The block to paste into a cloud environment's setup script. */
export function setupScript(relay) {
  const url = publishUrl(relay);
  return `# --- claude-micro: report this session's status to the pad at home ---
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/claude-micro-cloud-hook.sh" <<'CLAUDE_MICRO_HOOK'
${hookScript(url).trimEnd()}
CLAUDE_MICRO_HOOK
chmod +x "$HOME/.claude/claude-micro-cloud-hook.sh"
if [ ! -s "$HOME/.claude/settings.json" ]; then
  cat > "$HOME/.claude/settings.json" <<'CLAUDE_MICRO_SETTINGS'
${settingsJson('"$HOME/.claude/claude-micro-cloud-hook.sh"')}
CLAUDE_MICRO_SETTINGS
fi
# --- end claude-micro ---`;
}

/** Fallback: a .claude/settings.json to commit in the repo, plus the hook file. */
export function repoFiles(relay) {
  return {
    ".claude/claude-micro-cloud-hook.sh": hookScript(publishUrl(relay)),
    ".claude/settings.json": settingsJson('"$CLAUDE_PROJECT_DIR/.claude/claude-micro-cloud-hook.sh"'),
  };
}

/**
 * Installer for another machine that runs Claude Code itself (a server you
 * drive by Remote Control or over ssh). Pipe it through ssh:
 *   ssh HOST 'sh -s' < state/remote-install.sh
 * It writes the hook script and merges the five hook entries into that
 * machine's ~/.claude/settings.json (backing the file up first). Needs
 * python3 there for the JSON merge; curl only when a relay URL is given.
 * With no URL the hook only writes ~/.claude/claude-micro-events.jsonl, which
 * the helper follows over ssh (see src/remote.js).
 */
export function remoteInstaller(url = "") {
  return `#!/bin/sh
# claude-micro remote installer (generated). Safe to run again.
set -e
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/claude-micro-cloud-hook.sh" <<'CLAUDE_MICRO_HOOK'
${hookScript(url).trimEnd()}
CLAUDE_MICRO_HOOK
chmod +x "$HOME/.claude/claude-micro-cloud-hook.sh"
command -v python3 >/dev/null || { echo "python3 is needed to merge settings.json"; exit 1; }
python3 - <<'PY'
import json, os, shutil, time
path = os.path.expanduser("~/.claude/settings.json")
hook = os.path.expanduser("~/.claude/claude-micro-cloud-hook.sh")
settings = {}
if os.path.exists(path):
    shutil.copyfile(path, path + ".claude-micro-backup." + time.strftime("%Y%m%dT%H%M%S"))
    with open(path) as f:
        text = f.read().strip()
        settings = json.loads(text) if text else {}
hooks = settings.setdefault("hooks", {})
for event in ${JSON.stringify(EVENTS)}:
    entries = [e for e in hooks.get(event, []) if not any("claude-micro-cloud-hook.sh" in h.get("command", "") for h in e.get("hooks", []))]
    entries.append({"hooks": [{"type": "command", "command": '"' + hook + '"', "timeout": 5}]})
    hooks[event] = entries
with open(path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\\n")
print("claude-micro hooks installed in", path)
PY
${url ? `payload="$(printf '{"sid":"install-test-%s","ev":"Stop","repo":"%s","cloud":1,"t":%s}' "$(hostname)" "$(hostname)" "$(date +%s)")"
curl -s -m 5 -H 'Content-Type: application/json' -d "$payload" "${url}" >/dev/null && echo "relay reachable from this machine: a key on the pad should show green now"
` : ""}echo "New Claude Code sessions on this machine will report to the pad. Running sessions pick the hooks up on their next turn."
`;
}

export async function run(sub) {
  if (sub === "remote-install") {
    const relay = ensureRelay();
    process.stdout.write(remoteInstaller(publishUrl(relay)));
    return;
  }
  if (sub === "setup" || sub === "show") {
    const relay = ensureRelay();
    console.log(`Relay topic (keep it private): ${publishUrl(relay)}\n`);
    console.log("1. In the cloud environment's settings on claude.ai, allow network access to ntfy.sh (or use full access).");
    console.log("2. Paste this into the environment's setup script:\n");
    console.log(setupScript(relay));
    console.log("\n3. Start a new cloud session in that environment and send a prompt; its key lights within a few seconds.");
    console.log("\nFallback if the setup script is ignored: commit these two files to the repo (node bin/claude-micro.js cloud repo-files).");
    return;
  }
  if (sub === "repo-files") {
    const relay = ensureRelay();
    for (const [path, content] of Object.entries(repoFiles(relay))) console.log(`===== ${path}\n${content}`);
    return;
  }
  if (sub === "test") {
    const relay = loadRelay();
    if (!relay) {
      console.log("no relay yet; run: node bin/claude-micro.js cloud setup");
      process.exit(1);
    }
    const sid = `relaytest-${Date.now().toString(36)}`;
    const send = (ev, extra = {}) => publish(relay, { sid, ev, repo: "relay-test", cloud: 1, t: Math.floor(Date.now() / 1000), ...extra });
    console.log("publishing a fake cloud session: working, then done, then gone (watch an agent key)");
    await send("UserPromptSubmit");
    await new Promise((r) => setTimeout(r, 4000));
    await send("Stop");
    await new Promise((r) => setTimeout(r, 4000));
    await send("SessionEnd");
    console.log("done");
    return;
  }
  console.log("usage: claude-micro cloud <setup|test|repo-files|remote-install>");
  process.exit(2);
}
