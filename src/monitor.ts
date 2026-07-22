import type { EventAgent, EventInput } from "./db.js";
import type { EventType } from "./db.js";
import { createEvent } from "./db.js";
import type { GitStatus } from "./git.js";
import { listManagedSessions, simpleHash, type ManagedSession } from "./sessions.js";
import { sendSlackAlert } from "./slack.js";
import {
  extractWaitingPrompt,
  sendInputToSession,
  type AgentState,
  waitingReason,
  waitingReasonLabel
} from "./tmux.js";

export type AgentName = "claude" | "codex";

export type AgentStatus = {
  name: AgentName;
  tmuxSession: string;
  running: boolean;
  state: AgentState;
  lastOutput: string;
  lastActivity: string | null;
  repoPath: string;
  git: GitStatus;
};

type WaitingTracker = {
  waitingSince: number | null;
  alerted: boolean;
  waitingKey: string | null;
};

let cachedStatuses: AgentStatus[] = [];
let cachedSessions: ManagedSession[] = [];
let pollTimer: NodeJS.Timeout | null = null;
const trackers = new Map<string, WaitingTracker>();
const hookSuppressUntil = new Map<string, number>();

export function startMonitor(): void {
  if (pollTimer) return;
  void pollAgents();
  pollTimer = setInterval(() => void pollAgents(), 7000);
}

export async function getAgentStatuses(): Promise<AgentStatus[]> {
  cachedSessions = await listManagedSessions();
  cachedStatuses = agentStatusesFromSessions(cachedSessions);
  return cachedStatuses;
}

export function getCachedStatuses(): AgentStatus[] {
  return cachedStatuses;
}

export async function getObservedSessions(): Promise<ManagedSession[]> {
  cachedSessions = await listManagedSessions();
  cachedStatuses = agentStatusesFromSessions(cachedSessions);
  return cachedSessions;
}

export function sessionForAgent(agent: string): string {
  if (agent === "claude") return process.env.CLAUDE_TMUX_SESSION || "claude";
  if (agent === "codex") return process.env.CODEX_TMUX_SESSION || "codex";
  return "system";
}

export async function recordEvent(input: EventInput): Promise<void> {
  const event = createEvent(input);
  const session = sessionForEvent(input, event);
  if (isAgentName(input.agent) && isAlertType(input.type)) {
    hookSuppressUntil.set(session, Date.now() + 120000);
  }
  await sendSlackAlert(event, session, repoPathForEvent(input, event));
}

export async function sendAgentInput(agent: AgentName, text: string, submit: boolean, source: string): Promise<void> {
  const session = sessionForAgent(agent);
  await sendSessionInput(session, text, submit, source);
}

export async function sendSessionInput(session: string, text: string, submit: boolean, source: string): Promise<void> {
  await sendInputToSession(session, text, submit);
  const agent = eventAgentForSession(session);
  createEvent({
    agent,
    type: "info",
    message: `Input sent from ${source}${submit ? " and submitted" : ""}.`,
    raw: {
      source,
      session,
      repoPath: cachedSessions.find((item) => item.name === session)?.paneCurrentPath,
      submitted: submit,
      length: text.length
    }
  });
}

async function pollAgents(): Promise<void> {
  const sessions = await listManagedSessions();
  cachedSessions = sessions;
  cachedStatuses = agentStatusesFromSessions(sessions);
  const now = Date.now();
  const activeSessionNames = new Set(sessions.map((s) => s.name));

  for (const session of sessions) {
    const tracker = trackerForSession(session.name);
    if (session.state !== "waiting_for_input") {
      tracker.waitingSince = null;
      tracker.alerted = false;
      tracker.waitingKey = null;
      continue;
    }

    const reason = waitingReason(session.lastOutput);
    const key = `${reason || "waiting"}:${simpleHash(session.lastOutput)}`;
    if (tracker.waitingKey !== key) {
      tracker.waitingKey = key;
      tracker.alerted = false;
      tracker.waitingSince = now;
    }

    tracker.waitingSince ??= now;
    if (!tracker.alerted && now - tracker.waitingSince > waitAlertMs()) {
      if ((hookSuppressUntil.get(session.name) || 0) > now) {
        tracker.alerted = true;
        continue;
      }

      tracker.alerted = true;
      const agentValue: EventAgent = isAgentName(session.agent) ? session.agent : "system";
      const event: EventInput = {
        agent: agentValue,
        type: "approval_required",
        message: buildWaitingMessage(session.name, session.agent, reason, session.lastOutput),
        session: session.name,
        repoPath: session.paneCurrentPath,
        raw: {
          source: "tmux-monitor",
          session: session.name,
          tmuxAgent: session.agent,
          repoPath: session.paneCurrentPath,
          detectedAt: new Date(now).toISOString(),
          reason,
          outputPreview: session.lastOutput.slice(-1000)
        }
      };
      await recordEvent(event);
    }
  }

  for (const sessionName of trackers.keys()) {
    if (!activeSessionNames.has(sessionName)) trackers.delete(sessionName);
  }
}

function repoPath(): string {
  return process.env.REPO_PATH || process.cwd();
}

function waitAlertMs(): number {
  const seconds = Number(process.env.AGENT_WAIT_ALERT_SECONDS || 30);
  return Math.max(10, seconds) * 1000;
}

function agentLabel(agent: AgentName): string {
  return agent === "claude" ? "Claude" : "Codex";
}

function isAgentName(agent: string): agent is AgentName {
  return agent === "claude" || agent === "codex";
}

function isAlertType(type: EventType): boolean {
  return type === "approval_required" || type === "notification" || type === "error";
}

function buildWaitingMessage(sessionName: string, agent: string, reason: string | null, output: string): string {
  const prompt = extractWaitingPrompt(output);
  const reasonLabel = waitingReasonLabel(reason);
  const who = isAgentName(agent) ? agentLabel(agent) : `tmux:${sessionName}`;
  if (!prompt) return `${who} is waiting for input: ${reasonLabel}.`;
  return `${who} is waiting for input (${reasonLabel}): ${prompt}`;
}

function agentStatusesFromSessions(sessions: ManagedSession[]): AgentStatus[] {
  return sessions.filter(isAgentSession).map((session) => ({
    name: session.agent,
    tmuxSession: session.name,
    running: session.running,
    state: session.state,
    lastOutput: session.lastOutput,
    lastActivity: new Date().toISOString(),
    git: session.git,
    repoPath: session.paneCurrentPath
  }));
}

function isAgentSession(session: ManagedSession): session is ManagedSession & { agent: AgentName } {
  return isAgentName(session.agent);
}

function trackerForSession(session: string): WaitingTracker {
  const existing = trackers.get(session);
  if (existing) return existing;
  const tracker = { waitingSince: null, alerted: false, waitingKey: null };
  trackers.set(session, tracker);
  return tracker;
}

function eventAgentForSession(session: string): EventAgent {
  const cached = cachedSessions.find((item) => item.name === session);
  if (cached && isAgentName(cached.agent)) return cached.agent;
  const lower = session.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("codex")) return "codex";
  return "system";
}

function sessionForEvent(input: EventInput, event: { raw: unknown; agent: EventAgent }): string {
  return sessionFromRaw(input.raw) || sessionFromRaw(event.raw) || sessionForAgent(input.agent);
}

function repoPathForEvent(input: EventInput, event: { raw: unknown }): string {
  return pathFromRaw(input.raw) || pathFromRaw(event.raw) || repoPath();
}

function sessionFromRaw(raw: unknown): string | null {
  const value = objectRawValue(raw, "session");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pathFromRaw(raw: unknown): string | null {
  const value = objectRawValue(raw, "repoPath") || objectRawValue(raw, "repo_path") || objectRawValue(raw, "cwd");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectRawValue(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return (raw as Record<string, unknown>)[key];
}
