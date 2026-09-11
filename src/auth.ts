import type { NextFunction, Request, Response } from "express";
import type { IncomingMessage, Server } from "node:http";
import net from "node:net";
import { authenticateAccessRequest, type AccessIdentity } from "./cf-access.js";

// Three kinds of caller reach the app:
//   - localhost (hooks, curl on the box): trusted for reads and writes;
//   - the tailnet: reads without login, writes with AGENT_OPS_TOKEN;
//   - the Cloudflare tunnel listener: cloudflared connects from 127.0.0.1, so
//     these connections would look like localhost. They are marked per socket
//     at accept time and treated as hostile until a Cloudflare Access JWT has
//     been verified — after which they get tailnet privileges, never localhost.
// The mark lives on the socket rather than in a header because a localhost
// caller can send any `cf-*` header it likes.

const tunnelSockets = new WeakSet<net.Socket>();
const identities = new WeakMap<IncomingMessage, AccessIdentity>();

export function markTunnelServer(server: Server): Server {
  server.on("connection", (socket) => tunnelSockets.add(socket));
  return server;
}

export function isTunnelRequest(request: IncomingMessage): boolean {
  return tunnelSockets.has(request.socket);
}

export function accessIdentity(request: IncomingMessage): AccessIdentity | undefined {
  return identities.get(request);
}

// Mounted first: nothing on the tunnel listener — health, static files, API —
// runs before a valid Access JWT has been seen on this request.
export function requireTunnelAccess(req: Request, res: Response, next: NextFunction): void {
  if (!isTunnelRequest(req)) {
    next();
    return;
  }

  authenticateAccessRequest(req)
    .then((result) => {
      if (!result.ok) {
        res.status(401).set("cache-control", "no-store").json({ ok: false, error: "cloudflare access required", reason: result.reason });
        return;
      }
      identities.set(req, result.identity);
      next();
    })
    .catch(next);
}

export function requireWriteAuth(req: Request, res: Response, next: NextFunction): void {
  if (isTunnelRequest(req)) {
    const identity = identities.get(req);
    if (!identity) {
      res.status(401).json({ ok: false, error: "cloudflare access required" });
      return;
    }
    // The Access JWT proves who is at the keyboard; the write token is still
    // the second factor the PWA stores, so a stolen Access session alone
    // cannot type into an agent.
    if (!tokenMatches(readBearer(req) || req.header("x-agent-ops-token"))) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    if (!tunnelWriteLimiter.allow(identity.email)) {
      res.status(429).set("retry-after", String(Math.ceil(TUNNEL_WRITE_WINDOW_MS / 1000))).json({ ok: false, error: "too many write requests" });
      return;
    }
    next();
    return;
  }

  if (isLocalhost(req.ip)) {
    next();
    return;
  }

  if (tokenMatches(readBearer(req) || req.header("x-agent-ops-token"))) {
    next();
    return;
  }

  res.status(401).json({ ok: false, error: "unauthorized" });
}

export function requireTailnetRead(req: Request, res: Response, next: NextFunction): void {
  if (isTunnelRequest(req)) {
    if (identities.has(req)) next();
    else res.status(401).json({ ok: false, error: "cloudflare access required" });
    return;
  }

  if (process.env.TAILSCALE_ONLY !== "true") {
    next();
    return;
  }

  if (isLocalhost(req.ip) || isTailscaleIp(req.ip)) {
    next();
    return;
  }

  res.status(403).json({ ok: false, error: "tailnet access required" });
}

// The WebSocket terminal bypasses Express middleware entirely, so it has to run
// the same checks by hand against the upgrade request and query token.
// Watching a pane follows the read rules; typing into it follows the write rules.
export async function socketReadAllowed(request: IncomingMessage): Promise<boolean> {
  if (isTunnelRequest(request)) {
    const result = await authenticateAccessRequest(request);
    if (!result.ok) return false;
    identities.set(request, result.identity);
    return true;
  }
  if (process.env.TAILSCALE_ONLY !== "true") return true;
  const remote = request.socket.remoteAddress;
  return isLocalhost(remote) || isTailscaleIp(remote);
}

export function socketWriteAllowed(request: IncomingMessage, token: string | null): boolean {
  if (isTunnelRequest(request)) return identities.has(request) && tokenMatches(token);
  const remote = request.socket.remoteAddress;
  if (process.env.TAILSCALE_ONLY === "true" && !(isLocalhost(remote) || isTailscaleIp(remote))) return false;
  if (isLocalhost(remote)) return true;
  return tokenMatches(token);
}

// Fixed-window limiter for writes arriving through the tunnel, per Access
// identity. Generous enough for a human on the dashboard, tight enough that a
// leaked write token cannot be used to hammer the box from the internet.
const TUNNEL_WRITE_WINDOW_MS = 60_000;
const TUNNEL_WRITE_LIMIT = 120;

class FixedWindowLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.sweep(now);
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  reset(): void {
    this.buckets.clear();
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

export const tunnelWriteLimiter = new FixedWindowLimiter(TUNNEL_WRITE_LIMIT, TUNNEL_WRITE_WINDOW_MS);

function tokenMatches(actual: string | null | undefined): boolean {
  const expected = process.env.AGENT_OPS_TOKEN;
  return Boolean(expected) && actual === expected;
}

function readBearer(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function isLocalhost(value?: string): boolean {
  const ip = normalizeIp(value);
  return ip === "127.0.0.1" || ip === "::1";
}

function isTailscaleIp(value?: string): boolean {
  const ip = normalizeIp(value);
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  }
  return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function normalizeIp(value?: string): string {
  return (value || "").replace(/^::ffff:/, "");
}
