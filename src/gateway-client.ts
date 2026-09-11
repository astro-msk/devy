// Dashboard-side helpers for the gateway: talk to its admin API, prepare
// per-account login directories, build the env/args that point a new Claude
// Code or Codex session at the gateway, and run connectivity probes with the
// real clients.
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  accountCatalog,
  findAccount,
  gatewayUrl,
  PROBE_PREFIX,
  routeCatalog,
  type AccountDef,
  type Lane,
  type RouteDef
} from "./gateway-config.js";

const execFileAsync = promisify(execFile);

export type AccountStatus = AccountDef & {
  signedIn: boolean;
  detail: string | null;
  expiresAt: number | null;
  loginSession: string;
};

export type LaunchSpec = { env: Record<string, string>; args: string[]; account: string | null };

// ── Admin API ─────────────────────────────────────────────────────────────

export async function gatewayRequest<T = unknown>(method: string, apiPath: string, body?: unknown): Promise<T> {
  const response = await fetch(`${gatewayUrl()}/_gw${apiPath}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || `gateway HTTP ${response.status}`);
  return payload;
}

export async function gatewayState(): Promise<{ up: boolean; error?: string; state: Awaited<ReturnType<typeof gatewayRequest>> | null }> {
  try {
    return { up: true, state: await gatewayRequest("GET", "/state") };
  } catch (error) {
    return { up: false, error: (error as Error).message, state: null };
  }
}

// ── Accounts ──────────────────────────────────────────────────────────────

export async function accountStatuses(): Promise<AccountStatus[]> {
  return Promise.all(accountCatalog().map((account) => accountStatus(account)));
}

async function accountStatus(account: AccountDef): Promise<AccountStatus> {
  const base = { ...account, signedIn: false, detail: null as string | null, expiresAt: null as number | null, loginSession: loginSessionName(account.id) };
  try {
    if (account.lane === "claude") {
      const raw = JSON.parse(await readFile(path.join(account.dir, ".credentials.json"), "utf8")) as { claudeAiOauth?: { expiresAt?: number; subscriptionType?: string; refreshTokenExpiresAt?: number } };
      const oauth = raw.claudeAiOauth;
      if (!oauth) return { ...base, detail: "no claude.ai login" };
      const refreshDeadline = oauth.refreshTokenExpiresAt ?? null;
      const alive = !refreshDeadline || refreshDeadline > Date.now();
      return {
        ...base,
        signedIn: alive,
        expiresAt: refreshDeadline,
        detail: alive ? `claude.ai ${oauth.subscriptionType ?? "subscription"}` : "login expired — sign in again"
      };
    }
    const raw = JSON.parse(await readFile(path.join(account.dir, "auth.json"), "utf8")) as { auth_mode?: string; OPENAI_API_KEY?: string | null; tokens?: { access_token?: string; account_id?: string } };
    if (raw.tokens?.access_token) return { ...base, signedIn: true, detail: `ChatGPT login${raw.tokens.account_id ? ` · account ${raw.tokens.account_id.slice(0, 8)}…` : ""}` };
    if (raw.OPENAI_API_KEY) return { ...base, signedIn: true, detail: "API key login (not a ChatGPT subscription)" };
    return { ...base, detail: "auth.json has no tokens" };
  } catch {
    return { ...base, detail: "not signed in" };
  }
}

export function loginSessionName(accountId: string): string {
  return `login-${accountId}`;
}

/**
 * Create the isolated config directory for a non-default account. The client's
 * personal settings, skills and memory are shared by symlink so the second
 * login behaves like the first; only credentials and history are separate.
 */
export async function prepareAccountDir(account: AccountDef): Promise<void> {
  if (account.isDefaultHome) return;
  await mkdir(account.dir, { recursive: true, mode: 0o700 });
  const home = findAccount(account.lane === "claude" ? "claude-personal" : "chatgpt-personal")!.dir;
  const link = async (name: string) => {
    const target = path.join(home, name);
    const dest = path.join(account.dir, name);
    if (!(await exists(target)) || (await exists(dest))) return;
    await symlink(target, dest);
  };
  if (account.lane === "claude") {
    const settings = path.join(account.dir, "settings.json");
    if (!(await exists(settings)) && (await exists(path.join(home, "settings.json")))) {
      await copyFile(path.join(home, "settings.json"), settings);
    }
    for (const name of ["projects", "skills", "plugins", "commands", "agents", "CLAUDE.md"]) await link(name);
  } else {
    const config = path.join(account.dir, "config.toml");
    if (!(await exists(config))) {
      if (await exists(path.join(home, "config.toml"))) await copyFile(path.join(home, "config.toml"), config);
      else await writeFile(config, "");
    }
    for (const name of ["skills", "rules", "plugins", "memories", "hooks.json", "vendor_imports"]) await link(name);
  }
}

// ── Launching sessions through the gateway ────────────────────────────────

/**
 * Environment and extra arguments that make a client send its traffic to the
 * gateway under `session`. Passthrough routes need the account's login dir;
 * key-based routes get a dummy token the gateway replaces, unless a signed-in
 * default account exists — then its login is used so the session can still be
 * switched to a subscription route later.
 */
export async function launchSpec(lane: Lane, session: string, route: RouteDef, accountId?: string | null): Promise<LaunchSpec> {
  const base = `${gatewayUrl()}/${lane}/${session}`;
  let account: AccountDef | null = null;
  if (route.auth.type === "passthrough") {
    account = findAccount(route.account);
    if (!account) throw new Error(`route ${route.id} has no login account`);
  } else if (accountId) {
    account = findAccount(accountId);
  } else {
    const fallback = findAccount(lane === "claude" ? "claude-personal" : "chatgpt-personal")!;
    account = (await accountStatus(fallback)).signedIn ? fallback : null;
  }
  if (account) await prepareAccountDir(account);

  if (lane === "claude") {
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: base };
    if (account && !account.isDefaultHome) env.CLAUDE_CONFIG_DIR = account.dir;
    if (!account) env.ANTHROPIC_AUTH_TOKEN = "devy-gateway";
    return { env, args: [], account: account?.id ?? null };
  }

  const env: Record<string, string> = {};
  if (account && !account.isDefaultHome) env.CODEX_HOME = account.dir;
  const args = [
    "-c", "model_provider=devy",
    "-c", 'model_providers.devy.name="Devy gateway"',
    "-c", `model_providers.devy.base_url="${base}"`,
    "-c", 'model_providers.devy.wire_api="responses"'
  ];
  if (account) {
    args.push("-c", "model_providers.devy.requires_openai_auth=true");
  } else {
    env.DEVY_GATEWAY_KEY = "devy-gateway";
    args.push("-c", 'model_providers.devy.env_key="DEVY_GATEWAY_KEY"');
  }
  return { env, args, account: account?.id ?? null };
}

export function findRoute(routeId: string): RouteDef | null {
  return routeCatalog().find((route) => route.id === routeId) ?? null;
}

/** POSIX single-quote a string for `bash -c`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function launchCommand(agent: Lane, spec: LaunchSpec | null): string {
  if (!spec) return agent;
  const envPart = Object.entries(spec.env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  const argPart = spec.args.map(shellQuote).join(" ");
  return `${envPart ? `env ${envPart} ` : ""}${agent}${argPart ? ` ${argPart}` : ""}`;
}

// ── Sign-in sessions ──────────────────────────────────────────────────────

/** The interactive login command for an account, run inside a tmux session the dashboard can show. */
export async function loginCommand(account: AccountDef): Promise<string> {
  await prepareAccountDir(account);
  if (account.lane === "claude") {
    const env = account.isDefaultHome ? "" : `env CLAUDE_CONFIG_DIR=${shellQuote(account.dir)} `;
    return `${env}claude auth login`;
  }
  const env = account.isDefaultHome ? "" : `env CODEX_HOME=${shellQuote(account.dir)} `;
  return `${env}codex login --device-auth`;
}

export async function signOut(account: AccountDef): Promise<void> {
  const file = path.join(account.dir, account.lane === "claude" ? ".credentials.json" : "auth.json");
  if (account.lane === "claude") {
    // Keep MCP OAuth entries; only drop the claude.ai login.
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      delete raw.claudeAiOauth;
      await writeFile(file, JSON.stringify(raw, null, 2), { mode: 0o600 });
      return;
    } catch {
      /* fall through */
    }
  }
  await rm(file, { force: true });
}

// ── Probes ────────────────────────────────────────────────────────────────

export type ProbeResult = { ok: boolean; via: "gateway" | "client"; ms: number; status?: number; model?: string; output: string; error?: string };

/**
 * Validate a route end to end. Key-based routes are probed by the gateway
 * itself; subscription routes need the real client because only it holds the
 * login, so we run a one-line prompt through `claude -p` / `codex exec`.
 */
export async function probeRoute(route: RouteDef): Promise<ProbeResult> {
  const started = Date.now();
  const direct = await gatewayRequest<{ ok: boolean; needsClient?: boolean; status?: number; ms?: number; model?: string; error?: string }>("POST", `/routes/${route.id}/probe`);
  if (!direct.needsClient) {
    return { ok: direct.ok, via: "gateway", ms: direct.ms ?? Date.now() - started, status: direct.status, model: direct.model, output: direct.ok ? "OK" : "", error: direct.error };
  }

  const session = `${PROBE_PREFIX}${route.id}`;
  const spec = await launchSpec(route.lane, session, route);
  await gatewayRequest("PUT", `/sessions/${session}`, { route: route.id, mode: "pinned", account: spec.account });
  const env = { ...process.env, ...spec.env };
  const prompt = "Reply with exactly: PROBE_OK";
  // No `--bare` for claude: bare mode skips the claude.ai login, which is the
  // very thing a passthrough probe exercises. stdin is closed so neither client
  // waits on a pipe.
  const opts = { env, timeout: 120_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] as const };
  try {
    const { stdout, stderr } =
      route.lane === "claude"
        ? await execFileAsync("claude", ["-p", prompt, "--max-turns", "1", "--no-session-persistence", "--model", "haiku", ...spec.args], opts)
        : await execFileAsync("codex", ["exec", "--skip-git-repo-check", "-C", "/tmp", ...spec.args, prompt], opts);
    const output = `${stdout}\n${stderr}`.trim();
    const ok = /PROBE_OK/.test(output);
    return { ok, via: "client", ms: Date.now() - started, output: tail(output), error: ok ? undefined : "client did not answer PROBE_OK" };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, via: "client", ms: Date.now() - started, output: tail(`${err.stdout ?? ""}\n${err.stderr ?? ""}`), error: err.message.split("\n")[0] };
  }
}

function tail(text: string, lines = 25): string {
  return text.trim().split("\n").slice(-lines).join("\n").slice(-4000);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
