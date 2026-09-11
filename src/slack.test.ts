import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalDirectory = process.cwd();
const testDirectory = await mkdtemp(path.join(os.tmpdir(), "devy-slack-"));
process.chdir(testDirectory);
// Dynamic import is intentional: db.ts binds its SQLite path from cwd during module initialization.
const { shouldAlert, cleanSlackMessageText } = await import("./slack.js");

after(async () => {
  process.chdir(originalDirectory);
  await rm(testDirectory, { recursive: true, force: true });
});

test("alerts only the noisy event types, and none when disabled", () => {
  delete process.env.ENABLE_AGENT_ALERTS;
  assert.equal(shouldAlert("approval_required"), true);
  assert.equal(shouldAlert("notification"), true);
  assert.equal(shouldAlert("error"), true);
  assert.equal(shouldAlert("completed"), false);
  assert.equal(shouldAlert("info"), false);

  process.env.ENABLE_AGENT_ALERTS = "false";
  assert.equal(shouldAlert("approval_required"), false);
  assert.equal(shouldAlert("notification"), false);
  assert.equal(shouldAlert("error"), false);

  process.env.ENABLE_AGENT_ALERTS = "true";
  assert.equal(shouldAlert("approval_required"), true);
  delete process.env.ENABLE_AGENT_ALERTS;
});

test("strips Slack markup before sending text to a tmux agent", () => {
  assert.equal(cleanSlackMessageText("<@U123> continue"), "continue");
  assert.equal(cleanSlackMessageText("see <https://example.com|the docs>"), "see the docs (https://example.com)");
  assert.equal(cleanSlackMessageText("a &amp; b"), "a & b");
});
