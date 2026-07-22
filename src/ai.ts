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
import { agentToolsEnabled, runTool, toolDefinitions } from "./agent-tools.js";

const DEFAULT_MODEL = process.env.AGENT_OPS_AI_MODEL || "claude-opus-4-8";
const MAX_TOOL_ITERATIONS = 40;

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
      "You have real tools and act like Claude Code: run `bash`, `read_file`, and `write_file` to inspect and change anything on the box, and use `list_sessions` / `capture_session` / `send_session` to observe and unblock the OTHER Claude Code / Codex agents running in tmux. Prefer acting over guessing — when a question is answerable by running a command, run it. Chain tools until the task is actually done, then report the outcome first, concisely.",
      "Safety: you run as a non-root user behind Tailscale. Reversible actions: just do them. Irreversible or wide-blast-radius actions (deleting many files, killing production services, force-pushing, editing another agent's work): describe what you'll do and why before doing it. Never run destructive commands to 'clean up' unless asked.",
      "When you edit files, make the smallest correct change and say what you changed. Verify your work (build/test/inspect) when practical."
    );
  } else {
    lines.push(
      "Tools are currently disabled (ENABLE_AGENT_TOOLS=false), so answer from context only. Be concise, technically precise, and opinionated. Cite specific paths (file.py:line) when relevant."
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
      "ANTHROPIC_API_KEY is not set on this server. Add it to /etc/agent-ops.env (or .env), restart `agent-ops`, and try again.\n\nThe rest of the app still works without an API key.";
    send("delta", { text: reply });
    conversation.turns.push({ role: "assistant", content: reply, ts: new Date().toISOString() });
    await saveConversation(conversation);
    send("done", { conversationId: conversation.id });
    res.end();
    return;
  }

  const system = await buildSystemPrompt();
  const toolsOn = agentToolsEnabled();
  // The API needs full content blocks (tool_use/tool_result) preserved across
  // turns, so run the loop on a working copy and persist the new turns after.
  const work: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = conversation.turns.map(
    (t) => ({ role: t.role, content: t.content })
  );
  const baseLength = work.length;
  let lastText = "";

  const client = getClient();
  const clientClosed = { value: false };
  res.on("close", () => {
    clientClosed.value = true;
  });

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      if (clientClosed.value) break;
      let streamedText = "";
      const stream = client.messages.stream({
        model: DEFAULT_MODEL,
        max_tokens: 16000,
        // Adaptive thinking sharpens the tool-use decisions; the system prompt
        // carries the repo + memory digest and is stable, so cache it.
        thinking: toolsOn ? { type: "adaptive" } : undefined,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        // Client tools (bash/files/tmux) plus Anthropic's server-side web search
        // so the assistant can look things up online mid-task.
        tools: toolsOn
          ? ([...toolDefinitions(), { type: "web_search_20260209", name: "web_search", max_uses: 5 }] as Anthropic.ToolUnion[])
          : undefined,
        messages: work as Anthropic.MessageParam[]
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          streamedText += event.delta.text;
          send("delta", { text: event.delta.text });
        } else if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "tool_use") {
            // Surface the tool call as soon as the model commits to it.
            send("tool_start", { id: block.id, name: block.name });
          } else if (block.type === "server_tool_use") {
            send("tool_start", { id: block.id, name: block.name });
          }
        }
      }

      const finalMessage = await stream.finalMessage();
      if (finalMessage.usage) {
        send("usage", {
          input: finalMessage.usage.input_tokens,
          output: finalMessage.usage.output_tokens,
          cacheRead: finalMessage.usage.cache_read_input_tokens ?? 0
        });
      }
      if (streamedText.trim()) lastText = streamedText;

      // Keep the full content (incl. thinking) in the live loop so the model
      // sees its own reasoning; strip thinking only when persisting.
      work.push({ role: "assistant", content: finalMessage.content });

      if (finalMessage.stop_reason === "pause_turn") {
        // Server tool (e.g. web search) hit its per-turn limit; resume.
        continue;
      }
      if (finalMessage.stop_reason !== "tool_use") break;

      const toolUses = finalMessage.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        send("tool_use", { id: call.id, name: call.name, input: call.input });
        const result = await runTool(call.name, call.input, {
          onOutput: (chunk) => send("tool_output", { id: call.id, chunk })
        });
        send("tool_result", { id: call.id, isError: result.isError, content: result.content });
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: result.content,
          is_error: result.isError
        });
      }
      work.push({ role: "user", content: toolResults });
    }
  } catch (error) {
    const msg = friendlyApiError((error as Error).message);
    send("error", { message: msg });
    if (!lastText) lastText = msg;
  }

  // Persist every new turn from this exchange, dropping thinking blocks (they
  // are display-only and other models ignore them on resume).
  const now = new Date().toISOString();
  for (const turn of work.slice(baseLength)) {
    conversation.turns.push({ role: turn.role, content: stripThinking(turn.content), ts: now });
  }
  if (conversation.title === "New chat" || conversation.title === deriveTitle(message)) {
    conversation.title = deriveTitle(message);
  }
  await saveConversation(conversation);
  send("done", { conversationId: conversation.id });
  res.end();
}

// Thinking blocks must stay in the live loop (same-model replay) but are noise
// in persisted history, so remove them before saving.
function stripThinking(content: string | unknown[]): string | unknown[] {
  if (!Array.isArray(content)) return content;
  return content.filter((block) => {
    const type = (block as { type?: string })?.type;
    return type !== "thinking" && type !== "redacted_thinking";
  });
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
  if (lower.includes("credit balance is too low")) {
    return "Anthropic API credit balance is too low. Top up at console.anthropic.com (Billing), then retry — no code change needed.";
  }
  if (lower.includes("authentication") || lower.includes("invalid x-api-key") || lower.includes("401")) {
    return "ANTHROPIC_API_KEY is invalid or expired. Update it in /etc/agent-ops.env and restart agent-ops.";
  }
  if (lower.includes("rate_limit") || lower.includes("429")) {
    return "Anthropic API rate limit hit. Wait a moment and retry.";
  }
  if (lower.includes("overloaded") || lower.includes("529")) {
    return "Anthropic API is overloaded right now. Retry shortly.";
  }
  return `Anthropic API error: ${raw}`;
}

function deriveTitle(message: string): string {
  const stripped = message.replace(/^\/\w+\s+/, "");
  return stripped.split("\n")[0].slice(0, 80) || "New chat";
}
