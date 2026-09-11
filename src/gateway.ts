import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayServer, Gateway } from "./gateway-core.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = process.env.GATEWAY_STATE_FILE || path.join(projectRoot, "data", "gateway.json");
const port = Number(process.env.GATEWAY_PORT || 8791);
// Loopback only: the gateway holds provider keys and trusts every caller.
const host = process.env.GATEWAY_HOST || "127.0.0.1";

const gateway = new Gateway({ stateFile });
await gateway.load();
const server = createGatewayServer(gateway);

const shutdown = (signal: string) => {
  console.log(`[gateway] ${signal}: saving state and closing`);
  server.close();
  gateway.markDirty();
  void gateway.save().finally(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(port, host, () => {
  const routes = gateway.catalog.filter((route) => gateway.isAvailable(route)).map((route) => route.id);
  console.log(`[gateway] listening on http://${host}:${port} — available routes: ${routes.join(", ") || "none"}`);
});
