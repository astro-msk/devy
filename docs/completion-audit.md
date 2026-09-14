# Monitoring and Gateway UI verification

Source audit: 12 September 2026. This records implemented behavior and verification boundaries; the twelve ideas in [feature-opportunities.md](feature-opportunities.md) remain a proposed backlog.

## Automatic behavior

| Area | Verified behavior | Boundary |
| --- | --- | --- |
| Session monitoring | `src/server.ts` starts `startMonitor()` automatically. `src/monitor.ts` observes tmux every 7 seconds, skips overlapping polls, and catches poll failures. | This is terminal/session observation, not background provider probing. It does not automatically restart agents. |
| Waiting alerts | A stable waiting prompt produces one durable event after `AGENT_WAIT_ALERT_SECONDS` (30 seconds by default). Sessions are tracked separately; changed prompts re-arm, vanished sessions are removed, and recent hooks suppress duplicate alerts. | State is inferred from terminal output. Slack delivery also depends on the alert setting and configured transport. |
| Provider failover | Gateway-routed requests try compatible enabled routes on network failures, HTTP 429, and server errors. Key-based routes also retry authentication failures. Global auto-switch and session auto mode must permit fallbacks. | Retries happen before the response is relayed. An interrupted stream cannot safely switch providers midway; the client receives the stream failure. |
| Cooldown | Failed routes move behind warm routes. Numeric Retry-After, Anthropic unified reset and reset-after-seconds headers inform the delay, capped at 6 hours. | This is not an exact universal quota-reset scheduler. HTTP-date Retry-After is not parsed; cooling routes remain available as last-resort candidates. |
| Account and protocol identity | Claude and Codex lanes stay separate. Subscription fallback requires the session's original account; pinned sessions retain their selected provider. | A default change cannot replace a running process's login or turn a direct connection into gateway traffic. |
| Default changes | Existing compatible automatic gateway sessions follow the selected default on their next request. The result identifies updated sessions and sessions blocked by pinning/account requirements. The selected default can be reapplied. | In-flight requests finish on their existing route. Codex desktop configuration and already-loaded direct tasks have separate connection status; the UI reports reconnect requirements. |
| Provider health and usage | Live requests and explicit route tests update health and reported quota/token counters. | No periodic provider test timer was found in `src/gateway.ts` or `src/gateway-core.ts`. Missing quota headers do not prove unlimited capacity. |

No periodic paid model probes, agent restarts, Slack sends, or runtime configuration changes were performed for this audit.

## Browser regression coverage

`scripts/check-ui.mjs` runs against the local app with deterministic gateway/session fixtures, intercepted writes and closed terminal sockets. It checks both **390px** and **1440px** viewports:

- Cloudflare-authenticated Settings and manager pages do not request or send a stored write token.
- All four account sign-in buttons send exactly one request and open the returned terminal; completed login sessions return to Gateway.
- Changing a default reports the updated automatic session, identifies the pinned session that kept its provider, and shows Codex desktop reconnect/direct-task status.
- A busy default button prevents duplicate writes. Failed changes retain the prior default and show the error. The selected default can be reapplied.
- Failed inline replies preserve newer draft text.
- Manager route switching sends the intended session/route, and its creation dialog uses the current default.
- Settings, Gateway, Sessions, the expanded manager card and its creation dialog fit both widths without document overflow; neither width produces browser JavaScript errors.

Run with:

```bash
DEVY_TEST_BROWSER=/home/ubuntu/.local/bin/chromium npm run test:ui
```

Set `DEVY_TEST_ARTIFACTS` to an output directory to save screenshots. Browser checks verify the rendered UI contract, not real upstream credentials or a successful desktop reconnection. Provider/default behavior is additionally covered by hermetic fake-upstream tests in `src/gateway.test.ts`; waiting-alert behavior is covered in `src/monitor.test.ts`. The focused run passed **19 tests** on this audit date.

## Runtime observations

At inspection, `agent-ops`, `agent-sessions`, `agent-gateway` and `cloudflared` were all active. The preceding two hours of journal entries contained no matching error/warning entries for the three Devy services. Cloudflared recorded four entries at 20:10 UTC for two streams canceled remotely with error code 0. Those cancellations alone do not establish an origin outage; this sample contained no origin TLS mismatch or HTTP 502 evidence. Logs were inspected with error text only; credentials and request payloads were excluded from the report.

Source and browser checks do not by themselves prove that rebuilt backend code has been deployed. Deployment, service restarts and an authenticated public-path check remain integration responsibilities.
