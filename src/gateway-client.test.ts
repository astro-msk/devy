import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accountStatus, launchCommand, launchSpec, loginCommand, probeRoute } from "./gateway-client.js";
import { routeCatalog, type AccountDef } from "./gateway-config.js";

const execFileAsync = promisify(execFile);

test("Codex subscription probe closes stdin and removes its temporary assignment", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devy-probe-"));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url?.endsWith("/probe") ? { needsClient: true } : { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = { CODEX_HOME: process.env.CODEX_HOME, PATH: process.env.PATH, GATEWAY_URL: process.env.GATEWAY_URL };
  try {
    await writeFile(path.join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "test-only" } }));
    await writeFile(path.join(dir, "codex"), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log('PROBE_OK'));setTimeout(()=>process.exit(17),700).unref();\n`, { mode: 0o700 });
    process.env.CODEX_HOME = dir;
    process.env.PATH = `${dir}:${previous.PATH}`;
    process.env.GATEWAY_URL = `http://127.0.0.1:${address.port}`;
    const result = await probeRoute(routeCatalog().find((route) => route.id === "chatgpt-personal")!);
    assert.equal(result.ok, true, result.error);
    assert.ok(requests.some((request) => request.startsWith("DELETE /_gw/sessions/")));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("account readiness distinguishes usable subscriptions, expired logins and API keys", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devy-account-"));
  const account: AccountDef = { id: "test", lane: "claude", label: "Test", dir, isDefaultHome: true };
  try {
    assert.equal((await accountStatus(account)).signedIn, false);
    const credentials = path.join(dir, ".credentials.json");
    await writeFile(credentials, JSON.stringify({ claudeAiOauth: { subscriptionType: "team" } }));
    assert.equal((await accountStatus(account)).signedIn, false);
    await writeFile(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "test", expiresAt: Date.now() - 1000 } }));
    assert.equal((await accountStatus(account)).signedIn, false);
    await writeFile(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "test", expiresAt: Date.now() - 1000, refreshToken: "test", subscriptionType: "team" } }));
    assert.equal((await accountStatus(account)).signedIn, true);
    assert.match((await accountStatus(account)).detail || "", /team/);
    await writeFile(path.join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-only" }));
    assert.equal((await accountStatus({ ...account, lane: "codex" })).signedIn, false);
    await writeFile(path.join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "test-only" } }));
    assert.equal((await accountStatus({ ...account, lane: "codex" })).signedIn, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway launches force Responses over HTTP and refuse unsigned subscription accounts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devy-launch-"));
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const routes = routeCatalog({ AZURE_OPENAI_BASE_URL: "https://example.com/openai/v1", AZURE_OPENAI_API_KEY: "test", AZURE_OPENAI_DEPLOYMENT: "test" });
    const spec = await launchSpec("codex", "test", routes.find((r) => r.id === "codex-azure")!);
    assert.equal(spec.account, null);
    assert.equal(spec.env.DEVY_GATEWAY_KEY, "devy-gateway");
    assert.ok(spec.args.includes('model_providers.devy.wire_api="responses"'));
    assert.ok(spec.args.includes("model_providers.devy.supports_websockets=false"));
    await assert.rejects(launchSpec("codex", "test", routes.find((r) => r.id === "chatgpt-personal")!), /not signed in/);
    await assert.rejects(launchSpec("claude", "test", routes.find((r) => r.id === "claude-personal")!), /not signed in/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("launch and login commands use the selected account despite a different tmux environment", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devy-account-isolation-"));
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    await writeFile(path.join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture" } }));
    await writeFile(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture" } }));
    for (const lane of ["claude", "codex"] as const) {
      const homeKey = lane === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      await writeFile(path.join(dir, lane), `#!${process.execPath}\nconsole.log(JSON.stringify({dir:process.env.${homeKey},oauth:process.env.CLAUDE_CODE_OAUTH_TOKEN||'',oauthFd:process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR||''}));\n`, { mode: 0o700 });
      const inherited = {
        PATH: `${dir}:${process.env.PATH}`,
        [homeKey]: "/wrong-account-from-tmux",
        ...(lane === "claude" ? { CLAUDE_CODE_OAUTH_TOKEN: "wrong-account-token", CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "99" } : {})
      };
      const route = routeCatalog().find((item) => item.id === (lane === "claude" ? "claude-personal" : "chatgpt-personal"))!;
      const spec = await launchSpec(lane, "isolated-session", route);
      const account: AccountDef = { id: route.account!, lane, label: "Fixture", dir, isDefaultHome: true };
      for (const command of [launchCommand(lane, spec), await loginCommand(account)]) {
        const result = await execFileAsync("bash", ["--noprofile", "--norc", "-c", command], { env: inherited });
        assert.deepEqual(JSON.parse(result.stdout), { dir, oauth: "", oauthFd: "" });
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit unknown accounts cannot silently launch with another login", async () => {
  const route = routeCatalog({ AZURE_OPENAI_BASE_URL: "https://example.com/openai/v1", AZURE_OPENAI_API_KEY: "fixture", AZURE_OPENAI_DEPLOYMENT: "fixture" }).find((item) => item.id === "codex-azure")!;
  await assert.rejects(launchSpec("codex", "test", route, "missing-account"), /unknown login account/);
});

test("overlapping subscription probes keep their assignments until each client finishes", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devy-parallel-probe-"));
  const assignments = new Set<string>();
  const starts: import("node:http").ServerResponse[] = [];
  let removed = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    req.resume();
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/fixture/started") {
      starts.push(res);
      if (starts.length === 2) starts[0].end("{}");
      return;
    }
    if (url.pathname === "/fixture/assigned") {
      res.end(JSON.stringify({ assigned: assignments.has(url.searchParams.get("session")!) }));
      return;
    }
    if (req.method === "PUT") assignments.add(url.pathname.split("/").at(-1)!);
    if (req.method === "DELETE") {
      assignments.delete(url.pathname.split("/").at(-1)!);
      if (++removed === 1) starts[1]?.end("{}");
    }
    res.end(JSON.stringify(url.pathname.endsWith("/probe") ? { needsClient: true } : { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = { CODEX_HOME: process.env.CODEX_HOME, PATH: process.env.PATH, GATEWAY_URL: process.env.GATEWAY_URL };
  try {
    await writeFile(path.join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture" } }));
    await writeFile(path.join(dir, "codex"), `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end',async()=>{
 const setting=process.argv.find(arg=>arg.startsWith('model_providers.devy.base_url='));
 const url=new URL(JSON.parse(setting.split('=').slice(1).join('=')));
 await fetch(url.origin+'/fixture/started');
 const reply=await fetch(url.origin+'/fixture/assigned?session='+encodeURIComponent(url.pathname.split('/').pop()));
 if((await reply.json()).assigned) console.log('PROBE_OK'); else process.exitCode=1;
});
`, { mode: 0o700 });
    process.env.CODEX_HOME = dir;
    process.env.PATH = `${dir}:${previous.PATH}`;
    process.env.GATEWAY_URL = `http://127.0.0.1:${address.port}`;
    const route = routeCatalog().find((item) => item.id === "chatgpt-personal")!;
    const results = await Promise.all([probeRoute(route), probeRoute(route)]);
    assert.ok(results.every((result) => result.ok), "one probe removed the other probe's active assignment");
    assert.equal(removed, 2);
    assert.equal(assignments.size, 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
