import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

// A stand-in for https://<team>.cloudflareaccess.com/cdn-cgi/access/certs: an
// RSA key pair generated per test run and a tiny HTTP server that publishes
// the public half as a JWKS. `rotate()` swaps in a fresh key under a new kid so
// tests can exercise the refetch-on-unknown-kid path.

export interface FakeAccess {
  jwksUrl: string;
  teamDomain: string;
  issuer: string;
  audience: string;
  fetches: number;
  sign(claims: Record<string, unknown>, options?: SignOptions): Promise<string>;
  rotate(): Promise<void>;
  close(): Promise<void>;
}

export interface SignOptions {
  issuer?: string;
  audience?: string | string[];
  expiresIn?: string;
  notBefore?: string;
  kid?: string;
  /** Sign with a key that is not in the JWKS. */
  foreignKey?: boolean;
}

export async function startFakeAccess(): Promise<FakeAccess> {
  let keys = await generateKeyPair("RS256", { modulusLength: 2048 });
  let kid = "kid-1";
  const foreign = await generateKeyPair("RS256", { modulusLength: 2048 });
  const state = { fetches: 0 };

  const server: Server = createServer(async (_req, res) => {
    state.fetches += 1;
    const jwk = await exportJWK(keys.publicKey);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const teamDomain = "devy-test.cloudflareaccess.com";
  const issuer = `https://${teamDomain}`;
  const audience = "a".repeat(64);

  const fake: FakeAccess = {
    jwksUrl: `http://127.0.0.1:${port}/cdn-cgi/access/certs`,
    teamDomain,
    issuer,
    audience,
    get fetches() {
      return state.fetches;
    },
    async sign(claims, options = {}) {
      const signer: CryptoKey = options.foreignKey ? foreign.privateKey : keys.privateKey;
      let jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? kid })
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.audience ?? audience)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? "5m");
      if (options.notBefore) jwt = jwt.setNotBefore(options.notBefore);
      return jwt.sign(signer);
    },
    async rotate() {
      keys = await generateKeyPair("RS256", { modulusLength: 2048 });
      kid = `kid-${Date.now()}`;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
  return fake;
}
