import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { listManagedSessions, invalidateSessionCache } from "./sessions.js";
import { sendInputToSession } from "./tmux.js";

// The in-browser assistant is a real operator of this box: it can run shell
// commands, read/write files, and drive the *other* tmux agents. Everything
// runs as the `ubuntu` user, behind Tailscale + write-auth, and only when
// ENABLE_AGENT_TOOLS is not "false".
export function agentToolsEnabled(): boolean {
  return process.env.ENABLE_AGENT_TOOLS !== "false";
}

const HOME = process.env.HOME || "/home/ubuntu";
const BASH_TIMEOUT_MS = Number(process.env.AGENT_BASH_TIMEOUT_SECONDS || 180) * 1000;
const OUTPUT_CAP = 60_000; // characters returned to the model per tool call
const FILE_READ_CAP = 200_000;

// Guardrails against the handful of commands that can brick the host in one
// keystroke. Not a security boundary (the agent has a shell) — just a seatbelt
// against an obvious mistake. Rephrase-and-retry is always available.
const BLOCKED_BASH = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\/home\/ubuntu)(\s|$)/i,
  /\brm\s+-[a-z]*f[a-z]*r?\s+(\/|~)(\s|$)/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, // fork bomb
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|xvd|vd)/i,
  />\s*\/dev\/(sd|nvme|xvd|vd)[a-z0-9]/i,
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i
];

export type ToolContext = {
  onOutput?: (chunk: string) => void;
};

export type ToolResult = { content: string; isError: boolean };

type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

const bash: ToolDef = {
  name: "bash",
  description:
    "Run a shell command on the server (as user ubuntu). Use for anything: inspecting the system, git, running builds/tests, installing packages, managing services with sudo -n, etc. Output is combined stdout+stderr. Prefer non-interactive flags; commands time out after a few minutes.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      cwd: { type: "string", description: "Working directory. Defaults to the user home." }
    },
    required: ["command"]
  },
  async run(input, ctx) {
    const command = String(input.command || "").trim();
    if (!command) return { content: "empty command", isError: true };
    // Full yolo: AGENT_UNRESTRICTED_BASH=true drops even the brick-guard.
    const guarded = process.env.AGENT_UNRESTRICTED_BASH !== "true";
    if (guarded && BLOCKED_BASH.some((pattern) => pattern.test(command))) {
      return {
        content: `Refused: "${command}" matches a destructive-command guard. Rephrase to be more specific if you really mean it.`,
        isError: true
      };
    }
    const cwd = await resolveDir(String(input.cwd || HOME));
    return runShell(command, cwd, ctx);
  }
};

const readFileTool: ToolDef = {
  name: "read_file",
  description: "Read a text file from the server filesystem. Truncated if very large.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "Absolute or ~-relative path." } },
    required: ["path"]
  },
  async run(input) {
    const target = expandHome(String(input.path || ""));
    try {
      const info = await stat(target);
      if (info.isDirectory()) return { content: `${target} is a directory. Use bash 'ls' instead.`, isError: true };
      const raw = await readFile(target, "utf8");
      const clipped = raw.length > FILE_READ_CAP ? `${raw.slice(0, FILE_READ_CAP)}\n… [truncated ${raw.length - FILE_READ_CAP} chars]` : raw;
      return { content: clipped, isError: false };
    } catch (error) {
      return { content: `read failed: ${(error as Error).message}`, isError: true };
    }
  }
};

const writeFileTool: ToolDef = {
  name: "write_file",
  description: "Create or overwrite a text file on the server. Parent directories are created automatically.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or ~-relative path." },
      content: { type: "string", description: "Full file contents to write." }
    },
    required: ["path", "content"]
  },
  async run(input) {
    const target = expandHome(String(input.path || ""));
    const body = String(input.content ?? "");
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, "utf8");
      return { content: `Wrote ${body.length} bytes to ${target}`, isError: false };
    } catch (error) {
      return { content: `write failed: ${(error as Error).message}`, isError: true };
    }
  }
};

const listSessionsTool: ToolDef = {
  name: "list_sessions",
  description:
    "List the running Claude Code / Codex tmux agent sessions this dashboard is watching, with their state, repo, branch, and a short tail of recent output. Use this to see what the other agents are doing.",
  input_schema: { type: "object", properties: {} },
  async run() {
    const sessions = await listManagedSessions();
    if (!sessions.length) return { content: "No tmux sessions found.", isError: false };
    const summary = sessions.map((s) => ({
      name: s.name,
      agent: s.agent,
      state: s.state,
      dir: s.paneCurrentPath,
      branch: s.git?.branch,
      dirty: s.git?.dirty,
      tail: (s.lastOutput || "").slice(-400)
    }));
    return { content: JSON.stringify(summary, null, 2), isError: false };
  }
};

const captureSessionTool: ToolDef = {
  name: "capture_session",
  description: "Read the recent terminal output of one tmux agent session by name (e.g. to see why it is stuck).",
  input_schema: {
    type: "object",
    properties: { session: { type: "string", description: "tmux session name." } },
    required: ["session"]
  },
  async run(input) {
    const name = String(input.session || "");
    const sessions = await listManagedSessions();
    const match = sessions.find((s) => s.name === name);
    if (!match) return { content: `No session named "${name}". Use list_sessions.`, isError: true };
    return { content: match.lastOutput || "(no recent output)", isError: false };
  }
};

const sendSessionTool: ToolDef = {
  name: "send_session",
  description:
    "Type text into another tmux agent session and optionally submit it — e.g. to answer a prompt, approve an action, or unblock a stuck agent. Use capture_session first to see what it is asking.",
  input_schema: {
    type: "object",
    properties: {
      session: { type: "string", description: "tmux session name." },
      text: { type: "string", description: "Text to send." },
      submit: { type: "boolean", description: "Press Enter after sending. Default true." }
    },
    required: ["session", "text"]
  },
  async run(input) {
    const name = String(input.session || "");
    const text = String(input.text || "");
    const submit = input.submit !== false;
    if (!text) return { content: "empty text", isError: true };
    try {
      await sendInputToSession(name, text, submit);
      invalidateSessionCache();
      return { content: `Sent ${text.length} chars to ${name}${submit ? " and pressed Enter" : ""}.`, isError: false };
    } catch (error) {
      return { content: `send failed: ${(error as Error).message}`, isError: true };
    }
  }
};

const TOOLS: ToolDef[] = [
  bash,
  readFileTool,
  writeFileTool,
  listSessionsTool,
  captureSessionTool,
  sendSessionTool
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function toolDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  try {
    return await tool.run(args, ctx);
  } catch (error) {
    return { content: `tool error: ${(error as Error).message}`, isError: true };
  }
}

function runShell(command: string, cwd: string, ctx: ToolContext): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: process.env });
    let out = "";
    let capped = false;
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      ctx.onOutput?.(text);
      if (capped) return;
      out += text;
      if (out.length > OUTPUT_CAP) {
        out = `${out.slice(0, OUTPUT_CAP)}\n… [output truncated]`;
        capped = true;
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      out += `\n… [killed after ${Math.round(BASH_TIMEOUT_MS / 1000)}s timeout]`;
    }, BASH_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ content: `spawn failed: ${error.message}`, isError: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmed = out.trim() || "(no output)";
      const suffix = code === 0 ? "" : `\n[exit ${code}]`;
      resolve({ content: trimmed + suffix, isError: code !== 0 });
    });
  });
}

function expandHome(target: string): string {
  const expanded = target.startsWith("~") ? target.replace(/^~(?=\/|$)/, HOME) : target;
  return path.resolve(expanded);
}

async function resolveDir(dir: string): Promise<string> {
  const resolved = expandHome(dir);
  try {
    const info = await stat(resolved);
    if (info.isDirectory()) return resolved;
  } catch {
    // fall through to home
  }
  return HOME;
}
