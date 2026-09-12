import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WaitingAlertState, WaitingObservation, WaitingTracker } from "./monitor.js";

const originalDirectory = process.cwd();
const testDirectory = await mkdtemp(path.join(os.tmpdir(), "devy-monitor-"));
process.chdir(testDirectory);
// Dynamic import is intentional: monitor.ts pulls in db.ts, which binds its SQLite path from cwd.
const { detectWaitingAlerts } = await import("./monitor.js");

after(async () => {
  process.chdir(originalDirectory);
  await rm(testDirectory, { recursive: true, force: true });
});

const PROMPT = "Do you want to proceed?\n❯ 1. Yes\n  2. No";

function session(overrides: Partial<WaitingObservation> = {}): WaitingObservation {
  return {
    name: "claude-pilot",
    agent: "claude",
    state: "waiting_for_input",
    lastOutput: PROMPT,
    paneCurrentPath: "/home/ubuntu/work/repos/Pilot",
    ...overrides
  };
}

function freshState(now = 1_000_000): WaitingAlertState {
  return { trackers: new Map<string, WaitingTracker>(), suppressUntil: new Map(), now, waitMs: 30_000 };
}

test("alerts once after the prompt has waited longer than the threshold", () => {
  const state = freshState();
  assert.deepEqual(detectWaitingAlerts([session()], state), [], "first sighting only starts the clock");
  state.now += 29_000;
  assert.deepEqual(detectWaitingAlerts([session()], state), [], "still inside the window");
  state.now += 2_000;
  const alerts = detectWaitingAlerts([session()], state);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "approval_required");
  assert.equal(alerts[0].agent, "claude");
  assert.equal(alerts[0].session, "claude-pilot");
  assert.match(alerts[0].message, /Claude is waiting for input \(proceed confirmation\)/);
  state.now += 60_000;
  assert.deepEqual(detectWaitingAlerts([session()], state), [], "the same prompt never alerts twice");
});

test("a different prompt re-arms the alert; leaving the waiting state resets it", () => {
  const state = freshState();
  detectWaitingAlerts([session()], state);
  state.now += 31_000;
  assert.equal(detectWaitingAlerts([session()], state).length, 1);

  // New question on screen: the clock restarts and a second alert follows.
  const second = session({ lastOutput: "Allow this command?\n❯ Yes" });
  assert.equal(detectWaitingAlerts([second], state).length, 0);
  state.now += 31_000;
  const alerts = detectWaitingAlerts([second], state);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /permission request/);

  // Agent resumed, then asks the very same thing again later: alert again.
  detectWaitingAlerts([session({ state: "running", lastOutput: "Working…" })], state);
  detectWaitingAlerts([second], state);
  state.now += 31_000;
  assert.equal(detectWaitingAlerts([second], state).length, 1);
});

test("stays quiet while the session's own hook has recently alerted", () => {
  const state = freshState();
  state.suppressUntil.set("claude-pilot", state.now + 120_000);
  detectWaitingAlerts([session()], state);
  state.now += 31_000;
  assert.deepEqual(detectWaitingAlerts([session()], state), []);
  // The suppression counted as the alert, so the same prompt does not fire later either.
  state.now += 120_000;
  assert.deepEqual(detectWaitingAlerts([session()], state), []);
  assert.equal(state.suppressUntil.size, 0, "expired suppressions are dropped");
});

test("tracks sessions independently and forgets vanished ones", () => {
  const state = freshState();
  const codex = session({ name: "codex-app", agent: "codex", lastOutput: "Continue? (y/n)" });
  detectWaitingAlerts([session(), codex], state);
  state.now += 31_000;
  const alerts = detectWaitingAlerts([session(), codex], state);
  assert.deepEqual(alerts.map((alert) => alert.session).sort(), ["claude-pilot", "codex-app"]);
  assert.equal(state.trackers.size, 2);

  detectWaitingAlerts([codex], state);
  assert.deepEqual([...state.trackers.keys()], ["codex-app"]);
});

test("labels sessions that are not a known agent by their tmux name", () => {
  const state = freshState();
  const shell = session({ name: "scratch", agent: "unknown", lastOutput: "Overwrite? y/n" });
  detectWaitingAlerts([shell], state);
  state.now += 31_000;
  const [alert] = detectWaitingAlerts([shell], state);
  assert.equal(alert.agent, "system");
  assert.match(alert.message, /^tmux:scratch is waiting for input/);
});
