import type { NextFunction, Request, Response } from "express";
import { isTunnelRequest } from "./auth.js";

// The PWA loads its own scripts from /vendor and /app.js, Inter/JetBrains Mono
// from Google Fonts, and talks to the same origin over fetch, SSE and WebSocket.
// Inline styles are allowed because the UI builds markup with style attributes;
// inline scripts are not.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  // Only the tunnel hostnames are served over HTTPS (Cloudflare terminates
  // TLS); browsers ignore HSTS on the plain-HTTP tailnet listeners anyway.
  if (isTunnelRequest(req)) res.setHeader("strict-transport-security", "max-age=15552000; includeSubDomains");
  // API responses carry session state and tokens' effects; never let a shared
  // cache or the service worker hold on to them.
  if (req.path.startsWith("/api/")) res.setHeader("cache-control", "no-store");
  next();
}
