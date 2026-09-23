// Codex keeps a provider snapshot in each loaded task. A stable gateway URL
// makes future provider changes effective without editing those snapshots.
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { parse } from "smol-toml";
import { findAccount, gatewayUrl } from "./gateway-config.js";
import { accountStatus, gatewayRequest } from "./gateway-client.js";

export const CODEX_GATEWAY_SESSION = "codex-app";
export type CodexServerStatus = {
  status: "connected" | "restart-required" | "unavailable" | "error";
  detail: string;
  configuredProvider?: string;
};
type ConfigEdit = { keyPath: string; value: unknown; mergeStrategy: "replace" };

export function codexGatewayEdits(baseUrl: string): ConfigEdit[] {
  const url = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error("The Codex gateway must use a loopback address");
  }
  return [
    { keyPath: "model_providers.devy", value: {
      name: "Devy gateway", base_url: `${baseUrl}/codex/${CODEX_GATEWAY_SESSION}`,
      wire_api: "responses", supports_websockets: false, requires_openai_auth: true
    }, mergeStrategy: "replace" },
    { keyPath: "model_provider", value: "devy", mergeStrategy: "replace" }
  ];
}

/** Use the supported config writer in an isolated process, never load a task
 * or kill/restart the user's desktop server. No model request is made. */
export async function writeCodexGatewayConfig(home: string, baseUrl: string): Promise<void> {
  const edits = codexGatewayEdits(baseUrl);
  const child = spawn("codex", ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"]
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const fail = (error: Error) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Codex config writer exited before replying")));
  child.stdin.on("error", fail);
  // Config validation errors are returned by RPC. Never relay arbitrary
  // stderr (which can contain credentials from a user's integrations).
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let reply: { id?: number; result?: unknown; error?: { message: string } };
    try { reply = JSON.parse(line); } catch { return; }
    if (reply.id === undefined) return;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id); clearTimeout(waiter.timer);
    if (reply.error) waiter.reject(new Error("Codex rejected the gateway configuration"));
    else waiter.resolve(reply.result);
  });
  const rpc = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Codex config update timed out")); }, 8000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await rpc("initialize", { clientInfo: { name: "devy_gateway", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    await rpc("config/batchWrite", { edits });
  } finally {
    lines.close(); child.stdin.end(); child.kill("SIGTERM");
    fail(new Error("Codex config connection closed"));
  }
}

export async function codexServerStatus(traffic: { session: string; at: number; status: number }[] = []): Promise<CodexServerStatus> {
  const account = findAccount("chatgpt-personal")!;
  try {
    const config = parse(await readFile(path.join(account.dir, "config.toml"), "utf8"));
    const configuredProvider = typeof config.model_provider === "string" ? config.model_provider : "openai";
    const providers = config.model_providers as Record<string, { base_url?: string }> | undefined;
    const connected = configuredProvider === "devy" && providers?.devy?.base_url === `${gatewayUrl()}/codex/${CODEX_GATEWAY_SESSION}`;
    if (!connected) return { status: "restart-required", configuredProvider, detail: `Codex is configured for ${configuredProvider}. Apply a Codex default to connect it to Devy, then reconnect existing desktop tasks once.` };
    const recent = traffic.some((entry) => entry.session === CODEX_GATEWAY_SESSION && entry.status < 400 && entry.at > Date.now() - 300_000);
    return { status: recent ? "connected" : "restart-required", configuredProvider,
      detail: recent ? "Codex requests are reaching Devy. Older tasks still using a direct provider need reconnecting once."
        : "Codex is configured for Devy. Reconnect existing desktop tasks once; later provider changes apply on the next request." };
  } catch {
    return { status: "unavailable", detail: "Codex server configuration is not available on this host." };
  }
}

let configuring: Promise<CodexServerStatus> | null = null;
export function connectCodexGateway(routeAccount: string | null): Promise<CodexServerStatus> {
  // Serialize concurrent browser tabs so they cannot overwrite the config or
  // mistake a half-finished configuration for a working connection.
  const next = (configuring ?? Promise.resolve()).then(async (): Promise<CodexServerStatus> => {
    const account = findAccount("chatgpt-personal")!;
    if (routeAccount && routeAccount !== account.id) return { status: "restart-required", detail: "Codex desktop uses the default ChatGPT login. Reconnect with the selected account to change subscription accounts." };
    if (!(await accountStatus(account)).signedIn) return { status: "error", detail: "Sign in to the default ChatGPT account before connecting the Codex desktop server." };
    try {
      const configPath = path.join(account.dir, "config.toml");
      // Keep a private recovery copy; the Codex writer preserves unrelated
      // settings, comments, provider definitions and authentication files.
      await copyFile(configPath, `${configPath}.before-devy`, constants.COPYFILE_EXCL).then(() => chmod(`${configPath}.before-devy`, 0o600)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
      });
      await gatewayRequest("PUT", `/sessions/${CODEX_GATEWAY_SESSION}`, { route: null, mode: "auto", account: account.id, lane: "codex" });
      await writeCodexGatewayConfig(account.dir, gatewayUrl());
      return await codexServerStatus();
    } catch {
      return { status: "error", detail: "Gateway selection was saved, but Codex configuration could not be updated. Reapply the default to retry." };
    }
  });
  configuring = next;
  void next.finally(() => { if (configuring === next) configuring = null; });
  return next;
}


/**
 * Restart the Codex desktop app-server daemon (`codex app-server --listen`),
 * which pins provider settings per thread in memory. It only exits on SIGINT;
 * the desktop's ssh proxy respawns it, and threads reload from disk.
 */
export function restartCodexServer(): Promise<{ restarted: number; pids: number[] }> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-af", "app-server --listen"], { timeout: 3000 }, (error, stdout) => {
      const pids = (stdout || "")
        .split("\n")
        // The desktop spawns `codex [-c key=value ...] app-server --listen ...`; the
        // ssh-side `codex app-server proxy` processes are not the daemon.
        .filter((line) => /\bcodex\b.*\bapp-server\b/.test(line) && /--listen/.test(line) && !/\bproxy\b/.test(line) && !/pgrep/.test(line))
        .map((line) => Number(line.trim().split(/\s+/)[0]))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      let restarted = 0;
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGINT");
          restarted += 1;
        } catch {
          /* already gone */
        }
      }
      resolve({ restarted, pids });
    });
  });
}
