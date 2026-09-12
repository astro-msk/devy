import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "./redact.js";

// Fixtures are deliberately shaped like real credentials but are not ones.
const cases: Array<[string, string]> = [
  ["Authorization: Bearer abcdefghijklmnop.qrstuvwxyz", "Authorization=[redacted]"],
  ["curl -H 'Bearer 0123456789abcdefghij' https://x", "curl -H 'Bearer [redacted]' https://x"],
  ["token=xoxb-1234-5678-abcdefgh", "token=[redacted]"],
  ["got xoxp-1234-5678-abcdefgh back", "got [redacted] back"],
  ["app token xapp-1-A0123-4567-abcdef", "app token [redacted]"],
  ["set GH to ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "set GH to [redacted]"],
  ["github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "[redacted]"],
  ["OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz", "OPENAI_API_KEY=[redacted]"],
  ["anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "anthropic [redacted]"],
  ["aws AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE", "aws [redacted] and [redacted]"],
  ["gcp AIzaSyA-abcdefghijklmnopqrstuvwxyz0123456", "gcp [redacted]"],
  ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "jwt [redacted]"],
  ["password: hunter2", "password=[redacted]"],
  ["client_secret = 'abc'", "client_secret=[redacted]"],
  ["hash a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 committed", "hash [redacted] committed"]
];

test("redacts every known credential shape", () => {
  for (const [input, expected] of cases) {
    assert.equal(redactSecrets(input), expected, input);
  }
});

test("redacts PEM private key blocks as a unit", () => {
  const pem = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nQIDAQAB\n-----END RSA PRIVATE KEY-----\nafter";
  assert.equal(redactSecrets(pem), "before\n[redacted private key]\nafter");
});

test("leaves ordinary prose, paths and short identifiers alone", () => {
  const text = "Fixed src/app.ts:120 — the token refresh (see docs) and password validation now share validateInput().";
  assert.equal(redactSecrets(text), text);
  assert.equal(redactSecrets("run `git status` in /home/ubuntu/work/repos/Pilot"), "run `git status` in /home/ubuntu/work/repos/Pilot");
  assert.equal(redactSecrets("Bearer of bad news"), "Bearer of bad news");
});

test("the bare-token threshold is adjustable", () => {
  const id = "abcdefghijklmnopqrstuvwxyz012345"; // 32 chars
  assert.equal(redactSecrets(`id ${id}`), `id ${id}`);
  assert.equal(redactSecrets(`id ${id}`, { minTokenLength: 32 }), "id [redacted]");
});
