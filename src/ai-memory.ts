import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const MEM_DIR = path.resolve(process.cwd(), "data/ai-memory");
const CONV_DIR = path.resolve(process.cwd(), "data/ai-conversations");

export type MemoryEntry = {
  id: string;
  topic: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

// content is a plain string for simple chat, or an array of Anthropic content
// blocks (text / tool_use / tool_result) for agentic turns.
export type ConversationTurn = {
  role: "user" | "assistant";
  content: string | unknown[];
  ts: string;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
};

async function ensureDirs(): Promise<void> {
  await mkdir(MEM_DIR, { recursive: true });
  await mkdir(CONV_DIR, { recursive: true });
}

export async function listMemories(): Promise<MemoryEntry[]> {
  await ensureDirs();
  const files = (await readdir(MEM_DIR)).filter((f) => f.endsWith(".json"));
  const out: MemoryEntry[] = [];
  for (const file of files) {
    try {
      const content = await readFile(path.join(MEM_DIR, file), "utf8");
      out.push(JSON.parse(content));
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveMemory(input: { topic: string; body: string; tags?: string[]; id?: string }): Promise<MemoryEntry> {
  await ensureDirs();
  const now = new Date().toISOString();
  const id = input.id || crypto.randomBytes(6).toString("hex");
  let createdAt = now;
  try {
    const existing = JSON.parse(await readFile(path.join(MEM_DIR, `${id}.json`), "utf8"));
    createdAt = existing.createdAt || now;
  } catch {
    // new
  }
  const entry: MemoryEntry = {
    id,
    topic: input.topic.slice(0, 200),
    body: input.body.slice(0, 8000),
    tags: (input.tags || []).slice(0, 12).map((t) => t.slice(0, 40)),
    createdAt,
    updatedAt: now
  };
  await writeFile(path.join(MEM_DIR, `${id}.json`), JSON.stringify(entry, null, 2), "utf8");
  return entry;
}

export async function deleteMemory(id: string): Promise<boolean> {
  await ensureDirs();
  if (!/^[a-f0-9]{1,32}$/.test(id)) return false;
  try {
    await unlink(path.join(MEM_DIR, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function searchMemories(query: string): Promise<MemoryEntry[]> {
  const all = await listMemories();
  if (!query.trim()) return all;
  const q = query.toLowerCase();
  return all.filter((m) => {
    return (
      m.topic.toLowerCase().includes(q) ||
      m.body.toLowerCase().includes(q) ||
      m.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
}

export async function memoryDigest(maxEntries = 20): Promise<string> {
  const memories = await listMemories();
  if (memories.length === 0) return "(no saved memories yet)";
  return memories
    .slice(0, maxEntries)
    .map((m) => `- [${m.topic}] (${m.tags.join(", ") || "no tags"}): ${m.body}`)
    .join("\n");
}

export async function listConversations(): Promise<Conversation[]> {
  await ensureDirs();
  const files = (await readdir(CONV_DIR)).filter((f) => f.endsWith(".json"));
  const out: Conversation[] = [];
  for (const file of files) {
    try {
      const content = await readFile(path.join(CONV_DIR, file), "utf8");
      out.push(JSON.parse(content));
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getConversation(id: string): Promise<Conversation | null> {
  await ensureDirs();
  if (!/^[a-f0-9]{1,32}$/.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(CONV_DIR, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function saveConversation(conv: Conversation): Promise<void> {
  await ensureDirs();
  conv.updatedAt = new Date().toISOString();
  await writeFile(path.join(CONV_DIR, `${conv.id}.json`), JSON.stringify(conv, null, 2), "utf8");
}

export async function newConversation(title: string): Promise<Conversation> {
  await ensureDirs();
  const now = new Date().toISOString();
  const conv: Conversation = {
    id: crypto.randomBytes(6).toString("hex"),
    title: (title || "New chat").slice(0, 120),
    createdAt: now,
    updatedAt: now,
    turns: []
  };
  await saveConversation(conv);
  return conv;
}

export async function deleteConversation(id: string): Promise<boolean> {
  await ensureDirs();
  if (!/^[a-f0-9]{1,32}$/.test(id)) return false;
  try {
    await unlink(path.join(CONV_DIR, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}
