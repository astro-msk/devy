import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalDirectory = process.cwd();
const testDirectory = await mkdtemp(path.join(os.tmpdir(), "devy-db-"));
process.chdir(testDirectory);
// Dynamic import is intentional: db.ts binds its SQLite path from cwd during module initialization.
const {
  appendSlackChatTurn,
  connectionSettings,
  createEvent,
  createSlackTriage,
  finishSlackTriage,
  getRecentEvents,
  getSlackThread,
  getSlackTriageById,
  listSlackChatTurns,
  pruneOldRecords,
  saveSlackThread
} = await import("./db.js");
const Database = (await import("better-sqlite3")).default;

after(async () => {
  process.chdir(originalDirectory);
  await rm(testDirectory, { recursive: true, force: true });
});

// Retention is wall-clock driven; backdate rows through a second connection
// instead of waiting, which also proves a concurrent connection can write.
function backdate(table: string, column: string, id: number, days: number): void {
  const handle = new Database(path.join(testDirectory, "data", "agent-ops.sqlite"));
  handle.pragma("busy_timeout = 5000");
  handle.prepare(`UPDATE ${table} SET ${column} = datetime('now', ?) WHERE id = ?`).run(`-${days} days`, id);
  handle.close();
}

test("opens in WAL mode with a busy timeout for the second process", () => {
  const settings = connectionSettings();
  assert.equal(settings.journalMode, "wal");
  assert.equal(settings.busyTimeoutMs, 5000);
  assert.equal(settings.synchronous, 1, "synchronous=NORMAL");
});

test("prunes old events and their Slack threads but keeps recent and pending rows", () => {
  const old = createEvent({ agent: "claude", type: "notification", message: "old", session: "claude-old" });
  const fresh = createEvent({ agent: "codex", type: "completed", message: "fresh" });
  backdate("events", "created_at", old.id, 91);

  saveSlackThread({ channelId: "C1", threadTs: "1.0", agent: "claude", session: "claude-old", eventId: old.id });
  saveSlackThread({ channelId: "C1", threadTs: "2.0", agent: "codex", session: "codex", eventId: fresh.id });
  // A thread whose event is already gone is dead weight even if it is recent.
  saveSlackThread({ channelId: "C1", threadTs: "3.0", agent: "codex", session: "codex", eventId: 999999 });

  appendSlackChatTurn("D1", "im", "user", "old turn");
  appendSlackChatTurn("D1", "im", "user", "fresh turn");
  const oldTurnId = 1;
  backdate("slack_chat_turns", "created_at", oldTurnId, 91);

  const done = createSlackTriage({ sourceChannelId: "C1", sourceMessageTs: "10.0", sourceUserId: "U1", sourceText: "done" }).record;
  finishSlackTriage(done.id, "completed", "delivered");
  backdate("slack_triage", "updated_at", done.id, 91);
  const pending = createSlackTriage({ sourceChannelId: "C1", sourceMessageTs: "11.0", sourceUserId: "U1", sourceText: "pending" }).record;
  backdate("slack_triage", "updated_at", pending.id, 91);

  const dropped = pruneOldRecords(90);
  assert.deepEqual(dropped, { events: 1, slackThreads: 2, slackChatTurns: 1, slackTriage: 1 });

  const remaining = getRecentEvents(10).map((event) => event.message);
  assert.deepEqual(remaining, ["fresh"]);
  assert.equal(getSlackThread("C1", "1.0"), null);
  assert.equal(getSlackThread("C1", "3.0"), null);
  assert.ok(getSlackThread("C1", "2.0"));
  assert.deepEqual(listSlackChatTurns("D1", "im", 10).map((turn) => turn.text), ["fresh turn"]);
  assert.equal(getSlackTriageById(done.id), null);
  assert.equal(getSlackTriageById(pending.id)?.status, "analyzing", "a non-terminal triage is never pruned");

  // Idempotent: a second sweep finds nothing.
  assert.deepEqual(pruneOldRecords(90), { events: 0, slackThreads: 0, slackChatTurns: 0, slackTriage: 0 });
});

test("the retention window is never shorter than one day", () => {
  const event = createEvent({ agent: "system", type: "info", message: "keep me" });
  assert.equal(pruneOldRecords(0).events, 0);
  assert.ok(getRecentEvents(10).some((item) => item.id === event.id));
});
