import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import { startFakeAccess, type FakeAccess } from "./cf-access.test-support.js";

// End-to-end: the real Express app plus the WebSocket bridge on two listeners,
// one plain (like the tailnet port) and one marked as the Cloudflare tunnel.

const EMAIL = "mukil@noso.so";
const WRITE_TOKEN = "test-write-token";

const originalDirectory = process.cwd();
const testDirectory = await mkdtemp(path.join(os.tmpdir(), "devy-tunnel-"));
process.chdir(testDirectory);
process.env.TAILSCALE_ONLY = "true";
process.env.AGENT_OPS_TOKEN = WRITE_TOKEN;
process.env.ENABLE_AGENT_INPUT = "true";
// Dynamic import is intentional: db.ts binds its SQLite path from cwd during module initialization.
const { createApp } = await import("./app.js");
const { markTunnelServer, tunnelWriteLimiter } = await import("./auth.js");
const { configureAccess } = await import("./cf-access.js");
const { attachTerminalBridge } = await import("./terminal-bridge.js");

let fake: FakeAccess;
const bridges: WebSocketServer[] = [];
let plain: Server;
let tunnel: Server;
let plainUrl: string;
let tunnelUrl: string;
let jwt: string;

before(async () => {
  fake = await startFakeAccess();
  configureAccess({
    teamDomain: fake.teamDomain,
    audience: fake.audience,
    allowedEmails: [EMAIL],
    jwksUrl: fake.jwksUrl,
    jwksCooldownMs: 0
  });
  jwt = await fake.sign({ email: EMAIL });

  const app = createApp();
  plain = createServer(app);
  tunnel = markTunnelServer(createServer(app));
  bridges.push(attachTerminalBridge(plain), attachTerminalBridge(tunnel));
  plainUrl = await listen(plain);
  tunnelUrl = await listen(tunnel);
});

after(async () => {
  // Upgraded sockets are not covered by closeAllConnections, and a WebSocket
  // still mid-handshake would keep server.close() waiting forever.
  for (const wss of bridges) for (const client of wss.clients) client.terminate();
  await close(plain);
  await close(tunnel);
  await fake.close();
  process.chdir(originalDirectory);
  await rm(testDirectory, { recursive: true, force: true });
});

test("plain listener keeps trusting localhost for reads and writes", async () => {
  const health = await fetch(`${plainUrl}/api/health`);
  assert.equal(health.status, 200);
  const write = await postEvent(plainUrl, {});
  assert.equal(write.status, 201);
});

test("tunnel listener without a JWT: 401 for health, API, static files and the SPA fallback", async () => {
  for (const route of ["/api/health", "/api/sessions", "/", "/app.js", "/manifest.json", "/some/deep/link"]) {
    const res = await fetch(`${tunnelUrl}${route}`);
    assert.equal(res.status, 401, `${route} should be refused`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.error, "cloudflare access required");
  }
});

test("tunnel listener ignores spoofable Cloudflare identity headers", async () => {
  const res = await fetch(`${tunnelUrl}/api/health`, {
    headers: { "cf-access-authenticated-user-email": EMAIL, "cf-connecting-ip": "127.0.0.1" }
  });
  assert.equal(res.status, 401);
});

test("tunnel listener rejects bad JWTs (wrong audience, expired, stranger, foreign key)", async () => {
  const bad = await Promise.all([
    fake.sign({ email: EMAIL }, { audience: "nope" }),
    fake.sign({ email: EMAIL }, { expiresIn: "-1s" }),
    fake.sign({ email: "stranger@example.com" }),
    fake.sign({ email: EMAIL }, { foreignKey: true })
  ]);
  for (const token of bad) {
    const res = await fetch(`${tunnelUrl}/api/health`, { headers: { "cf-access-jwt-assertion": token } });
    assert.equal(res.status, 401);
  }
});

test("tunnel + valid JWT: reads work, writes still need the write token", async () => {
  const health = await fetch(`${tunnelUrl}/api/health`, { headers: { "cf-access-jwt-assertion": jwt } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).app, "devy");
  assert.equal(health.headers.get("strict-transport-security"), "max-age=15552000; includeSubDomains");

  const page = await fetch(`${tunnelUrl}/`, { headers: { "cf-access-jwt-assertion": jwt } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  assert.match(page.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);

  // cloudflared connects from 127.0.0.1, which must not unlock the localhost write path.
  const noToken = await postEvent(tunnelUrl, { "cf-access-jwt-assertion": jwt });
  assert.equal(noToken.status, 401);
  assert.equal((await noToken.json()).error, "unauthorized");

  const wrongToken = await postEvent(tunnelUrl, { "cf-access-jwt-assertion": jwt, authorization: "Bearer wrong" });
  assert.equal(wrongToken.status, 401);
});

test("tunnel + valid JWT + write token: writes succeed", async () => {
  const res = await postEvent(tunnelUrl, { "cf-access-jwt-assertion": jwt, authorization: `Bearer ${WRITE_TOKEN}` });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).ok, true);
});

test("write token alone is not enough on the tunnel", async () => {
  const res = await postEvent(tunnelUrl, { authorization: `Bearer ${WRITE_TOKEN}` });
  assert.equal(res.status, 401);
});

test("tunnel writes are rate limited per identity", async () => {
  tunnelWriteLimiter.reset();
  try {
    const headers = { "cf-access-jwt-assertion": jwt, authorization: `Bearer ${WRITE_TOKEN}` };
    let limited = 0;
    for (let index = 0; index < 125; index += 1) {
      const res = await fetch(`${tunnelUrl}/api/events`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}"
      });
      if (res.status === 429) {
        limited += 1;
        assert.ok(res.headers.get("retry-after"));
      } else {
        assert.equal(res.status, 400, "invalid body should fail validation, not auth");
      }
      await res.arrayBuffer();
    }
    assert.equal(limited, 5);
  } finally {
    tunnelWriteLimiter.reset();
  }
});

test("WebSocket upgrade on the tunnel without a JWT is refused with 401", async () => {
  const status = await upgradeStatus(`${wsUrl(tunnelUrl)}/ws/terminal?session=devy-test`);
  assert.equal(status, 401);
});

test("WebSocket upgrade on the tunnel with a JWT opens read-only; with the write token it can type", async () => {
  const readOnly = await firstMessage(`${wsUrl(tunnelUrl)}/ws/terminal?session=devy-test`, jwt);
  assert.equal(readOnly.type, "ready");
  assert.equal(readOnly.canWrite, false);

  const writable = await firstMessage(
    `${wsUrl(tunnelUrl)}/ws/terminal?session=devy-test&token=${encodeURIComponent(WRITE_TOKEN)}`,
    jwt
  );
  assert.equal(writable.canWrite, true);
});

test("WebSocket upgrade on the plain listener from localhost still works and can type", async () => {
  const message = await firstMessage(`${wsUrl(plainUrl)}/ws/terminal?session=devy-test`);
  assert.equal(message.type, "ready");
  assert.equal(message.canWrite, true);
});

test("WebSocket upgrade on an unknown path gets 400", async () => {
  const status = await upgradeStatus(`${wsUrl(plainUrl)}/ws/other`);
  assert.equal(status, 400);
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    })
  );
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function wsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws");
}

async function postEvent(base: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${base}/api/events`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ agent: "system", type: "info", message: "tunnel test", raw: {} })
  });
}

function upgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode || 0);
      res.resume();
    });
    socket.on("open", () => {
      socket.close();
      reject(new Error("upgrade unexpectedly succeeded"));
    });
    socket.on("error", (error) => reject(error));
  });
}

function firstMessage(url: string, accessJwt?: string): Promise<{ type: string; canWrite?: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: accessJwt ? { "cf-access-jwt-assertion": accessJwt } : {} });
    socket.on("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    socket.on("error", reject);
    socket.once("message", (raw) => {
      socket.close();
      resolve(JSON.parse(raw.toString()));
    });
  });
}
