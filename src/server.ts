import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { startMonitor, sendSessionInput } from "./monitor.js";
import { startSlackInputListener } from "./slack.js";
import { attachTerminalBridge } from "./terminal-bridge.js";

const app = createApp();
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const server = createServer(app);
attachTerminalBridge(server);

startMonitor();
startSlackInputListener(sendSessionInput);
server.listen(port, host, () => {
  console.log(`agent-ops listening on http://${host}:${port}`);
});
