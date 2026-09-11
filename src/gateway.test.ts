import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mapModel, reconcileState, routeCatalog, type RouteDef } from "./gateway-config.js";
import { createGatewayServer, extractUsage, Gateway } from "./gateway-core.js";

// A fake upstream that records requests and answers with whatever the test
// queues up, so failover and header handling can be asserted precisely.
type Reply = { status: number; headers?: Record<string, string>; body: string };
function fakeUpstream() {
  const seen: { path: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const replies: Reply[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ path: req.url || "/", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const reply = replies.shift() ?? { status: 200, body: JSON.stringify({ id: "msg_1", usage: { input_tokens: 3, output_tokens: 2 } }) };
      res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
      res.end(reply.body);
    });
  });
  return { server, seen, replies };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

async function harness(routes: (upstream: string) => RouteDef[]) {
  const up = fakeUpstream();
  const upstream = await listen(up.server);
  const dir = await mkdtemp(path.join(os.tmpdir(), "gw-test-"));
  const gateway = new Gateway({ stateFile: path.join(dir, "state.json"), env: { KEY_A: "secret-a", KEY_B: "secret-b" }, catalog: routes(upstream) });
  const server = createGatewayServer(gateway);
  const base = await listen(server);
  const close = async () => {
    server.close();
    up.server.close();
  };
  return { up, upstream, gateway, base, close };
}

function keyRoute(id: string, upstream: string, env: string, extra: Partial<RouteDef> = {}): RouteDef {
  return { id, lane: "claude", label: id, provider: "test", description: "", upstream, auth: { type: "x-api-key", env }, defaultEnabled: true, unavailableReason: null, ...extra };
}

test("forwards the request, swaps the credential and strips the oauth beta flag", async () => {
  const t = await harness((u) => [keyRoute("a", u, "KEY_A")]);
  try {
    const res = await fetch(`${t.base}/claude/s1/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-oauth", "anthropic-beta": "oauth-2025-04-20,context-1m-2025-08-07", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-opus-5", messages: [] })
    });
    assert.equal(res.status, 200);
    const req = t.up.seen[0];
    assert.equal(req.path, "/v1/messages?beta=true");
    assert.equal(req.headers["x-api-key"], "secret-a");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["anthropic-beta"], "context-1m-2025-08-07");
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    assert.equal(JSON.parse(req.body).model, "claude-opus-5");
    assert.equal(t.gateway.log[0].inputTokens, 3);
    assert.equal(t.gateway.counters("a").requests, 1);
  } finally {
    await t.close();
  }
});

test("passthrough keeps the client's own token and needs a real login", async () => {
  const t = await harness((u) => [{ ...keyRoute("p", u, "KEY_A"), auth: { type: "passthrough" }, account: "claude-personal" }]);
  try {
    const ok = await fetch(`${t.base}/claude/s1/v1/messages`, { method: "POST", headers: { authorization: "Bearer client-oauth", "anthropic-beta": "oauth-2025-04-20" }, body: "{}" });
    assert.equal(ok.status, 200);
    assert.equal(t.up.seen[0].headers.authorization, "Bearer client-oauth");
    assert.equal(t.up.seen[0].headers["anthropic-beta"], "oauth-2025-04-20");

    const dummy = await fetch(`${t.base}/claude/s1/v1/messages`, { method: "POST", headers: { authorization: "Bearer devy-gateway" }, body: "{}" });
    assert.equal(dummy.status, 503);
    assert.match((await dummy.json()).error.message, /no login token/);
  } finally {
    await t.close();
  }
});

test("renames the model for the upstream and records both names", async () => {
  const t = await harness((u) => [keyRoute("bedrock", u, "KEY_A", { modelPrefix: "anthropic.", stripDateSuffix: true })]);
  try {
    await fetch(`${t.base}/claude/s1/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1 }) });
    assert.equal(JSON.parse(t.up.seen[0].body).model, "anthropic.claude-haiku-4-5");
    assert.equal(t.gateway.log[0].upstreamModel, "anthropic.claude-haiku-4-5");
    assert.equal(t.gateway.log[0].model, "claude-haiku-4-5-20251001");
  } finally {
    await t.close();
  }
});

test("fails over to the next route on 429 and cools the first one down", async () => {
  const t = await harness((u) => [keyRoute("a", u, "KEY_A"), keyRoute("b", u, "KEY_B")]);
  try {
    t.up.replies.push({ status: 429, headers: { "retry-after": "120" }, body: '{"error":"rate limited"}' });
    const res = await fetch(`${t.base}/claude/s1/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(t.up.seen.length, 2);
    assert.equal(t.up.seen[1].headers["x-api-key"], "secret-b");
    const health = t.gateway.health.get("a")!;
    assert.equal(health.status, "cooling");
    assert.ok(health.coolUntil! > Date.now() + 100_000);
    assert.equal(t.gateway.log[0].route, "b");
    assert.equal(t.gateway.log[0].attempts, 2);

    // Next request skips the cooling route entirely.
    await fetch(`${t.base}/claude/s1/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(t.up.seen[2].headers["x-api-key"], "secret-b");
  } finally {
    await t.close();
  }
});

test("pinned sessions never fail over; the upstream error passes through unchanged", async () => {
  const t = await harness((u) => [keyRoute("a", u, "KEY_A"), keyRoute("b", u, "KEY_B")]);
  try {
    t.gateway.assign("s1", { route: "a", mode: "pinned" });
    t.up.replies.push({ status: 529, body: '{"type":"error","error":{"type":"overloaded_error"}}' });
    const res = await fetch(`${t.base}/claude/s1/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(res.status, 529);
    assert.equal((await res.json()).error.type, "overloaded_error");
    assert.equal(t.up.seen.length, 1);
  } finally {
    await t.close();
  }
});

test("admin API: settings, route order, session assignment and persistence", async () => {
  const t = await harness((u) => [keyRoute("a", u, "KEY_A"), keyRoute("b", u, "KEY_B")]);
  try {
    let res = await fetch(`${t.base}/_gw/settings`, { method: "PUT", body: JSON.stringify({ autoSwitch: false, defaults: { claude: "b" } }) });
    assert.equal(res.status, 200);
    res = await fetch(`${t.base}/_gw/routes/b`, { method: "PUT", body: JSON.stringify({ enabled: true, position: 0 }) });
    assert.equal(res.status, 200);
    res = await fetch(`${t.base}/_gw/sessions/s9`, { method: "PUT", body: JSON.stringify({ route: "a", mode: "pinned", account: null }) });
    assert.equal(res.status, 200);
    const state = await (await fetch(`${t.base}/_gw/state`)).json();
    assert.equal(state.autoSwitch, false);
    assert.equal(state.defaults.claude, "b");
    assert.deepEqual(state.order.claude, ["b", "a"]);
    assert.equal(state.assignments.s9.route, "a");
    res = await fetch(`${t.base}/_gw/routes/nope`, { method: "PUT", body: "{}" });
    assert.equal(res.status, 400);

    await t.gateway.save();
    const again = new Gateway({ stateFile: (t.gateway as unknown as { stateFile: string }).stateFile, env: {}, catalog: t.gateway.catalog });
    await again.load();
    assert.equal(again.state.defaults.claude, "b");
    assert.equal(again.state.assignments.s9.mode, "pinned");
  } finally {
    await t.close();
  }
});

test("HEAD /api/hello is answered locally", async () => {
  const t = await harness((u) => [keyRoute("a", u, "KEY_A")]);
  try {
    const res = await fetch(`${t.base}/claude/s1/api/hello`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(t.up.seen.length, 0);
  } finally {
    await t.close();
  }
});

test("extractUsage merges Anthropic SSE usage and reads OpenAI usage", () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":100,"output_tokens":1}}}',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}'
  ].join("\n\n");
  assert.deepEqual(extractUsage(sse), { inputTokens: 120, outputTokens: 42, cacheReadTokens: 100 });
  const openai = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":4},"output_tokens":5}}}';
  assert.deepEqual(extractUsage(openai), { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4 });
  assert.deepEqual(extractUsage("nothing here"), { inputTokens: null, outputTokens: null, cacheReadTokens: null });
});

test("mapModel and catalog availability follow the environment", () => {
  assert.equal(mapModel({ modelMap: { "*": "gpt-6-astra" } }, "gpt-5.5"), "gpt-6-astra");
  assert.equal(mapModel({ modelPrefix: "anthropic.", stripDateSuffix: true }, "claude-sonnet-4-5-20250929"), "anthropic.claude-sonnet-4-5");
  assert.equal(mapModel({}, "claude-opus-5"), "claude-opus-5");

  const none = routeCatalog({});
  assert.equal(none.find((r) => r.id === "claude-bedrock")!.unavailableReason, "AWS_BEARER_TOKEN_BEDROCK is not set");
  const withAzure = routeCatalog({ AZURE_OPENAI_API_KEY: "k", AZURE_OPENAI_BASE_URL: "https://x.services.ai.azure.com/openai/v1", AZURE_OPENAI_DEPLOYMENT: "gpt-6-astra" });
  const azure = withAzure.find((r) => r.id === "codex-azure")!;
  assert.equal(azure.unavailableReason, null);
  assert.equal(withAzure.find((r) => r.id === "claude-azure")!.upstream, "https://x.services.ai.azure.com/anthropic");

  const state = reconcileState({ order: { claude: ["claude-bedrock", "ghost"], codex: [] }, enabled: { ghost: true, "claude-key": true } }, none);
  assert.equal(state.order.claude[0], "claude-bedrock");
  assert.ok(!state.order.claude.includes("ghost"));
  assert.equal(state.enabled["claude-key"], true);
  assert.equal(state.enabled.ghost, undefined);
});
