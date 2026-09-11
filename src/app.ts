import express, { type Express } from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { requireTailnetRead, requireWriteAuth } from "./auth.js";
import { activeModel, aiConfigured, providerName, streamAsk } from "./ai.js";
import {
  deleteConversation,
  deleteMemory,
  getConversation,
  listConversations,
  listMemories,
  newConversation,
  saveMemory,
  searchMemories
} from "./ai-memory.js";
import { getRecentEvents } from "./db.js";
import {
  getCachedStatuses,
  getObservedSessions,
  recordEvent,
  sendAgentInput,
  sendSessionInput
} from "./monitor.js";
import { listProjects } from "./projects.js";
import { buildAllIndices } from "./repo-index.js";
import {
  activePaneDirectory,
  createManagedSession,
  invalidateSessionCache,
  listManagedSessions,
  tmux,
  tmuxKey,
  validSessionName
} from "./sessions.js";

const sessionNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.:-]+$/);

const eventSchema = z.object({
  agent: z.enum(["claude", "codex", "system"]),
  type: z.enum(["notification", "approval_required", "completed", "error", "info"]),
  message: z.string().min(1).max(5000),
  session: sessionNameSchema.optional(),
  repoPath: z.string().min(1).max(500).optional(),
  raw: z.unknown().optional()
});

const inputSchema = z.object({
  text: z.string().min(1).max(4000),
  submit: z.boolean().optional().default(true)
});

const createSessionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  agent: z.enum(["claude", "codex"]),
  directory: z.string().min(1).max(500)
});

const claudePermissionSchema = z.object({
  directory: z.string().min(1).max(500),
  defaultMode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  addAllow: z.string().max(500).optional(),
  addDeny: z.string().max(500).optional(),
  removeAllow: z.string().max(500).optional(),
  removeDeny: z.string().max(500).optional()
});

const codexPermissionSchema = z.object({
  directory: z.string().min(1).max(500),
  approvalPolicy: z.enum(["untrusted", "on-failure", "on-request", "never"]).optional(),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional()
});

const askSchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.string().regex(/^[a-f0-9]{1,32}$/).optional()
});

const memorySchema = z.object({
  topic: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  tags: z.array(z.string().max(40)).max(12).optional(),
  id: z.string().regex(/^[a-f0-9]{1,32}$/).optional()
});

export function createApp(): Express {
  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.resolve(__dirname, "../web");
  const projectRoot = path.resolve(__dirname, "..");

  app.set("trust proxy", false);
  app.use(express.json({ limit: "1mb" }));
  app.use(requireTailnetRead);

  app.use("/vendor/xterm", express.static(path.join(projectRoot, "node_modules/@xterm/xterm/lib")));
  app.use("/vendor/xterm/css", express.static(path.join(projectRoot, "node_modules/@xterm/xterm/css")));
  app.use("/vendor/xterm-addon-fit", express.static(path.join(projectRoot, "node_modules/@xterm/addon-fit/lib")));
  app.use("/vendor/xterm-addon-web-links", express.static(path.join(projectRoot, "node_modules/@xterm/addon-web-links/lib")));
  app.use("/vendor/xterm-addon-search", express.static(path.join(projectRoot, "node_modules/@xterm/addon-search/lib")));
  app.use("/vendor/xterm-addon-unicode11", express.static(path.join(projectRoot, "node_modules/@xterm/addon-unicode11/lib")));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      app: "devy",
      time: new Date().toISOString(),
      hostname: os.hostname(),
      aiEnabled: aiConfigured(),
      agentInputEnabled: agentInputEnabled(),
      tailscaleOnly: process.env.TAILSCALE_ONLY === "true",
      tokenRequired: Boolean(process.env.AGENT_OPS_TOKEN)
    });
  });

  app.get("/api/status", async (_req, res) => {
    const sessions = await getObservedSessions();
    res.json({ agents: getCachedStatuses(), sessions });
  });

  app.get("/api/sessions", async (_req, res) => {
    res.json({ sessions: await listManagedSessions() });
  });

  app.get("/api/projects", async (_req, res) => {
    res.json({ projects: await listProjects() });
  });

  app.get("/api/repos/index", async (_req, res) => {
    res.json({ repos: await buildAllIndices() });
  });

  app.get("/api/system", async (_req, res) => {
    res.json(await getSystemStats());
  });

  app.get("/api/events", (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ events: getRecentEvents(Number.isFinite(limit) ? limit : 50) });
  });

  app.get("/api/events/stream", (req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const since = Number(req.query.since);
    // `since=0` would replay the last 50 events into a client that already has
    // them, so an unusable `since` starts from the newest id instead.
    let lastSeen = Number.isFinite(since) && since > 0 ? since : getRecentEvents(1)[0]?.id ?? 0;

    const tick = () => {
      const events = getRecentEvents(50).filter((event) => event.id > lastSeen);
      if (!events.length) return;
      lastSeen = events[0].id;
      for (const event of events.slice().reverse()) {
        res.write(`id: ${event.id}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };

    const interval = setInterval(tick, 2000);
    // Comment frames keep the connection from being reaped by idle timeouts and
    // let the client notice a dead server instead of silently going quiet.
    const keepAlive = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 20000);
    const stop = () => {
      clearInterval(interval);
      clearInterval(keepAlive);
    };
    req.on("close", stop);
    res.on("close", stop);
  });

  app.post("/api/events", requireWriteAuth, async (req, res) => {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.flatten() });
      return;
    }
    await recordEvent(parsed.data);
    res.status(201).json({ ok: true });
  });

  app.post("/api/agents/:agent/input", requireWriteAuth, async (req, res) => {
    if (!agentInputEnabled()) {
      res.status(403).json({ ok: false, error: "agent input is disabled" });
      return;
    }
    const agent = z.enum(["claude", "codex"]).safeParse(req.params.agent);
    const input = inputSchema.safeParse(req.body);
    if (!agent.success || !input.success) {
      res.status(400).json({ ok: false, error: "invalid agent or input" });
      return;
    }
    try {
      await sendAgentInput(agent.data, input.data.text, input.data.submit, "browser");
      res.status(201).json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  app.post("/api/sessions", requireWriteAuth, async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid session request" });
      return;
    }
    try {
      await createManagedSession(parsed.data.name, parsed.data.agent, parsed.data.directory);
      res.status(201).json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  app.post("/api/sessions/:session/input", requireWriteAuth, async (req, res) => {
    const sessionName = String(req.params.session || "");
    const input = inputSchema.safeParse(req.body);
    if (!validSessionName(sessionName) || !input.success) {
      res.status(400).json({ ok: false, error: "invalid session or input" });
      return;
    }
    if (!agentInputEnabled()) {
      res.status(403).json({ ok: false, error: "agent input is disabled (ENABLE_AGENT_INPUT=false)" });
      return;
    }
    try {
      await sendSessionInput(sessionName, input.data.text, input.data.submit, "browser");
      res.status(201).json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  app.post("/api/sessions/:session/key", requireWriteAuth, async (req, res) => {
    const sessionName = String(req.params.session || "");
    const parsed = z
      .object({ key: z.enum(["Enter", "Backspace", "C-c", "C-d", "Up", "Down", "Tab", "Escape"]) })
      .safeParse(req.body);
    if (!validSessionName(sessionName) || !parsed.success) {
      res.status(400).json({ ok: false, error: "invalid session or key" });
      return;
    }
    try {
      const result = await tmux(["send-keys", "-t", sessionName, tmuxKey(parsed.data.key)]);
      if (result.code !== 0) throw new Error(result.stderr || "tmux send-keys failed");
      res.status(201).json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  app.delete("/api/sessions/:session", requireWriteAuth, async (req, res) => {
    const sessionName = String(req.params.session || "");
    if (!validSessionName(sessionName)) {
      res.status(400).json({ ok: false, error: "invalid session name" });
      return;
    }
    try {
      const result = await tmux(["kill-session", "-t", sessionName]);
      if (result.code !== 0) throw new Error(result.stderr.trim() || "tmux kill-session failed");
      invalidateSessionCache();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  app.get("/api/permissions", async (req, res) => {
    const sessionName = String(req.query.session || "");
    if (!validSessionName(sessionName)) {
      res.status(400).json({ ok: false, error: "invalid session name" });
      return;
    }
    try {
      const directory = await activePaneDirectory(sessionName);
      res.json({ ok: true, directory, permissions: await readProjectPermissions(directory) });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  app.patch("/api/permissions/claude", requireWriteAuth, async (req, res) => {
    const parsed = claudePermissionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid Claude permission request" });
      return;
    }
    try {
      const directory = safeProjectDirectory(parsed.data.directory);
      await updateClaudePermissions(directory, parsed.data);
      res.json({ ok: true, directory, permissions: await readProjectPermissions(directory) });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  app.patch("/api/permissions/codex", requireWriteAuth, async (req, res) => {
    const parsed = codexPermissionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid Codex permission request" });
      return;
    }
    try {
      const directory = safeProjectDirectory(parsed.data.directory);
      await updateCodexPermissions(directory, parsed.data);
      res.json({ ok: true, directory, permissions: await readProjectPermissions(directory) });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  // ─── AI assistant ─────────────────────────────────────────────────────────
  app.get("/api/ai/status", (_req, res) => {
    res.json({ enabled: aiConfigured(), provider: providerName(), model: activeModel() });
  });

  app.post("/api/ai/ask", requireWriteAuth, async (req, res) => {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid ask request" });
      return;
    }
    try {
      await streamAsk({ message: parsed.data.message, conversationId: parsed.data.conversationId, res });
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ ok: false, error: (error as Error).message });
    }
  });

  app.get("/api/ai/conversations", async (_req, res) => {
    res.json({ conversations: await listConversations() });
  });

  app.get("/api/ai/conversations/:id", async (req, res) => {
    const conv = await getConversation(req.params.id);
    if (!conv) {
      res.status(404).json({ ok: false, error: "not found" });
      return;
    }
    res.json({ conversation: conv });
  });

  app.post("/api/ai/conversations", requireWriteAuth, async (req, res) => {
    const title = String((req.body && req.body.title) || "New chat");
    res.status(201).json({ conversation: await newConversation(title) });
  });

  app.delete("/api/ai/conversations/:id", requireWriteAuth, async (req, res) => {
    const ok = await deleteConversation(String(req.params.id));
    res.json({ ok });
  });

  app.get("/api/ai/memories", async (req, res) => {
    const q = String(req.query.q || "");
    res.json({ memories: q ? await searchMemories(q) : await listMemories() });
  });

  app.post("/api/ai/memories", requireWriteAuth, async (req, res) => {
    const parsed = memorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid memory" });
      return;
    }
    res.status(201).json({ memory: await saveMemory(parsed.data) });
  });

  app.delete("/api/ai/memories/:id", requireWriteAuth, async (req, res) => {
    const ok = await deleteMemory(String(req.params.id));
    res.json({ ok });
  });

  app.use(express.static(webDir, { index: "index.html", extensions: ["html"] }));

  // Unknown /api/* paths used to fall through to index.html, so a typo'd fetch
  // resolved with an HTML body and failed later at JSON.parse.
  app.use("/api", (_req, res) => {
    res.status(404).json({ ok: false, error: "unknown endpoint" });
  });

  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(webDir, "index.html"));
  });

  // Without this, a throw inside any handler yields Express's HTML error page
  // (or a hung request), which the client surfaces as an unparseable response.
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[Devy] unhandled request error:", error);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: error.message || "internal error" });
  });

  return app;
}

// Every write path already requires auth; this switch exists to hard-disable
// typing into agents. Unset means enabled — the dashboard is useless read-only.
function agentInputEnabled(): boolean {
  return process.env.ENABLE_AGENT_INPUT !== "false";
}

async function readProjectPermissions(directory: string): Promise<unknown> {
  const resolved = safeProjectDirectory(directory);
  const claudePath = path.join(resolved, ".claude/settings.local.json");
  const codexPath = path.join(resolved, ".codex/config.toml");
  return {
    claude: {
      path: claudePath,
      settings: await readJsonObject(claudePath)
    },
    codex: {
      path: codexPath,
      config: await readTomlObject(codexPath)
    }
  };
}

async function updateClaudePermissions(
  directory: string,
  request: z.infer<typeof claudePermissionSchema>
): Promise<void> {
  const resolved = safeProjectDirectory(directory);
  const settingsPath = path.join(resolved, ".claude/settings.local.json");
  const settings = await readJsonObject(settingsPath);
  const permissions = objectValue(settings.permissions);
  const allow = stringArray(permissions.allow);
  const deny = stringArray(permissions.deny);

  if (request.defaultMode) permissions.defaultMode = request.defaultMode;
  if (request.addAllow?.trim()) addUnique(allow, request.addAllow.trim());
  if (request.addDeny?.trim()) addUnique(deny, request.addDeny.trim());
  if (request.removeAllow) removeValue(allow, request.removeAllow);
  if (request.removeDeny) removeValue(deny, request.removeDeny);

  permissions.allow = allow;
  permissions.deny = deny;
  settings.permissions = permissions;
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function updateCodexPermissions(
  directory: string,
  request: z.infer<typeof codexPermissionSchema>
): Promise<void> {
  const resolved = safeProjectDirectory(directory);
  const configPath = path.join(resolved, ".codex/config.toml");
  const config = await readTomlObject(configPath);
  if (request.approvalPolicy) config.approval_policy = request.approvalPolicy;
  if (request.sandboxMode) config.sandbox_mode = request.sandboxMode;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, stringifyToml(config), "utf8");
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(filePath, "utf8");
    return objectValue(JSON.parse(content));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return {};
    throw error;
  }
}

async function readTomlObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(filePath, "utf8");
    return objectValue(parseToml(content));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return {};
    throw error;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function removeValue(values: string[], value: string): void {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

function safeProjectDirectory(directory: string): string {
  const expanded = directory.startsWith("~")
    ? directory.replace(/^~(?=\/|$)/, process.env.HOME || "/home/ubuntu")
    : directory;
  const normalized = path.resolve(expanded);
  if (normalized !== "/home/ubuntu" && !normalized.startsWith("/home/ubuntu/")) {
    throw new Error("directory must be under /home/ubuntu");
  }
  return normalized;
}

async function getSystemStats(): Promise<unknown> {
  const cpus = os.cpus();
  const load = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const diskPath = process.env.REPO_PATH || process.cwd();

  let disk: unknown = null;
  try {
    const stats = await statfs(diskPath);
    disk = {
      path: diskPath,
      total: stats.blocks * stats.bsize,
      free: stats.bavail * stats.bsize,
      usedPercent: Math.round(((stats.blocks - stats.bavail) / stats.blocks) * 100)
    };
  } catch {
    disk = { path: diskPath, total: 0, free: 0, usedPercent: 0 };
  }

  return {
    hostname: os.hostname(),
    uptimeSeconds: os.uptime(),
    load1: load[0],
    // Load average alone is meaningless without knowing the core count; expose
    // the normalized ratio so the UI can colour it sensibly.
    loadPercent: cpus.length ? Math.min(100, Math.round((load[0] / cpus.length) * 100)) : 0,
    cpuCount: cpus.length,
    memory: {
      total: totalMem,
      free: freeMem,
      usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100)
    },
    disk
  };
}
