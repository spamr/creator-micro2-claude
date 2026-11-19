#!/bin/sh
# claude-micro hook relay. Claude Code runs this on hook events and pipes the
# event JSON to stdin. It appends one line to state/events.jsonl and exits 0
# at once; it never waits on the helper, so a stopped helper can't slow Claude.
dir="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/state"
[ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || exit 0
payload="$(cat 2>/dev/null)"
[ -n "$payload" ] || payload='{}'
# Which window this session lives in: the desktop app's own session id, or
# the iTerm2 session id. Both are plain ids with no quotes.
printf '{"t":%s,"host":"%s","iterm":"%s","term":"%s","hook":%s}\n' \
  "$(date +%s)" "${CLAUDE_CODE_HOST_SESSION_ID:-}" "${ITERM_SESSION_ID:-}" "${TERM_PROGRAM:-}" "$payload" \
  >> "$dir/events.jsonl" 2>/dev/null
exit 0
