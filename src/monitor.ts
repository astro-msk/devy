import { envValue } from "./config.js";
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

export type WaitingTracker = {
  waitingSince: number | null;
  alerted: boolean;
  waitingKey: string | null;
};

/** The slice of a session the alert state machine looks at. */
export type WaitingObservation = Pick<ManagedSession, "name" | "agent" | "state" | "lastOutput" | "paneCurrentPath">;

const POLL_INTERVAL_MS = 7000;
const HOOK_SUPPRESS_MS = 120000;

let cachedStatuses: AgentStatus[] = [];
let cachedSessions: ManagedSession[] = [];
let pollTimer: NodeJS.Timeout | null = null;
let pollInFlight = false;
const trackers = new Map<string, WaitingTracker>();
const hookSuppressUntil = new Map<string, number>();

export function startMonitor(): void {
  if (pollTimer) return;
  void safePoll();
  pollTimer = setInterval(() => void safePoll(), POLL_INTERVAL_MS);
}

// A poll that throws (SQLite busy, tmux wedged) used to surface as an
// unhandled rejection, which Node turns into a process exit. A slow poll used
// to overlap with the next tick; now a tick is skipped instead.
async function safePoll(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await pollAgents();
  } catch (error) {
    console.warn(`[Devy] monitor poll failed: ${(error as Error).message}`);
  } finally {
    pollInFlight = false;
  }
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
  if (agent === "claude") return envValue("CLAUDE_TMUX_SESSION");
  if (agent === "codex") return envValue("CODEX_TMUX_SESSION");
  return "system";
}

export async function recordEvent(input: EventInput): Promise<void> {
  const event = createEvent(input);
  const session = sessionForEvent(input, event);
  if (isAgentName(input.agent) && isAlertType(input.type)) {
    hookSuppressUntil.set(session, Date.now() + HOOK_SUPPRESS_MS);
  }
  // The event is durable once createEvent returns; Slack delivery is a side
  // effect that must not hold up the hook script's 2-second curl or the
  // monitor loop, and its failure must not reject the caller.
  sendSlackAlert(event, session, repoPathForEvent(input, event)).catch((error) => {
    console.warn(`[Devy] Slack alert for event ${event.id} failed: ${(error as Error).message}`);
  });
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

  const alerts = detectWaitingAlerts(sessions, {
    trackers,
    suppressUntil: hookSuppressUntil,
    now: Date.now(),
    waitMs: waitAlertMs()
  });
  for (const alert of alerts) {
    // One bad event (say, SQLite briefly locked) must not skip the rest.
    try {
      await recordEvent(alert);
    } catch (error) {
      console.warn(`[Devy] could not record waiting alert for ${alert.session}: ${(error as Error).message}`);
    }
  }
}

export type WaitingAlertState = {
  /** Per-session debounce state; mutated in place. */
  trackers: Map<string, WaitingTracker>;
  /** Sessions whose own hook already alerted; the monitor stays quiet until the timestamp. */
  suppressUntil: Map<string, number>;
  now: number;
  waitMs: number;
};

/**
 * The alert state machine, separated from tmux and SQLite so it can be driven
 * with fake sessions and a fake clock. A session that has shown the same
 * prompt (same reason + same screen hash) for longer than `waitMs` yields one
 * approval_required event; a changed prompt re-arms it, leaving the waiting
 * state resets it, and a vanished session drops its tracker.
 */
export function detectWaitingAlerts(sessions: WaitingObservation[], state: WaitingAlertState): EventInput[] {
  const { trackers: trackerMap, suppressUntil, now, waitMs } = state;
  const alerts: EventInput[] = [];
  const activeSessionNames = new Set(sessions.map((session) => session.name));

  for (const session of sessions) {
    const tracker = trackerFor(trackerMap, session.name);
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
    if (tracker.alerted || now - tracker.waitingSince <= waitMs) continue;

    tracker.alerted = true;
    if ((suppressUntil.get(session.name) || 0) > now) continue;

    const agentValue: EventAgent = isAgentName(session.agent) ? session.agent : "system";
    alerts.push({
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
    });
  }

  for (const sessionName of trackerMap.keys()) {
    if (!activeSessionNames.has(sessionName)) trackerMap.delete(sessionName);
  }
  for (const [sessionName, until] of suppressUntil) {
    if (until <= now) suppressUntil.delete(sessionName);
  }
  return alerts;
}

function repoPath(): string {
  return envValue("REPO_PATH") || process.cwd();
}

function waitAlertMs(): number {
  return envValue("AGENT_WAIT_ALERT_SECONDS") * 1000;
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

function trackerFor(trackerMap: Map<string, WaitingTracker>, session: string): WaitingTracker {
  const existing = trackerMap.get(session);
  if (existing) return existing;
  const tracker = { waitingSince: null, alerted: false, waitingKey: null };
  trackerMap.set(session, tracker);
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
