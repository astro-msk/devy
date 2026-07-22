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
`);

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
