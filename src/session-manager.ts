import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { attachTerminalBridge } from "./terminal-bridge.js";
import { startTunnelListener } from "./tunnel-listener.js";

const app = createApp();
const port = Number(process.env.MANAGER_PORT || 8790);
const host = process.env.HOST || "0.0.0.0";
const server = createServer(app);
attachTerminalBridge(server);

server.listen(port, host, () => {
  console.log(`Devy sessions listening on http://${host}:${port}`);
});
// Loopback listener that cloudflared forwards sessions.devy.<domain> to; Cloudflare Access JWT required.
startTunnelListener(app, Number(process.env.MANAGER_TUNNEL_PORT || 8798), "Devy sessions");
