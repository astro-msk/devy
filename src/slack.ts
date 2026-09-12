import os from "node:os";
import path from "node:path";
import { App, LogLevel } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { envValue } from "./config.js";
import { getSlackThread, saveSlackThread, type EventRecord } from "./db.js";
import { getGitStatus } from "./git.js";
import { redactSecrets } from "./redact.js";
import { registerDevySlackAgent } from "./slack-agent.js";

const alertTypes = new Set(["approval_required", "notification", "error"]);
const WEBHOOK_TIMEOUT_MS = 10_000;
let slackApp: App | null = null;
let slackStarted = false;

type SlackThreadMessage = {
  type: "message";
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
};

export function shouldAlert(type: string): boolean {
  if (!envValue("ENABLE_AGENT_ALERTS")) return false;
  return alertTypes.has(type);
}

export async function sendSlackAlert(event: EventRecord, session: string, repoPath: string): Promise<void> {
  const webhookUrl = envValue("SLACK_WEBHOOK_URL");
  const botToken = envValue("SLACK_BOT_TOKEN");
  const channelId = envValue("SLACK_CHANNEL_ID");
  if (!shouldAlert(event.type)) return;

  const git = await getGitStatus(repoPath);
  const agentLabel = labelForAgent(event.agent);
  const repoName = path.basename(repoPath) || os.hostname();
  const message = humanSlackMessage(event.message, event.type);
  const title = titleForEvent(agentLabel, event.type, session, repoName);
  const text = `[Devy] ${title}`;
  const blocks = buildAlertBlocks(title, event.type, agentLabel, session, git.branch, repoName, repoPath, message);

  if (botToken && channelId) {
    try {
      const app = ensureSlackApp();
      const result = await app.client.chat.postMessage({
        token: botToken,
        channel: channelId,
        text,
        attachments: [
          {
            color: colorForEvent(event.type),
            fallback: text,
            blocks
          }
        ],
        unfurl_links: false,
        unfurl_media: false
      });
      if (result.ok && result.ts && session && session !== "system") {
        saveSlackThread({
          channelId,
          threadTs: result.ts,
          agent: event.agent,
          session,
          eventId: event.id
        });
      }
      return;
    } catch (error) {
      console.warn(`Slack bot alert failed: ${(error as Error).message}`);
    }
  }

  if (!webhookUrl) return;
  try {
    // The Bolt client retries and honours Retry-After on its own; the raw
    // webhook needs at least a deadline so a stalled connection cannot hold
    // an alert delivery open indefinitely.
    const response = await fetch(webhookUrl, {
      method: "POST",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        attachments: [
          {
            color: colorForEvent(event.type),
            fallback: text,
            blocks
          }
        ]
      })
    });
    if (!response.ok) {
      console.warn(`Slack alert failed with HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn(`Slack alert skipped: ${(error as Error).message}`);
  }
}

export function startSlackInputListener(
  sendInput: (session: string, text: string, submit: boolean, source: string) => Promise<void>
): void {
  if (slackStarted) return;
  if (!envValue("SLACK_SOCKET_MODE")) {
    console.log("Slack Socket Mode listener disabled: SLACK_SOCKET_MODE is not true");
    return;
  }
  if (!envValue("SLACK_APP_TOKEN") || !envValue("SLACK_BOT_TOKEN")) {
    console.warn("Slack Socket Mode listener disabled: SLACK_APP_TOKEN or SLACK_BOT_TOKEN missing");
    return;
  }
  if (!envValue("ENABLE_AGENT_INPUT")) {
    console.warn("Slack Socket Mode listener active but ENABLE_AGENT_INPUT is not true — thread replies will be rejected at the tmux layer.");
  }

  const app = ensureSlackApp();
  registerDevySlackAgent(app);
  app.message(async ({ message, say }) => {
    const userMessage = asGenericUserMessage(message);
    if (!userMessage) return;
    if (!userMessage.thread_ts || userMessage.thread_ts === userMessage.ts) return;
    if (!userMessage.text?.trim()) return;

    const thread = getSlackThread(userMessage.channel, userMessage.thread_ts);
    if (!thread) {
      console.log(`Slack thread ${userMessage.channel}/${userMessage.thread_ts} has no agent-ops mapping — ignoring`);
      return;
    }

    const cleaned = cleanSlackMessageText(userMessage.text);
    if (!cleaned) {
      await say({ thread_ts: userMessage.thread_ts, text: "Empty after sanitization — nothing sent." }).catch(() => {});
      return;
    }

    try {
      await sendInput(thread.session, cleaned, true, "slack-thread");
      const preview = cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned;
      await say({
        thread_ts: userMessage.thread_ts,
        text: `:white_check_mark: Sent to \`${thread.session}\` (${cleaned.length} chars): \`${preview.replaceAll("`", "ʼ")}\``
      });
    } catch (error) {
      await say({
        thread_ts: userMessage.thread_ts,
        text: `:warning: Could not send to \`${thread.session}\`: ${(error as Error).message}`
      });
    }
  });

  app
    .start()
    .then(() => console.log("Slack Socket Mode listener started"))
    .catch((error) => console.warn(`Slack Socket Mode listener failed: ${(error as Error).message}`));
  slackStarted = true;
}

export function cleanSlackMessageText(text: string): string {
  let s = text;
  // <@U12345> → "" (drop user mentions — Claude/Codex don't want a stray @user token)
  s = s.replace(/<@[UW][A-Z0-9]+(?:\|[^>]+)?>/g, (match) => {
    const labelMatch = match.match(/\|([^>]+)>/);
    return labelMatch ? `@${labelMatch[1]}` : "";
  });
  // <#C12345|channel> → #channel
  s = s.replace(/<#C[A-Z0-9]+\|([^>]+)>/g, "#$1");
  // <!subteam^S123|name> → @name
  s = s.replace(/<![a-z]+\^[A-Z0-9]+\|([^>]+)>/g, "@$1");
  // <!here>, <!channel>, <!everyone> → ""
  s = s.replace(/<![a-z]+>/g, "");
  // <http://example.com|label> → label (http://example.com)
  s = s.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)");
  // <http://example.com>
  s = s.replace(/<(https?:\/\/[^>]+)>/g, "$1");
  // <mailto:x@y|x@y>
  s = s.replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1");
  // Slack HTML entities
  s = s.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  // Strip leading mentions like "@bot " left over
  s = s.replace(/^\s*@\S+\s*/, "");
  return s.trim();
}

function resolveSlackLogLevel(): LogLevel {
  const requested = envValue("SLACK_LOG_LEVEL");
  if (requested === "debug") return LogLevel.DEBUG;
  if (requested === "warn") return LogLevel.WARN;
  if (requested === "error") return LogLevel.ERROR;
  return LogLevel.INFO;
}

function ensureSlackApp(): App {
  if (!slackApp) {
    slackApp = new App({
      token: envValue("SLACK_BOT_TOKEN"),
      appToken: envValue("SLACK_APP_TOKEN"),
      socketMode: envValue("SLACK_SOCKET_MODE"),
      logLevel: resolveSlackLogLevel()
    });
  }
  return slackApp;
}

function buildAlertBlocks(
  title: string,
  type: string,
  agentLabel: string,
  session: string,
  branch: string,
  repoName: string,
  repoPath: string,
  message: string
): KnownBlock[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: title,
        emoji: true
      }
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `:desktop_computer: \`${slackEscape(session)}\` · :open_file_folder: *${slackEscape(repoName)}* (\`${slackEscape(branch)}\`) · :robot_face: ${slackEscape(agentLabel)}` }
      ]
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*tmux session:*\n\`${slackEscape(session)}\`` },
        { type: "mrkdwn", text: `*State:*\n${slackEscape(displayType(type))}` },
        { type: "mrkdwn", text: `*Project:*\n${slackEscape(repoName)}` },
        { type: "mrkdwn", text: `*Branch:*\n\`${slackEscape(branch)}\`` },
        { type: "mrkdwn", text: `*Repo path:*\n\`${slackEscape(repoPath || "—")}\`` },
        { type: "mrkdwn", text: `*Host:*\n${slackEscape(os.hostname())}` }
      ]
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*What happened:*\n${slackEscape(message || "Open the dashboard for details.")}`
      }
    },
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:speech_balloon: Reply in this thread to send input to \`${slackEscape(session)}\`. Each alert starts its own thread, so replies always reach the right terminal.`
        }
      ]
    }
  ];
}

function labelForAgent(agent: string): string {
  if (agent === "claude") return "Claude";
  if (agent === "codex") return "Codex";
  if (agent === "system") return "System";
  return `tmux (${agent})`;
}

function titleForEvent(agentLabel: string, type: string, session: string, repoName: string): string {
  const where = `${session}@${repoName}`;
  if (type === "approval_required") return `${agentLabel} needs input · ${where}`;
  if (type === "error") return `${agentLabel} hit an error · ${where}`;
  return `${agentLabel} notification · ${where}`;
}

function colorForEvent(type: string): string {
  if (type === "error") return "#dc2626";
  if (type === "approval_required") return "#2563eb";
  return "#6b7280";
}

function slackEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function displayType(type: string): string {
  if (type === "approval_required") return "Needs input";
  if (type === "notification") return "Notification";
  if (type === "error") return "Error";
  return type;
}

function humanSlackMessage(message: string, type: string): string {
  const sanitized = sanitizeSnippet(message);
  if (looksLikeCodeDiff(sanitized) && !sanitized.toLowerCase().includes("waiting for input")) {
    return type === "approval_required"
      ? "The agent is paused and waiting for your input."
      : "The agent sent an update. Open the dashboard for the full pane output.";
  }
  return sanitized;
}

function looksLikeCodeDiff(value: string): boolean {
  return /(^|\s)[+-]\s*(function|const|let|var|return|import|export|class|type|interface)\b/.test(value)
    || /\b\d{1,4}\s+[+-]\s*/.test(value)
    || /⋮/.test(value);
}

function asGenericUserMessage(message: unknown): SlackThreadMessage | null {
  const candidate = message as Partial<SlackThreadMessage>;
  if (candidate.type !== "message" || candidate.subtype || candidate.bot_id) return null;
  if (!candidate.channel || !candidate.ts) return null;
  return candidate as SlackThreadMessage;
}

export function sanitizeSnippet(value: string): string {
  // Alerts quote raw tmux output, where a pasted key is likelier than in
  // prose, so the bare-token threshold is tighter than for Codex replies.
  return redactSecrets(value, { minTokenLength: 32 })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
