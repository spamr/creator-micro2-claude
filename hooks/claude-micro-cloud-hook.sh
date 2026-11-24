#!/bin/sh
# claude-micro remote hook. Runs on another machine (a server you drive by
# Remote Control or ssh, or a cloud session) on every Claude Code hook event.
# It appends one small JSON line to ~/.claude/claude-micro-events.jsonl, which
# the helper on your Mac follows over ssh, and, when a relay URL is set, also
# publishes the line to that relay in the background. It never blocks Claude.
#
# Relay: CLAUDE_MICRO_RELAY_URL=https://ntfy.sh/<topic>, or the default below.
# An empty default means ssh only.
url="${CLAUDE_MICRO_RELAY_URL:-__RELAY_URL__}"
log="$HOME/.claude/claude-micro-events.jsonl"
payload="$(cat 2>/dev/null)"
# First match only: tool events carry tool input that may repeat a field name.
field() { printf '%s' "$payload" | grep -o "\"$1\":\"[^\"]*\"" | head -n 1 | cut -d '"' -f 4; }
sid="$(field session_id)"
ev="$(field hook_event_name)"
nt="$(field notification_type)"
cwd="$(field cwd)"
repo="${cwd##*/}"
[ -n "$sid" ] && [ -n "$ev" ] || exit 0
# "Still waiting for you" reminders change nothing on the pad; don't send them.
case "$nt" in idle*) exit 0 ;; esac
# Answering a permission prompt or a question fires no hook of its own. A
# "needs you" notification leaves a marker; the next PostToolUse clears it and
# is sent as "working again". Every other PostToolUse exits here, unsent.
mark="$HOME/.claude/claude-micro-needs-$(printf '%s' "$sid" | tr -cd 'A-Za-z0-9_-')"
case "$ev" in
  PostToolUse) [ -f "$mark" ] || exit 0; rm -f "$mark" 2>/dev/null ;;
  Notification) : > "$mark" 2>/dev/null ;;
  *) rm -f "$mark" 2>/dev/null ;;
esac
bridge="${CLAUDE_CODE_BRIDGE_SESSION_ID:-}"
# Newer Remote Control sessions don't export that variable; their id is in the
# Claude process's --sdk-url (…/code/sessions/cse_…). Look a few parents up.
if [ -z "$bridge" ]; then
  pid="$PPID"; hops=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && [ "$hops" -lt 6 ]; do
    bridge="$(ps -ww -o args= -p "$pid" 2>/dev/null | sed -n 's#.*/code/sessions/\(cse_[A-Za-z0-9]*\).*#\1#p' | head -n 1)"
    [ -n "$bridge" ] && break
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"; hops=$((hops + 1))
  done
fi
host="$(hostname 2>/dev/null | cut -d. -f1)"
msg="$(printf '{"sid":"%s","ev":"%s","nt":"%s","repo":"%s","bridge":"%s","host":"%s","cloud":1,"t":%s}' "$sid" "$ev" "$nt" "$repo" "$bridge" "$host" "$(date +%s)")"
{
  # Keep the file small: start a fresh one past about 512 KB.
  if [ -f "$log" ] && [ "$(wc -c < "$log" 2>/dev/null || echo 0)" -gt 524288 ]; then mv -f "$log" "$log.1"; fi
  printf '%s\n' "$msg" >> "$log"
} 2>/dev/null
if [ -n "$url" ]; then
  ( curl -s -m 5 -H 'Content-Type: application/json' -d "$msg" "$url" >/dev/null 2>&1 & ) 2>/dev/null
fi
exit 0
