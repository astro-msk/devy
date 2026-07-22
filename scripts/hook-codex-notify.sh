#!/usr/bin/env bash
set +e

INPUT="$(cat)"
PORT="${PORT:-8787}"
TOKEN="${AGENT_OPS_TOKEN:-}"
TMUX_SESSION="${AGENT_OPS_TMUX_SESSION:-}"
if [ -z "$TMUX_SESSION" ] && [ -n "${TMUX_PANE:-}" ]; then
  TMUX_SESSION="$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)"
fi
if [ -z "$TMUX_SESSION" ] && [ -n "${TMUX:-}" ]; then
  TMUX_SESSION="$(tmux display-message -p '#{session_name}' 2>/dev/null)"
fi
REPO_PATH="$(pwd -P 2>/dev/null || pwd)"
export TMUX_SESSION REPO_PATH

TYPE="$(printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const l=s.toLowerCase(); console.log(l.includes("stop")||l.includes("completed") ? "completed" : "notification")})' 2>/dev/null)"
export TYPE
BODY="$(printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let raw;try{raw=JSON.parse(s)}catch{raw={stdin:s}}; if (process.env.TMUX_SESSION) raw.session=process.env.TMUX_SESSION; if (process.env.REPO_PATH) raw.repoPath=process.env.REPO_PATH; const event=String(raw.hook_event_name || raw.event || ""); let msg=raw.message || "Codex notification"; if (/PermissionRequest/i.test(event) || /PermissionRequest/i.test(msg)) msg="Codex requested permission. Reply in this Slack thread or use the dashboard to respond."; if (/Stop|completed/i.test(event) || /completed/i.test(msg)) msg="Codex completed the current turn."; console.log(JSON.stringify({agent:"codex",type:process.env.TYPE || "notification",message:msg,session:process.env.TMUX_SESSION || undefined,repoPath:process.env.REPO_PATH || undefined,raw}))})' 2>/dev/null)"

if [ -n "$TOKEN" ] && [ -n "$BODY" ]; then
  curl -fsS -m 2 \
    -H "content-type: application/json" \
    -H "authorization: Bearer $TOKEN" \
    -d "$BODY" \
    "http://127.0.0.1:${PORT}/api/events" >/dev/null 2>&1
else
  curl -fsS -m 2 \
    -H "content-type: application/json" \
    -d "$BODY" \
    "http://127.0.0.1:${PORT}/api/events" >/dev/null 2>&1
fi

exit 0
