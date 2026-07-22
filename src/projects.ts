import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getGitStatus, type GitStatus } from "./git.js";
import { listManagedSessions } from "./sessions.js";

export type ProjectInfo = {
  path: string;
  name: string;
  group: string;
  isGitRepo: boolean;
  git: GitStatus;
  hasClaudeSettings: boolean;
  hasCodexConfig: boolean;
  hasReadme: boolean;
  sessions: { name: string; agent: string; state: string }[];
  lastModified: string | null;
};

const PROJECT_ROOTS = [
  "/home/ubuntu/work/repos",
  "/home/ubuntu/apps"
];

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "dist",
  "build",
  ".next",
  ".turbo",
  "target"
]);

export async function listProjects(): Promise<ProjectInfo[]> {
  const sessions = await listManagedSessions();
  const sessionsByDir = new Map<string, { name: string; agent: string; state: string }[]>();
  for (const session of sessions) {
    const dir = session.paneCurrentPath;
    if (!dir) continue;
    const existing = sessionsByDir.get(dir) || [];
    existing.push({ name: session.name, agent: session.agent, state: session.state });
    sessionsByDir.set(dir, existing);
  }

  const projects: ProjectInfo[] = [];
  for (const root of PROJECT_ROOTS) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        if (IGNORE_DIRS.has(entry.name)) continue;
        const fullPath = path.join(root, entry.name);
        const info = await inspectProject(fullPath, root, sessionsByDir);
        projects.push(info);
      }
    } catch {
      // root missing — skip
    }
  }

  return projects.sort((a, b) => {
    const dirtyDiff = Number(b.git.dirty) - Number(a.git.dirty);
    if (dirtyDiff !== 0) return dirtyDiff;
    return a.name.localeCompare(b.name);
  });
}

async function inspectProject(
  fullPath: string,
  root: string,
  sessionsByDir: Map<string, { name: string; agent: string; state: string }[]>
): Promise<ProjectInfo> {
  const [git, hasClaudeSettings, hasCodexConfig, hasReadme, mtime] = await Promise.all([
    getGitStatus(fullPath),
    fileExists(path.join(fullPath, ".claude")),
    fileExists(path.join(fullPath, ".codex")),
    anyExists([
      path.join(fullPath, "README.md"),
      path.join(fullPath, "README.rst"),
      path.join(fullPath, "readme.md")
    ]),
    lastModified(fullPath)
  ]);

  return {
    path: fullPath,
    name: path.basename(fullPath),
    group: path.basename(root),
    isGitRepo: git.branch !== "unknown",
    git,
    hasClaudeSettings,
    hasCodexConfig,
    hasReadme,
    sessions: sessionsByDir.get(fullPath) || [],
    lastModified: mtime
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function anyExists(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    if (await fileExists(p)) return true;
  }
  return false;
}

async function lastModified(p: string): Promise<string | null> {
  try {
    const s = await stat(p);
    return s.mtime.toISOString();
  } catch {
    return null;
  }
}

export function projectRoots(): string[] {
  return [...PROJECT_ROOTS];
}
