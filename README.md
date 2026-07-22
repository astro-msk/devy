# agent-ops

Tailscale-only PWA dashboard for watching all Claude Code and Codex tmux sessions and sending Slack alerts when an agent appears to need input.

This MVP intentionally has no browser login. Tailscale is the access layer. Do not expose port `8787` to the public internet.

## What It Does

- Serves a mobile-first PWA dashboard at `http://TAILSCALE_IP:8787`.
- Serves a separate multi-session PWA manager at `http://TAILSCALE_IP:8790`.
- Reads all tmux sessions with `tmux list-sessions`, `tmux capture-pane`, and `tmux list-panes`.
- Stores hook and monitor events in SQLite at `data/agent-ops.sqlite`.
- Polls discovered Claude/Codex tmux sessions every 7 seconds and creates an `approval_required` event if a waiting prompt lasts more than 10 seconds.
- Deduplicates monitor alerts per tmux session so parallel repos get separate alert state.
- Sends Slack webhook alerts for `approval_required`, `notification`, and `error`, including the source tmux session.
- Optionally sends text input to any observed tmux session when `ENABLE_AGENT_INPUT=true`.
- Exposes read APIs without login over Tailscale.
- Requires `AGENT_OPS_TOKEN` for non-local writes to `POST /api/events`.

## Setup

```bash
cd /home/ubuntu/apps/agent-ops
npm install
cp .env.example .env
nano .env
npm run build
npm run start
```

Open the dashboard from a Tailscale-connected device:

```text
http://TAILSCALE_IP:8787
http://TAILSCALE_MAGICDNS_NAME:8787
```

Open the multi-session manager from a Tailscale-connected device:

```text
http://TAILSCALE_IP:8790
http://TAILSCALE_MAGICDNS_NAME:8790
```

Both dashboards discover all tmux sessions, classify Claude/Codex sessions, show the branch for each session's active pane directory, and let you send a reply into that exact tmux session. The manager also exposes the terminal-style controls and session creation flow. It does not run arbitrary shell commands.

Keep the AWS security group closed for ports `8787` and `8790`. Allow access through Tailscale only. Tailscale Serve can be added later for a nicer tailnet URL, but do not use Tailscale Funnel because Funnel exposes services publicly.

## Environment

Fill these values in `.env` for local runs and `/etc/agent-ops.env` for systemd:

```bash
PORT=8787
MANAGER_PORT=8790
HOST=0.0.0.0
TAILSCALE_ONLY=true
REPO_PATH=/home/ubuntu/path/to/repo
CLAUDE_TMUX_SESSION=claude
CODEX_TMUX_SESSION=codex
AGENT_OPS_TOKEN=replace-with-a-random-token-for-write-hooks
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
SLACK_CHANNEL_ID=
SLACK_SOCKET_MODE=false
ENABLE_AGENT_INPUT=false
AGENT_WAIT_ALERT_SECONDS=30
```

`SLACK_WEBHOOK_URL` may be empty. Alerts are skipped gracefully when neither webhook nor bot credentials are configured.

Use `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`, and `SLACK_SOCKET_MODE=true` for the better Slack flow: each alert is posted as a separate top-level message, and replies in that Slack thread are sent to the exact tmux session from the alert. This uses Slack Socket Mode, so no public inbound HTTP route is needed.

`ENABLE_AGENT_INPUT=false` keeps browser-to-tmux input and stop actions disabled on the main dashboard. Set it to `true` only if you want the dashboard to type into and manage tmux sessions. The dashboard prompts once for `AGENT_OPS_TOKEN` and stores it in browser local storage for write requests.

`CLAUDE_TMUX_SESSION` and `CODEX_TMUX_SESSION` are still used by the legacy `/api/agents/:agent/input` endpoint. Discovery and Slack monitoring use `tmux list-sessions`, so session names like `claude-pilot` and `codex-app-a` are picked up automatically.

`AGENT_WAIT_ALERT_SECONDS=30` means a Claude or Codex tmux session must look like it needs input for at least 30 seconds before the tmux fallback monitor sends an alert.

## API

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/status
curl http://127.0.0.1:8787/api/sessions
curl http://127.0.0.1:8787/api/events
```

Create an event:

```bash
curl -X POST http://127.0.0.1:8787/api/events \
  -H 'content-type: application/json' \
  -d '{"agent":"codex","type":"notification","message":"manual test","session":"codex-pilot","repoPath":"/home/ubuntu/apps/example","raw":{"source":"curl"}}'
```

For non-local writes:

```bash
curl -X POST http://TAILSCALE_IP:8787/api/events \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGENT_OPS_TOKEN" \
  -d '{"agent":"system","type":"notification","message":"remote write test","raw":{}}'
```

Send input to a specific tmux session:

```bash
curl -X POST http://127.0.0.1:8787/api/sessions/codex-pilot/input \
  -H 'content-type: application/json' \
  -d '{"text":"continue","submit":true}'
```

From a browser over Tailscale, this endpoint requires `AGENT_OPS_TOKEN` and `ENABLE_AGENT_INPUT=true`.

## Claude Code Hook

Make the hook executable:

```bash
chmod +x /home/ubuntu/apps/agent-ops/scripts/hook-claude-notify.sh
```

Example `~/.claude/settings.json` notification hook:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/home/ubuntu/apps/agent-ops/scripts/hook-claude-notify.sh"
          }
        ]
      }
    ]
  }
}
```

The script reads stdin JSON, posts a `notification` event for `claude`, includes the raw payload, attaches the current tmux session when available, and exits `0` even if the local API is down.

## Codex Hook

Make the hook executable:

```bash
chmod +x /home/ubuntu/apps/agent-ops/scripts/hook-codex-notify.sh
```

Codex hooks are registered and reviewed from Codex with `/hooks`. Add a command hook that runs:

```text
/home/ubuntu/apps/agent-ops/scripts/hook-codex-notify.sh
```

The script reads stdin, posts a `notification` event for `codex`, attaches the current tmux session when available, and marks it `completed` when the payload text looks like a completion/stop event. It exits `0` even if the local API is down.

## Slack Alert Test

After Slack alerting is configured:

```bash
curl -X POST http://127.0.0.1:8787/api/events \
  -H 'content-type: application/json' \
  -d '{"agent":"claude","type":"approval_required","message":"Do you want to proceed?","session":"claude-pilot","repoPath":"/home/ubuntu/apps/example","raw":{"source":"manual-test"}}'
```

Expected Slack alert:

```text
[Mukil's Dev Agent] Claude needs input

Agent: Claude
State: Needs input
Session: claude-pilot
Branch: branch-name
Repo: repo-name

What happened:
Do you want to proceed?
```

Secrets, token-like strings, and long logs are trimmed before sending.

## Slack Input

Reply-to-thread input requires Slack Socket Mode. Do not use a normal Slack slash command or interactive button unless you are willing to expose a public Slack endpoint.

Set these values in `/etc/agent-ops.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_ID=C0123456789
SLACK_SOCKET_MODE=true
ENABLE_AGENT_INPUT=true
```

Then restart:

```bash
sudo systemctl restart agent-ops
```

Flow:

1. `agent-ops` posts each alert as its own top-level Slack message.
2. The app stores that message's Slack thread ID in SQLite.
3. You reply in that thread.
4. `agent-ops` receives the reply over Socket Mode.
5. The reply text is sent to the exact tmux session from that alert with Enter.

Safe options:

- Use the browser dashboard over Tailscale for input.
- Use Slack Socket Mode for reply-to-thread input.
- Use a deliberately public, signature-verified Slack relay only if you decide to relax the Tailscale-only rule.

## tmux Detection

The monitor treats recent pane output as `waiting_for_input` when it contains:

```text
Do you want to proceed?
Approve
Requires approval
Waiting for input
Continue?
Permission required
Allow this command?
Select an option
y/n
```

It treats output as `error` when it contains:

```text
error
failed
exception
```

If a discovered Claude/Codex session remains in `waiting_for_input` for more than `AGENT_WAIT_ALERT_SECONDS`, `agent-ops` stores an `approval_required` event and sends one Slack alert for that tmux session. The alert state resets when the pane output changes meaningfully or the agent resumes.

## systemd

Install and start the service:

```bash
cd /home/ubuntu/apps/agent-ops
npm install
npm run build
sudo scripts/install-systemd.sh
sudo nano /etc/agent-ops.env
sudo systemctl restart agent-ops
```

Check logs:

```bash
journalctl -u agent-ops -f
```

Service details:

- Unit: `/etc/systemd/system/agent-ops.service`
- Env file: `/etc/agent-ops.env`
- Working directory: `/home/ubuntu/apps/agent-ops`
- Start command: `npm run start`

## Acceptance Checks

```bash
cd /home/ubuntu/apps/agent-ops
npm install
npm run build
npm run typecheck
npm run start
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/status
curl http://127.0.0.1:8787/api/sessions
curl -X POST http://127.0.0.1:8787/api/events \
  -H 'content-type: application/json' \
  -d '{"agent":"system","type":"info","message":"storage test","raw":{}}'
curl http://127.0.0.1:8787/api/events
```

`GET /api/status` and `GET /api/sessions` return discovered tmux sessions. If no tmux server is running, they return empty session lists instead of failing.
