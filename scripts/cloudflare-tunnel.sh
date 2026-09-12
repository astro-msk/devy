#!/usr/bin/env bash
# Helpers for the cloudflared systemd unit that publishes Devy through a
# Cloudflare Tunnel. See README "Public access via Cloudflare Tunnel + Access".
set -euo pipefail

ENV_FILE="/etc/agent-ops.env"
UNIT="cloudflared"
TUNNEL_PORT="${TUNNEL_PORT:-8797}"
MANAGER_TUNNEL_PORT="${MANAGER_TUNNEL_PORT:-8798}"
REQUIRED_VARS=(CLOUDFLARE_TUNNEL_TOKEN CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD)

usage() {
  cat <<EOF
Usage: $0 status|start|stop|enable|disable|logs

  status   Unit state, env var presence (names only), tunnel listeners on 127.0.0.1
  start    Start the tunnel for this boot only (systemctl start)
  stop     Stop the tunnel (systemctl stop)
  enable   Preflight, then enable + start the tunnel (systemctl enable --now)
  disable  Stop and disable the tunnel (systemctl disable --now)
  logs     Follow the cloudflared journal
EOF
}

# Reports which of the required variables are set in the env file, without
# printing any value. Needs sudo because the env file is root-only.
env_report() {
  local missing=0 name
  if ! sudo test -r "$ENV_FILE"; then
    echo "  env file: $ENV_FILE not found"
    return 1
  fi
  for name in "${REQUIRED_VARS[@]}"; do
    if sudo grep -Eq "^${name}=.+" "$ENV_FILE"; then
      echo "  $name: set"
    else
      echo "  $name: MISSING"
      missing=1
    fi
  done
  return $missing
}

listener_report() {
  local ok=0 port
  for port in "$TUNNEL_PORT" "$MANAGER_TUNNEL_PORT"; do
    if ss -ltn 2>/dev/null | grep -q "127.0.0.1:${port} "; then
      echo "  127.0.0.1:${port}: listening"
    else
      echo "  127.0.0.1:${port}: NOT listening (deploy the code and restart agent-ops / agent-sessions)"
      ok=1
    fi
  done
  return $ok
}

status() {
  # is-enabled / is-active exit non-zero for "disabled" / "inactive", so read
  # their output rather than their status.
  local enabled active
  enabled=$(systemctl is-enabled "$UNIT" 2>/dev/null) || true
  active=$(systemctl is-active "$UNIT" 2>/dev/null) || true
  echo "cloudflared unit:"
  echo "  enabled: ${enabled:-not installed}"
  echo "  active:  ${active:-unknown}"
  echo "environment ($ENV_FILE):"
  env_report || true
  echo "tunnel listeners:"
  listener_report || true
  echo
  systemctl status "$UNIT" --no-pager 2>/dev/null | head -12 || true
}

preflight() {
  local failed=0
  echo "Preflight:"
  env_report || failed=1
  listener_report || failed=1
  if ! command -v cloudflared >/dev/null; then
    echo "  cloudflared: not installed"
    failed=1
  fi
  if [ "$failed" -ne 0 ]; then
    echo "Preflight failed; not enabling the tunnel." >&2
    exit 1
  fi
}

case "${1:-}" in
  status) status ;;
  start)
    preflight
    sudo systemctl start "$UNIT"
    systemctl status "$UNIT" --no-pager | head -8
    ;;
  stop) sudo systemctl stop "$UNIT"; echo "stopped" ;;
  enable)
    preflight
    sudo systemctl enable --now "$UNIT"
    systemctl status "$UNIT" --no-pager | head -8
    ;;
  disable) sudo systemctl disable --now "$UNIT"; echo "disabled" ;;
  logs) journalctl -u "$UNIT" -f ;;
  *) usage; exit 1 ;;
esac
