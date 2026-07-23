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

// Responses API tool shape: functions are flat (not nested under `.function`).
// gpt-5.x reasoning models reject function tools on /v1/chat/completions, so we
// use /v1/responses, which supports tools + reasoning together.
function openaiTools(): OpenAI.Responses.Tool[] {
  return toolDefinitions().map(
    (tool) =>
      ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        strict: false
      }) as OpenAI.Responses.Tool
  );
}

async function runOpenAI(system: string, history: ChatMessage[], emit: Emit): Promise<DisplayBlock[]> {
  const client = getOpenAI();
  const toolsOn = agentToolsEnabled();
  const input: OpenAI.Responses.ResponseInputItem[] = history.map(
    (m) => ({ role: m.role, content: m.text }) as OpenAI.Responses.ResponseInputItem
  );
  const blocks: DisplayBlock[] = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const stream = await client.responses.create({
      model: openaiModel(),
      instructions: system,
      input,
      tools: toolsOn ? openaiTools() : undefined,
      stream: true
    });

    let text = "";
    let final: OpenAI.Responses.Response | null = null;

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        text += event.delta;
        emit("delta", { text: event.delta });
      } else if (event.type === "response.output_item.added" && event.item.type === "function_call") {
        emit("tool_start", { id: event.item.call_id, name: event.item.name });
      } else if (event.type === "response.completed") {
        final = event.response;
      }
    }

    if (text.trim()) blocks.push({ type: "text", text });
    if (final?.usage) emit("usage", { output: final.usage.output_tokens });

    const fnCalls = (final?.output || []).filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call"
    );
    if (!fnCalls.length) break;

    // Feed the model's own output (message + reasoning + function_call items)
    // back in, then append each tool result, and loop. Cast bridges the
    // output-item vs input-item union mismatch in the SDK types.
    if (final?.output) input.push(...(final.output as unknown as OpenAI.Responses.ResponseInputItem[]));

    for (const call of fnCalls) {
      let toolInput: unknown = {};
      try {
        toolInput = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        toolInput = {};
      }
      emit("tool_use", { id: call.call_id, name: call.name, input: toolInput });
      const result = await runTool(call.name, toolInput, {
        onOutput: (chunk) => emit("tool_output", { id: call.call_id, chunk })
      });
      emit("tool_result", { id: call.call_id, isError: result.isError, content: result.content });
      blocks.push({ type: "tool", id: call.call_id, name: call.name, input: toolInput, output: result.content, isError: result.isError });
      input.push({ type: "function_call_output", call_id: call.call_id, output: result.content });
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
