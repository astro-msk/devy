import type { Express } from "express";
import { createServer, type Server } from "node:http";
import { markTunnelServer } from "./auth.js";
import { initAccessFromEnv } from "./cf-access.js";
import { attachTerminalBridge } from "./terminal-bridge.js";

// A second, loopback-only listener that cloudflared forwards the public
// hostnames to. It serves the same app, but every connection accepted here is
// marked as a tunnel connection so auth.ts demands a Cloudflare Access JWT
// before doing anything at all. Set the port to 0 to skip it.
export function startTunnelListener(app: Express, port: number, label: string): Server | null {
  if (!Number.isFinite(port) || port <= 0) return null;

  const { verifier, missing } = initAccessFromEnv();
  if (!verifier) {
    console.warn(
      `[${label}] Cloudflare Access is not configured (missing ${missing.join(", ")}); ` +
        `the tunnel listener on 127.0.0.1:${port} will refuse every request until it is.`
    );
  } else {
    console.log(
      `[${label}] Cloudflare Access enforced on tunnel listener: team ${verifier.config.teamDomain}, ` +
        (verifier.config.allowedEmails.length
          ? `${verifier.config.allowedEmails.length} locally allowed email(s)`
          : "identity policy managed by Cloudflare")
    );
  }

  const server = markTunnelServer(createServer(app));
  attachTerminalBridge(server);
  server.listen(port, "127.0.0.1", () => {
    console.log(`[${label}] tunnel listener on http://127.0.0.1:${port} (Cloudflare Access required)`);
  });
  return server;
}
