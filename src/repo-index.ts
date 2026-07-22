import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type RepoTreeNode = {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
};

export type RepoIndex = {
  name: string;
  rootPath: string;
  exists: boolean;
  readme: string;
  designDoc: string;
  claudeDoc: string;
  topLevel: RepoTreeNode[];
  packageMap: Record<string, string[]>;
  fileCount: number;
  generatedAt: string;
};

const TRACKED_REPOS: { name: string; path: string }[] = [
  { name: "Pilot", path: "/home/ubuntu/work/repos/Pilot" },
  { name: "Crucible", path: "/home/ubuntu/work/repos/Crucible" }
];

const SUMMARY_FILES = ["README.md", "DESIGN.md", "CLAUDE.md", "ARCHITECTURE.md"];

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
  ".idea",
  ".vscode",
  "target",
  ".deepeval"
]);

const cache = new Map<string, { index: RepoIndex; cachedAt: number }>();
const CACHE_TTL_MS = 60_000;

export function trackedRepos(): { name: string; path: string }[] {
  return [...TRACKED_REPOS];
}

export async function buildIndex(name: string, repoPath: string): Promise<RepoIndex> {
  const cached = cache.get(repoPath);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.index;

  const exists = await pathExists(repoPath);
  if (!exists) {
    const empty: RepoIndex = {
      name,
      rootPath: repoPath,
      exists: false,
      readme: "",
      designDoc: "",
      claudeDoc: "",
      topLevel: [],
      packageMap: {},
      fileCount: 0,
      generatedAt: new Date().toISOString()
    };
    cache.set(repoPath, { index: empty, cachedAt: Date.now() });
    return empty;
  }

  const readme = await readSummaryFile(repoPath, "README.md", 12000);
  const designDoc = await readSummaryFile(repoPath, "DESIGN.md", 20000);
  const claudeDoc = await readSummaryFile(repoPath, "CLAUDE.md", 12000);
  const topLevel = await listTopLevel(repoPath);
  const packageMap = await scanPackages(repoPath, topLevel);
  const fileCount = await countFiles(repoPath, 2);

  const index: RepoIndex = {
    name,
    rootPath: repoPath,
    exists: true,
    readme,
    designDoc,
    claudeDoc,
    topLevel,
    packageMap,
    fileCount,
    generatedAt: new Date().toISOString()
  };
  cache.set(repoPath, { index, cachedAt: Date.now() });
  return index;
}

export async function buildAllIndices(): Promise<RepoIndex[]> {
  return Promise.all(TRACKED_REPOS.map(({ name, path: p }) => buildIndex(name, p)));
}

export async function indexDigest(maxChars = 14000): Promise<string> {
  const indices = await buildAllIndices();
  const sections: string[] = [];
  for (const idx of indices) {
    if (!idx.exists) {
      sections.push(`# ${idx.name}\n(missing at ${idx.rootPath})`);
      continue;
    }
    sections.push(`# ${idx.name}\nPath: ${idx.rootPath}\nFiles indexed (top 2 levels): ${idx.fileCount}\n`);
    if (idx.readme) sections.push(`## README\n${truncate(idx.readme, 3500)}`);
    if (idx.designDoc) sections.push(`## DESIGN\n${truncate(idx.designDoc, 3500)}`);
    if (idx.claudeDoc) sections.push(`## CLAUDE.md\n${truncate(idx.claudeDoc, 2500)}`);
    sections.push(`## Top-level layout\n${idx.topLevel.map((n) => `- ${n.name}${n.type === "dir" ? "/" : ""}`).join("\n")}`);
    if (Object.keys(idx.packageMap).length) {
      const pkgSummary = Object.entries(idx.packageMap)
        .slice(0, 12)
        .map(([dir, files]) => `- ${dir}/ — ${files.slice(0, 6).join(", ")}${files.length > 6 ? ", ..." : ""}`)
        .join("\n");
      sections.push(`## Sub-packages\n${pkgSummary}`);
    }
  }
  return truncate(sections.join("\n\n"), maxChars);
}

async function readSummaryFile(repoPath: string, name: string, maxBytes: number): Promise<string> {
  try {
    const buf = await readFile(path.join(repoPath, name), "utf8");
    return buf.length > maxBytes ? `${buf.slice(0, maxBytes)}\n... [truncated]` : buf;
  } catch {
    return "";
  }
}

async function listTopLevel(repoPath: string): Promise<RepoTreeNode[]> {
  try {
    const entries = await readdir(repoPath, { withFileTypes: true });
    const nodes: RepoTreeNode[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(repoPath, entry.name);
      if (entry.isDirectory()) {
        nodes.push({ name: entry.name, path: full, type: "dir" });
      } else {
        try {
          const s = await stat(full);
          nodes.push({ name: entry.name, path: full, type: "file", size: s.size });
        } catch {
          // skip
        }
      }
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

async function scanPackages(repoPath: string, topLevel: RepoTreeNode[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const node of topLevel) {
    if (node.type !== "dir") continue;
    try {
      const sub = await readdir(node.path, { withFileTypes: true });
      const childNames = sub
        .filter((e) => !e.name.startsWith(".") && !IGNORE_DIRS.has(e.name))
        .slice(0, 50)
        .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`);
      if (childNames.length) out[node.name] = childNames;
    } catch {
      // skip
    }
  }
  return out;
}

async function countFiles(dir: string, depth: number): Promise<number> {
  if (depth < 0) return 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORE_DIRS.has(entry.name)) continue;
      if (entry.isFile()) count += 1;
      if (entry.isDirectory()) count += await countFiles(path.join(dir, entry.name), depth - 1);
    }
    return count;
  } catch {
    return 0;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n... [truncated]` : value;
}
