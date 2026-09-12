import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AccessVerifier, accessConfigFromEnv, parseEmailList } from "./cf-access.js";
import { startFakeAccess, type FakeAccess } from "./cf-access.test-support.js";

const EMAIL = "mukil@noso.so";
let fake: FakeAccess;
let verifier: AccessVerifier;

before(async () => {
  fake = await startFakeAccess();
  verifier = new AccessVerifier({
    teamDomain: fake.teamDomain,
    audience: fake.audience,
    allowedEmails: [EMAIL],
    jwksUrl: fake.jwksUrl,
    jwksCooldownMs: 0
  });
});

after(async () => {
  await fake.close();
});

test("accepts a JWT signed by the JWKS for an allowed email, case-insensitively", async () => {
  const result = await verifier.verify(await fake.sign({ email: "Mukil@NOSO.so" }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.identity.email, EMAIL);
    assert.ok(result.identity.expiresAt > Date.now());
  }
});

test("rejects the wrong audience", async () => {
  const result = await verifier.verify(await fake.sign({ email: EMAIL }, { audience: "b".repeat(64) }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /aud/i);
});

test("rejects the wrong issuer", async () => {
  const result = await verifier.verify(await fake.sign({ email: EMAIL }, { issuer: "https://other.cloudflareaccess.com" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /iss/i);
});

test("rejects an expired JWT", async () => {
  const result = await verifier.verify(await fake.sign({ email: EMAIL }, { expiresIn: "-1m" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /exp/i);
});

test("rejects an otherwise valid JWT without an expiration", async () => {
  const result = await verifier.verify(await fake.sign({ email: EMAIL }, { expiresIn: null }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /exp/i);
});

test("rejects a JWT that is not yet valid", async () => {
  const result = await verifier.verify(await fake.sign({ email: EMAIL }, { notBefore: "10m" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /nbf/i);
});

test("rejects an email outside the allow list, and a missing email", async () => {
  const stranger = await verifier.verify(await fake.sign({ email: "someone@example.com" }));
  assert.deepEqual(stranger, { ok: false, reason: "email not allowed" });
  const anonymous = await verifier.verify(await fake.sign({}));
  assert.deepEqual(anonymous, { ok: false, reason: "access token has no email claim" });
});

test("rejects a JWT signed by a key that is not in the JWKS", async () => {
  const result = await verifier.verify(await fake.sign({ email: EMAIL }, { foreignKey: true }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /signature|key/i);
});

test("rejects garbage and tampered tokens", async () => {
  assert.equal((await verifier.verify("not-a-jwt")).ok, false);
  const [header, payload, signature] = (await fake.sign({ email: EMAIL })).split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), email: "evil@example.com" })).toString("base64url");
  assert.equal((await verifier.verify(`${header}.${forged}.${signature}`)).ok, false);
});

test("refetches the JWKS when it meets an unknown kid", async () => {
  const before = fake.fetches;
  await fake.rotate();
  const result = await verifier.verify(await fake.sign({ email: EMAIL }));
  assert.equal(result.ok, true);
  assert.ok(fake.fetches > before, "expected a JWKS refetch after key rotation");
});

test("fails closed when the environment is incomplete", () => {
  assert.deepEqual(accessConfigFromEnv({}), {
    config: null,
    missing: ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"]
  });
  assert.deepEqual(
    accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "x" }).missing,
    []
  );
});

test("Cloudflare policy controls access when no additional email list is set", async () => {
  const unrestricted = new AccessVerifier({ ...verifier.config, allowedEmails: [] });
  assert.equal((await unrestricted.verify(await fake.sign({ email: "cloudflare-approved@example.com" }))).ok, true);
  // Service identities need not have a human email claim.
  assert.equal((await unrestricted.verify(await fake.sign({ sub: "approved-service" }))).ok, true);
  assert.equal((await unrestricted.verify(await fake.sign({ email: EMAIL }, { audience: "other-app" }))).ok, false);
  assert.equal((await unrestricted.verify(await fake.sign({ email: EMAIL }, { expiresIn: null }))).ok, false);
  assert.equal((await unrestricted.verify(await fake.sign({ email: EMAIL }, { foreignKey: true }))).ok, false);
});

test("parses the environment into a config", () => {
  const { config } = accessConfigFromEnv({
    CF_ACCESS_TEAM_DOMAIN: "https://Team.cloudflareaccess.com/",
    CF_ACCESS_AUD: "aud-tag",
    CF_ACCESS_ALLOWED_EMAILS: " Mukil@noso.so, other@example.com ,"
  });
  assert.deepEqual(config, {
    teamDomain: "team.cloudflareaccess.com",
    audience: "aud-tag",
    allowedEmails: ["mukil@noso.so", "other@example.com"]
  });
  assert.deepEqual(parseEmailList(undefined), []);
});
