#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="/etc/agent-ops.env"
SERVICE_FILE="/etc/systemd/system/agent-ops.service"
MANAGER_SERVICE_FILE="/etc/systemd/system/agent-sessions.service"
GATEWAY_SERVICE_FILE="/etc/systemd/system/agent-gateway.service"
CLOUDFLARED_SERVICE_FILE="/etc/systemd/system/cloudflared.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo $0"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$APP_DIR/.env" ]; then
    cp "$APP_DIR/.env" "$ENV_FILE"
  else
    cp "$APP_DIR/.env.example" "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE; edit it before relying on alerts."
fi

sed "s#__AGENT_OPS_DIR__#$APP_DIR#g" "$APP_DIR/systemd/agent-ops.service" > "$SERVICE_FILE"
sed "s#__AGENT_OPS_DIR__#$APP_DIR#g" "$APP_DIR/systemd/agent-sessions.service" > "$MANAGER_SERVICE_FILE"
chmod 644 "$SERVICE_FILE"
chmod 644 "$MANAGER_SERVICE_FILE"
sed "s#__AGENT_OPS_DIR__#$APP_DIR#g" "$APP_DIR/systemd/agent-gateway.service" > "$GATEWAY_SERVICE_FILE"
chmod 644 "$GATEWAY_SERVICE_FILE"
# The Cloudflare Tunnel unit is installed but deliberately neither enabled nor
# started: go live with scripts/cloudflare-tunnel.sh enable once the Access
# variables are in the env file (see README).
if command -v cloudflared >/dev/null; then
  cp "$APP_DIR/systemd/cloudflared.service" "$CLOUDFLARED_SERVICE_FILE"
  chmod 644 "$CLOUDFLARED_SERVICE_FILE"
fi
systemctl daemon-reload
systemctl enable agent-ops
systemctl enable agent-sessions
systemctl enable agent-gateway
systemctl restart agent-ops
systemctl restart agent-sessions
systemctl restart agent-gateway
systemctl status agent-ops --no-pager
systemctl status agent-sessions --no-pager
systemctl status agent-gateway --no-pager
