import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import { codexGatewayEdits, codexServerStatus, writeCodexGatewayConfig } from "./codex-gateway.js";

const hasCodex = spawnSync("codex", ["--version"], { timeout: 3000 }).status === 0;

test("Codex config update preserves model, other providers, comments and login", { skip: !hasCodex, timeout: 20_000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "devy-codex-config-"));
  try {
    await writeFile(path.join(home, "config.toml"), '# Keep my settings\nmodel="gpt-6-astra"\nmodel_provider="azure"\nmodel_reasoning_effort="high"\n[model_providers.azure]\nname="Azure fixture"\nbase_url="https://fixture.invalid"\nwire_api="responses"\n');
    const auth = '{"tokens":{"access_token":"fixture-do-not-modify"}}';
    await writeFile(path.join(home, "auth.json"), auth);
    await writeCodexGatewayConfig(home, "http://127.0.0.1:8791");
    const raw = await readFile(path.join(home, "config.toml"), "utf8");
    const updated = parse(raw);
    assert.equal(updated.model_provider, "devy");
    assert.equal(updated.model, "gpt-6-astra");
    assert.equal(updated.model_reasoning_effort, "high");
    assert.match(raw, /Keep my settings/);
    const providers = updated.model_providers as Record<string, { base_url: string }>;
    assert.equal(providers.azure.base_url, "https://fixture.invalid");
    assert.equal(providers.devy.base_url, "http://127.0.0.1:8791/codex/codex-app");
    assert.equal(await readFile(path.join(home, "auth.json"), "utf8"), auth);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Codex cannot forward membership credentials to a nonlocal gateway", () => {
  assert.throws(() => codexGatewayEdits("http://untrusted.example"), /loopback/);
});

test("configured Codex is not reported connected without observed gateway traffic", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "devy-codex-status-"));
  const previous = { CODEX_HOME: process.env.CODEX_HOME, GATEWAY_URL: process.env.GATEWAY_URL };
  process.env.CODEX_HOME = home;
  process.env.GATEWAY_URL = "http://127.0.0.1:8791";
  try {
    await writeFile(path.join(home, "config.toml"), 'model_provider="devy"\n[model_providers.devy]\nbase_url="http://127.0.0.1:8791/codex/codex-app"\n');
    assert.equal((await codexServerStatus()).status, "restart-required");
    assert.equal((await codexServerStatus([{ session: "other-session", at: Date.now(), status: 200 }])).status, "restart-required");
    assert.equal((await codexServerStatus([{ session: "codex-app", at: Date.now(), status: 502 }])).status, "restart-required");
    assert.equal((await codexServerStatus([{ session: "codex-app", at: Date.now(), status: 200 }])).status, "connected");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});
