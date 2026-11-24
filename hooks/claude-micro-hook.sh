#!/bin/sh
# claude-micro hook relay. Claude Code runs this on hook events and pipes the
# event JSON to stdin. It appends one line to state/events.jsonl and exits 0
# at once; it never waits on the helper, so a stopped helper can't slow Claude.
dir="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/state"
[ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || exit 0
payload="$(cat 2>/dev/null)"
[ -n "$payload" ] || payload='{}'
# First match only: tool events carry tool input that may repeat a field name.
field() { printf '%s' "$payload" | grep -o "\"$1\":\"[^\"]*\"" | head -n 1 | cut -d '"' -f 4; }
ev="$(field hook_event_name)"
sid="$(field session_id | tr -cd 'A-Za-z0-9_-')"
mark="$dir/needs-$sid"
# Answering a permission prompt or a question fires no hook of its own, so a
# session that needed you would stay red until its turn ended. A "needs you"
# notification leaves a marker; the next PostToolUse (the approved tool has
# run) clears it and is passed on as "working again". Every other PostToolUse
# exits here without writing anything.
case "$ev" in
  PostToolUse)
    [ -n "$sid" ] && [ -f "$mark" ] || exit 0
    rm -f "$mark" 2>/dev/null ;;
  Notification)
    case "$(field notification_type)" in idle*) ;; *) [ -n "$sid" ] && : > "$mark" 2>/dev/null ;; esac ;;
  *)
    [ -n "$sid" ] && rm -f "$mark" 2>/dev/null ;;
esac
# Which window this session lives in: the desktop app's own session id, or
# the iTerm2 session id. Both are plain ids with no quotes.
printf '{"t":%s,"host":"%s","iterm":"%s","term":"%s","hook":%s}\n' \
  "$(date +%s)" "${CLAUDE_CODE_HOST_SESSION_ID:-}" "${ITERM_SESSION_ID:-}" "${TERM_PROGRAM:-}" "$payload" \
  >> "$dir/events.jsonl" 2>/dev/null
exit 0
