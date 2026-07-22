import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitStatus = {
  branch: string;
  dirty: boolean;
  stagedCount: number;
  unstagedCount: number;
};

const STATUS_TTL_MS = 4000;
const statusCache = new Map<string, { at: number; status: GitStatus }>();
const statusInFlight = new Map<string, Promise<GitStatus>>();

// `git status --porcelain` on a large dirty repo is the slowest call in a
// session scan, and the same directories repeat across sessions and projects.
export async function getGitStatus(repoPath: string): Promise<GitStatus> {
  const cached = statusCache.get(repoPath);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;

  const pending = statusInFlight.get(repoPath);
  if (pending) return pending;

  const run = readGitStatus(repoPath)
    .then((status) => {
      statusCache.set(repoPath, { at: Date.now(), status });
      if (statusCache.size > 200) statusCache.clear();
      return status;
    })
    .finally(() => statusInFlight.delete(repoPath));
  statusInFlight.set(repoPath, run);
  return run;
}

async function readGitStatus(repoPath: string): Promise<GitStatus> {
  const [branch, porcelain] = await Promise.all([
    git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(repoPath, ["status", "--porcelain"])
  ]);

  if (branch.code !== 0 || porcelain.code !== 0) {
    return {
      branch: "unknown",
      dirty: false,
      stagedCount: 0,
      unstagedCount: 0
    };
  }

  let stagedCount = 0;
  let unstagedCount = 0;
  const lines = porcelain.stdout.split("\n").filter(Boolean);
  for (const line of lines) {
    const staged = line[0] ?? " ";
    const unstaged = line[1] ?? " ";
    if (staged !== " " && staged !== "?") stagedCount += 1;
    if (unstaged !== " ") unstagedCount += 1;
    if (staged === "?" && unstaged === "?") unstagedCount += 1;
  }

  return {
    branch: branch.stdout.trim() || "unknown",
    dirty: lines.length > 0,
    stagedCount,
    unstagedCount
  };
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 3000,
      maxBuffer: 512 * 1024
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}
