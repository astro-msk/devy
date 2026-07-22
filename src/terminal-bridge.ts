import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { simpleHash, tmux, tmuxKey, validSessionName } from "./sessions.js";
import { sendInputToSession } from "./tmux.js";

const messageSchema = z.union([
  z.object({ type: z.literal("data"), data: z.string().max(4000) }),
  z.object({ type: z.literal("key"), key: z.string().max(40) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200)
  }),
  z.object({ type: z.literal("ping") })
]);

export function attachTerminalBridge(server: Server, basePath = "/ws/terminal"): WebSocketServer {
  const wss = new WebSocketServer({ server, path: basePath });
  wss.on("connection", (socket, request) => {
    void handleConnection(socket, request).catch((error) =>
      safeSend(socket, { type: "error", message: (error as Error).message })
    );
  });
  return wss;
}

async function handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
  const url = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
  const sessionName = url.searchParams.get("session") || "";
  if (!validSessionName(sessionName)) {
    socket.close(1008, "invalid session");
    return;
  }

  let lastHash = "";
  let closed = false;
  const intervalMs = 400;
  let cols = 100;
  let rows = 30;

  const sizeSession = async () => {
    // Intentionally a no-op. Previously this called `tmux resize-window` with the
    // browser's cols/rows, which hijacked the real tmux window size for any
    // terminal client also attached to the session. capture-pane reads the pane
    // regardless of viewport, so we let the actual attached terminal own the size.
  };

  const sendSnapshot = async (force = false) => {
    if (closed || socket.readyState !== socket.OPEN) return;
    const capture = await tmux([
      "capture-pane",
      "-t",
      sessionName,
      "-p",
      "-e",
      "-S",
      "-2000"
    ]);
    if (capture.code !== 0) {
      safeSend(socket, { type: "error", message: capture.stderr || "tmux capture failed" });
      return;
    }
    const output = capture.stdout;
    const hash = simpleHash(output);
    if (hash !== lastHash || force) {
      lastHash = hash;
      safeSend(socket, { type: "snapshot", output });
    }
  };

  const tick = async () => {
    if (closed) return;
    try {
      await sendSnapshot();
    } catch (error) {
      safeSend(socket, { type: "error", message: (error as Error).message });
    }
  };

  let interval = setInterval(() => void tick(), intervalMs);
  const bump = (burstMs: number): void => {
    clearInterval(interval);
    interval = setInterval(() => void tick(), 150);
    setTimeout(() => {
      if (closed) return;
      clearInterval(interval);
      interval = setInterval(() => void tick(), intervalMs);
    }, burstMs);
  };

  await sizeSession();
  await sendSnapshot(true);

  socket.on("message", async (raw) => {
    try {
      const parsed = messageSchema.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success) return;
      const msg = parsed.data;

      if (msg.type === "ping") {
        safeSend(socket, { type: "pong" });
        return;
      }
      if (msg.type === "resize") {
        cols = msg.cols;
        rows = msg.rows;
        await sizeSession();
        await sendSnapshot(true);
        return;
      }
      if (msg.type === "data") {
        await sendTerminalData(sessionName, msg.data);
        bump(500);
        await sendSnapshot();
        return;
      }
      if (msg.type === "key") {
        const result = await tmux(["send-keys", "-t", sessionName, tmuxKey(msg.key)]);
        if (result.code !== 0) throw new Error(result.stderr || "tmux send-keys failed");
        bump(500);
        await sendSnapshot();
        return;
      }
    } catch (error) {
      safeSend(socket, { type: "error", message: (error as Error).message });
    }
  });

  socket.on("close", () => {
    closed = true;
    clearInterval(interval);
  });
}

async function sendTerminalData(sessionName: string, data: string): Promise<void> {
  for (const chunk of splitTerminalInput(data)) {
    if (chunk.type === "text") {
      await sendInputToSession(sessionName, chunk.value, false);
    } else {
      const result = await tmux(["send-keys", "-t", sessionName, chunk.value]);
      if (result.code !== 0) throw new Error(result.stderr || "tmux send-keys failed");
    }
  }
}

function splitTerminalInput(data: string): Array<{ type: "text" | "key"; value: string }> {
  const chunks: Array<{ type: "text" | "key"; value: string }> = [];
  let text = "";
  const flushText = () => {
    if (text) chunks.push({ type: "text", value: text });
    text = "";
  };

  for (const char of data) {
    const code = char.charCodeAt(0);
    if (code === 0x0d || code === 0x0a) {
      flushText();
      chunks.push({ type: "key", value: "Enter" });
    } else if (code === 0x7f || code === 0x08) {
      flushText();
      chunks.push({ type: "key", value: "BSpace" });
    } else if (code === 0x03) {
      flushText();
      chunks.push({ type: "key", value: "C-c" });
    } else if (code === 0x04) {
      flushText();
      chunks.push({ type: "key", value: "C-d" });
    } else if (code === 0x09) {
      flushText();
      chunks.push({ type: "key", value: "Tab" });
    } else if (code === 0x1b) {
      flushText();
      chunks.push({ type: "key", value: "Escape" });
    } else {
      text += char;
    }
  }
  flushText();
  return chunks;
}

function safeSend(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
}
