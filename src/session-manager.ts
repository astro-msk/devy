import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { attachTerminalBridge } from "./terminal-bridge.js";

const app = createApp();
const port = Number(process.env.MANAGER_PORT || 8790);
const host = process.env.HOST || "0.0.0.0";
const server = createServer(app);
attachTerminalBridge(server);

server.listen(port, host, () => {
  console.log(`agent-sessions listening on http://${host}:${port}`);
});
