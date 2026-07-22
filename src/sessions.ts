import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getGitStatus, type GitStatus } from "./git.js";
import { inferState, type AgentState } from "./tmux.js";

const execFileAsync = promisify(execFile);

export type SessionAgent = "claude" | "codex" | "unknown";

export type ManagedSession = {
  id: string;
  name: string;
  agent: SessionAgent;
  running: boolean;
  state: AgentState;
  paneCurrentPath: string;
  paneCommand: string;
  paneTitle: string;
  createdAt: string | null;
  lastOutput: string;
  outputHash: string;
  git: GitStatus;
};

export async function listManagedSessions(): Promise<ManagedSession[]> {
  const sessions = await tmux([
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_created_string}\t#{session_attached}"
  ]);
  if (sessions.code !== 0) return [];

  const rows = sessions.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const managed = await Promise.all(rows.map((row) => inspectManagedSession(row)));
  return managed.sort((a, b) => {
    const agentOrder = agentRank(a.agent) - agentRank(b.agent);
    return agentOrder || a.name.localeCompare(b.name);
  });
}

export async function createManagedSession(name: string, agent: "claude" | "codex", directory: string): Promise<void> {
  const resolved = safeProjectDirectory(directory);

  const exists = await tmux(["list-sessions", "-F", "#{session_name}"]);
  if (exists.stdout.split("\n").some((session) => session.trim() === name)) {
    throw new Error(`tmux session already exists: ${name}`);
  }

  const result = await tmux(["new-session", "-d", "-s", name, "-c", resolved, agent]);
  if (result.code !== 0) {
    throw new Error(result.stderr || `failed to create ${agent} session`);
  }
}

export async function activePaneDirectory(sessionName: string): Promise<string> {
  const pane = await tmux(["list-panes", "-t", sessionName, "-F", "#{pane_active}\t#{pane_current_path}"]);
  if (pane.code !== 0) throw new Error(pane.stderr || "tmux session not found");
  const activePane = pane.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .find((parts) => parts[0] === "1");
  return safeProjectDirectory(activePane?.[1] || process.env.REPO_PATH || process.cwd());
}

export function validSessionName(sessionName: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(sessionName);
}

export function tmuxKey(key: string): string {
  if (key === "Backspace") return "BSpace";
  return key;
}

export async function tmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

async function inspectManagedSession(row: string): Promise<ManagedSession> {
  const [name, createdAt] = row.split("\t");
  const pane = await tmux([
    "list-panes",
    "-t",
    name,
    "-F",
    "#{pane_active}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}"
  ]);
  const activePane = pane.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .find((parts) => parts[0] === "1");
  const paneCurrentPath = activePane?.[1] || process.env.REPO_PATH || process.cwd();
  const paneCommand = activePane?.[2] || "unknown";
  const paneTitle = activePane?.[3] || "";

  const capture = await tmux(["capture-pane", "-t", name, "-p", "-S", "-140"]);
  const lastOutput = capture.stdout.trim().slice(-5000);
  const agent = classifyAgent(name, paneCommand, paneTitle, lastOutput);
  const git = await getGitStatus(paneCurrentPath);

  return {
    id: name,
    name,
    agent,
    running: pane.code === 0,
    state: inferState(lastOutput),
    paneCurrentPath,
    paneCommand,
    paneTitle,
    createdAt: createdAt || null,
    lastOutput,
    outputHash: simpleHash(lastOutput),
    git
  };
}

function classifyAgent(sessionName: string, command: string, title: string, output: string): SessionAgent {
  const haystack = `${sessionName} ${command} ${title} ${output.slice(-500)}`.toLowerCase();
  if (haystack.includes("claude")) return "claude";
  if (haystack.includes("codex")) return "codex";
  return "unknown";
}

function agentRank(agent: SessionAgent): number {
  if (agent === "claude") return 0;
  if (agent === "codex") return 1;
  return 2;
}

function safeProjectDirectory(directory: string): string {
  const expanded = directory.startsWith("~")
    ? directory.replace(/^~(?=\/|$)/, process.env.HOME || "/home/ubuntu")
    : directory;
  const normalized = path.resolve(expanded);
  if (normalized !== "/home/ubuntu" && !normalized.startsWith("/home/ubuntu/")) {
    throw new Error("directory must be under /home/ubuntu");
  }
  return normalized;
}

export function simpleHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}
