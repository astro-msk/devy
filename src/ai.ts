import Anthropic from "@anthropic-ai/sdk";
import type { Response } from "express";
import {
  deleteMemory,
  getConversation,
  listMemories,
  newConversation,
  saveConversation,
  saveMemory,
  memoryDigest,
  type Conversation
} from "./ai-memory.js";
import { indexDigest } from "./repo-index.js";

const DEFAULT_MODEL = process.env.AGENT_OPS_AI_MODEL || "claude-opus-4-8";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function buildSystemPrompt(): Promise<string> {
  const [memories, repos] = await Promise.all([memoryDigest(30), indexDigest(16000)]);
  return [
    "You are Mukil's personal repo assistant inside agent-ops. You help reason about two repositories:",
    " - Pilot: HVAC backoffice browser-agent framework at /home/ubuntu/work/repos/Pilot",
    " - Crucible: AI agent studio (FastAPI backend + RN mobile app) at /home/ubuntu/work/repos/Crucible",
    "",
    "Be concise, technically precise, and opinionated. Cite specific paths (file.py:line) when relevant.",
    "When the user shares a preference or insight worth remembering for later sessions, suggest saving it as a memory.",
    "If the user asks for changes, propose the smallest correct diff. Never invent file paths or APIs.",
    "Match the user's terseness — a short answer for short questions.",
    "",
    "## Persistent memory (your notes from prior chats)",
    memories,
    "",
    "## Repository snapshots (cached every 60s from disk)",
    repos
  ].join("\n");
}

type AskOptions = {
  conversationId?: string;
  message: string;
  res: Response;
};

export async function streamAsk({ conversationId, message, res }: AskOptions): Promise<void> {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let conversation: Conversation;
  if (conversationId) {
    const existing = await getConversation(conversationId);
    conversation = existing || (await newConversation(deriveTitle(message)));
  } else {
    conversation = await newConversation(deriveTitle(message));
  }
  send("conversation", { id: conversation.id, title: conversation.title });

  const userTurn = { role: "user" as const, content: message, ts: new Date().toISOString() };
  conversation.turns.push(userTurn);

  const intercepted = await interceptSlashCommand(message);
  if (intercepted) {
    send("delta", { text: intercepted.text });
    if (intercepted.memory) send("memory", intercepted.memory);
    conversation.turns.push({ role: "assistant", content: intercepted.text, ts: new Date().toISOString() });
    await saveConversation(conversation);
    send("done", { conversationId: conversation.id });
    res.end();
    return;
  }

  if (!aiConfigured()) {
    const reply =
      "ANTHROPIC_API_KEY is not set on this server. Add it to /etc/agent-ops.env (or .env), restart `agent-ops`, and try again.\n\nThe rest of the app still works without an API key.";
    send("delta", { text: reply });
    conversation.turns.push({ role: "assistant", content: reply, ts: new Date().toISOString() });
    await saveConversation(conversation);
    send("done", { conversationId: conversation.id });
    res.end();
    return;
  }

  const system = await buildSystemPrompt();
  const history = conversation.turns.map((t) => ({ role: t.role, content: t.content }));

  let assistantText = "";
  try {
    const stream = await getClient().messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      // The system prompt carries the repo + memory digest and is identical
      // across turns in a conversation; caching it makes follow-ups cheap.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: history
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        assistantText += event.delta.text;
        send("delta", { text: event.delta.text });
      }
    }
  } catch (error) {
    const msg = (error as Error).message;
    send("error", { message: msg });
    assistantText = assistantText || `Error from Anthropic API: ${msg}`;
  }

  conversation.turns.push({ role: "assistant", content: assistantText, ts: new Date().toISOString() });
  if (conversation.title === "New chat" || conversation.title === deriveTitle(message)) {
    conversation.title = deriveTitle(message);
  }
  await saveConversation(conversation);
  send("done", { conversationId: conversation.id });
  res.end();
}

async function interceptSlashCommand(message: string): Promise<{ text: string; memory?: { id: string; topic: string } } | null> {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) return null;

  const rememberMatch = trimmed.match(/^\/remember(?:\s+#(\S+))?\s+(.+)$/is);
  if (rememberMatch) {
    const tag = rememberMatch[1];
    const body = rememberMatch[2].trim();
    const topic = body.split(/[.!?\n]/)[0].slice(0, 80) || "memory";
    const saved = await saveMemory({ topic, body, tags: tag ? [tag] : [] });
    return {
      text: `Saved memory **${saved.topic}** (id ${saved.id})${tag ? ` with tag #${tag}` : ""}.`,
      memory: { id: saved.id, topic: saved.topic }
    };
  }

  const forgetMatch = trimmed.match(/^\/forget\s+([a-f0-9]{1,32})\s*$/i);
  if (forgetMatch) {
    const ok = await deleteMemory(forgetMatch[1]);
    return { text: ok ? `Forgot memory ${forgetMatch[1]}.` : `No memory with id ${forgetMatch[1]}.` };
  }

  if (/^\/memories\s*$/i.test(trimmed)) {
    const all = await listMemories();
    if (!all.length) return { text: "No memories saved yet." };
    const lines = all.map((m) => `- \`${m.id}\` **${m.topic}**${m.tags.length ? ` _(${m.tags.join(", ")})_` : ""}: ${m.body.slice(0, 160)}`);
    return { text: `# Saved memories (${all.length})\n${lines.join("\n")}` };
  }

  if (/^\/help\s*$/i.test(trimmed)) {
    return {
      text: [
        "**Slash commands**",
        "- `/remember [#tag] <text>` — save a memory the AI will recall in future chats",
        "- `/memories` — list all saved memories",
        "- `/forget <id>` — delete a memory by id",
        "- `/help` — this message",
        "",
        "Anything else is sent to Anthropic with Pilot + Crucible context attached."
      ].join("\n")
    };
  }

  return null;
}

function deriveTitle(message: string): string {
  const stripped = message.replace(/^\/\w+\s+/, "");
  return stripped.split("\n")[0].slice(0, 80) || "New chat";
}
