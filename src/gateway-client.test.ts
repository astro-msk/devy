import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { accountStatus, launchSpec, probeRoute } from "./gateway-client.js";
import { routeCatalog, type AccountDef } from "./gateway-config.js";

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
