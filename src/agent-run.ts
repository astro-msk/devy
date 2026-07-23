import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { agentToolsEnabled, runTool, toolDefinitions } from "./agent-tools.js";

// Neutral, provider-independent transcript pieces. These are what we persist and
// what the browser renders, so switching model providers never changes storage
// or the UI.
export type DisplayBlock =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown; output: string; isError: boolean };

export type ChatMessage = { role: "user" | "assistant"; text: string };
export type Emit = (event: string, data: unknown) => void;

const MAX_TOOL_ITERATIONS = 40;

export type Provider = "openai" | "anthropic";

export function providerName(): Provider {
  const explicit = (process.env.AGENT_OPS_AI_PROVIDER || "").toLowerCase();
  if (explicit === "openai" || explicit === "anthropic") return explicit;
  // Default to OpenAI when its key is present (the Anthropic key is out of
  // credits on this box); otherwise fall back to Anthropic.
  if (process.env.OPENAI_API_KEY) return "openai";
  return "anthropic";
}

export function aiConfigured(): boolean {
  return providerName() === "openai" ? Boolean(process.env.OPENAI_API_KEY) : Boolean(process.env.ANTHROPIC_API_KEY);
}

export function activeModel(): string {
  return providerName() === "openai" ? openaiModel() : anthropicModel();
}

function openaiModel(): string {
  return process.env.OPENAI_MODEL || "gpt-5.6";
}

function anthropicModel(): string {
  return process.env.AGENT_OPS_AI_MODEL || "claude-opus-4-8";
}

// Runs the agentic tool loop against the active provider, emitting SSE events
// (delta / tool_start / tool_use / tool_output / tool_result / usage) as it goes
// and returning the assistant's turn as neutral DisplayBlocks to persist.
export async function runAgent(system: string, history: ChatMessage[], emit: Emit): Promise<DisplayBlock[]> {
  return providerName() === "openai"
    ? runOpenAI(system, history, emit)
    : runAnthropic(system, history, emit);
}

// ─── OpenAI (Chat Completions + function calling) ───────────────────────────
let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

function openaiTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return toolDefinitions().map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
  }));
}

async function runOpenAI(system: string, history: ChatMessage[], emit: Emit): Promise<DisplayBlock[]> {
  const client = getOpenAI();
  const toolsOn = agentToolsEnabled();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...history.map((m) => ({ role: m.role, content: m.text }) as OpenAI.Chat.Completions.ChatCompletionMessageParam)
  ];
  const blocks: DisplayBlock[] = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const stream = await client.chat.completions.create({
      model: openaiModel(),
      messages,
      tools: toolsOn ? openaiTools() : undefined,
      stream: true,
      stream_options: { include_usage: true }
    });

    let text = "";
    let finish: string | null = null;
    const calls = new Map<number, { id: string; name: string; args: string; started: boolean }>();

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) {
        text += delta.content;
        emit("delta", { text: delta.content });
      }
      for (const tc of delta?.tool_calls || []) {
        const slot = calls.get(tc.index) || { id: "", name: "", args: "", started: false };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        if (!slot.started && slot.name && slot.id) {
          slot.started = true;
          emit("tool_start", { id: slot.id, name: slot.name });
        }
        calls.set(tc.index, slot);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) emit("usage", { output: chunk.usage.completion_tokens });
    }

    if (text.trim()) blocks.push({ type: "text", text });

    const toolCalls = [...calls.values()].filter((call) => call.name && call.id);
    if (!toolCalls.length || finish === "stop") break;

    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.args || "{}" }
      }))
    });

    for (const call of toolCalls) {
      let input: unknown = {};
      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch {
        input = {};
      }
      emit("tool_use", { id: call.id, name: call.name, input });
      const result = await runTool(call.name, input, {
        onOutput: (chunk) => emit("tool_output", { id: call.id, chunk })
      });
      emit("tool_result", { id: call.id, isError: result.isError, content: result.content });
      blocks.push({ type: "tool", id: call.id, name: call.name, input, output: result.content, isError: result.isError });
      messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
    }
  }

  return blocks;
}

// ─── Anthropic (kept for when the Anthropic key has credits) ─────────────────
let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

async function runAnthropic(system: string, history: ChatMessage[], emit: Emit): Promise<DisplayBlock[]> {
  const client = getAnthropic();
  const toolsOn = agentToolsEnabled();
  const work: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.text }));
  const blocks: DisplayBlock[] = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    let streamedText = "";
    const stream = client.messages.stream({
      model: anthropicModel(),
      max_tokens: 16000,
      thinking: toolsOn ? { type: "adaptive" } : undefined,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: toolsOn
        ? ([...toolDefinitions(), { type: "web_search_20260209", name: "web_search", max_uses: 5 }] as Anthropic.ToolUnion[])
        : undefined,
      messages: work
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        streamedText += event.delta.text;
        emit("delta", { text: event.delta.text });
      } else if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          emit("tool_start", { id: block.id, name: block.name });
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    if (finalMessage.usage) emit("usage", { output: finalMessage.usage.output_tokens });
    if (streamedText.trim()) blocks.push({ type: "text", text: streamedText });
    work.push({ role: "assistant", content: finalMessage.content });

    // Record any web_search the server ran, for the persisted transcript.
    for (const block of finalMessage.content) {
      if (block.type === "server_tool_use") {
        blocks.push({
          type: "tool",
          id: block.id,
          name: block.name,
          input: block.input,
          output: "(searched the web)",
          isError: false
        });
      }
    }

    if (finalMessage.stop_reason === "pause_turn") continue;
    if (finalMessage.stop_reason !== "tool_use") break;

    const toolUses = finalMessage.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolUses) {
      emit("tool_use", { id: call.id, name: call.name, input: call.input });
      const result = await runTool(call.name, call.input, {
        onOutput: (chunk) => emit("tool_output", { id: call.id, chunk })
      });
      emit("tool_result", { id: call.id, isError: result.isError, content: result.content });
      blocks.push({ type: "tool", id: call.id, name: call.name, input: call.input, output: result.content, isError: result.isError });
      toolResults.push({ type: "tool_result", tool_use_id: call.id, content: result.content, is_error: result.isError });
    }
    work.push({ role: "user", content: toolResults });
  }

  return blocks;
}
