import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

// Cloudflare Access sits in front of the tunnel hostnames and attaches a signed
// JWT to every request it lets through. The origin re-verifies that JWT so a
// hostname that was accidentally published without an Access policy, or a
// request that reached the tunnel port some other way, is still refused.

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export interface AccessConfig {
  /** Team domain, e.g. `team.cloudflareaccess.com` (no scheme). */
  teamDomain: string;
  /** Application Audience (AUD) tag of the Access application. */
  audience: string;
  /** Lower-cased allow list; the JWT `email` claim must be one of these. */
  allowedEmails: string[];
  /** Where the signing keys live. Defaults to Cloudflare's certs endpoint; tests point it at a local server. */
  jwksUrl?: string;
  /** Minimum gap between JWKS refetches triggered by an unknown `kid`. */
  jwksCooldownMs?: number;
}

export interface AccessIdentity {
  email: string;
  /** Unix milliseconds when the JWT expires. */
  expiresAt: number;
}

export type AccessResult = { ok: true; identity: AccessIdentity } | { ok: false; reason: string };

const envSchema = z.object({
  CF_ACCESS_TEAM_DOMAIN: z.string().trim().optional(),
  CF_ACCESS_AUD: z.string().trim().optional(),
  CF_ACCESS_ALLOWED_EMAILS: z.string().trim().optional()
});

export function accessConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  config: AccessConfig | null;
  missing: string[];
} {
  const parsed = envSchema.parse(env);
  const teamDomain = normalizeTeamDomain(parsed.CF_ACCESS_TEAM_DOMAIN);
  const audience = parsed.CF_ACCESS_AUD || "";
  const allowedEmails = parseEmailList(parsed.CF_ACCESS_ALLOWED_EMAILS);

  const missing: string[] = [];
  if (!teamDomain) missing.push("CF_ACCESS_TEAM_DOMAIN");
  if (!audience) missing.push("CF_ACCESS_AUD");
  if (!allowedEmails.length) missing.push("CF_ACCESS_ALLOWED_EMAILS");
  if (missing.length) return { config: null, missing };

  return { config: { teamDomain, audience, allowedEmails }, missing };
}

export function normalizeTeamDomain(value: string | undefined): string {
  return (value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function parseEmailList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

// Verified tokens are remembered briefly so a page load's dozen static
// requests don't each pay for an RSA verification. Entries expire with the
// token or after a few minutes, whichever comes first.
const TOKEN_CACHE_MAX = 256;
const TOKEN_CACHE_TTL_MS = 5 * 60_000;

export class AccessVerifier {
  readonly config: AccessConfig;
  readonly issuer: string;
  private readonly keys: JWTVerifyGetKey;
  private readonly cache = new Map<string, AccessIdentity>();

  constructor(config: AccessConfig) {
    this.config = {
      ...config,
      teamDomain: normalizeTeamDomain(config.teamDomain),
      allowedEmails: config.allowedEmails.map((email) => email.trim().toLowerCase()).filter(Boolean)
    };
    this.issuer = `https://${this.config.teamDomain}`;
    const jwksUrl = config.jwksUrl || `${this.issuer}/cdn-cgi/access/certs`;
    // createRemoteJWKSet caches the key set, refetches when it meets an unknown
    // kid, and refuses to refetch more often than cooldownDuration.
    this.keys = createRemoteJWKSet(new URL(jwksUrl), {
      cooldownDuration: config.jwksCooldownMs ?? 30_000,
      cacheMaxAge: 10 * 60_000,
      timeoutDuration: 5_000
    });
  }

  async verify(token: string): Promise<AccessResult> {
    const cached = this.cache.get(token);
    if (cached) {
      if (cached.expiresAt > Date.now()) return { ok: true, identity: cached };
      this.cache.delete(token);
    }

    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        audience: this.config.audience,
        algorithms: ["RS256"]
      });
      payload = verified.payload;
    } catch (error) {
      return { ok: false, reason: `invalid access token: ${(error as Error).message}` };
    }

    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email) return { ok: false, reason: "access token has no email claim" };
    if (!this.config.allowedEmails.includes(email)) return { ok: false, reason: "email not allowed" };

    const exp = typeof payload.exp === "number" ? payload.exp * 1000 : Date.now() + TOKEN_CACHE_TTL_MS;
    const identity: AccessIdentity = { email, expiresAt: Math.min(exp, Date.now() + TOKEN_CACHE_TTL_MS) };
    this.remember(token, identity);
    return { ok: true, identity };
  }

  private remember(token: string, identity: AccessIdentity): void {
    if (this.cache.size >= TOKEN_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(token, identity);
  }
}

// One process-wide verifier. `undefined` means nobody has initialised it yet, in
// which case the first tunnel request initialises it from the environment;
// `null` means Access is not configured and every tunnel request is refused.
let verifier: AccessVerifier | null | undefined;

export function configureAccess(config: AccessConfig | null): AccessVerifier | null {
  verifier = config ? new AccessVerifier(config) : null;
  return verifier;
}

export function initAccessFromEnv(): { verifier: AccessVerifier | null; missing: string[] } {
  const { config, missing } = accessConfigFromEnv();
  return { verifier: configureAccess(config), missing };
}

export function accessConfigured(): boolean {
  if (verifier === undefined) initAccessFromEnv();
  return Boolean(verifier);
}

export function readAccessToken(request: IncomingMessage): string | null {
  const header = request.headers[ACCESS_JWT_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  const token = value?.trim();
  return token ? token : null;
}

export async function authenticateAccessRequest(request: IncomingMessage): Promise<AccessResult> {
  if (verifier === undefined) initAccessFromEnv();
  if (!verifier) return { ok: false, reason: "cloudflare access is not configured on this server" };
  const token = readAccessToken(request);
  if (!token) return { ok: false, reason: "missing cloudflare access token" };
  return verifier.verify(token);
}
