import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

export type AgentState = "running" | "waiting_for_input" | "error" | "idle" | "unknown";

export type TmuxSnapshot = {
  session: string;
  running: boolean;
  state: AgentState;
  lastOutput: string;
  outputHash: string;
  lastActivity: string | null;
};

const waitingPatterns = [
  { reason: "proceed_prompt", pattern: /Do you want to proceed\?/i },
  { reason: "approval_prompt", pattern: /\bApprove\b/i },
  { reason: "requires_approval", pattern: /Requires approval/i },
  { reason: "waiting_for_input", pattern: /Waiting for input/i },
  { reason: "continue_prompt", pattern: /Continue\?/i },
  { reason: "permission_required", pattern: /Permission required/i },
  { reason: "allow_command", pattern: /Allow this command\?/i },
  { reason: "select_option", pattern: /Select an option|Would you like to (run|make)/i },
  { reason: "yes_no_prompt", pattern: /\by\/n\b/i }
];

// Only patterns that look like genuine terminal/runtime errors — NOT casual
// mentions of "error" or "failed" inside an agent's chat output. Without this
// the Claude TUI is permanently flagged as "error" whenever Claude says the word.
const errorPatterns = [
  /^Traceback \(most recent call last\):/m,
  /^\s*[A-Z][A-Za-z0-9_]+(Error|Exception):/m,            // ValueError:, RuntimeException:
  /^Error: /m,
  /^ERROR\b/m,
  /^FATAL\b/m,
  /\bcommand not found\b/,
  /\bSegmentation fault\b/i,
  /\bcore dumped\b/i,
  /\bbash: .+: No such file or directory\b/,
  /\bENOENT\b/,
  /\bECONNREFUSED\b/,
  /\bMODULE_NOT_FOUND\b/,
  /\bUnhandledPromiseRejection\b/
];

export async function inspectSession(session: string): Promise<TmuxSnapshot> {
  if (!(await sessionExists(session))) {
    return {
      session,
      running: false,
      state: "unknown",
      lastOutput: "",
      outputHash: "",
      lastActivity: null
    };
  }

  const [capture, pane] = await Promise.all([
    execTmux(["capture-pane", "-t", session, "-p", "-S", "-120"]),
    execTmux(["list-panes", "-t", session, "-F", "#{pane_active} #{pane_current_command} #{pane_pid} #{pane_start_command}"])
  ]);

  const lastOutput = capture.stdout.trim().slice(-4000);
  const lastActivity = new Date().toISOString();
  const outputHash = crypto.createHash("sha256").update(lastOutput).digest("hex");
  const paneText = pane.stdout.trim();

  return {
    session,
    running: paneText.length > 0,
    state: inferState(lastOutput),
    lastOutput,
    outputHash,
    lastActivity
  };
}

export async function sendInputToSession(session: string, text: string, submit: boolean): Promise<void> {
  if (!(await sessionExists(session))) {
    throw new Error(`tmux session not found: ${session}`);
  }

  const trimmed = text.slice(0, 4000);
  if (trimmed.length === 0) {
    throw new Error("input text is empty");
  }

  // Multi-line text is risky to send with `send-keys -l` because embedded newlines
  // become submission events in most TUIs. Use a tmux buffer + paste-buffer with
  // bracketed-paste so the target app (Claude Code, Codex, shells) treats it as
  // a single paste rather than a stream of line submits.
  if (trimmed.includes("\n")) {
    const bufferName = `agentops_${process.pid}_${Date.now().toString(36)}`;
    const set = await execTmux(["set-buffer", "-b", bufferName, trimmed]);
    if (set.code !== 0) throw new Error(set.stderr || "tmux set-buffer failed");
    // `-p` enables bracketed paste; `-d` deletes the buffer after pasting.
    const paste = await execTmux(["paste-buffer", "-b", bufferName, "-t", session, "-p", "-d"]);
    if (paste.code !== 0) throw new Error(paste.stderr || "tmux paste-buffer failed");
  } else {
    await sendKeys(["send-keys", "-t", session, "-l", trimmed]);
  }

  if (submit) {
    await sendKeys(["send-keys", "-t", session, "Enter"]);
  }
}

export function inferState(output: string): AgentState {
  if (!output.trim()) return "idle";
  if (waitingReason(output)) return "waiting_for_input";
  if (errorPatterns.some((pattern) => pattern.test(recentOutput(output)))) return "error";
  return "running";
}

function recentOutput(output: string): string {
  return output.split("\n").slice(-12).join("\n");
}

export function waitingReason(output: string): string | null {
  return waitingPatterns.find(({ pattern }) => pattern.test(output))?.reason ?? null;
}

export function waitingReasonLabel(reason: string | null): string {
  switch (reason) {
    case "proceed_prompt":
      return "proceed confirmation";
    case "approval_prompt":
    case "requires_approval":
      return "approval request";
    case "continue_prompt":
      return "continue confirmation";
    case "permission_required":
    case "allow_command":
      return "permission request";
    case "select_option":
      return "option selection";
    case "yes_no_prompt":
      return "yes/no prompt";
    case "waiting_for_input":
      return "waiting for input";
    default:
      return "input prompt";
  }
}

export function extractWaitingPrompt(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const promptLines = lines.filter((line) =>
    /Do you want to proceed\?|Approve|Requires approval|Waiting for input|Continue\?|Permission required|Allow this command\?|Select an option|Would you like to (run|make)|\by\/n\b/i.test(
      line
    )
  );
  const selected = promptLines.at(-1) || lines.at(-1) || "";
  return selected.slice(0, 360);
}

async function sessionExists(session: string): Promise<boolean> {
  const result = await execTmux(["list-sessions", "-F", "#{session_name}"]);
  return result.code === 0 && result.stdout.split("\n").some((name) => name.trim() === session);
}

async function execTmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("tmux", args, {
      timeout: 3000,
      maxBuffer: 1024 * 1024
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

async function sendKeys(args: string[]): Promise<void> {
  const result = await execTmux(args);
  if (result.code !== 0) {
    throw new Error(result.stderr || "tmux send-keys failed");
  }
}
