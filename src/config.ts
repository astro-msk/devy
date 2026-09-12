import { z } from "zod";

// Single source of truth for every environment variable Devy reads: its type,
// its default, and a one-line description. Modules read values through
// `envValue()` so a typo like AGENT_WAIT_ALERT_SECONDS=3O fails loudly at startup
// (see `assertValidConfig`) instead of silently becoming NaN → "never alert".
//
// Values are read lazily from process.env on every call rather than frozen at
// import time: tests flip variables at runtime, and a dozen tiny parses per
// request is far cheaper than a tmux call.

const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

// Range violations are clamped with a warning instead of failing startup: the
// old ad-hoc parsers already clamped silently, so a value that ran fine
// yesterday must not take the service down after an upgrade. Type errors
// (non-numeric, unknown enum member) are fatal — they never worked as intended.
let pendingWarnings: string[] = [];

function optionalString() {
  return z.preprocess(blankToUndefined, z.string().trim().optional());
}

function stringWithDefault(fallback: string) {
  return z.preprocess(blankToUndefined, z.string().trim().default(fallback));
}

function flag(fallback: boolean) {
  return z.preprocess(blankToUndefined, z.stringbool().default(fallback));
}

function integer(name: string, fallback: number, min: number, max: number) {
  return z.preprocess(
    blankToUndefined,
    z.coerce
      .number()
      .int()
      .default(fallback)
      .transform((value) => {
        if (value < min) {
          pendingWarnings.push(`${name}=${value} is below the minimum ${min}; using ${min}`);
          return min;
        }
        if (value > max) {
          pendingWarnings.push(`${name}=${value} is above the maximum ${max}; using ${max}`);
          return max;
        }
        return value;
      })
  );
}

function port(name: string, fallback: number) {
  return integer(name, fallback, 1, 65535);
}

const repositoryListSchema = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .refine(
      (value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .every((entry) => /^[A-Za-z0-9_-]+=\/.+$/.test(entry)),
      { message: "expected comma-separated Name=/absolute/path entries" }
    )
    .optional()
);

export const envSchema = z.object({
  // ── HTTP ─────────────────────────────────────────────────────────────────
  PORT: port("PORT", 8787),
  MANAGER_PORT: port("MANAGER_PORT", 8790),
  HOST: stringWithDefault("0.0.0.0"),
  TAILSCALE_ONLY: flag(false),
  AGENT_OPS_TOKEN: optionalString(),

  // ── tmux / repos ─────────────────────────────────────────────────────────
  REPO_PATH: optionalString(),
  CLAUDE_TMUX_SESSION: stringWithDefault("claude"),
  CODEX_TMUX_SESSION: stringWithDefault("codex"),
  ENABLE_AGENT_INPUT: flag(true),
  AGENT_WAIT_ALERT_SECONDS: integer("AGENT_WAIT_ALERT_SECONDS", 30, 10, 3600),
  EVENT_RETENTION_DAYS: integer("EVENT_RETENTION_DAYS", 90, 1, 3650),

  // ── Slack ────────────────────────────────────────────────────────────────
  SLACK_WEBHOOK_URL: optionalString(),
  SLACK_BOT_TOKEN: optionalString(),
  SLACK_APP_TOKEN: optionalString(),
  SLACK_USER_TOKEN: optionalString(),
  SLACK_CHANNEL_ID: optionalString(),
  SLACK_SOCKET_MODE: flag(false),
  ENABLE_AGENT_ALERTS: flag(true),
  SLACK_LOG_LEVEL: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() || undefined : value),
    z.enum(["info", "debug", "warn", "error"]).default("info")
  ),
  SLACK_WATCH_USER_ID: optionalString(),
  SLACK_WATCH_NAMES: optionalString(),
  SLACK_OBSERVE_CHANNELS: optionalString(),
  SLACK_TRIAGE_CHANNEL_ID: optionalString(),
  SLACK_CONTEXT_MESSAGES: integer("SLACK_CONTEXT_MESSAGES", 12, 3, 30),
  SLACK_CHAT_HISTORY_TURNS: integer("SLACK_CHAT_HISTORY_TURNS", 20, 2, 60),
  SLACK_CHAT_TIMEOUT_SECONDS: integer("SLACK_CHAT_TIMEOUT_SECONDS", 300, 30, 1800),
  SLACK_ACK_REMINDER_MINUTES: integer("SLACK_ACK_REMINDER_MINUTES", 30, 1, 1440),
  SLACK_TRIAGE_TIMEOUT_SECONDS: integer("SLACK_TRIAGE_TIMEOUT_SECONDS", 600, 60, 1800),
  SLACK_BUILD_TIMEOUT_SECONDS: integer("SLACK_BUILD_TIMEOUT_SECONDS", 3600, 300, 7200),
  SLACK_CODEX_MODEL: optionalString(),
  DEVY_REPOSITORIES: repositoryListSchema,

  // ── AI assistant / agent ─────────────────────────────────────────────────
  AGENT_OPS_AI_PROVIDER: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() || undefined : value),
    z.enum(["openai", "anthropic"]).optional()
  ),
  OPENAI_API_KEY: optionalString(),
  OPENAI_MODEL: stringWithDefault("gpt-5.6"),
  ANTHROPIC_API_KEY: optionalString(),
  AGENT_OPS_AI_MODEL: stringWithDefault("claude-opus-4-8"),
  ENABLE_AGENT_TOOLS: flag(true),
  AGENT_BASH_TIMEOUT_SECONDS: integer("AGENT_BASH_TIMEOUT_SECONDS", 180, 1, 3600),
  AGENT_UNRESTRICTED_BASH: flag(false),

  // ── Gateway (validated here; consumed by src/gateway*.ts) ────────────────
  GATEWAY_PORT: port("GATEWAY_PORT", 8791),
  GATEWAY_HOST: stringWithDefault("127.0.0.1"),
  GATEWAY_URL: optionalString(),
  GATEWAY_AUTO_SWITCH: flag(true),
  DEVY_ACCOUNTS_DIR: optionalString(),
  AWS_BEARER_TOKEN_BEDROCK: optionalString(),
  BEDROCK_REGION: stringWithDefault("us-east-1"),
  BEDROCK_CODEX_MODEL: stringWithDefault("openai.gpt-5.6-sol"),
  AZURE_OPENAI_API_KEY: optionalString(),
  AZURE_OPENAI_BASE_URL: optionalString(),
  AZURE_OPENAI_DEPLOYMENT: optionalString(),
  AZURE_ANTHROPIC_BASE_URL: optionalString()
});

export type Config = z.infer<typeof envSchema>;
export type ConfigKey = keyof Config;

// Human explanations for the fatal message. Kept next to the schema so adding a
// variable without documenting it is a type error.
export const configDocs: Record<ConfigKey, string> = {
  PORT: "TCP port for the main dashboard (default 8787)",
  MANAGER_PORT: "TCP port for the multi-session manager (default 8790)",
  HOST: "interface to bind (default 0.0.0.0)",
  TAILSCALE_ONLY: "true = only localhost and Tailscale (100.64/10, fd7a:115c:a1e0::/48) clients may read (default false)",
  AGENT_OPS_TOKEN: "bearer token required for non-localhost Tailscale writes; Cloudflare Access authorizes public writes",
  REPO_PATH: "fallback repository path when a tmux pane has no directory (default: process cwd)",
  CLAUDE_TMUX_SESSION: "tmux session used by the legacy /api/agents/claude/input endpoint (default claude)",
  CODEX_TMUX_SESSION: "tmux session used by the legacy /api/agents/codex/input endpoint (default codex)",
  ENABLE_AGENT_INPUT: "false = disable browser/Slack typing into tmux sessions (default true)",
  AGENT_WAIT_ALERT_SECONDS: "seconds a session must look like it needs input before alerting (default 30, range 10-3600)",
  EVENT_RETENTION_DAYS: "days to keep events, Slack alert threads and chat turns in SQLite (default 90, range 1-3650)",
  SLACK_WEBHOOK_URL: "incoming webhook for alerts when no bot token is set",
  SLACK_BOT_TOKEN: "xoxb- bot token for posting alerts and reports",
  SLACK_APP_TOKEN: "xapp- app-level token for Socket Mode",
  SLACK_USER_TOKEN: "xoxp- user token for workspace-wide context reads",
  SLACK_CHANNEL_ID: "channel for legacy alerts and fallback triage reports",
  SLACK_SOCKET_MODE: "true = start the Socket Mode listener (default false)",
  ENABLE_AGENT_ALERTS: "false = record events but never post tmux/hook alerts to Slack (default true)",
  SLACK_LOG_LEVEL: "Bolt log level: info, debug, warn or error (default info)",
  SLACK_WATCH_USER_ID: "Slack member ID whose mentions Devy triages",
  SLACK_WATCH_NAMES: "comma-separated bare names that also trigger triage (default: none)",
  SLACK_OBSERVE_CHANNELS: "comma-separated channel allowlist (default: every delivered channel)",
  SLACK_TRIAGE_CHANNEL_ID: "channel for triage reports (default SLACK_CHANNEL_ID)",
  SLACK_CONTEXT_MESSAGES: "surrounding Slack messages to include in a triage (default 12, range 3-30)",
  SLACK_CHAT_HISTORY_TURNS: "conversation turns replayed to the chat agent (default 20, range 2-60)",
  SLACK_CHAT_TIMEOUT_SECONDS: "Codex timeout for a chat reply (default 300, range 30-1800)",
  SLACK_ACK_REMINDER_MINUTES: "cadence for re-pinging unacknowledged reports (default 30, range 1-1440)",
  SLACK_TRIAGE_TIMEOUT_SECONDS: "Codex timeout for a triage analysis (default 600, range 60-1800)",
  SLACK_BUILD_TIMEOUT_SECONDS: "Codex timeout for an approved build (default 3600, range 300-7200)",
  SLACK_CODEX_MODEL: "model passed to `codex exec --model` (default: Codex's own default)",
  DEVY_REPOSITORIES: "comma-separated Name=/absolute/path repositories Codex may inspect (default Pilot and Crucible under /home/ubuntu/work/repos)",
  AGENT_OPS_AI_PROVIDER: "force openai or anthropic (default: openai when OPENAI_API_KEY is set, else anthropic)",
  OPENAI_API_KEY: "OpenAI API key for the dashboard agent",
  OPENAI_MODEL: "OpenAI model for the dashboard agent (default gpt-5.6)",
  ANTHROPIC_API_KEY: "Anthropic API key for the dashboard agent",
  AGENT_OPS_AI_MODEL: "Anthropic model for the dashboard agent (default claude-opus-4-8)",
  ENABLE_AGENT_TOOLS: "false = chat only, no bash/file/tmux tools for the dashboard agent (default true)",
  AGENT_BASH_TIMEOUT_SECONDS: "kill an agent bash command after this long (default 180, range 1-3600)",
  AGENT_UNRESTRICTED_BASH: "true = drop the destructive-command guard on the agent's bash tool (default false)",
  GATEWAY_PORT: "loopback port of the provider gateway (default 8791)",
  GATEWAY_HOST: "interface the gateway binds (default 127.0.0.1)",
  GATEWAY_URL: "where the dashboard reaches the gateway (default http://127.0.0.1:GATEWAY_PORT)",
  GATEWAY_AUTO_SWITCH: "fail over to the next enabled route on rate limits or errors (default true)",
  DEVY_ACCOUNTS_DIR: "login directories for non-default accounts (default ~/.devy/accounts)",
  AWS_BEARER_TOKEN_BEDROCK: "Bedrock API key; enables the claude-bedrock and codex-bedrock routes",
  BEDROCK_REGION: "Bedrock region (default us-east-1)",
  BEDROCK_CODEX_MODEL: "model every Codex request is served as on Bedrock (default openai.gpt-5.6-sol)",
  AZURE_OPENAI_API_KEY: "Azure OpenAI / Foundry key; enables the codex-azure route",
  AZURE_OPENAI_BASE_URL: "Azure OpenAI base URL, e.g. https://<resource>.services.ai.azure.com/openai/v1",
  AZURE_OPENAI_DEPLOYMENT: "Azure OpenAI deployment name",
  AZURE_ANTHROPIC_BASE_URL: "override for the Claude-on-Foundry base URL (default: same host + /anthropic)"
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid environment configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export type ReadConfigResult = { config: Config; warnings: string[] };

/** Parse a whole environment. Throws ConfigError listing every bad variable. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ReadConfigResult {
  pendingWarnings = [];
  const parsed = envSchema.safeParse(env);
  const warnings = pendingWarnings;
  pendingWarnings = [];
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const key = String(issue.path[0]) as ConfigKey;
      const shown = JSON.stringify(env[key] ?? "");
      return `${key}=${shown}: ${issue.message} (${configDocs[key] ?? "undocumented"})`;
    });
    throw new ConfigError(problems);
  }
  return { config: parsed.data, warnings };
}

/** Read one variable with its default and validation applied. */
export function envValue<K extends ConfigKey>(key: K, env: NodeJS.ProcessEnv = process.env): Config[K] {
  pendingWarnings = [];
  // The shape is a union of every field's schema; narrowing by key is exactly
  // what z.infer already did for Config[K], so the cast is sound.
  const field = envSchema.shape[key] as unknown as z.ZodType<Config[K]>;
  const parsed = field.safeParse(env[key]);
  pendingWarnings = [];
  if (!parsed.success) {
    throw new ConfigError([`${key}=${JSON.stringify(env[key] ?? "")}: ${parsed.error.issues[0]?.message} (${configDocs[key]})`]);
  }
  return parsed.data;
}

/** Split a comma-separated list variable into trimmed, non-empty entries. */
export function envList(key: ConfigKey, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = envValue(key, env);
  return typeof raw === "string"
    ? raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

/**
 * Validate the whole environment once at startup. A bad value is fatal here,
 * where the operator is watching the journal, rather than a NaN discovered by
 * a timer three hours later. Range clamps are logged, not fatal.
 */
export function assertValidConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    const { config, warnings } = readConfig(env);
    for (const warning of warnings) console.warn(`[Devy] config warning: ${warning}`);
    return config;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[Devy] ${error.message}\nFix the value in /etc/agent-ops.env (systemd) or .env (local) and restart.`);
      process.exit(1);
    }
    throw error;
  }
}
