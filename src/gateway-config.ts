// Shared between the gateway process (src/gateway.ts) and the dashboard
// (src/app.ts via src/gateway-client.ts): the catalog of upstream routes and
// login accounts, plus the small persisted state the gateway keeps.
//
// A "lane" is the wire format a client speaks. Claude Code speaks Anthropic
// Messages; Codex speaks OpenAI Responses. Every upstream in a lane accepts that
// format natively, so the gateway never translates — it only swaps credentials,
// optionally renames the model, and streams bytes through.
import os from "node:os";
import path from "node:path";

export type Lane = "claude" | "codex";

export type AuthSpec =
  | { type: "passthrough" } // forward the client's own login (claude.ai / ChatGPT OAuth)
  | { type: "bearer"; env: string } // Authorization: Bearer $env
  | { type: "x-api-key"; env: string } // x-api-key: $env  (Anthropic, Foundry)
  | { type: "api-key"; env: string }; // api-key: $env    (Azure OpenAI)

export type RouteDef = {
  id: string;
  lane: Lane;
  label: string;
  provider: string;
  description: string;
  /** Base URL. The client's path suffix (e.g. /v1/messages, /responses) is appended. */
  upstream: string | null;
  auth: AuthSpec;
  /** Login account whose token this route forwards (passthrough routes only). */
  account?: string;
  /** Exact model renames; "*" matches any model. */
  modelMap?: Record<string, string>;
  /** Prefix added to models not matched by modelMap, e.g. "anthropic." for Bedrock Mantle. */
  modelPrefix?: string;
  /** Drop a trailing -YYYYMMDD from model ids (Mantle wants unversioned ids). */
  stripDateSuffix?: boolean;
  /** Off until the operator enables it, e.g. an upstream that needs a deployment first. */
  defaultEnabled: boolean;
  /** Why the route is unavailable right now (missing key, missing deployment). */
  unavailableReason: string | null;
};

export type AccountDef = {
  id: string;
  lane: Lane;
  label: string;
  /** Directory the client keeps its login in: CLAUDE_CONFIG_DIR or CODEX_HOME. */
  dir: string;
  /** True when dir is the client's normal home (~/.claude, ~/.codex). */
  isDefaultHome: boolean;
};

export type SessionMode = "auto" | "pinned";

export type SessionAssignment = {
  /** Recorded at launch so following defaults cannot change the wire protocol. */
  lane?: Lane;
  route: string | null;
  mode: SessionMode;
  /** Account whose login the client was launched with; null = launched with a dummy token. */
  account: string | null;
  updatedAt: number;
};

export type GatewayState = {
  version: 1;
  autoSwitch: boolean;
  defaults: Record<Lane, string | null>;
  enabled: Record<string, boolean>;
  order: Record<Lane, string[]>;
  assignments: Record<string, SessionAssignment>;
  counters: Record<string, RouteCounters>;
};

export type RouteCounters = {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
};

export const home = process.env.HOME || os.homedir();
export const accountsDir = process.env.DEVY_ACCOUNTS_DIR || path.join(home, ".devy", "accounts");

export function gatewayUrl(): string {
  return (process.env.GATEWAY_URL || `http://127.0.0.1:${process.env.GATEWAY_PORT || 8791}`).replace(/\/$/, "");
}

export function accountCatalog(): AccountDef[] {
  return [
    { id: "claude-personal", lane: "claude", label: "Claude default account", dir: process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), isDefaultHome: true },
    { id: "claude-business", lane: "claude", label: "Claude business (Team/Enterprise)", dir: path.join(accountsDir, "claude-business"), isDefaultHome: false },
    { id: "chatgpt-personal", lane: "codex", label: "ChatGPT default account", dir: process.env.CODEX_HOME || path.join(home, ".codex"), isDefaultHome: true },
    { id: "chatgpt-business", lane: "codex", label: "ChatGPT business (Team)", dir: path.join(accountsDir, "chatgpt-business"), isDefaultHome: false }
  ];
}

export function findAccount(id: string | null | undefined): AccountDef | null {
  if (!id) return null;
  return accountCatalog().find((account) => account.id === id) ?? null;
}

/** Route catalog, evaluated against the current environment (keys present or not). */
export function routeCatalog(env: NodeJS.ProcessEnv = process.env): RouteDef[] {
  const region = env.BEDROCK_REGION || env.AWS_REGION || "us-east-1";
  const mantle = `https://bedrock-mantle.${region}.api.aws`;
  const azureOpenAI = (env.AZURE_OPENAI_BASE_URL || "").replace(/\/$/, "");
  const azureAnthropic = (env.AZURE_ANTHROPIC_BASE_URL || azureOpenAI.replace(/\/openai(\/v1)?$/, "/anthropic")).replace(/\/$/, "");
  const has = (key: string) => Boolean(env[key] && env[key]!.trim());
  const missing = (key: string) => (has(key) ? null : `${key} is not set`);

  return [
    // ── Claude lane (Anthropic Messages) ──────────────────────────────────
    {
      id: "claude-personal",
      lane: "claude",
      label: "Claude default account",
      provider: "Anthropic (claude.ai subscription)",
      description: "Forwards the session's own claude.ai login to api.anthropic.com. Usage counts against whichever plan is signed in to the default account.",
      upstream: "https://api.anthropic.com",
      auth: { type: "passthrough" },
      account: "claude-personal",
      defaultEnabled: true,
      unavailableReason: null
    },
    {
      id: "claude-business",
      lane: "claude",
      label: "Claude business",
      provider: "Anthropic (Team/Enterprise subscription)",
      description: "Uses the separately stored business login for sessions launched with that account.",
      upstream: "https://api.anthropic.com",
      auth: { type: "passthrough" },
      account: "claude-business",
      defaultEnabled: true,
      unavailableReason: null
    },
    {
      id: "claude-bedrock",
      lane: "claude",
      label: "Claude on Bedrock",
      provider: `Amazon Bedrock Mantle (${region})`,
      description: "Bedrock Mantle's Anthropic-compatible endpoint (/anthropic/v1/messages), authenticated with a Bedrock API key. Pay per token on AWS. Only the Claude models enabled in the Bedrock account and region are served.",
      upstream: `${mantle}/anthropic`,
      auth: { type: "bearer", env: "AWS_BEARER_TOKEN_BEDROCK" },
      modelPrefix: "anthropic.",
      stripDateSuffix: true,
      defaultEnabled: true,
      unavailableReason: missing("AWS_BEARER_TOKEN_BEDROCK")
    },
    {
      id: "claude-azure",
      lane: "claude",
      label: "Claude on Azure",
      provider: "Microsoft Foundry",
      description: "Claude served by Microsoft Foundry. Needs a Claude deployment in the Foundry resource first.",
      upstream: azureAnthropic || null,
      auth: { type: "x-api-key", env: "AZURE_OPENAI_API_KEY" },
      defaultEnabled: false,
      unavailableReason: azureAnthropic ? missing("AZURE_OPENAI_API_KEY") : "AZURE_OPENAI_BASE_URL is not set"
    },
    {
      id: "claude-key",
      lane: "claude",
      label: "Anthropic API key",
      provider: "Anthropic Console (pay per token)",
      description: "Direct API billing with ANTHROPIC_API_KEY.",
      upstream: "https://api.anthropic.com",
      auth: { type: "x-api-key", env: "ANTHROPIC_API_KEY" },
      defaultEnabled: false,
      unavailableReason: missing("ANTHROPIC_API_KEY")
    },
    // ── Codex lane (OpenAI Responses) ─────────────────────────────────────
    {
      id: "chatgpt-personal",
      lane: "codex",
      label: "ChatGPT default account",
      provider: "OpenAI (ChatGPT subscription)",
      description: "Forwards the session's own ChatGPT login to the Codex backend. Usage counts against whichever plan is signed in to the default account.",
      upstream: "https://chatgpt.com/backend-api/codex",
      auth: { type: "passthrough" },
      account: "chatgpt-personal",
      defaultEnabled: true,
      unavailableReason: null
    },
    {
      id: "chatgpt-business",
      lane: "codex",
      label: "ChatGPT business",
      provider: "OpenAI (ChatGPT Team subscription)",
      description: "Uses the separately stored business login for sessions launched with that account.",
      upstream: "https://chatgpt.com/backend-api/codex",
      auth: { type: "passthrough" },
      account: "chatgpt-business",
      defaultEnabled: true,
      unavailableReason: null
    },
    {
      id: "codex-azure",
      lane: "codex",
      label: "Codex on Azure",
      provider: "Azure OpenAI",
      description: `Azure OpenAI Responses API. Every model is served by the ${env.AZURE_OPENAI_DEPLOYMENT || "configured"} deployment.`,
      upstream: azureOpenAI || null,
      auth: { type: "api-key", env: "AZURE_OPENAI_API_KEY" },
      modelMap: env.AZURE_OPENAI_DEPLOYMENT ? { "*": env.AZURE_OPENAI_DEPLOYMENT } : undefined,
      defaultEnabled: true,
      unavailableReason: !azureOpenAI ? "AZURE_OPENAI_BASE_URL is not set" : !env.AZURE_OPENAI_DEPLOYMENT ? "AZURE_OPENAI_DEPLOYMENT is not set" : missing("AZURE_OPENAI_API_KEY")
    },
    {
      id: "codex-bedrock",
      lane: "codex",
      label: "Codex on Bedrock",
      provider: `Amazon Bedrock Mantle (${region})`,
      // Mantle only accepts the Responses API (which Codex speaks) for the
      // gpt-oss models; the frontier openai.gpt-5.x ids reject /v1/responses.
      description: `OpenAI models on Bedrock. Every model is served as ${env.BEDROCK_CODEX_MODEL || "openai.gpt-oss-120b"}.`,
      upstream: `${mantle}/v1`,
      auth: { type: "bearer", env: "AWS_BEARER_TOKEN_BEDROCK" },
      modelMap: { "*": env.BEDROCK_CODEX_MODEL || "openai.gpt-oss-120b" },
      defaultEnabled: true,
      unavailableReason: missing("AWS_BEARER_TOKEN_BEDROCK")
    },
    {
      id: "openai-key",
      lane: "codex",
      label: "OpenAI API key",
      provider: "OpenAI platform (pay per token)",
      description: "Direct API billing with OPENAI_API_KEY.",
      upstream: "https://api.openai.com/v1",
      auth: { type: "bearer", env: "OPENAI_API_KEY" },
      defaultEnabled: false,
      unavailableReason: missing("OPENAI_API_KEY")
    }
  ];
}

export function emptyCounters(): RouteCounters {
  return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, lastOkAt: null, lastErrorAt: null, lastError: null };
}

export function defaultState(catalog: RouteDef[]): GatewayState {
  const order: Record<Lane, string[]> = { claude: [], codex: [] };
  const enabled: Record<string, boolean> = {};
  for (const route of catalog) {
    order[route.lane].push(route.id);
    enabled[route.id] = route.defaultEnabled;
  }
  return {
    version: 1,
    autoSwitch: (process.env.GATEWAY_AUTO_SWITCH || "true") !== "false",
    defaults: {
      claude: order.claude.includes("claude-personal") ? "claude-personal" : order.claude[0] ?? null,
      codex: order.codex.includes("chatgpt-personal") ? "chatgpt-personal" : order.codex[0] ?? null
    },
    enabled,
    order,
    assignments: {},
    counters: {}
  };
}

/** Merge a persisted state with the current catalog so new routes appear and removed ones vanish. */
export function reconcileState(saved: Partial<GatewayState> | null, catalog: RouteDef[]): GatewayState {
  const base = defaultState(catalog);
  if (!saved) return base;
  const known = new Set(catalog.map((route) => route.id));
  const state: GatewayState = {
    ...base,
    autoSwitch: typeof saved.autoSwitch === "boolean" ? saved.autoSwitch : base.autoSwitch,
    assignments: saved.assignments ?? {},
    counters: saved.counters ?? {}
  };
  for (const [id, value] of Object.entries(saved.enabled ?? {})) {
    if (known.has(id)) state.enabled[id] = value;
  }
  for (const lane of ["claude", "codex"] as Lane[]) {
    const savedOrder = (saved.order?.[lane] ?? []).filter((id) => known.has(id));
    state.order[lane] = [...savedOrder, ...base.order[lane].filter((id) => !savedOrder.includes(id))];
    const savedDefault = saved.defaults?.[lane];
    state.defaults[lane] = savedDefault && known.has(savedDefault) ? savedDefault : base.defaults[lane];
  }
  return state;
}

/** Apply a route's model rename rules. Returns the input unchanged when no rule matches. */
export function mapModel(route: Pick<RouteDef, "modelMap" | "modelPrefix" | "stripDateSuffix">, model: string): string {
  if (route.modelMap?.[model]) return route.modelMap[model];
  if (route.modelMap?.["*"]) return route.modelMap["*"];
  let next = model;
  if (route.stripDateSuffix) next = next.replace(/-\d{8}$/, "");
  if (route.modelPrefix && !next.startsWith(route.modelPrefix)) next = route.modelPrefix + next;
  return next;
}

/** Session names the gateway treats as connectivity probes for one route: `_probe--<routeId>`. */
export const PROBE_PREFIX = "_probe--";
