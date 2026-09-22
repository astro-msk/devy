import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalDirectory = process.cwd();
const testDirectory = await mkdtemp(path.join(os.tmpdir(), "devy-failover-"));
process.chdir(testDirectory);
// Dynamic import: failover.ts pulls in monitor.ts → db.ts, which binds SQLite to cwd.
const { chooseFailoverTarget, currentRouteFor, decideFailover, isIdle, limitReason, projectSlug, recentGatewayLimit, resumeArgv } = await import("./failover.js");

after(async () => {
  process.chdir(originalDirectory);
  await rm(testDirectory, { recursive: true, force: true });
});

test("limitReason matches the CLIs' limit banners only near the bottom of the screen", () => {
  assert.equal(limitReason("claude", "…\nYou've hit your limit · resets 3pm (America/Los_Angeles)\n> "), "You've hit your limit");
  assert.equal(limitReason("claude", "Claude usage limit reached. Your limit will reset at 3pm.\n"), "usage limit reached");
  assert.equal(limitReason("codex", "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/…)\n› "), "You've hit your usage limit");
  // Casual mention far up the scrollback does not count.
  const chatter = ["Earlier I said: you've hit your limit, jokingly.", ...Array(30).fill("normal output line"), "> "].join("\n");
  assert.equal(limitReason("claude", chatter), null);
  assert.equal(limitReason("claude", "all good\n> "), null);
  // Typed into the prompt box, not printed by the CLI.
  assert.equal(limitReason("claude", "● ok\n❯ You've hit your limit — is that what it says?\n"), null);
});

test("recentGatewayLimit finds a fresh 429 for the session and ignores old or other sessions", () => {
  const now = 1_000_000;
  const entry = (session: string, status: number, at: number) => ({ id: 1, at, lane: "claude" as const, session, route: "claude-personal", attempts: 1, status, ms: 5, model: null, upstreamModel: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, error: "HTTP 429" });
  const log = [entry("a", 429, now - 10_000), entry("b", 429, now - 400_000), entry("c", 200, now - 1000)];
  assert.equal(recentGatewayLimit(log, "a", now)?.session, "a");
  assert.equal(recentGatewayLimit(log, "b", now), null);
  assert.equal(recentGatewayLimit(log, "c", now), null);
});

const routes = [
  { id: "claude-personal", lane: "claude" as const, authType: "passthrough", account: "claude-personal", available: true, health: { status: "cooling", coolUntil: 1, reason: null, limits: {}, limitsAt: null, cooling: true } },
  { id: "claude-business", lane: "claude" as const, authType: "passthrough", account: "claude-business", available: true, health: { status: "ok", coolUntil: null, reason: null, limits: {}, limitsAt: null, cooling: false } },
  { id: "claude-bedrock", lane: "claude" as const, authType: "bearer", account: null, available: true, health: { status: "ok", coolUntil: null, reason: null, limits: {}, limitsAt: null, cooling: false } },
  { id: "claude-key", lane: "claude" as const, authType: "x-api-key", account: null, available: false, health: { status: "unknown", coolUntil: null, reason: null, limits: {}, limitsAt: null, cooling: false } }
];
const order = ["claude-personal", "claude-business", "claude-bedrock", "claude-key"];

test("chooseFailoverTarget prefers the next signed-in subscription, then key routes, never the exhausted login", () => {
  const both = [{ id: "claude-personal", signedIn: true }, { id: "claude-business", signedIn: true }];
  assert.equal(chooseFailoverTarget("claude", order, routes, both, { routeId: "claude-personal", account: "claude-personal" })?.id, "claude-business");
  const businessOut = [{ id: "claude-personal", signedIn: true }, { id: "claude-business", signedIn: false }];
  assert.equal(chooseFailoverTarget("claude", order, routes, businessOut, { routeId: "claude-personal", account: "claude-personal" })?.id, "claude-bedrock");
  // A direct session (no route) on the personal login still skips that account.
  assert.equal(chooseFailoverTarget("claude", order, routes, both, { routeId: null, account: "claude-personal" })?.id, "claude-business");
  // Nothing left: the only other subscription is exhausted too and no key route is available.
  const cooled = routes.map((r) => (r.id === "claude-bedrock" ? { ...r, available: false } : r));
  assert.equal(chooseFailoverTarget("claude", order, cooled, both, { routeId: "claude-business", account: "claude-business" }), null);
});

test("chooseFailoverTarget skips a route with a fresh error but not a stale one", () => {
  const now = 10_000_000;
  const both = [{ id: "claude-personal", signedIn: true }, { id: "claude-business", signedIn: true }];
  const erroring = (lastErrorAt: number) => routes.map((r) => (r.id === "claude-business" ? { ...r, health: { ...r.health, status: "error", cooling: false }, counters: { lastErrorAt, lastOkAt: null } } : r));
  assert.equal(chooseFailoverTarget("claude", order, erroring(now - 60_000), both, { routeId: "claude-personal", account: "claude-personal" }, now)?.id, "claude-bedrock");
  assert.equal(chooseFailoverTarget("claude", order, erroring(now - 60 * 60_000), both, { routeId: "claude-personal", account: "claude-personal" }, now)?.id, "claude-business");
});

test("resumeArgv for Claude keeps launch flags, drops old resume/session flags and prompts, adds --resume", () => {
  const argv = ["claude", "--dangerously-skip-permissions", "--model", "opus", "--resume", "11111111-1111-1111-1111-111111111111", "--fork-session", "do the thing"];
  assert.deepEqual(resumeArgv("claude", argv, "22222222-2222-2222-2222-222222222222", []), [
    "--resume", "22222222-2222-2222-2222-222222222222", "--dangerously-skip-permissions", "--model", "opus"
  ]);
  assert.deepEqual(resumeArgv("claude", ["claude", "-c"], null, []), []);
});

test("resumeArgv for Codex replaces gateway -c overrides, keeps user flags after `resume <id>`", () => {
  const argv = ["codex", "--yolo", "-c", "model_provider=devy", "-c", 'model_providers.devy.base_url="http://old"', "-c", "features.apps=false", "-m", "gpt-5"];
  const gatewayArgs = ["-c", "model_provider=devy", "-c", 'model_providers.devy.base_url="http://127.0.0.1:8791/codex/s"'];
  assert.deepEqual(resumeArgv("codex", argv, "01a0c59d-cf7f-7391-8105-50afddae5c77", gatewayArgs), [
    "-c", "features.apps=false", ...gatewayArgs, "resume", "01a0c59d-cf7f-7391-8105-50afddae5c77", "--yolo", "-m", "gpt-5"
  ]);
  // Already a resumed session: the old id and --last are dropped.
  assert.deepEqual(resumeArgv("codex", ["codex", "resume", "--last", "--yolo"], null, []), ["--yolo"]);
});

test("projectSlug mirrors Claude Code's transcript directory naming", () => {
  assert.equal(projectSlug("/home/ubuntu/work/repos/Pilot"), "-home-ubuntu-work-repos-Pilot");
  assert.equal(projectSlug("/home/ubuntu/.devy/x"), "-home-ubuntu--devy-x");
});

test("decideFailover relaunches only when a limit is visible and another login exists", () => {
  const view = {
    autoSwitch: true,
    assignments: { "claude-pilot-1": { lane: "claude" as const, route: null, mode: "auto" as const, account: "claude-personal", updatedAt: 0 } },
    defaults: { claude: "claude-personal", codex: null },
    order: { claude: order, codex: [] as string[] },
    routes,
    log: [] as never[]
  };
  const accounts = [{ id: "claude-personal", signedIn: true }, { id: "claude-business", signedIn: true }];
  const limited = { name: "claude-pilot-1", agent: "claude" as const, running: true, lastOutput: "You've hit your limit · resets 3pm\n> " };
  const happy = { ...limited, lastOutput: "Done.\n> " };
  const now = Date.now();

  assert.equal(decideFailover(happy, view, accounts, null, now).action, "skip");
  // Tool output that quotes the banner while the CLI is still working is not a limit.
  const busy = { ...limited, lastOutput: "grep: You've hit your limit\n✻ Crunching… (esc to interrupt)\n" };
  assert.equal(decideFailover(busy, view, accounts, null, now).action, "skip");
  const go = decideFailover(limited, view, accounts, null, now);
  assert.equal(go.action, "relaunch");
  assert.equal(go.action === "relaunch" && go.route, "claude-business");

  // Pinned sessions and auto-switch off are left alone.
  assert.equal(decideFailover(limited, { ...view, autoSwitch: false }, accounts, null, now).action, "skip");
  const pinned = { ...view, assignments: { "claude-pilot-1": { ...view.assignments["claude-pilot-1"], mode: "pinned" as const } } };
  assert.equal(decideFailover(limited, pinned, accounts, null, now).action, "skip");

  // Direct session on the personal login: relaunch onto business.
  const direct = { ...view, assignments: {} };
  const d = decideFailover(limited, direct, accounts, "claude-personal", now);
  assert.equal(d.action === "relaunch" && d.route, "claude-business");

  // Gateway session whose next option is a key route: the gateway handles it.
  const noBusiness = [{ id: "claude-personal", signedIn: true }, { id: "claude-business", signedIn: false }];
  assert.equal(decideFailover(limited, view, noBusiness, null, now).action, "skip");
  // Direct session with only a key route left still gets moved onto the gateway.
  assert.equal(decideFailover(limited, direct, noBusiness, "claude-personal", now).action, "relaunch");

  // Nobody left to take over.
  const stuck = { ...direct, routes: routes.map((r) => (r.id === "claude-bedrock" ? { ...r, available: false } : r)) };
  assert.equal(decideFailover(limited, stuck, noBusiness, "claude-personal", now).action, "stuck");
});

test("currentRouteFor keeps a gateway session's route, maps a direct login to its own route, else the default", () => {
  const view = { assignments: { via: { lane: "claude" as const, route: "claude-business", mode: "auto" as const, account: "claude-business", updatedAt: 0 }, follower: { lane: "claude" as const, route: null, mode: "auto" as const, account: "claude-personal", updatedAt: 0 } }, defaults: { claude: "claude-personal", codex: null }, routes };
  assert.equal(currentRouteFor("via", "claude", view, null), "claude-business");
  assert.equal(currentRouteFor("follower", "claude", view, null), "claude-personal");
  assert.equal(currentRouteFor("direct-biz", "claude", view, "claude-business"), "claude-business");
  assert.equal(currentRouteFor("direct-unknown", "claude", view, null), "claude-personal");
});

test("isIdle needs a quiet prompt for several minutes", () => {
  const now = 10_000_000;
  const prompt = "● done\n────\n❯ \n  ⏵⏵ bypass permissions on";
  assert.equal(isIdle({ lastOutput: prompt, lastActivity: now - 6 * 60_000, state: "running" }, now), true);
  assert.equal(isIdle({ lastOutput: prompt, lastActivity: now - 30_000, state: "running" }, now), false);
  assert.equal(isIdle({ lastOutput: "✻ Thinking… (esc to interrupt)\n", lastActivity: now - 6 * 60_000, state: "running" }, now), false);
  assert.equal(isIdle({ lastOutput: prompt, lastActivity: null, state: "running" }, now), false);
});
