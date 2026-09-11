import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalDirectory = process.cwd();
const testDirectory = await mkdtemp(path.join(os.tmpdir(), "devy-slack-agent-"));
process.chdir(testDirectory);
// Dynamic import is intentional: db.ts binds its SQLite path from cwd during module initialization.
const {
  analyzeSlackReference,
  buildTriageBlocks,
  chatThreadKey,
  hasBuildIntent,
  isAcknowledgement,
  isWatchedReference,
  parseApprovalCommand,
  recoverInterruptedTriages,
  registerDevySlackAgent,
  sendDueAckReminders
} = await import("./slack-agent.js");
const {
  acknowledgeSlackTriage,
  createSlackTriage,
  finishSlackTriage,
  getSlackTriageByReport,
  getSlackTriageById,
  getSlackTriageBySource,
  listSlackTriageNeedingPing,
  saveSlackTriageAnalysis,
  saveSlackTriageReport,
  transitionSlackTriage
} = await import("./db.js");
const Database = (await import("better-sqlite3")).default;

// Reminder cadence is wall-clock driven; move the stored timestamp instead of
// sleeping so the test stays deterministic.
function ageLastPing(id: number, minutes: number): void {
  const handle = new Database(path.join(testDirectory, "data", "agent-ops.sqlite"));
  handle.prepare("UPDATE slack_triage SET last_ping_at = datetime('now', ?) WHERE id = ?").run(`-${minutes} minutes`, id);
  handle.close();
}

after(async () => {
  process.chdir(originalDirectory);
  await rm(testDirectory, { recursive: true, force: true });
});

test("matches explicit owner mentions always and textual names only when configured", () => {
  const message = {
    type: "message" as const,
    channel: "C123",
    ts: "1.0001",
    user: "UWINSTON",
    text: "Can <@UMUKIL> build this?"
  };
  assert.equal(isWatchedReference(message, "UMUKIL"), true);
  assert.equal(isWatchedReference({ ...message, user: "UMUKIL" }, "UMUKIL"), false);
  // No configured names: a bare textual name must be ignored.
  assert.equal(isWatchedReference({ ...message, text: "Mukil can build this" }, "UMUKIL"), false);
  assert.equal(isWatchedReference({ ...message, text: "Mukil can build this" }, "UMUKIL", ["mukil"]), true);
  assert.equal(isWatchedReference({ ...message, text: "mukilteo is unrelated" }, "UMUKIL", ["mukil"]), false);
  assert.equal(isWatchedReference({ ...message, text: "Ask M Rao" }, "UMUKIL", ["M Rao"]), true);
});

test("keeps a DM as one conversation and threads channel replies", () => {
  const base = { type: "message" as const, channel: "D123", ts: "5.0001", user: "UMUKIL", text: "hi" };
  assert.equal(chatThreadKey({ ...base, channel_type: "im" }), "im");
  assert.equal(chatThreadKey({ ...base, channel_type: "im", thread_ts: "4.0001" }), "im");
  assert.equal(chatThreadKey({ ...base, channel: "C123", channel_type: "channel" }), "5.0001");
  assert.equal(chatThreadKey({ ...base, channel: "C123", channel_type: "channel", thread_ts: "4.0001" }), "4.0001");
});

test("requires an exact approval tied to the report", () => {
  assert.equal(parseApprovalCommand("approve", 42), "approve");
  assert.equal(parseApprovalCommand("APPROVE 42", 42), "approve");
  assert.equal(parseApprovalCommand("approve 41", 42), null);
  assert.equal(parseApprovalCommand("please approve", 42), null);
  assert.equal(parseApprovalCommand("cancel", 42), "reject");
});

test("treats explicit build language as approval-gated intent", () => {
  assert.equal(hasBuildIntent("<@UMUKIL> can we build this product?"), true);
  assert.equal(hasBuildIntent("Could you add the queue endpoint?"), true);
  assert.equal(hasBuildIntent("Can you check whether this is possible?"), false);
  assert.equal(hasBuildIntent("FYI: the release shipped"), false);
});

test("deduplicates references and permits one approval transition", () => {
  const input = {
    sourceChannelId: "C123",
    sourceMessageTs: "2.0001",
    sourceUserId: "UWINSTON",
    sourceText: "Can <@UMUKIL> build this?"
  };
  const first = createSlackTriage(input);
  const duplicate = createSlackTriage(input);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);

  const analysis = { requestType: "build_request", repository: "Pilot", needsApproval: true };
  saveSlackTriageAnalysis(first.record.id, analysis);
  saveSlackTriageReport(first.record.id, "CREPORT", "3.0001", "awaiting_approval");
  const stored = getSlackTriageByReport("CREPORT", "3.0001");
  assert.deepEqual(stored?.analysis, analysis);
  assert.equal(transitionSlackTriage(first.record.id, "awaiting_approval", "approved"), true);
  assert.equal(transitionSlackTriage(first.record.id, "awaiting_approval", "approved"), false);
  finishSlackTriage(first.record.id, "dismissed", "test cleanup");
});

test("offers build controls only for an actionable build request", () => {
  const analysis = {
    urgency: "medium" as const,
    relevant: true,
    relevanceReason: "The request targets Pilot.",
    summary: "Add a queue health endpoint",
    recommendedAction: "Inspect the existing health routes and add the endpoint.",
    requestType: "build_request" as const,
    repository: "Pilot" as const,
    feasibility: "likely" as const,
    implementationIdeas: ["Reuse the existing health router."],
    risks: ["Confirm the queue client exposes a non-blocking check."],
    needsApproval: true
  };
  const buildBlocks = buildTriageBlocks(42, analysis, "https://example.slack.com/source");
  const actions = buildBlocks.find((block) => block.type === "actions");
  assert.ok(actions);
  assert.deepEqual(
    actions.elements.map((element) => ("action_id" in element ? element.action_id : null)),
    ["devy_approve_triage", "devy_reject_triage", "devy_ack_triage"]
  );

  // Every report is acknowledgeable; only a build request gets build controls.
  const reportBlocks = buildTriageBlocks(43, { ...analysis, requestType: "code_feasibility", needsApproval: false }, null);
  const reportActions = reportBlocks.find((block) => block.type === "actions");
  assert.ok(reportActions);
  assert.deepEqual(
    reportActions.elements.map((element) => ("action_id" in element ? element.action_id : null)),
    ["devy_ack_triage"]
  );
});

test("redacts credentials from Slack reports", () => {
  const blocks = buildTriageBlocks(
    44,
    {
      urgency: "high",
      relevant: true,
      relevanceReason: "authorization=xoxb-example-secret",
      summary: "token=xoxb-example-secret",
      recommendedAction: "Rotate ghp_FAKE_redaction_fixture",
      requestType: "action_required",
      repository: "none",
      feasibility: "not_applicable",
      implementationIdeas: [],
      risks: [],
      needsApproval: false
    },
    null
  );
  const serialized = JSON.stringify(blocks);
  assert.equal(serialized.includes("xoxb-example-secret"), false);
  assert.equal(serialized.includes("ghp_FAKE_redaction_fixture"), false);
  assert.match(serialized, /redacted/);
});

test(
  "runs a read-only codebase-aware triage",
  { skip: process.env.DEVY_RUN_CODEX_SMOKE !== "1", timeout: 900_000 },
  async () => {
    const analysis = await analyzeSlackReference(
      {
        id: 900001,
        sourceChannelId: "CSMOKE",
        sourceMessageTs: "1.000001",
        sourceUserId: "UWINSTON",
        sourceText: "<@UMUKIL> can we add a read-only endpoint in Pilot that reports whether the browser worker queue is healthy?",
        context: null,
        permalink: null,
        reportChannelId: null,
        reportThreadTs: null,
        status: "analyzing",
        analysis: null,
        result: null,
        prUrl: null,
        acknowledgedAt: null,
        lastPingAt: null,
        pingCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      [
        {
          type: "message",
          channel: "CSMOKE",
          ts: "1.000001",
          user: "UWINSTON",
          text: "<@UMUKIL> can we add a read-only endpoint in Pilot that reports whether the browser worker queue is healthy?"
        }
      ]
    );
    assert.equal(analysis.requestType, "build_request");
    assert.equal(analysis.repository, "Pilot");
    assert.equal(analysis.needsApproval, true);
    assert.notEqual(analysis.feasibility, "not_applicable");
    assert.ok(analysis.summary.length > 0);
  }
);

test(
  "produces Slack-valid triage blocks",
  { skip: process.env.DEVY_VALIDATE_SLACK_BLOCKS !== "1", timeout: 30_000 },
  async () => {
    const blocks = buildTriageBlocks(
      42,
      {
        urgency: "high",
        relevant: true,
        relevanceReason: "The request targets Pilot.",
        summary: "Add a queue health endpoint",
        recommendedAction: "Approve an isolated implementation branch.",
        requestType: "build_request",
        repository: "Pilot",
        feasibility: "likely",
        implementationIdeas: ["Reuse the existing health router."],
        risks: ["Confirm the queue client exposes a non-blocking check."],
        needsApproval: true
      },
      "https://example.slack.com/archives/C123/p123"
    );
    const body = new URLSearchParams({ blocks: JSON.stringify(blocks) });
    const response = await fetch("https://slack.com/api/blocks.validate", { method: "POST", body });
    const result = await response.json() as { ok?: boolean; error?: string; errors?: unknown[] };
    assert.equal(result.ok, true, JSON.stringify(result));
  }
);

test("observes only allowlisted channels and configured names", async () => {
  process.env.SLACK_WATCH_USER_ID = "UMUKIL";
  process.env.SLACK_TRIAGE_CHANNEL_ID = "CREPORT";
  process.env.SLACK_WATCH_NAMES = "mukil";
  process.env.SLACK_OBSERVE_CHANNELS = "CTEAM";
  delete process.env.SLACK_USER_TOKEN;

  type MessageHandler = (args: { message: unknown; client: unknown }) => Promise<void>;
  let messageHandler: MessageHandler | null = null;
  const app = {
    message: (handler: MessageHandler) => {
      messageHandler = handler;
    },
    event: () => undefined,
    action: () => undefined
  };
  registerDevySlackAgent(app as unknown as Parameters<typeof registerDevySlackAgent>[0]);
  const handle = messageHandler as MessageHandler | null;
  assert.ok(handle, "registration must install a message handler");

  const posts: string[] = [];
  let reported: (() => void) | null = null;
  const firstReport = new Promise<void>((resolve) => {
    reported = resolve;
  });
  const client = {
    conversations: {
      history: async () => ({ ok: false, error: "not_in_channel" }),
      replies: async () => ({ ok: false, error: "not_in_channel" })
    },
    chat: {
      getPermalink: async () => ({ ok: false }),
      postMessage: async (input: { text: string }) => {
        posts.push(input.text);
        reported?.();
        return { ok: true, ts: "9.0001" };
      }
    }
  };

  await handle({
    message: { type: "message", channel: "CTEAM", ts: "8.0001", user: "UWINSTON", text: "mukil should see this outage" },
    client
  });
  await handle({
    message: { type: "message", channel: "CTEAM", ts: "8.0002", user: "UWINSTON", text: "mukilteo shipped unrelated work" },
    client
  });
  // Same trigger word, channel outside the allowlist: must be ignored entirely.
  await handle({
    message: { type: "message", channel: "CPRIVATE", ts: "8.0003", user: "UWINSTON", text: "mukil should see this too" },
    client
  });
  await firstReport;

  const triage = getSlackTriageBySource("CTEAM", "8.0001");
  assert.ok(triage, "a configured textual name in an allowlisted channel must create a triage record");
  assert.equal(triage.status, "failed");
  assert.match(triage.result || "", /not_in_channel/);
  assert.equal(getSlackTriageBySource("CTEAM", "8.0002"), null);
  assert.equal(getSlackTriageBySource("CPRIVATE", "8.0003"), null);
  assert.equal(posts.length, 1);
  delete process.env.SLACK_OBSERVE_CHANNELS;
  delete process.env.SLACK_WATCH_NAMES;
});

test("hands an interrupted build back to the approve button and drops interrupted triage", async () => {
  process.env.DEVY_REPOSITORIES = `Pilot=${testDirectory}`;
  const analysis = {
    urgency: "medium", relevant: true, relevanceReason: "test", summary: "interrupted test build",
    recommendedAction: "retry", requestType: "build_request", repository: "Pilot", feasibility: "likely",
    implementationIdeas: [], risks: [], needsApproval: true
  };

  const stuckBuild = createSlackTriage({
    sourceChannelId: "CTEAM", sourceMessageTs: "20.0001", sourceUserId: "UMUKIL", sourceText: "build it"
  }).record;
  saveSlackTriageAnalysis(stuckBuild.id, analysis);
  saveSlackTriageReport(stuckBuild.id, "CREPORT", "21.0001", "awaiting_approval");
  assert.equal(transitionSlackTriage(stuckBuild.id, "awaiting_approval", "approved"), true);
  assert.equal(transitionSlackTriage(stuckBuild.id, "approved", "building"), true);

  const stuckTriage = createSlackTriage({
    sourceChannelId: "CTEAM", sourceMessageTs: "20.0002", sourceUserId: "UMUKIL", sourceText: "look at this"
  }).record;

  const posts: { channel: string; thread_ts?: string; text: string }[] = [];
  const client = {
    chat: {
      postMessage: async (input: { channel: string; thread_ts?: string; text: string }) => {
        posts.push(input);
        return { ok: true, ts: "22.0001" };
      }
    }
  };

  await recoverInterruptedTriages(client as unknown as Parameters<typeof recoverInterruptedTriages>[0], "CFALLBACK");

  assert.equal(getSlackTriageById(stuckBuild.id)?.status, "awaiting_approval");
  const buildPost = posts.find((post) => post.text.includes(`Build #${stuckBuild.id}`));
  assert.ok(buildPost, "an interrupted build must be reported in its report thread");
  assert.equal(buildPost.channel, "CREPORT");
  assert.equal(buildPost.thread_ts, "21.0001");
  assert.match(buildPost.text, /Approve build/);

  assert.equal(getSlackTriageById(stuckTriage.id)?.status, "failed");
  const triagePost = posts.find((post) => post.text.includes(`reference #${stuckTriage.id}`));
  assert.ok(triagePost, "an interrupted analysis must be reported");
  assert.equal(triagePost.channel, "CFALLBACK");

  finishSlackTriage(stuckBuild.id, "dismissed", "test cleanup");
  delete process.env.DEVY_REPOSITORIES;
});

test("pings until acknowledged, then stops", async () => {
  process.env.SLACK_ACK_REMINDER_MINUTES = "30";
  const { record } = createSlackTriage({
    sourceChannelId: "CTEAM", sourceMessageTs: "30.0001", sourceUserId: "UMUKIL", sourceText: "look at this"
  });
  saveSlackTriageReport(record.id, "CREPORT", "31.0001", "completed");

  const posts: { channel: string; thread_ts?: string; text: string; reply_broadcast?: boolean }[] = [];
  const client = {
    chat: {
      postMessage: async (input: typeof posts[number]) => {
        posts.push(input);
        return { ok: true, ts: "32.0001" };
      }
    }
  } as unknown as Parameters<typeof sendDueAckReminders>[0];

  // Freshly reported: inside the quiet window, so no reminder yet.
  assert.equal(await sendDueAckReminders(client, "UMUKIL"), 0);
  assert.equal(posts.length, 0);

  // Age the last ping past the window without waiting on a real clock.
  ageLastPing(record.id, 31);
  assert.equal(await sendDueAckReminders(client, "UMUKIL"), 1);
  assert.equal(posts[0].channel, "CREPORT");
  assert.equal(posts[0].thread_ts, "31.0001");
  assert.equal(posts[0].reply_broadcast, true);
  assert.match(posts[0].text, /<@UMUKIL> reminder 1/);

  // Immediately after a ping the record is quiet again.
  assert.equal(await sendDueAckReminders(client, "UMUKIL"), 0);

  ageLastPing(record.id, 31);
  assert.equal(await sendDueAckReminders(client, "UMUKIL"), 1);
  assert.match(posts[1].text, /reminder 2/);

  assert.equal(acknowledgeSlackTriage(record.id), true);
  assert.equal(acknowledgeSlackTriage(record.id), false, "acknowledging twice must be a no-op");
  ageLastPing(record.id, 999);
  assert.equal(await sendDueAckReminders(client, "UMUKIL"), 0);
  assert.equal(listSlackTriageNeedingPing(30).length, 0);
  assert.equal(posts.length, 2);

  finishSlackTriage(record.id, "dismissed", "test cleanup");
  delete process.env.SLACK_ACK_REMINDER_MINUTES;
});

test("recognises acknowledgement wording without swallowing real questions", () => {
  for (const text of ["ack", "ACK", "ok", "got it", "noted", "thanks"]) {
    assert.equal(isAcknowledgement(text), true, text);
  }
  for (const text of ["ack the deploy too", "which branch?", "ok but what about tests"]) {
    assert.equal(isAcknowledgement(text), false, text);
  }
});
