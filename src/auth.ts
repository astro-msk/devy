import type { NextFunction, Request, Response } from "express";
import net from "node:net";

export function requireWriteAuth(req: Request, res: Response, next: NextFunction): void {
  if (isLocalhost(req.ip)) {
    next();
    return;
  }

  const expected = process.env.AGENT_OPS_TOKEN;
  const actual = readBearer(req) || req.header("x-agent-ops-token");
  if (expected && actual === expected) {
    next();
    return;
  }

  res.status(401).json({ ok: false, error: "unauthorized" });
}

export function requireTailnetRead(req: Request, res: Response, next: NextFunction): void {
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
// the same checks by hand against the raw socket address and query token.
// Watching a pane follows the read rules; typing into it follows the write rules.
export function socketReadAllowed(remoteAddress: string | undefined): boolean {
  if (process.env.TAILSCALE_ONLY !== "true") return true;
  return isLocalhost(remoteAddress) || isTailscaleIp(remoteAddress);
}

export function socketWriteAllowed(remoteAddress: string | undefined, token: string | null): boolean {
  if (!socketReadAllowed(remoteAddress)) return false;
  if (isLocalhost(remoteAddress)) return true;
  const expected = process.env.AGENT_OPS_TOKEN;
  return Boolean(expected) && token === expected;
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
