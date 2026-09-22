// Live failover: move a running Claude Code / Codex tmux session to another
// provider account without losing its conversation.
//
// The gateway can swap API keys between requests, but it never substitutes one
// subscription login for another: the CLI process owns its claude.ai / ChatGPT
// token. So when a login hits its usage limit and the next best provider is a
// different subscription, the only way forward is to relaunch the CLI with that
// account's config dir and resume the same conversation. This module does that
// in place — same tmux session, same window, same cwd — and a supervisor calls
// it automatically when a session's screen or the gateway log shows the limit.
import { execFile } from "node:child_process";
import Database from "better-sqlite3";
import { access, copyFile, mkdir, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { envValue } from "./config.js";
import {
  accountStatuses,
  ensureClaudeOnboarded,
  findRoute,
  gatewayRequest,
  gatewayState,
  launchCommand,
  launchSpec,
  type AccountStatus
} from "./gateway-client.js";
import { accountCatalog, findAccount, type Lane } from "./gateway-config.js";
import type { Gateway } from "./gateway-core.js";
import { recordEvent } from "./monitor.js";
import { invalidateSessionCache, listManagedSessions, managedSessionCommand, tmux, type ManagedSession } from "./sessions.js";

const execFileAsync = promisify(execFile);

type GatewayView = ReturnType<Gateway["view"]>;
/** The slice of a gateway route the failover logic reads (the real view and test fixtures both satisfy it). */
export type RouteLike = {
  id: string; lane: Lane; authType: string; account: string | null; available: boolean;
  health?: { cooling?: boolean; status?: string } | null;
  counters?: { lastErrorAt?: number | null; lastOkAt?: number | null } | null;
};
/** An "error" health status is only disqualifying while it is fresh; it persists until the next success. */
const STALE_ERROR_MS = 15 * 60_000;
export type LogLike = { session: string; status: number; at: number; error: string | null };

// ── Limit detection ───────────────────────────────────────────────────────

/**
 * What the CLIs print when a subscription is exhausted. Only the last few
 * lines are checked — the banner sits right above the prompt box — so tool
 * output or an agent merely *talking* about limits higher up does not match.
 */
export const LIMIT_PATTERNS: Record<Lane, RegExp[]> = {
  claude: [
    /You['’]ve hit your (usage |monthly |weekly |session |fast |extra usage )?limit\b/i,
    /\busage limit (reached|exceeded)\b/i,
    /hit your (team['’]s shared budget|monthly spend limit|channel['’]s monthly spend limit)/i,
    /\bClaude (AI )?usage limit reached\b/i
  ],
  codex: [
    /You['’]ve hit your (usage|rate) limit/i,
    /\bhit your usage limit\b/i,
    /\bhit your spend cap\b/i,
    /\busage limit reached\b/i
  ]
};

export function limitReason(lane: Lane, output: string, lines = 8): string | null {
  // The input box line (❯ / › / >) is the user's own draft, not a banner.
  const tail = output.split("\n").slice(-lines).filter((line) => !/^\s*[❯›>]/.test(line)).join("\n");
  for (const pattern of LIMIT_PATTERNS[lane]) {
    const match = pattern.exec(tail);
    if (match) return match[0].replace(/\s+/g, " ").trim();
  }
  return null;
}

/** Gateway log entries showing this session was answered 429 recently (all its routes were limited). */
export function recentGatewayLimit<T extends LogLike>(log: T[], session: string, now: number, windowMs = 180_000): T | null {
  return log.find((entry) => entry.session === session && entry.status === 429 && now - entry.at <= windowMs) ?? null;
}

// ── Target selection ──────────────────────────────────────────────────────

export type ExhaustedIdentity = { routeId: string | null; account: string | null };

/**
 * The first route in the lane's preference order that can take over from an
 * exhausted login: enabled, not cooling down, and — for subscription routes —
 * signed in on a *different* account than the one that just ran out.
 */
export function chooseFailoverTarget<T extends RouteLike>(
  lane: Lane,
  order: string[],
  routes: T[],
  accounts: Pick<AccountStatus, "id" | "signedIn">[],
  exhausted: ExhaustedIdentity,
  now = Date.now()
): T | null {
  for (const id of order) {
    const route = routes.find((item) => item.id === id);
    if (!route || route.lane !== lane || !route.available) continue;
    if (route.id === exhausted.routeId) continue;
    if (route.health?.cooling) continue;
    if (route.health?.status === "error") {
      const lastErrorAt = route.counters?.lastErrorAt ?? null;
      const lastOkAt = route.counters?.lastOkAt ?? null;
      const fresh = lastErrorAt === null || now - lastErrorAt < STALE_ERROR_MS;
      if (fresh && (lastOkAt === null || lastOkAt < (lastErrorAt ?? Infinity))) continue;
    }
    if (route.authType === "passthrough") {
      if (!route.account || route.account === exhausted.account) continue;
      if (!accounts.some((account) => account.id === route.account && account.signedIn)) continue;
    }
    return route;
  }
  return null;
}

// ── Command rebuilding ────────────────────────────────────────────────────

const CLAUDE_RESUME_FLAGS = new Set(["--resume", "-r", "--continue", "-c", "--session-id", "--fork-session"]);
/** Claude Code flags that take a value; anything else without a dash is a prompt and is not replayed. */
const CLAUDE_VALUE_FLAGS = new Set([
  "--model", "--permission-mode", "--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--mcp-config", "--settings", "--agent", "--agents", "--append-system-prompt", "--system-prompt", "--max-turns",
  "--output-format", "--input-format", "--fallback-model", "--tools", "--permission-prompt-tool", "--name", "--effort", "--betas"
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Arguments for the relaunched CLI: the flags the user started it with (minus
 * anything about which conversation to open, and minus stale gateway `-c`
 * overrides), plus the new gateway arguments and the resume instruction.
 */
export function resumeArgv(lane: Lane, argv: string[], conversationId: string | null, gatewayArgs: string[]): string[] {
  const rest = argv.slice(1);
  if (lane === "claude") {
    const kept: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (CLAUDE_RESUME_FLAGS.has(token)) {
        if ((token === "--resume" || token === "-r" || token === "--session-id") && rest[index + 1] && !rest[index + 1].startsWith("-")) index += 1;
        continue;
      }
      if (token.startsWith("--resume=") || token.startsWith("--session-id=")) continue;
      if (!token.startsWith("-")) continue; // positional prompt: already in the transcript
      kept.push(token);
      if (CLAUDE_VALUE_FLAGS.has(token) && rest[index + 1] !== undefined && !rest[index + 1].startsWith("-")) {
        kept.push(rest[index + 1]);
        index += 1;
      }
    }
    return conversationId ? ["--resume", conversationId, ...kept] : kept;
  }

  // Codex: `-c key=value` overrides are global and go before the subcommand;
  // interactive flags (--yolo, -m, -s, ...) are accepted after `resume <id>`.
  const configPairs: string[] = [];
  const flags: string[] = [];
  let index = 0;
  if (rest[0] === "resume") {
    index = 1;
    if (rest[1] && !rest[1].startsWith("-")) index = 2;
  }
  for (; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "-c" || token === "--config") {
      const pair = rest[index + 1] ?? "";
      index += 1;
      if (/^model_providers?\b/.test(pair)) continue;
      configPairs.push("-c", pair);
      continue;
    }
    if (token === "--last" || token === "resume" || !token.startsWith("-")) continue;
    flags.push(token);
    if ((token === "-m" || token === "--model" || token === "-s" || token === "--sandbox" || token === "-a" || token === "--ask-for-approval" || token === "-p" || token === "--profile" || token === "-C" || token === "--cd" || token === "--add-dir") && rest[index + 1] !== undefined && !rest[index + 1].startsWith("-")) {
      flags.push(rest[index + 1]);
      index += 1;
    }
  }
  const head = [...configPairs, ...gatewayArgs];
  return conversationId ? [...head, "resume", conversationId, ...flags] : [...head, ...flags];
}

// ── Live process inspection ───────────────────────────────────────────────

export type LiveProcess = { pid: number; argv: string[]; env: Record<string, string>; cwd: string };
export type Conversation = { id: string; transcript: string | null };

async function readProc(pid: number, file: string): Promise<string> {
  return readFile(`/proc/${pid}/${file}`, "utf8");
}

async function children(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(pid)], { timeout: 2000 });
    return stdout.split("\n").map((line) => Number(line.trim())).filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

async function describe(pid: number): Promise<LiveProcess | null> {
  try {
    const argv = (await readProc(pid, "cmdline")).split("\0").filter((token, index, all) => index < all.length - 1 || token !== "");
    const env: Record<string, string> = {};
    for (const entry of (await readProc(pid, "environ")).split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    const cwd = await readlink(`/proc/${pid}/cwd`);
    return { pid, argv, env, cwd };
  } catch {
    return null;
  }
}

/** The agent process running inside the session's active pane, if any (the pane may have dropped to a shell). */
export async function inspectSessionProcess(session: string, lane: Lane): Promise<LiveProcess | null> {
  const panes = await tmux(["list-panes", "-t", session, "-F", "#{pane_active}\t#{pane_pid}"]);
  if (panes.code !== 0) throw new Error(panes.stderr.trim() || "tmux session not found");
  const active = panes.stdout.split("\n").map((line) => line.split("\t")).find((parts) => parts[0] === "1");
  const panePid = Number(active?.[1]);
  if (!Number.isInteger(panePid)) return null;
  const isAgent = (proc: LiveProcess | null) => Boolean(proc && path.basename(proc.argv[0] ?? "") === lane);

  const own = await describe(panePid);
  if (isAgent(own)) return own;
  // Breadth-first, two levels: `bash -lc wrapper` → agent, or shell → agent.
  let frontier = await children(panePid);
  for (let depth = 0; depth < 3 && frontier.length; depth += 1) {
    const described = await Promise.all(frontier.map((pid) => describe(pid)));
    const hit = described.find((proc) => isAgent(proc));
    if (hit) return hit;
    frontier = (await Promise.all(frontier.map((pid) => children(pid)))).flat();
  }
  return null;
}

export function accountForConfigDir(lane: Lane, dir: string | undefined): string | null {
  const resolved = path.resolve(dir || (lane === "claude" ? findAccount("claude-personal")!.dir : findAccount("chatgpt-personal")!.dir));
  return accountCatalog().find((account) => account.lane === lane && path.resolve(account.dir) === resolved)?.id ?? null;
}

/**
 * Which conversation the process has open. Claude Code writes
 * `<config dir>/sessions/<pid>.json` with the session id; Codex holds its
 * rollout file open, which carries the thread id in its name.
 */
export async function conversationOf(lane: Lane, proc: LiveProcess): Promise<Conversation | null> {
  if (lane === "claude") {
    const dir = proc.env.CLAUDE_CONFIG_DIR || findAccount("claude-personal")!.dir;
    try {
      const raw = JSON.parse(await readFile(path.join(dir, "sessions", `${proc.pid}.json`), "utf8")) as { sessionId?: string; cwd?: string };
      if (raw.sessionId && UUID.test(raw.sessionId)) {
        return { id: raw.sessionId, transcript: path.join(dir, "projects", projectSlug(raw.cwd || proc.cwd), `${raw.sessionId}.jsonl`) };
      }
    } catch {
      /* no session file: fall through */
    }
    return null;
  }
  try {
    const fds = await readdir(`/proc/${proc.pid}/fd`);
    for (const fd of fds) {
      const target = await readlink(`/proc/${proc.pid}/fd/${fd}`).catch(() => "");
      const match = /\/sessions\/.*rollout-.*-([0-9a-f-]{36})\.jsonl$/i.exec(target);
      if (match) return { id: match[1], transcript: target };
    }
  } catch {
    /* process gone */
  }
  const home = proc.env.CODEX_HOME || findAccount("chatgpt-personal")!.dir;
  const started = await processStartMs(proc.pid);
  // A resumed older thread has an old created_at but a fresh updated_at once
  // it has been used; a never-used fresh TUI has no thread at all yet.
  return codexThreadFromState(home, proc.cwd, (started ?? Date.now()) - 60_000);
}

/** Wall-clock start of a process (ms), from /proc: boot time + start ticks. */
export async function processStartMs(pid: number): Promise<number | null> {
  try {
    const [stat, sys] = await Promise.all([readProc(pid, "stat"), readFile("/proc/stat", "utf8")]);
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number(afterComm[19]); // field 22 overall
    const btime = Number(/^btime (\d+)/m.exec(sys)?.[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
    return (btime + startTicks / 100) * 1000;
  } catch {
    return null;
  }
}

/**
 * Codex closes its rollout file between turns, so an idle TUI shows no open
 * handle. Its state database lists every thread with cwd, originator and last
 * update: the interactive thread in the process's directory that was updated
 * after the process started is the one on screen.
 */
export async function codexThreadFromState(home: string, cwd: string, startedAfterMs: number): Promise<Conversation | null> {
  let file: string | null = null;
  try {
    const versions = (await readdir(home)).filter((name) => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (versions.length) file = path.join(home, versions[0]);
  } catch {
    return null;
  }
  if (!file) return null;
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const row = db.prepare(
      "SELECT id, rollout_path FROM threads WHERE cwd = ? AND originator = 'codex-tui' AND thread_source = 'user' AND updated_at_ms >= ? ORDER BY updated_at_ms DESC LIMIT 1"
    ).get(cwd, Math.floor(startedAfterMs)) as { id?: string; rollout_path?: string } | undefined;
    if (row?.id) return { id: row.id, transcript: row.rollout_path ?? null };
  } catch {
    /* schema changed or db locked */
  } finally {
    db?.close();
  }
  return null;
}

export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make the transcript visible to the new account's config dir. Claude account
 * dirs share `projects/` by symlink; Codex keeps `sessions/` per home, so the
 * rollout file is copied to the same relative path.
 */
export async function shareTranscript(lane: Lane, conversation: Conversation, fromDir: string, toDir: string): Promise<void> {
  if (!conversation.transcript || path.resolve(fromDir) === path.resolve(toDir)) return;
  const relative = path.relative(fromDir, conversation.transcript);
  if (relative.startsWith("..")) return;
  const dest = path.join(toDir, relative);
  if (await exists(dest)) return;
  if (lane === "claude") {
    // projects/ is normally a symlink to the default home; if it is not, copy.
    const projects = path.join(toDir, "projects");
    try {
      const real = await readlink(projects);
      if (path.resolve(path.dirname(projects), real) === path.resolve(fromDir, "projects")) return;
    } catch {
      /* not a symlink */
    }
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(conversation.transcript, dest);
}

// ── Route resolution & idleness ───────────────────────────────────────────

/**
 * The route a session should be relaunched on when none is asked for: the
 * route it already uses via the gateway, else the subscription route of the
 * login it runs with directly, else the lane default.
 */
export function currentRouteFor(
  session: string,
  lane: Lane,
  view: Pick<GatewayView, "assignments" | "defaults"> & { routes: RouteLike[] },
  directAccount: string | null
): string | null {
  const assignment = view.assignments[session];
  if (assignment) return assignment.route ?? view.defaults[lane];
  if (directAccount) {
    const own = view.routes.find((route) => route.lane === lane && route.authType === "passthrough" && route.account === directAccount && route.available);
    if (own) return own.id;
  }
  return view.defaults[lane];
}

const WORKING_HINT = /esc to interrupt|Esc to interrupt|\bthinking\b|\bworking\b/i;
const IDLE_MS = 5 * 60_000;

/** True when the CLI has been sitting at its prompt for a while: safe to restart without cutting a turn. */
export function isIdle(session: Pick<ManagedSession, "lastOutput" | "lastActivity" | "state">, now: number): boolean {
  if (session.state === "error") return true;
  if (!session.lastActivity || now - session.lastActivity < IDLE_MS) return false;
  const tail = session.lastOutput.split("\n").slice(-8).join("\n");
  return !WORKING_HINT.test(tail);
}

// ── Relaunch ──────────────────────────────────────────────────────────────

export type RelaunchResult = {
  session: string;
  lane: Lane;
  route: string;
  account: string | null;
  conversationId: string | null;
  previousAccount: string | null;
  command: string;
};

const inFlight = new Set<string>();

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Stop the CLI in `session`, then start it again in the same pane through the
 * gateway on `routeId`, resuming the conversation it had open. The gateway
 * assignment is re-created with the new login so the route is usable at once.
 */
export async function relaunchSession(session: string, routeId: string | null, reason: string, options: { source?: string } = {}): Promise<RelaunchResult> {
  if (inFlight.has(session)) throw new Error(`${session} is already being relaunched`);
  inFlight.add(session);
  try {
    const live = await listManagedSessions(true);
    const current = live.find((item) => item.name === session);
    if (!current) throw new Error("session no longer exists");
    const lane = current.agent;
    if (lane !== "claude" && lane !== "codex") throw new Error("only Claude Code and Codex sessions can be relaunched");

    const proc = await inspectSessionProcess(session, lane);
    const conversation = proc ? await conversationOf(lane, proc) : null;
    const previousDir = proc?.env[lane === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"];
    const previousAccount = accountForConfigDir(lane, previousDir);

    if (!routeId) {
      const gateway = await gatewayState();
      if (!gateway.up || !gateway.state) throw new Error(`gateway is not reachable: ${gateway.error ?? "unknown error"}`);
      routeId = currentRouteFor(session, lane, gateway.state, previousAccount);
      if (!routeId) throw new Error(`no ${lane} gateway route is configured; pick a default on the Gateway page`);
    }
    const route = findRoute(routeId);
    if (!route) throw new Error(`unknown route: ${routeId}`);
    if (route.lane !== lane) throw new Error(`route ${routeId} does not serve ${lane}`);

    const spec = await launchSpec(lane, session, route);
    const nextDir = spec.env[lane === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"];
    if (conversation && nextDir) {
      const fromDir = previousDir || (lane === "claude" ? findAccount("claude-personal")!.dir : findAccount("chatgpt-personal")!.dir);
      await shareTranscript(lane, conversation, fromDir, nextDir).catch((error) => {
        console.warn(`[Devy] could not share transcript for ${session}: ${(error as Error).message}`);
      });
    }

    // The session was already running in this directory, so it is trusted.
    if (lane === "claude" && nextDir) await ensureClaudeOnboarded(nextDir, proc?.cwd || current.paneCurrentPath, { trust: true });

    const argv = resumeArgv(lane, proc?.argv ?? [lane], conversation?.id ?? null, spec.args);
    const launch = launchCommand(lane, { ...spec, args: argv });
    const command = managedSessionCommand(lane, launch);

    // Re-register with the new login: `assign` refuses to change a live
    // session's account, so drop the old assignment first.
    await gatewayRequest("DELETE", `/sessions/${session}`).catch(() => {});
    await gatewayRequest("PUT", `/sessions/${session}`, { route: route.id, mode: "auto", account: spec.account });

    if (proc) {
      try {
        process.kill(proc.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      if (!(await waitForExit(proc.pid, 8000))) {
        try {
          process.kill(proc.pid, "SIGKILL");
        } catch {
          /* gone */
        }
        await waitForExit(proc.pid, 2000);
      }
    }
    const cwd = proc?.cwd || current.paneCurrentPath;
    const respawn = await tmux(["respawn-pane", "-k", "-t", session, "-c", cwd, "bash", "-lc", command]);
    if (respawn.code !== 0) throw new Error(respawn.stderr.trim() || "tmux respawn-pane failed");
    invalidateSessionCache();

    const result: RelaunchResult = { session, lane, route: route.id, account: spec.account, conversationId: conversation?.id ?? null, previousAccount, command };
    await recordEvent({
      agent: lane,
      type: "notification",
      session,
      repoPath: cwd,
      message: `${session} moved to ${route.label}: ${reason}. ${conversation ? `Restarted and resumed conversation ${conversation.id.slice(0, 8)}.` : "Restarted (no open conversation to resume)."}`,
      raw: { source: options.source ?? "failover", ...result }
    }).catch((error) => console.warn(`[Devy] could not record relaunch event: ${(error as Error).message}`));
    return result;
  } finally {
    inFlight.delete(session);
  }
}

// ── Supervisor ────────────────────────────────────────────────────────────

const POLL_MS = 10_000;
const RELAUNCH_COOLDOWN_MS = 10 * 60_000;
const NOTICE_COOLDOWN_MS = 30 * 60_000;
const lastRelaunch = new Map<string, number>();
const lastNotice = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
let ticking = false;

export type FailoverDecision =
  | { action: "skip"; session: string; why: string }
  | { action: "relaunch"; session: string; lane: Lane; route: string; reason: string }
  | { action: "stuck"; session: string; lane: Lane; reason: string };

/** Pure decision for one session; the supervisor executes it. */
export function decideFailover(
  session: Pick<ManagedSession, "name" | "agent" | "running" | "lastOutput">,
  view: Pick<GatewayView, "autoSwitch" | "assignments" | "defaults" | "order"> & { routes: RouteLike[]; log: LogLike[] },
  accounts: Pick<AccountStatus, "id" | "signedIn">[],
  currentAccount: string | null,
  now: number
): FailoverDecision {
  const name = session.name;
  if (session.agent !== "claude" && session.agent !== "codex") return { action: "skip", session: name, why: "not an agent session" };
  const lane = session.agent;
  if (!session.running) return { action: "skip", session: name, why: "not running" };
  if (!view.autoSwitch) return { action: "skip", session: name, why: "auto-switch is off" };
  const assignment = view.assignments[name] ?? null;
  if (assignment?.mode === "pinned") return { action: "skip", session: name, why: "pinned" };

  // A working CLI (spinner, "esc to interrupt") is mid-turn: whatever the
  // screen says came from tool output, not from the CLI giving up.
  const working = WORKING_HINT.test(session.lastOutput.split("\n").slice(-8).join("\n"));
  const screen = working ? null : limitReason(lane, session.lastOutput);
  const gatewayHit = recentGatewayLimit(view.log, name, now);
  if (!screen && !gatewayHit) return { action: "skip", session: name, why: "no limit seen" };
  const reason = screen ? `"${screen}" on screen` : `gateway answered 429 (${gatewayHit!.error?.slice(0, 120) ?? "rate limited"})`;

  const exhausted: ExhaustedIdentity = {
    routeId: assignment ? assignment.route ?? view.defaults[lane] : null,
    account: assignment ? assignment.account : currentAccount
  };
  const target = chooseFailoverTarget(lane, view.order[lane], view.routes, accounts, exhausted, now);
  if (!target) return { action: "stuck", session: name, lane, reason };
  // A gateway session with a warm key-based alternative fails over inside the
  // gateway on its next request; a restart would only lose the screen.
  if (assignment && target.authType !== "passthrough") return { action: "skip", session: name, why: `gateway will fail over to ${target.id}` };
  return { action: "relaunch", session: name, lane, route: target.id, reason };
}

export type AdoptResult = { session: string; ok: boolean; route?: string; conversationId?: string | null; error?: string; skipped?: string };

/**
 * Move sessions that talk to their provider directly onto the gateway, on the
 * route of the login they already use, resuming their conversations. With
 * `onlyIdle`, sessions in the middle of a turn are left for the next pass.
 */
export async function adoptDirectSessions(options: { onlyIdle?: boolean; sessions?: string[]; source?: string } = {}): Promise<AdoptResult[]> {
  const gateway = await gatewayState();
  if (!gateway.up || !gateway.state) throw new Error(`gateway is not reachable: ${gateway.error ?? "unknown error"}`);
  const view = gateway.state;
  const live = await listManagedSessions(true);
  const now = Date.now();
  const results: AdoptResult[] = [];
  for (const session of live) {
    if (session.agent !== "claude" && session.agent !== "codex") continue;
    if (session.name.startsWith("login-") || view.assignments[session.name]) continue;
    if (options.sessions && !options.sessions.includes(session.name)) continue;
    if (inFlight.has(session.name)) continue;
    const proc = await inspectSessionProcess(session.name, session.agent).catch(() => null);
    if (!proc) {
      results.push({ session: session.name, ok: false, skipped: "no agent process in the pane" });
      continue;
    }
    if (options.onlyIdle && !isIdle(session, now)) {
      results.push({ session: session.name, ok: false, skipped: "busy" });
      continue;
    }
    const account = accountForConfigDir(session.agent, proc.env[session.agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]);
    const routeId = currentRouteFor(session.name, session.agent, view, account);
    if (!routeId) {
      results.push({ session: session.name, ok: false, error: `no ${session.agent} gateway route configured` });
      continue;
    }
    lastRelaunch.set(session.name, now);
    try {
      const result = await relaunchSession(session.name, routeId, "moved onto the gateway so it can fail over", { source: options.source ?? "adopt" });
      results.push({ session: session.name, ok: true, route: result.route, conversationId: result.conversationId });
    } catch (error) {
      results.push({ session: session.name, ok: false, error: (error as Error).message });
    }
  }
  return results;
}

export async function failoverTick(now = Date.now()): Promise<FailoverDecision[]> {
  const gateway = await gatewayState();
  if (!gateway.up || !gateway.state) return [];
  const view = gateway.state;
  if (!view.autoSwitch) return [];
  const [accounts, sessions] = await Promise.all([accountStatuses(), listManagedSessions()]);
  const decisions: FailoverDecision[] = [];
  for (const session of sessions) {
    if (session.agent !== "claude" && session.agent !== "codex") continue;
    if (session.name.startsWith("login-")) continue;
    if (inFlight.has(session.name) || now - (lastRelaunch.get(session.name) ?? 0) < RELAUNCH_COOLDOWN_MS) continue;
    let currentAccount: string | null = null;
    let direct = false;
    if (!view.assignments[session.name]) {
      const proc = await inspectSessionProcess(session.name, session.agent).catch(() => null);
      currentAccount = accountForConfigDir(session.agent, proc?.env[session.agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]);
      direct = Boolean(proc);
    }
    const decision = decideFailover(session, view, accounts, currentAccount, now);
    // Everything should run through the gateway: a direct session that is
    // idle at its prompt is moved over now, so it can fail over later.
    if (decision.action === "skip" && direct && isIdle(session, now)) {
      const routeId = currentRouteFor(session.name, session.agent, view, currentAccount);
      if (routeId) {
        lastRelaunch.set(session.name, now);
        decisions.push({ action: "relaunch", session: session.name, lane: session.agent, route: routeId, reason: "moved onto the gateway so it can fail over" });
        await relaunchSession(session.name, routeId, "moved onto the gateway so it can fail over", { source: "failover-supervisor" }).catch((error) => {
          console.warn(`[Devy] could not move ${session.name} onto the gateway: ${(error as Error).message}`);
        });
        continue;
      }
    }
    decisions.push(decision);
    if (decision.action === "relaunch") {
      lastRelaunch.set(session.name, now);
      try {
        await relaunchSession(session.name, decision.route, decision.reason, { source: "failover-supervisor" });
      } catch (error) {
        console.warn(`[Devy] failover of ${session.name} failed: ${(error as Error).message}`);
        await recordEvent({ agent: decision.lane, type: "error", session: session.name, message: `Could not move ${session.name} to ${decision.route}: ${(error as Error).message}` }).catch(() => {});
      }
    } else if (decision.action === "stuck" && now - (lastNotice.get(session.name) ?? 0) > NOTICE_COOLDOWN_MS) {
      lastNotice.set(session.name, now);
      await recordEvent({
        agent: decision.lane,
        type: "notification",
        session: session.name,
        message: `${session.name} hit a usage limit (${decision.reason}) and no other signed-in provider is available. Sign in to another account or enable a key-based route on the Gateway page.`
      }).catch(() => {});
    }
  }
  return decisions;
}

export function startFailoverSupervisor(): void {
  if (timer || !envValue("ENABLE_LIVE_FAILOVER")) return;
  const run = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await failoverTick();
    } catch (error) {
      console.warn(`[Devy] failover tick failed: ${(error as Error).message}`);
    } finally {
      ticking = false;
    }
  };
  timer = setInterval(() => void run(), POLL_MS);
  timer.unref();
  setTimeout(() => void run(), 15_000).unref();
}
