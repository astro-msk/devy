import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { socketReadAllowed, socketWriteAllowed } from "./auth.js";
import { simpleHash, tmux, tmuxKey, validSessionName } from "./sessions.js";

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

const IDLE_POLL_MS = 700;
const ACTIVE_POLL_MS = 140;
// How long we keep polling fast after the pane last changed or the user typed.
const ACTIVE_WINDOW_MS = 2500;

export function attachTerminalBridge(server: Server, basePath = "/ws/terminal"): WebSocketServer {
  const wss = new WebSocketServer({ server, path: basePath, maxPayload: 64 * 1024 });

  // Drop half-open connections (phone sleeps, wifi drops) instead of polling
  // tmux forever for a client that will never read the output.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const live = socket as WebSocket & { isAlive?: boolean };
      if (live.isAlive === false) {
        socket.terminate();
        continue;
      }
      live.isAlive = false;
      socket.ping();
    }
  }, 30000);
  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (socket, request) => {
    const live = socket as WebSocket & { isAlive?: boolean };
    live.isAlive = true;
    socket.on("pong", () => {
      live.isAlive = true;
    });
    void handleConnection(socket, request).catch((error) =>
      safeSend(socket, { type: "error", message: (error as Error).message })
    );
  });
  return wss;
}

async function handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
  const url = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
  const sessionName = url.searchParams.get("session") || "";
  const token = url.searchParams.get("token");
  const remote = request.socket.remoteAddress;

  if (!validSessionName(sessionName)) {
    socket.close(1008, "invalid session");
    return;
  }
  if (!socketReadAllowed(remote)) {
    socket.close(1008, "tailnet access required");
    return;
  }
  const canWrite = socketWriteAllowed(remote, token);

  let lastHash = "";
  let closed = false;
  let lastChangeAt = Date.now();
  let timer: NodeJS.Timeout | null = null;

  safeSend(socket, { type: "ready", session: sessionName, canWrite });

  const sendSnapshot = async (force = false) => {
    if (closed || socket.readyState !== socket.OPEN) return;
    // Capture the visible screen only (not 2000 lines of scrollback): it is what
    // the pane actually shows, it is far smaller on the wire, and it lets the
    // client repaint in place instead of clearing and redrawing everything.
    const [capture, cursor] = await Promise.all([
      tmux(["capture-pane", "-t", sessionName, "-p", "-e"]),
      tmux(["display-message", "-p", "-t", sessionName, "#{cursor_x} #{cursor_y}"])
    ]);
    if (capture.code !== 0) {
      safeSend(socket, { type: "error", message: capture.stderr.trim() || "tmux session not found" });
      return;
    }
    const output = capture.stdout.replace(/\n+$/, "");
    const hash = simpleHash(output);
    if (hash === lastHash && !force) return;
    if (hash !== lastHash) lastChangeAt = Date.now();
    lastHash = hash;
    const [cx, cy] = cursor.stdout.trim().split(" ").map((value) => Number(value) || 0);
    safeSend(socket, { type: "snapshot", output, cursor: { x: cx, y: cy } });
  };

  const tick = async () => {
    if (closed) return;
    try {
      await sendSnapshot();
    } catch (error) {
      safeSend(socket, { type: "error", message: (error as Error).message });
    }
    schedule();
  };

  // Self-rescheduling instead of setInterval: a slow tmux call can't stack up
  // overlapping captures, and the cadence follows activity.
  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    const active = Date.now() - lastChangeAt < ACTIVE_WINDOW_MS;
    timer = setTimeout(() => void tick(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  };

  await sendSnapshot(true);
  schedule();

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
        // Deliberately not resizing the tmux window: a phone-sized browser
        // viewport would otherwise shrink the pane for every attached client.
        await sendSnapshot(true);
        return;
      }
      if (!canWrite) {
        safeSend(socket, { type: "error", message: "read-only: save AGENT_OPS_TOKEN in Settings to type here" });
        return;
      }
      if (msg.type === "data") {
        await sendTerminalData(sessionName, msg.data);
      } else if (msg.type === "key") {
        const result = await tmux(["send-keys", "-t", sessionName, tmuxKey(msg.key)]);
        if (result.code !== 0) throw new Error(result.stderr || "tmux send-keys failed");
      }
      lastChangeAt = Date.now();
      await sendSnapshot();
      schedule();
    } catch (error) {
      safeSend(socket, { type: "error", message: (error as Error).message });
    }
  });

  socket.on("close", () => {
    closed = true;
    if (timer) clearTimeout(timer);
  });
}

async function sendTerminalData(sessionName: string, data: string): Promise<void> {
  for (const chunk of splitTerminalInput(data)) {
    // `send-keys -l` sends the text literally; there is deliberately no
    // session-exists probe first, because that doubled the tmux round-trips on
    // every keystroke — a failed send-keys already tells us the session is gone.
    const args =
      chunk.type === "text"
        ? ["send-keys", "-t", sessionName, "-l", chunk.value]
        : ["send-keys", "-t", sessionName, chunk.value];
    const result = await tmux(args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `tmux session not found: ${sessionName}`);
    }
  }
}

// xterm.js sends arrows, Home/End, Delete and friends as CSI escape sequences.
// Forwarding those byte-for-byte as literal text made arrow keys type "[A" into
// Claude's prompt, so translate the common ones into tmux key names.
const escapeSequences: Array<[string, string]> = [
  ["\x1b[A", "Up"],
  ["\x1b[B", "Down"],
  ["\x1b[C", "Right"],
  ["\x1b[D", "Left"],
  ["\x1bOA", "Up"],
  ["\x1bOB", "Down"],
  ["\x1bOC", "Right"],
  ["\x1bOD", "Left"],
  ["\x1b[H", "Home"],
  ["\x1b[F", "End"],
  ["\x1b[1~", "Home"],
  ["\x1b[4~", "End"],
  ["\x1b[3~", "DC"],
  ["\x1b[5~", "PageUp"],
  ["\x1b[6~", "PageDown"],
  ["\x1b[Z", "BTab"]
];

function splitTerminalInput(data: string): Array<{ type: "text" | "key"; value: string }> {
  const chunks: Array<{ type: "text" | "key"; value: string }> = [];
  let text = "";
  const flushText = () => {
    if (text) chunks.push({ type: "text", value: text });
    text = "";
  };
  const pushKey = (value: string) => {
    flushText();
    chunks.push({ type: "key", value });
  };

  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    const code = char.charCodeAt(0);

    if (code === 0x1b) {
      const match = escapeSequences.find(([sequence]) => data.startsWith(sequence, index));
      if (match) {
        pushKey(match[1]);
        index += match[0].length - 1;
        continue;
      }
      // Alt-<char> arrives as ESC followed by the character.
      const next = data[index + 1];
      if (next && next.charCodeAt(0) >= 0x20 && next.charCodeAt(0) < 0x7f) {
        pushKey(`M-${next}`);
        index += 1;
        continue;
      }
      pushKey("Escape");
      continue;
    }

    if (code === 0x0d || code === 0x0a) pushKey("Enter");
    else if (code === 0x7f || code === 0x08) pushKey("BSpace");
    else if (code === 0x09) pushKey("Tab");
    else if (code >= 1 && code <= 26) pushKey(`C-${String.fromCharCode(code + 96)}`);
    else text += char;
  }
  flushText();
  return chunks;
}

function safeSend(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
}
