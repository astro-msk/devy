import type { Response } from "express";
import {
  deleteMemory,
  getConversation,
  listMemories,
  newConversation,
  saveConversation,
  saveMemory,
  memoryDigest,
  type Conversation,
  type ConversationTurn
} from "./ai-memory.js";
import { indexDigest } from "./repo-index.js";
import { agentToolsEnabled } from "./agent-tools.js";
import { activeModel, aiConfigured, providerName, runAgent, type ChatMessage, type DisplayBlock } from "./agent-run.js";

export { aiConfigured, activeModel, providerName } from "./agent-run.js";

export async function buildSystemPrompt(): Promise<string> {
  const [memories, repos] = await Promise.all([memoryDigest(30), indexDigest(16000)]);
  const toolsOn = agentToolsEnabled();
  const lines = [
    "You are Mukil's agentic operator inside agent-ops, running on his dev server (host: devy, user: ubuntu).",
    "You help with two repositories:",
    " - Pilot: HVAC backoffice browser-agent framework at /home/ubuntu/work/repos/Pilot",
    " - Crucible: AI agent studio (FastAPI backend + RN mobile app) at /home/ubuntu/work/repos/Crucible",
    ""
  ];
  if (toolsOn) {
    lines.push(
      "You are a coding/ops agent with real tools: run `bash`, `read_file`, and `write_file` to inspect and change anything on the box, and use `list_sessions` / `capture_session` / `send_session` to observe and unblock the OTHER Claude Code / Codex agents running in tmux. Prefer acting over guessing — when a question is answerable by running a command, run it. Chain tools until the task is actually done, then report the outcome first, concisely.",
      "Safety: you run as a non-root user behind Tailscale. Reversible actions: just do them. Irreversible or wide-blast-radius actions (deleting many files, killing production services, force-pushing, editing another agent's work): describe what you'll do and why before doing it. Never run destructive commands to 'clean up' unless asked.",
      "When you edit files, make the smallest correct change and say what you changed. Verify your work (build/test/inspect) when practical."
    );
  } else {
    lines.push(
      "Tools are currently disabled (ENABLE_AGENT_TOOLS=false), so answer from context only. Be concise, technically precise, and opinionated. Cite specific paths (file.py:line) when relevant."
    );
  }
  if (toolsOn) {
    lines.push(
      "You ARE the agent-ops dashboard, and you can modify and redeploy YOURSELF. Your source is at /home/ubuntu/apps/agent-ops — TypeScript in src/ (backend, the AI agent = src/ai.ts + src/agent-run.ts + src/agent-tools.ts), static PWA in web/. You have full sudo (NOPASSWD ALL) on this host.",
      "To ship a backend change: edit files under src/, run `npm run build` in that directory, then redeploy. Restarting the service kills the process streaming this very reply, so ALWAYS restart DETACHED so your message finishes first: `nohup bash -c 'sleep 2; sudo systemctl restart agent-ops agent-sessions' >/dev/null 2>&1 &`. Tell the user the restart is queued and the change lands in ~2s.",
      "Frontend-only edits (web/) take effect on reload with no rebuild — bump CACHE_NAME in web/sw.js so clients pull the new files. Always `npm run build` (or at least `npx tsc --noEmit`) before restarting so a type error can't take the app down."
    );
  }
  lines.push(
    "When the user shares a preference or insight worth remembering, suggest saving it as a memory (/remember).",
    "Match the user's terseness — a short answer for short questions.",
    "",
    "## Persistent memory (your notes from prior chats)",
    memories,
    "",
    "## Repository snapshots (cached every 60s from disk)",
    repos
  );
  return lines.join("\n");
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
      providerName() === "openai"
        ? "OPENAI_API_KEY is not set on this server. Add it to /etc/agent-ops.env, restart `agent-ops`, and try again.\n\nThe rest of the app works without an API key."
        : "ANTHROPIC_API_KEY is not set on this server. Add it to /etc/agent-ops.env, restart `agent-ops`, and try again.\n\nThe rest of the app works without an API key.";
    send("delta", { text: reply });
    conversation.turns.push({ role: "assistant", content: reply, ts: new Date().toISOString() });
    await saveConversation(conversation);
    send("done", { conversationId: conversation.id });
    res.end();
    return;
  }

  const system = await buildSystemPrompt();
  // Provider messages are rebuilt fresh from a flattened text history; the live
  // tool loop keeps full provider-native context in memory inside runAgent.
  const history: ChatMessage[] = conversation.turns.map((turn) => ({ role: turn.role, text: turnText(turn.content) }));

  let blocks: DisplayBlock[] = [];
  try {
    blocks = await runAgent(system, history, send);
  } catch (error) {
    const msg = friendlyApiError((error as Error).message);
    send("error", { message: msg });
    if (!blocks.some((block) => block.type === "text")) blocks.push({ type: "text", text: msg });
  }

  conversation.turns.push({ role: "assistant", content: blocks, ts: new Date().toISOString() });
  if (conversation.title === "New chat" || conversation.title === deriveTitle(message)) {
    conversation.title = deriveTitle(message);
  }
  await saveConversation(conversation);
  send("done", { conversationId: conversation.id });
  res.end();
}

// Flatten a stored turn (plain string or DisplayBlock[]) into the text we replay
// to the model as prior context. Tool actions become a compact note so the model
// remembers what it already did without re-sending full tool payloads.
function turnText(content: ConversationTurn["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as DisplayBlock[]) {
    if (block?.type === "text") parts.push(block.text);
    else if (block?.type === "tool") parts.push(`[ran ${block.name}${block.isError ? " (error)" : ""}]`);
  }
  return parts.join("\n").trim();
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
        "Anything else goes to the agent, which can run **bash**, **read/write files**, **search the web**, and **observe & unblock your other tmux agents** (`list_sessions`, `capture_session`, `send_session`) — with Pilot + Crucible context attached."
      ].join("\n")
    };
  }

  return null;
}

// The raw SDK errors are JSON blobs; translate the ones that actually happen in
// this deployment into one-line guidance the phone UI can show.
function friendlyApiError(raw: string): string {
  const lower = raw.toLowerCase();
  const provider = providerName() === "openai" ? "OpenAI" : "Anthropic";
  const keyVar = providerName() === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const billing = providerName() === "openai" ? "platform.openai.com (Billing)" : "console.anthropic.com (Billing)";
  if (lower.includes("credit balance is too low") || lower.includes("insufficient_quota") || lower.includes("exceeded your current quota")) {
    return `${provider} API has no available credit/quota. Top up at ${billing}, then retry — no code change needed.`;
  }
  if (lower.includes("model_not_found") || lower.includes("does not exist") || lower.includes("no such model")) {
    return `The configured model isn't available on this ${provider} account. Set OPENAI_MODEL (or AGENT_OPS_AI_MODEL) to a model you have access to and restart agent-ops.`;
  }
  if (lower.includes("authentication") || lower.includes("invalid api key") || lower.includes("incorrect api key") || lower.includes("invalid x-api-key") || lower.includes("401")) {
    return `${keyVar} is invalid or expired. Update it in /etc/agent-ops.env and restart agent-ops.`;
  }
  if (lower.includes("rate_limit") || lower.includes("rate limit") || lower.includes("429")) {
    return `${provider} API rate limit hit. Wait a moment and retry.`;
  }
  if (lower.includes("overloaded") || lower.includes("529")) {
    return `${provider} API is overloaded right now. Retry shortly.`;
  }
  return `${provider} API error: ${raw}`;
}

function deriveTitle(message: string): string {
  const stripped = message.replace(/^\/\w+\s+/, "");
  return stripped.split("\n")[0].slice(0, 80) || "New chat";
}
