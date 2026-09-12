import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, configDocs, envList, envSchema, envValue, readConfig } from "./config.js";

test("an empty environment yields the documented defaults", () => {
  const { config, warnings } = readConfig({});
  assert.equal(config.PORT, 8787);
  assert.equal(config.MANAGER_PORT, 8790);
  assert.equal(config.TAILSCALE_ONLY, false);
  assert.equal(config.ENABLE_AGENT_INPUT, true);
  assert.equal(config.ENABLE_AGENT_ALERTS, true);
  assert.equal(config.AGENT_UNRESTRICTED_BASH, false);
  assert.equal(config.AGENT_WAIT_ALERT_SECONDS, 30);
  assert.equal(config.EVENT_RETENTION_DAYS, 90);
  assert.equal(config.SLACK_LOG_LEVEL, "info");
  assert.equal(config.AGENT_OPS_AI_PROVIDER, undefined);
  assert.equal(config.OPENAI_API_KEY, undefined);
  assert.deepEqual(warnings, []);
});

test("blank values from a copied .env.example count as unset", () => {
  const { config } = readConfig({ SLACK_WEBHOOK_URL: "", PORT: " ", ENABLE_AGENT_TOOLS: "", SLACK_LOG_LEVEL: "" });
  assert.equal(config.SLACK_WEBHOOK_URL, undefined);
  assert.equal(config.PORT, 8787);
  assert.equal(config.ENABLE_AGENT_TOOLS, true);
  assert.equal(config.SLACK_LOG_LEVEL, "info");
});

test("flags accept the usual spellings and reject nonsense", () => {
  assert.equal(envValue("TAILSCALE_ONLY", { TAILSCALE_ONLY: "true" }), true);
  assert.equal(envValue("TAILSCALE_ONLY", { TAILSCALE_ONLY: "1" }), true);
  assert.equal(envValue("ENABLE_AGENT_INPUT", { ENABLE_AGENT_INPUT: "false" }), false);
  assert.equal(envValue("ENABLE_AGENT_INPUT", { ENABLE_AGENT_INPUT: "no" }), false);
  assert.throws(() => envValue("ENABLE_AGENT_INPUT", { ENABLE_AGENT_INPUT: "maybe" }), ConfigError);
});

test("a non-numeric number is fatal and names the variable and its meaning", () => {
  assert.throws(
    () => readConfig({ AGENT_WAIT_ALERT_SECONDS: "3O" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.problems.length, 1);
      assert.match(error.problems[0], /^AGENT_WAIT_ALERT_SECONDS="3O": /);
      assert.match(error.problems[0], /seconds a session must look like it needs input/);
      return true;
    }
  );
  assert.throws(() => readConfig({ PORT: "12.5" }), ConfigError);
});

test("every bad variable is reported at once", () => {
  assert.throws(
    () => readConfig({ PORT: "abc", SLACK_LOG_LEVEL: "loud", AGENT_OPS_AI_PROVIDER: "gemini" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.deepEqual(
        error.problems.map((problem) => problem.split("=")[0]).sort(),
        ["AGENT_OPS_AI_PROVIDER", "PORT", "SLACK_LOG_LEVEL"]
      );
      return true;
    }
  );
});

test("out-of-range numbers are clamped with a warning rather than fatal", () => {
  const { config, warnings } = readConfig({ SLACK_CONTEXT_MESSAGES: "500", AGENT_WAIT_ALERT_SECONDS: "1" });
  assert.equal(config.SLACK_CONTEXT_MESSAGES, 30);
  assert.equal(config.AGENT_WAIT_ALERT_SECONDS, 10);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((warning) => /SLACK_CONTEXT_MESSAGES=500 is above the maximum 30/.test(warning)), warnings.join("; "));
  assert.ok(warnings.some((warning) => /AGENT_WAIT_ALERT_SECONDS=1 is below the minimum 10/.test(warning)), warnings.join("; "));
  // A single-field read applies the same clamp.
  assert.equal(envValue("SLACK_CONTEXT_MESSAGES", { SLACK_CONTEXT_MESSAGES: "500" }), 30);
});

test("enums are case-insensitive and trimmed", () => {
  assert.equal(envValue("SLACK_LOG_LEVEL", { SLACK_LOG_LEVEL: " DEBUG " }), "debug");
  assert.equal(envValue("AGENT_OPS_AI_PROVIDER", { AGENT_OPS_AI_PROVIDER: "OpenAI" }), "openai");
});

test("repository lists must be Name=/absolute/path entries", () => {
  assert.equal(
    envValue("DEVY_REPOSITORIES", { DEVY_REPOSITORIES: "Pilot=/home/ubuntu/work/repos/Pilot, Crucible=/tmp/c" }),
    "Pilot=/home/ubuntu/work/repos/Pilot, Crucible=/tmp/c"
  );
  assert.throws(() => envValue("DEVY_REPOSITORIES", { DEVY_REPOSITORIES: "Pilot=relative/path" }), ConfigError);
  assert.throws(() => envValue("DEVY_REPOSITORIES", { DEVY_REPOSITORIES: "Pilot" }), ConfigError);
});

test("list variables split on commas and drop blanks", () => {
  assert.deepEqual(envList("SLACK_WATCH_NAMES", { SLACK_WATCH_NAMES: " mukil, ,M Rao " }), ["mukil", "M Rao"]);
  assert.deepEqual(envList("SLACK_WATCH_NAMES", {}), []);
});

test("every variable in the schema is documented", () => {
  for (const key of Object.keys(envSchema.shape)) {
    assert.ok(configDocs[key as keyof typeof configDocs], `${key} is missing from configDocs`);
  }
});
