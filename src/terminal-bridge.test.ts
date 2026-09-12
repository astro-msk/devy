import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { attachTerminalBridge, splitTerminalInput, type TmuxRunner } from "./terminal-bridge.js";

// A stand-in tmux server: one session with a screen the test can change or
// take away, recording every command the bridge issues.
function fakeTmux() {
  const calls: string[][] = [];
  const state = { alive: true, screen: "$ hello\n", cursor: "7 0" };
  const run: TmuxRunner = async (args) => {
    calls.push(args);
    if (!state.alive) return { code: 1, stdout: "", stderr: `can't find session: ${args[2]}` };
    if (args[0] === "capture-pane") return { code: 0, stdout: state.screen, stderr: "" };
    if (args[0] === "display-message") return { code: 0, stdout: `${state.cursor}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, state, run };
}

type Frame = { type: string; [key: string]: unknown };

function connect(url: string) {
  const socket = new WebSocket(url);
  const frames: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  socket.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as Frame;
    frames.push(frame);
    for (const waiter of waiters.splice(0)) {
      if (waiter.match(frame)) waiter.resolve(frame);
      else waiters.push(waiter);
    }
  });
  const next = (match: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> =>
    new Promise((resolve, reject) => {
      const seen = frames.find(match);
      if (seen) {
        frames.splice(frames.indexOf(seen), 1);
        resolve(seen);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`no frame matched within ${timeoutMs}ms; saw ${JSON.stringify(frames)}`)), timeoutMs);
      waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          frames.splice(frames.indexOf(frame), 1);
          resolve(frame);
        }
      });
    });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, frames, next, opened };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let server: Server;
let baseUrl: string;
const tmux = fakeTmux();

before(async () => {
  // Read/write rules are exercised as a localhost client; the auth module's
  // own behaviour is not under test here.
  process.env.TAILSCALE_ONLY = "false";
  server = createServer();
  attachTerminalBridge(server, { tmux: tmux.run });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `ws://127.0.0.1:${address.port}/ws/terminal`;
});

after(async () => {
  delete process.env.TAILSCALE_ONLY;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("sends ready then a snapshot of the visible pane", async () => {
  const client = connect(`${baseUrl}?session=claude-pilot`);
  await client.opened;
  const ready = await client.next((frame) => frame.type === "ready");
  assert.equal(ready.session, "claude-pilot");
  assert.equal(ready.canWrite, true, "localhost may write without a token");
  const snapshot = await client.next((frame) => frame.type === "snapshot");
  assert.equal(snapshot.output, "$ hello");
  assert.deepEqual(snapshot.cursor, { x: 7, y: 0 });
  client.socket.close();
});

test("rejects an invalid session name before touching tmux", async () => {
  const before = tmux.calls.length;
  const client = connect(`${baseUrl}?session=../etc`);
  const code = await new Promise<number>((resolve) => client.socket.once("close", resolve));
  assert.equal(code, 1008);
  assert.equal(tmux.calls.length, before);
});

test("delivers typed input to tmux in order, translating control bytes", async () => {
  const client = connect(`${baseUrl}?session=claude-pilot`);
  await client.opened;
  await client.next((frame) => frame.type === "snapshot");
  const before = tmux.calls.length;

  // Two messages back to back: the bridge must not let the second overtake the first.
  client.socket.send(JSON.stringify({ type: "data", data: "--force" }));
  client.socket.send(JSON.stringify({ type: "data", data: "\x1b[A\r" }));
  client.socket.send(JSON.stringify({ type: "key", key: "Backspace" }));
  await sleep(200);

  const sent = tmux.calls.slice(before).filter((args) => args[0] === "send-keys");
  assert.deepEqual(sent, [
    ["send-keys", "-t", "claude-pilot", "-l", "--", "--force"],
    ["send-keys", "-t", "claude-pilot", "Up"],
    ["send-keys", "-t", "claude-pilot", "Enter"],
    ["send-keys", "-t", "claude-pilot", "BSpace"]
  ]);
  client.socket.close();
});

test("reports a vanished session once and resumes when it returns", async () => {
  const client = connect(`${baseUrl}?session=claude-pilot`);
  await client.opened;
  await client.next((frame) => frame.type === "snapshot");

  tmux.state.alive = false;
  const error = await client.next((frame) => frame.type === "error");
  assert.match(String(error.message), /can't find session/);
  // Several idle polls' worth of time: the same outage must not be repeated.
  await sleep(1600);
  assert.equal(client.frames.filter((frame) => frame.type === "error").length, 0);

  tmux.state.alive = true;
  tmux.state.screen = "$ back again\n";
  const snapshot = await client.next((frame) => frame.type === "snapshot", 5000);
  assert.equal(snapshot.output, "$ back again");
  client.socket.close();
});

test("an unchanged screen is not re-sent, a changed one is", async () => {
  tmux.state.screen = "$ hello\n";
  const client = connect(`${baseUrl}?session=claude-pilot`);
  await client.opened;
  await client.next((frame) => frame.type === "snapshot");
  await sleep(500);
  assert.equal(client.frames.filter((frame) => frame.type === "snapshot").length, 0);

  tmux.state.screen = "$ hello\n$ world\n";
  const snapshot = await client.next((frame) => frame.type === "snapshot");
  assert.equal(snapshot.output, "$ hello\n$ world");
  client.socket.close();
});

test("splits xterm input into literal text and tmux key names", () => {
  assert.deepEqual(splitTerminalInput("ls -la\r"), [
    { type: "text", value: "ls -la" },
    { type: "key", value: "Enter" }
  ]);
  assert.deepEqual(splitTerminalInput("\x1b[3~\x1bx\x1b\x03\t\x7f"), [
    { type: "key", value: "DC" },
    { type: "key", value: "M-x" },
    { type: "key", value: "Escape" },
    { type: "key", value: "C-c" },
    { type: "key", value: "Tab" },
    { type: "key", value: "BSpace" }
  ]);
});
