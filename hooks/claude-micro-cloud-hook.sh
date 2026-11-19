#!/bin/sh
# claude-micro cloud hook. Runs inside a Claude Code cloud session on every
# hook event and publishes one small JSON message to the relay topic, then
# exits at once (the upload runs in the background). Needs curl and network
# access to the relay host from the cloud environment.
#
# Configure with CLAUDE_MICRO_RELAY_URL=https://ntfy.sh/<topic> (set by the
# setup script) or edit the default below.
url="${CLAUDE_MICRO_RELAY_URL:-__RELAY_URL__}"
payload="$(cat 2>/dev/null)"
field() { printf '%s' "$payload" | sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" | head -n 1; }
sid="$(field session_id)"
ev="$(field hook_event_name)"
nt="$(field notification_type)"
cwd="$(field cwd)"
repo="${cwd##*/}"
[ -n "$sid" ] && [ -n "$ev" ] || exit 0
bridge="${CLAUDE_CODE_BRIDGE_SESSION_ID:-}"
host="$(hostname 2>/dev/null | cut -d. -f1)"
msg="$(printf '{"sid":"%s","ev":"%s","nt":"%s","repo":"%s","bridge":"%s","host":"%s","cloud":1,"t":%s}' "$sid" "$ev" "$nt" "$repo" "$bridge" "$host" "$(date +%s)")"
( curl -s -m 5 -H 'Content-Type: application/json' -d "$msg" "$url" >/dev/null 2>&1 & ) 2>/dev/null
exit 0
