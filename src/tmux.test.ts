import assert from "node:assert/strict";
import { test } from "node:test";
import { extractWaitingPrompt, inferState, planInput, waitingReason } from "./tmux.js";

test("single-line input is sent literally, guarded against option parsing", () => {
  const plan = planInput("claude-pilot", "--force", true, "buf");
  assert.deepEqual(
    plan.map((command) => command.args),
    [
      ["send-keys", "-t", "claude-pilot", "-l", "--", "--force"],
      ["send-keys", "-t", "claude-pilot", "Enter"]
    ]
  );
  assert.deepEqual(planInput("s", "y", false, "buf").map((command) => command.args), [["send-keys", "-t", "s", "-l", "--", "y"]]);
});

test("multi-line input goes through a bracketed paste buffer that is deleted afterwards", () => {
  const plan = planInput("codex-app", "-x line one\nline two", true, "agentops_1_abc");
  assert.deepEqual(
    plan.map((command) => command.args),
    [
      ["set-buffer", "-b", "agentops_1_abc", "--", "-x line one\nline two"],
      ["paste-buffer", "-b", "agentops_1_abc", "-t", "codex-app", "-p", "-d"],
      ["send-keys", "-t", "codex-app", "Enter"]
    ]
  );
});

test("classifies pane output without flagging chat that merely mentions errors", () => {
  assert.equal(inferState(""), "idle");
  assert.equal(inferState("Do you want to proceed?\n❯ 1. Yes"), "waiting_for_input");
  assert.equal(inferState("Traceback (most recent call last):\n  File x\nValueError: boom"), "error");
  assert.equal(inferState("I fixed the error handling in the parser, tests pass."), "running");
  assert.equal(waitingReason("Allow this command?"), "allow_command");
  assert.equal(waitingReason("compiling..."), null);
});

test("extracts the prompt line that asked the question", () => {
  const output = "Editing src/app.ts\n\n  Do you want to proceed?   \n  ❯ 1. Yes\n    2. No";
  assert.equal(extractWaitingPrompt(output), "Do you want to proceed?");
  assert.equal(extractWaitingPrompt("just text\nlast line"), "last line");
});
