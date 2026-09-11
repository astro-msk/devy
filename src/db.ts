import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type EventAgent = "claude" | "codex" | "system";
export type EventType = "notification" | "approval_required" | "completed" | "error" | "info";

export type EventInput = {
  agent: EventAgent;
  type: EventType;
  message: string;
  session?: string;
  repoPath?: string;
  raw?: unknown;
};

export type EventRecord = {
  id: number;
  agent: EventAgent;
  type: EventType;
  message: string;
  raw: unknown;
  createdAt: string;
};

export type SlackThread = {
  channelId: string;
  threadTs: string;
  agent: EventAgent;
  session: string;
  eventId: number;
};

export type SlackTriageStatus =
  | "analyzing"
  | "awaiting_approval"
  | "approved"
  | "building"
  | "completed"
  | "dismissed"
  | "failed";

export type SlackTriageInput = {
  sourceChannelId: string;
  sourceMessageTs: string;
  sourceThreadTs?: string;
  sourceUserId: string;
  sourceText: string;
};

export type SlackTriageRecord = SlackTriageInput & {
  id: number;
  context: unknown;
  permalink: string | null;
  reportChannelId: string | null;
  reportThreadTs: string | null;
  status: SlackTriageStatus;
  analysis: unknown;
  result: string | null;
  prUrl: string | null;
  acknowledgedAt: string | null;
  lastPingAt: string | null;
  pingCount: number;
  createdAt: string;
  updatedAt: string;
};

const dataDir = path.resolve(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "agent-ops.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    raw_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);

  CREATE TABLE IF NOT EXISTS slack_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    agent TEXT NOT NULL,
    session TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(channel_id, thread_ts)
  );

  CREATE INDEX IF NOT EXISTS idx_slack_threads_lookup ON slack_threads(channel_id, thread_ts);

  CREATE TABLE IF NOT EXISTS slack_triage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_channel_id TEXT NOT NULL,
    source_message_ts TEXT NOT NULL,
    source_thread_ts TEXT,
    source_user_id TEXT NOT NULL,
    source_text TEXT NOT NULL,
    context_json TEXT,
    permalink TEXT,
    report_channel_id TEXT,
    report_thread_ts TEXT,
    status TEXT NOT NULL DEFAULT 'analyzing',
    analysis_json TEXT,
    result_text TEXT,
    pr_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_channel_id, source_message_ts)
  );

  CREATE INDEX IF NOT EXISTS idx_slack_triage_report
    ON slack_triage(report_channel_id, report_thread_ts);

  CREATE TABLE IF NOT EXISTS slack_chat_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_slack_chat_turns_thread
    ON slack_chat_turns(channel_id, thread_ts, id);
`);

// Added after the first release, so migrate in place.
const triageColumns = new Set(
  (db.prepare("PRAGMA table_info(slack_triage)").all() as { name: string }[]).map((column) => column.name)
);
if (!triageColumns.has("acknowledged_at")) db.exec("ALTER TABLE slack_triage ADD COLUMN acknowledged_at TEXT");
if (!triageColumns.has("last_ping_at")) db.exec("ALTER TABLE slack_triage ADD COLUMN last_ping_at TEXT");
if (!triageColumns.has("ping_count")) db.exec("ALTER TABLE slack_triage ADD COLUMN ping_count INTEGER NOT NULL DEFAULT 0");

const insertEvent = db.prepare(`
  INSERT INTO events (agent, type, message, raw_json)
  VALUES (@agent, @type, @message, @raw_json)
`);

const listEvents = db.prepare(`
  SELECT id, agent, type, message, raw_json, created_at
  FROM events
  ORDER BY id DESC
  LIMIT ?
`);

const upsertSlackThread = db.prepare(`
  INSERT INTO slack_threads (channel_id, thread_ts, agent, session, event_id)
  VALUES (@channelId, @threadTs, @agent, @session, @eventId)
  ON CONFLICT(channel_id, thread_ts) DO UPDATE SET
    agent = excluded.agent,
    session = excluded.session,
    event_id = excluded.event_id
`);

const selectSlackThread = db.prepare(`
  SELECT channel_id, thread_ts, agent, session, event_id
  FROM slack_threads
  WHERE channel_id = ? AND thread_ts = ?
`);

const insertSlackTriage = db.prepare(`
  INSERT OR IGNORE INTO slack_triage (
    source_channel_id,
    source_message_ts,
    source_thread_ts,
    source_user_id,
    source_text
  ) VALUES (
    @sourceChannelId,
    @sourceMessageTs,
    @sourceThreadTs,
    @sourceUserId,
    @sourceText
  )
`);

const selectSlackTriageBySource = db.prepare(`
  SELECT *
  FROM slack_triage
  WHERE source_channel_id = ? AND source_message_ts = ?
`);

const selectSlackTriageByReport = db.prepare(`
  SELECT *
  FROM slack_triage
  WHERE report_channel_id = ? AND report_thread_ts = ?
`);

const selectSlackTriageById = db.prepare(`
  SELECT *
  FROM slack_triage
  WHERE id = ?
`);

export function createEvent(input: EventInput): EventRecord {
  const raw = normalizeRaw(input);
  const rawJson = raw === undefined ? null : JSON.stringify(raw).slice(0, 20000);
  const result = insertEvent.run({
    agent: input.agent,
    type: input.type,
    message: input.message.slice(0, 2000),
    raw_json: rawJson
  });

  return getEvent(Number(result.lastInsertRowid));
}

export function getRecentEvents(limit = 50): EventRecord[] {
  return listEvents.all(Math.min(Math.max(limit, 1), 200)).map(mapEventRow);
}

export function saveSlackThread(thread: SlackThread): void {
  upsertSlackThread.run(thread);
}

export function getSlackThread(channelId: string, threadTs: string): SlackThread | null {
  const row = selectSlackThread.get(channelId, threadTs);
  if (!row) return null;
  const thread = row as {
    channel_id: string;
    thread_ts: string;
    agent: EventAgent;
    session: string;
    event_id: number;
  };
  return {
    channelId: thread.channel_id,
    threadTs: thread.thread_ts,
    agent: thread.agent,
    session: thread.session,
    eventId: thread.event_id
  };
}

export function createSlackTriage(input: SlackTriageInput): { record: SlackTriageRecord; created: boolean } {
  const result = insertSlackTriage.run({
    ...input,
    sourceThreadTs: input.sourceThreadTs || null,
    sourceText: input.sourceText.slice(0, 4000)
  });
  const record = getSlackTriageBySource(input.sourceChannelId, input.sourceMessageTs);
  if (!record) throw new Error("Slack triage record was not stored");
  return { record, created: result.changes === 1 };
}

export function saveSlackTriageContext(id: number, context: unknown, permalink: string | null): void {
  db.prepare(`
    UPDATE slack_triage
    SET context_json = ?, permalink = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(context).slice(0, 50000), permalink, id);
}

export function saveSlackTriageAnalysis(id: number, analysis: unknown): void {
  db.prepare(`
    UPDATE slack_triage
    SET analysis_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(analysis).slice(0, 50000), id);
}

export function saveSlackTriageReport(
  id: number,
  reportChannelId: string,
  reportThreadTs: string,
  status: SlackTriageStatus
): void {
  db.prepare(`
    UPDATE slack_triage
    SET report_channel_id = ?,
        report_thread_ts = ?,
        status = ?,
        last_ping_at = COALESCE(last_ping_at, datetime('now')),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(reportChannelId, reportThreadTs, status, id);
}

export function acknowledgeSlackTriage(id: number): boolean {
  const result = db.prepare(`
    UPDATE slack_triage
    SET acknowledged_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND acknowledged_at IS NULL
  `).run(id);
  return result.changes === 1;
}

export function listSlackTriageNeedingPing(quietMinutes: number): SlackTriageRecord[] {
  const rows = db.prepare(`
    SELECT * FROM slack_triage
    WHERE acknowledged_at IS NULL
      AND report_thread_ts IS NOT NULL
      AND status != 'dismissed'
      AND COALESCE(last_ping_at, updated_at) <= datetime('now', ?)
    ORDER BY id
  `).all(`-${Math.round(quietMinutes)} minutes`);
  return rows
    .map(mapSlackTriageRow)
    .filter((record): record is SlackTriageRecord => Boolean(record));
}

export function recordSlackTriagePing(id: number): void {
  db.prepare(`
    UPDATE slack_triage
    SET last_ping_at = datetime('now'), ping_count = ping_count + 1
    WHERE id = ?
  `).run(id);
}

export function getSlackTriageBySource(channelId: string, messageTs: string): SlackTriageRecord | null {
  return mapSlackTriageRow(selectSlackTriageBySource.get(channelId, messageTs));
}

export function getSlackTriageByReport(channelId: string, threadTs: string): SlackTriageRecord | null {
  return mapSlackTriageRow(selectSlackTriageByReport.get(channelId, threadTs));
}

export function getSlackTriageById(id: number): SlackTriageRecord | null {
  return mapSlackTriageRow(selectSlackTriageById.get(id));
}

export function listSlackTriageByStatus(statuses: SlackTriageStatus[]): SlackTriageRecord[] {
  if (!statuses.length) return [];
  const placeholders = statuses.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT * FROM slack_triage
    WHERE status IN (${placeholders})
    ORDER BY id
  `).all(...statuses);
  return rows
    .map(mapSlackTriageRow)
    .filter((record): record is SlackTriageRecord => Boolean(record));
}

export function transitionSlackTriage(
  id: number,
  from: SlackTriageStatus,
  to: SlackTriageStatus
): boolean {
  const result = db.prepare(`
    UPDATE slack_triage
    SET status = ?, updated_at = datetime('now')
    WHERE id = ? AND status = ?
  `).run(to, id, from);
  return result.changes === 1;
}

export function finishSlackTriage(
  id: number,
  status: Extract<SlackTriageStatus, "completed" | "failed" | "dismissed">,
  result: string,
  prUrl: string | null = null
): void {
  db.prepare(`
    UPDATE slack_triage
    SET status = ?, result_text = ?, pr_url = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, result.slice(0, 20000), prUrl, id);
}

export type SlackChatTurn = { role: "user" | "devy"; text: string };

export function appendSlackChatTurn(
  channelId: string,
  threadTs: string,
  role: SlackChatTurn["role"],
  text: string
): void {
  db.prepare(`
    INSERT INTO slack_chat_turns (channel_id, thread_ts, role, text)
    VALUES (?, ?, ?, ?)
  `).run(channelId, threadTs, role, text.slice(0, 20000));
}

export function listSlackChatTurns(channelId: string, threadTs: string, limit: number): SlackChatTurn[] {
  const rows = db.prepare(`
    SELECT role, text
    FROM slack_chat_turns
    WHERE channel_id = ? AND thread_ts = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(channelId, threadTs, limit) as { role: SlackChatTurn["role"]; text: string }[];
  return rows.reverse();
}

function mapSlackTriageRow(row: unknown): SlackTriageRecord | null {
  if (!row) return null;
  const value = row as {
    id: number;
    source_channel_id: string;
    source_message_ts: string;
    source_thread_ts: string | null;
    source_user_id: string;
    source_text: string;
    context_json: string | null;
    permalink: string | null;
    report_channel_id: string | null;
    report_thread_ts: string | null;
    status: SlackTriageStatus;
    analysis_json: string | null;
    result_text: string | null;
    pr_url: string | null;
    acknowledged_at: string | null;
    last_ping_at: string | null;
    ping_count: number | null;
    created_at: string;
    updated_at: string;
  };
  return {
    id: value.id,
    sourceChannelId: value.source_channel_id,
    sourceMessageTs: value.source_message_ts,
    sourceThreadTs: value.source_thread_ts || undefined,
    sourceUserId: value.source_user_id,
    sourceText: value.source_text,
    context: value.context_json ? safeJsonParse(value.context_json) : null,
    permalink: value.permalink,
    reportChannelId: value.report_channel_id,
    reportThreadTs: value.report_thread_ts,
    status: value.status,
    analysis: value.analysis_json ? safeJsonParse(value.analysis_json) : null,
    result: value.result_text,
    prUrl: value.pr_url,
    acknowledgedAt: value.acknowledged_at,
    lastPingAt: value.last_ping_at,
    pingCount: value.ping_count || 0,
    createdAt: value.created_at,
    updatedAt: value.updated_at
  };
}

function normalizeRaw(input: EventInput): unknown {
  if (!input.session && !input.repoPath) return input.raw;
  const raw: Record<string, unknown> = input.raw && typeof input.raw === "object" && !Array.isArray(input.raw)
    ? { ...(input.raw as Record<string, unknown>) }
    : { value: input.raw };
  if (input.session) raw.session = input.session;
  if (input.repoPath) raw.repoPath = input.repoPath;
  return raw;
}

function getEvent(id: number): EventRecord {
  const row = db
    .prepare("SELECT id, agent, type, message, raw_json, created_at FROM events WHERE id = ?")
    .get(id);
  if (!row) {
    throw new Error(`event ${id} was not stored`);
  }
  return mapEventRow(row);
}

function mapEventRow(row: unknown): EventRecord {
  const event = row as {
    id: number;
    agent: EventAgent;
    type: EventType;
    message: string;
    raw_json: string | null;
    created_at: string;
  };

  return {
    id: event.id,
    agent: event.agent,
    type: event.type,
    message: event.message,
    raw: event.raw_json ? safeJsonParse(event.raw_json) : null,
    createdAt: event.created_at
  };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
