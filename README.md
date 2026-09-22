# Devy

Operations dashboard for Claude Code and Codex tmux sessions, provider routing, Slack triage, and approved code changes. Connect privately over Tailscale or through Cloudflare Access.

This MVP intentionally has no browser login of its own. Tailscale is the access layer. Do not expose ports `8787`, `8790` or `8791` to the public internet. The one supported public path is a Cloudflare Tunnel in front of Cloudflare Access, described in [Public access via Cloudflare Tunnel + Access](#public-access-via-cloudflare-tunnel--access).

## What It Does

- Serves a mobile-first PWA dashboard at `http://TAILSCALE_IP:8787`.
- Serves a separate multi-session PWA manager at `http://TAILSCALE_IP:8790`.
- Reads all tmux sessions with `tmux list-sessions`, `tmux capture-pane`, and `tmux list-panes`.
- Stores hook and monitor events in SQLite at `data/agent-ops.sqlite`.
- Polls discovered Claude/Codex tmux sessions every 7 seconds and creates an `approval_required` event if a waiting prompt lasts more than 10 seconds.
- Deduplicates monitor alerts per tmux session so parallel repos get separate alert state.
- Sends Slack webhook alerts for `approval_required`, `notification`, and `error`, including the source tmux session.
- Watches explicit references to Mukil in every Slack conversation the app can access, adds bounded local context, and reports urgency, relevance, recommended action, and code feasibility.
- Runs feasibility checks with Codex in a read-only sandbox; approved builds run in isolated git worktrees and stop at a review-ready pull request.
- Optionally sends text input to any observed tmux session when `ENABLE_AGENT_INPUT=true`.
- Exposes read APIs without login over Tailscale.
- Uses Cloudflare Access for public reads and writes, and `AGENT_OPS_TOKEN` for non-local Tailscale writes.

## Setup

```bash
cd /home/ubuntu/apps/devy
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
SLACK_USER_TOKEN=
SLACK_CHANNEL_ID=
SLACK_SOCKET_MODE=true
SLACK_WATCH_USER_ID=U0123456789
SLACK_WATCH_NAMES=
SLACK_OBSERVE_CHANNELS=
SLACK_TRIAGE_CHANNEL_ID=C0123456789
SLACK_CONTEXT_MESSAGES=12
DEVY_REPOSITORIES=Pilot=/home/ubuntu/work/repos/Pilot,Crucible=/home/ubuntu/work/repos/Crucible
ENABLE_AGENT_INPUT=false
ENABLE_AGENT_ALERTS=false
SLACK_LOG_LEVEL=info
AGENT_WAIT_ALERT_SECONDS=30
```

`SLACK_WEBHOOK_URL` may be empty. Alerts are skipped gracefully when neither webhook nor bot credentials are configured.

Use `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`, and `SLACK_SOCKET_MODE=true` for the better Slack flow: each alert is posted as a separate top-level message, and replies in that Slack thread are sent to the exact tmux session from the alert. This uses Slack Socket Mode, so no public inbound HTTP route is needed.

`ENABLE_AGENT_INPUT=false` keeps browser-to-tmux input and stop actions disabled on the main dashboard. Set it to `true` only if you want the dashboard to type into and manage tmux sessions. Cloudflare Access sign-in authorizes those controls directly. Over Tailscale, the dashboard prompts once for `AGENT_OPS_TOKEN` and stores it in browser local storage for write requests.

`CLAUDE_TMUX_SESSION` and `CODEX_TMUX_SESSION` are still used by the legacy `/api/agents/:agent/input` endpoint. Discovery and Slack monitoring use `tmux list-sessions`, so session names like `claude-pilot` and `codex-app-a` are picked up automatically.

`AGENT_WAIT_ALERT_SECONDS=30` means a Claude or Codex tmux session must look like it needs input for at least 30 seconds before the tmux fallback monitor sends an alert.

`ENABLE_AGENT_ALERTS=false` stops every legacy tmux/hook alert (`approval_required`, `notification`, `error`) from being posted to `SLACK_CHANNEL_ID`. Events are still recorded in SQLite and shown on the dashboard, and Devy reference triage reports are unaffected — they are a separate path. Use this when the alert channel is too noisy.

`SLACK_LOG_LEVEL` sets the Bolt log level: `info` (default), `debug`, `warn`, `error`. `debug` writes full Slack payloads, including message text, to the journal; enable it only while diagnosing event delivery, then set it back.

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
chmod +x /home/ubuntu/apps/devy/scripts/hook-claude-notify.sh
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
            "command": "/home/ubuntu/apps/devy/scripts/hook-claude-notify.sh"
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
chmod +x /home/ubuntu/apps/devy/scripts/hook-codex-notify.sh
```

Codex hooks are registered and reviewed from Codex with `/hooks`. Add a command hook that runs:

```text
/home/ubuntu/apps/devy/scripts/hook-codex-notify.sh
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
[Devy] Claude needs input

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

1. Devy posts each alert as its own top-level Slack message.
2. The app stores that message's Slack thread ID in SQLite.
3. You reply in that thread.
4. Devy receives the reply over Socket Mode.
5. The reply text is sent to the exact tmux session from that alert with Enter.

Safe options:

- Use the browser dashboard over Tailscale for input.
- Use Slack Socket Mode for reply-to-thread input.
- Use a deliberately public, signature-verified Slack relay only if you decide to relax the Tailscale-only rule.

## Slack Reference Triage and Approved Builds

Set `SLACK_WATCH_USER_ID` to Mukil's Slack member ID and `SLACK_TRIAGE_CHANNEL_ID` to the private channel where Devy should post reports. `SLACK_CHANNEL_ID` is used when the dedicated triage channel is unset.

What Devy acts on, in order of narrowness:

- a DM to Devy from `SLACK_WATCH_USER_ID`;
- an explicit `<@SLACK_WATCH_USER_ID>` reference written by someone else;
- a bare textual name, **only** if you opt in by listing it in `SLACK_WATCH_NAMES` (comma-separated, whole-word, case-insensitive). Empty by default because it is a much wider net.

`SLACK_OBSERVE_CHANNELS` further confines Devy to a comma-separated allowlist of channel IDs. Empty means every channel your Slack event subscriptions deliver. DMs to Devy are always honoured.

Everything else is dropped in the handler: it is never stored, never sent to Codex, and never logged. Only a message that triggers a triage is persisted (its text, up to `SLACK_CONTEXT_MESSAGES` surrounding messages, and the analysis) in `data/agent-ops.sqlite`.

### Talking to Devy

DM Devy, or `@Devy` in a channel and keep replying in that thread, and it answers conversationally like an agent: read-only Codex against the configured repositories, with the last `SLACK_CHAT_HISTORY_TURNS` turns of that conversation as context. In a DM the whole conversation is one context; in a channel each thread is its own context. Replies cite the files it actually read.

Chat is the default for anything you send it. A message that explicitly asks for work — `can you add …`, `please implement …` — routes to the approval-gated triage path instead and comes back with *Approve build* / *Reject* buttons, so conversation can never silently turn into a code change. Turns are stored in `slack_chat_turns` in `data/agent-ops.sqlite`.

```bash
SLACK_CHAT_HISTORY_TURNS=20
SLACK_CHAT_TIMEOUT_SECONDS=300
```

### Acknowledgements

Every report Devy posts must be acknowledged. While one is unacknowledged, Devy re-pings it in its thread every `SLACK_ACK_REMINDER_MINUTES` (default 30), mentioning you and broadcasting the reminder to the channel so it is not buried in an unopened thread. The reminder is numbered, so `Reminder 4` means it has waited two hours.

A report counts as acknowledged when you press *Acknowledge*, reply `ack` (also `ok`, `got it`, `noted`, `thanks`), approve or reject a build, or reply anything at all in that thread — replying means you saw it. Acknowledging is idempotent, and a dismissed triage is never pinged.

```bash
SLACK_ACK_REMINDER_MINUTES=30
```

Use two Slack identities:

- The Devy bot token posts reports, receives direct `@Devy` commands, and handles approval buttons. The bot does not need to join every monitored channel.
- A user token authorized by Mukil receives workspace/user message events and reads context with Mukil's visibility. Treat this `xoxp-...` token as a secret.

Under **OAuth & Permissions → Bot Token Scopes**, add:

- `app_mentions:read`
- `chat:write`
- `im:history` for direct messages to Devy

Under **OAuth & Permissions → User Token Scopes**, add:

- `channels:history`
- `groups:history`
- `im:history`
- `mpim:history`

Under **Event Subscriptions → Subscribe to bot events**, add `app_mention` and `message.im`. Under **Subscribe to events on behalf of users** (called **Workspace Events** in current Slack documentation), add:

- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

Enable **Interactivity & Shortcuts**, then reinstall the Slack app as the watched user after changing scopes or event subscriptions. Copy the resulting **User OAuth Token** to `SLACK_USER_TOKEN` in `/etc/agent-ops.env`; never paste the token into chat. Restart the service with `sudo systemctl restart agent-ops`.

User-scoped events cover public channels visible to Mukil plus private channels, DMs, and group DMs that Mukil can access. They do not expose private conversations Mukil cannot access. This removes the requirement to invite the Devy bot to every channel while preserving Slack's authorization boundary.

For every message from another user containing either the exact Slack reference `<@SLACK_WATCH_USER_ID>` or a whole-word name from `SLACK_WATCH_NAMES`, Devy fetches up to `SLACK_CONTEXT_MESSAGES` preceding messages from the same channel, or the containing thread when the reference is threaded. It then runs Codex with a read-only sandbox against the configured repositories and posts:

- urgency independent of whether the request belongs to Mukil;
- relevance and its reason;
- recommended action;
- repository and feasibility;
- implementation ideas and risks.

Mukil can also DM Devy or mention `@Devy` with a question. A build request produces *Approve build* and *Reject* controls. Only `SLACK_WATCH_USER_ID` can approve. Approval creates an isolated worktree and `devy/slack-*` branch, runs Codex with workspace-only write access, commits and pushes the result, and opens a non-draft GitHub pull request with `gh`. Devy never merges. Text replies `approve`, `approve ID`, `reject`, or `reject ID` are accepted in the report thread as a fallback.

The service user needs working Codex and GitHub CLI authentication. `gh auth status` must show `repo` access. Optional controls:

```bash
SLACK_TRIAGE_TIMEOUT_SECONDS=600
SLACK_BUILD_TIMEOUT_SECONDS=3600
SLACK_CODEX_MODEL=
```

## Provider gateway

The loopback-only `agent-gateway` service listens on port 8791. Claude Code uses the Anthropic Messages protocol; Codex uses OpenAI Responses over HTTP streaming. Routes forward the client's request format and inject the selected API credential when needed. The gateway does not convert Claude conversations into Codex conversations.

Use **Gateway** to inspect accounts, run a real provider probe, choose defaults, order fallback routes, and switch a gateway-managed session between compatible providers. **Auto** retries eligible routes on rate limits or upstream failures before any response bytes reach the client; **Pinned** preserves the selected route and returns its error. A stream that fails after output starts is reported as failed and is not replayed on another provider.

New sessions default to an available gateway route. Select **Direct (no gateway)** explicitly to bypass it. Sessions already running outside the gateway cannot be redirected in place: create a routed session instead. Switching a subscription login also requires a new session, since the running CLI owns that login. Switching between API routes or from the launch subscription to an API route retains the same session.

**Live failover when a login runs out.** The gateway swaps API keys between requests, but it never forwards one subscription's token for another: the running CLI owns its claude.ai / ChatGPT login. So when that login hits its usage limit and the next provider in the lane's order is another subscription (say Claude personal → Claude business), Devy restarts the session instead of waiting for you: it stops the CLI, relaunches it in the same tmux window through the gateway with the other account's config dir, and resumes the same conversation (`claude --resume <id>` / `codex resume <id>`; Claude account dirs share `projects/`, Codex rollout files are copied). The supervisor in `src/failover.ts` polls every 10 s and acts when the session's screen shows the CLI's limit banner or the gateway log shows a 429 for it, provided gateway auto-switch is on and the session is not pinned; sessions started outside the gateway are moved onto it the same way. Each move is recorded as an event (and alerted to Slack), with a 10-minute per-session cooldown. `ENABLE_LIVE_FAILOVER=false` turns it off. The same restart is available by hand: the **Routing** page lists every session with a provider dropdown (options marked **restart** relaunch in place) and a **Restart** button, session cards have **Restart** too, and the API is `POST /api/sessions/:session/relaunch {route?}` (no route = same provider). `POST /api/gateway/adopt` moves every direct session onto the gateway; the supervisor does this by itself for sessions idle at their prompt. `POST /api/gateway/codex-server/restart` interrupts the Codex desktop app-server daemon so it reloads provider settings. The Terminal page renders the bare xterm screen with no input row or key bar; tap it to type on a phone. A session's gateway environment is now `export`ed in its shell, so a client re-typed in the fallback shell still goes through the gateway.

Changing a Gateway default now updates existing automatic gateway sessions on their next request. Pinned sessions retain their provider. Sessions using a different subscription account retain their working route and are listed as needing a reconnect. The result lists applied and skipped sessions, and **Apply default again** retries the operation even when the selected default has not changed. An in-flight response is allowed to finish.

Applying a compatible Codex default also connects the host's Codex configuration to the stable Devy gateway URL. The supported Codex config writer preserves the selected model, unrelated providers, comments, and login credentials; a recovery copy is saved as `~/.codex/config.toml.before-devy`. **Existing loaded desktop tasks need to reconnect once**: Codex snapshots the provider when it loads a task, and neither config reload nor rejoining an already loaded task changes its endpoint. Devy does not interrupt that task or restart the desktop server. Once the task uses the gateway, later compatible provider changes take effect on its next request. The connection panel distinguishes configuration from observed gateway traffic. See the [official Codex app-server documentation](https://learn.chatgpt.com/codex/app-server).

The default account directory may contain a personal or team login; its account detail shows the actual subscription. Additional logins have isolated directories under `~/.devy/accounts`. Missing logins are shown as unavailable. Azure requires `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_KEY`, and `AZURE_OPENAI_DEPLOYMENT`; Bedrock Mantle routes require `AWS_BEARER_TOKEN_BEDROCK`. Environment values stay in `/etc/agent-ops.env`, never in the repository. Current CLI provider fields are documented in the [official Codex configuration reference](https://developers.openai.com/codex/config-reference/).

Startup configuration is validated by `src/config.ts`; errors identify the variable to fix. `EVENT_RETENTION_DAYS` defaults to 90 for retained event/conversation history.

Account sign-in opens a temporary `login-*` terminal. Successful login closes that helper and returns the dashboard to Gateway; credentials stay in the account directory. A failed login keeps its error visible in the terminal. Ordinary agent sessions retain their shell when the agent exits.

For **Codex on Bedrock**, generate a Bedrock API key in the [AWS console](https://console.aws.amazon.com/bedrock/home?region=us-east-1) under **API keys**, then set `AWS_BEARER_TOKEN_BEDROCK`, `BEDROCK_REGION` (default `us-east-1`) and `BEDROCK_CODEX_MODEL` (default `openai.gpt-oss-120b`; on Bedrock Mantle only the gpt-oss models accept the Responses API that Codex speaks, the openai.gpt-5.x ids reject it) in `/etc/agent-ops.env`. The key needs permission for Mantle inference and bearer-token authentication. Restart `agent-gateway`, `agent-ops` and `agent-sessions`, test the route, and select **Codex on Bedrock** when creating a session. AWS bills this independently of a ChatGPT subscription. A pasted short-term key expires within 12 hours; this gateway does not yet refresh AWS credentials automatically. See [AWS key generation and refresh guidance](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) and the [Bedrock Responses API](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html).

## Public access via Cloudflare Tunnel + Access

Devy can be reached from a phone off the tailnet through a Cloudflare Tunnel, with Cloudflare Access doing the login. Nothing new is opened on the box: cloudflared makes an outbound connection to Cloudflare and forwards each public hostname to a loopback-only listener that Devy adds next to its tailnet ports.

| Public hostname | Tunnel target | Serves |
| --- | --- | --- |
| `devy.mukilsenthil.com` | `http://localhost:8797` (`TUNNEL_PORT`) | dashboard (`agent-ops`) |
| `sessions-devy.mukilsenthil.com` | `http://localhost:8798` (`MANAGER_TUNNEL_PORT`) | session manager (`agent-sessions`) |

The session manager is also available at `https://devy.mukilsenthil.com/remote/`, under the main hostname's existing Access application and certificate. Keep this hostname a single level below the zone apex: Universal SSL's `*.mukilsenthil.com` certificate does not cover nested names such as `sessions.devy.mukilsenthil.com`, and Chrome fails them with `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`.

How the origin treats those two listeners (`src/auth.ts`, `src/cf-access.ts`):

- Every connection accepted on 8797/8798 is marked as a tunnel connection at the socket level. It is never treated as localhost, even though cloudflared connects from `127.0.0.1`, and `cf-*` headers are never trusted on their own.
- Every request — `/api/health`, static files, API calls and the WebSocket terminal upgrade — is refused with `401` until the `Cf-Access-Jwt-Assertion` header carries a JWT that verifies against the team's JWKS (`https://<team>/cdn-cgi/access/certs`, cached, refetched on an unknown key id): RS256 signature, `aud` = `CF_ACCESS_AUD`, `iss` = `https://<team>`, required `exp`, and `nbf` when present. Cloudflare's Access policy determines who may enter. `CF_ACCESS_ALLOWED_EMAILS` is an optional additional local restriction; leave it blank to accept every identity Cloudflare authorizes for this application, including service identities without an email claim.
- Cloudflare Access login authorizes reads and writes, including the terminal, without an additional `AGENT_OPS_TOKEN`. Browser writes and WebSocket upgrades must come from the same origin. Writes through the tunnel are rate limited (120/minute per identity). The separate Tailscale listeners still require the write token for non-local writes.
- If `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` is missing, the tunnel listeners refuse everything and the service logs a warning at startup. The tailnet listeners on 8787/8790 keep their `TAILSCALE_ONLY` behaviour unchanged.

### Zero Trust dashboard

1. **Tunnel.** Zero Trust → *Networks* → *Tunnels* → *Create a tunnel* → *Cloudflared*. Name it `devy`. On *Install and run a connector*, copy the token from the command shown (the long string after `--token`). Do not run the command; the box uses the systemd unit below. Click *Next*.
2. **Public hostnames.** In the tunnel's *Public Hostname* tab add two entries:
   - Subdomain `devy`, domain `mukilsenthil.com`, service type `HTTP`, URL `localhost:8797`.
   - Subdomain `sessions.devy`, domain `mukilsenthil.com`, service type `HTTP`, URL `localhost:8798`.
   Cloudflare creates the DNS records. No local `config.yml`, `cert.pem` or `cloudflared tunnel login` is involved.
3. **Access application.** Zero Trust → *Access* → *Applications* → *Add an application* → *Self-hosted*. Name it `Devy`, add both public hostnames (`devy.mukilsenthil.com` and `sessions-devy.mukilsenthil.com`) so they share one application, pick a session duration.
4. **Policy.** Add a policy with action **Allow**, include rule *Emails* = `mukil@noso.so`. Keep at least one login method enabled (One-time PIN is enough). Save the application.
5. **Copy the two values the origin needs.** Open the application → *Overview* (Basic information) and copy the **Application Audience (AUD) Tag**. The **team domain** is under Zero Trust → *Settings* → *Custom Pages* and looks like `<team>.cloudflareaccess.com`.

### Environment

Add to `/etc/agent-ops.env` (values only there, never in the repo):

```bash
CLOUDFLARE_TUNNEL_TOKEN=<token copied in step 1>
CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
CF_ACCESS_AUD=<AUD tag copied in step 5>
# Optional additional restriction; blank trusts Cloudflare's policy.
CF_ACCESS_ALLOWED_EMAILS=
# optional, these are the defaults
TUNNEL_PORT=8797
MANAGER_TUNNEL_PORT=8798
```

### cloudflared on the box

`cloudflared` comes from Cloudflare's apt repository (`https://pkg.cloudflare.com/cloudflared`, signed with the key in `/usr/share/keyrings/cloudflare-main.gpg`). The unit `systemd/cloudflared.service` runs `cloudflared tunnel --no-autoupdate run` with the token taken from `CLOUDFLARE_TUNNEL_TOKEN` in `/etc/agent-ops.env` (passed as `TUNNEL_TOKEN` in the environment so it does not show up in `ps`). `scripts/install-systemd.sh` installs the unit but leaves it disabled.

```bash
scripts/cloudflare-tunnel.sh status    # unit state, which CF vars are set (names only), 8797/8798 listening?
scripts/cloudflare-tunnel.sh enable    # preflight, then systemctl enable --now cloudflared
scripts/cloudflare-tunnel.sh start|stop|disable|logs
```

### Go-live order

1. Deploy this code: `npm ci && npm run build`, then `sudo systemctl restart agent-ops agent-sessions`. The journal should show `tunnel listener on http://127.0.0.1:8797` (and 8798) and, once the variables are in place, `Cloudflare Access enforced on tunnel listener`.
2. Do the dashboard steps above and add the environment lines; restart `agent-ops` and `agent-sessions` again so they pick up `CF_ACCESS_*`.
3. Confirm the origin fails closed before anything is public: `curl -i http://127.0.0.1:8797/api/health` must return `401` with `"cloudflare access required"`, and so must `curl -i -H 'cf-access-authenticated-user-email: mukil@noso.so' http://127.0.0.1:8797/`.
4. `scripts/cloudflare-tunnel.sh enable`. The tunnel shows *Healthy* in Zero Trust → Networks → Tunnels within a minute.
5. From a phone with Tailscale off, open `https://devy.mukilsenthil.com`: Cloudflare Access asks for the email and a one-time code, then the dashboard and its controls work without another token. Open `/remote/` for the quick session manager. An unauthenticated `curl -i https://devy.mukilsenthil.com/api/health` must answer with a `302` to the Access login page, never with `200`.

To take the public path down again: `scripts/cloudflare-tunnel.sh disable`. The tailnet listeners are unaffected either way.

### A 502 after successful Access login

The published application's **service type must be HTTP**, with URL `localhost:8797` (or `localhost:8798` for the separate manager). These loopback listeners do not speak TLS. Configuring `https://localhost:8797` produces a Cloudflare 502 and the connector logs `tls: first record does not look like a TLS handshake`. Change the tunnel route to HTTP and save it; Cloudflare still serves HTTPS to the browser. This dashboard-managed route update takes effect without restarting Devy.

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
cd /home/ubuntu/apps/devy
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
- Working directory: `/home/ubuntu/apps/devy`
- Start command: `npm run start`

## Acceptance Checks

`npm run test:ui` checks the running dashboard's Gateway buttons, Cloudflare token-free settings, completed-login navigation and reply draft preservation at phone and desktop sizes. API writes and terminal sockets are intercepted. It defaults to `http://127.0.0.1:8787`; override with `DEVY_TEST_URL`, and set `DEVY_TEST_BROWSER` to a Chromium executable if Playwright's bundled browser is unavailable.

```bash
cd /home/ubuntu/apps/devy
npm install
npm run build
npm run typecheck
npm test
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
