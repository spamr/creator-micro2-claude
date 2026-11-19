#!/bin/sh
# Remove everything claude-micro placed outside this folder: the login item
# and the Claude Code hooks. Pass --restore-settings to put back the exact
# ~/.claude/settings.json saved before the hooks were installed instead of
# only removing the hook entries. Permissions granted in System Settings are
# left for you to revoke. This folder itself is not deleted.
set -u
cd "$(dirname "$0")" || exit 1
node bin/claude-micro.js stop >/dev/null 2>&1
node bin/claude-micro.js agent uninstall
if [ "${1:-}" = "--restore-settings" ] && [ -f "$HOME/.claude/settings.json.claude-micro-backup" ]; then
  cp "$HOME/.claude/settings.json" "$HOME/.claude/settings.json.before-claude-micro-uninstall"
  cp "$HOME/.claude/settings.json.claude-micro-backup" "$HOME/.claude/settings.json"
  echo "settings.json restored from the pre-install backup (previous file kept as settings.json.before-claude-micro-uninstall)"
else
  node bin/claude-micro.js hooks uninstall
fi
echo "done. Optional: remove 'node' from Input Monitoring and Accessibility in System Settings."
