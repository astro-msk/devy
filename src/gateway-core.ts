// The gateway proper: a streaming reverse proxy that Claude Code and Codex
// sessions point at. It picks an upstream per session, swaps credentials,
// streams the response through byte-for-byte, and fails over to the next
// route when an upstream rate-limits or errors — before any byte has reached
// the client, so the client never sees a torn response.
//
// URL shape:  /<lane>/<session>/<client path>   e.g. /claude/pilot-1/v1/messages
//             /_gw/...                            admin API (loopback only)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  emptyCounters,
  mapModel,
  PROBE_PREFIX,
  reconcileState,
  routeCatalog,
  type GatewayState,
  type Lane,
  type RouteCounters,
  type RouteDef,
  type SessionAssignment,
  type SessionMode
} from "./gateway-config.js";

export type RouteHealth = {
  status: "ok" | "cooling" | "error" | "unknown";
  coolUntil: number | null;
  reason: string | null;
  /** Rate-limit headers last seen from this upstream (anthropic-ratelimit-*, x-codex-*, ...). */
  limits: Record<string, string>;
  limitsAt: number | null;
};

export type LogEntry = {
  id: number;
  at: number;
  lane: Lane;
  session: string;
  route: string;
  attempts: number;
  status: number;
  ms: number;
  model: string | null;
  upstreamModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  error: string | null;
};

export type GatewayOptions = {
  stateFile: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Override the catalog (tests point routes at local servers). */
  catalog?: RouteDef[];
  logSize?: number;
};

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "accept-encoding"
]);
const AUTH_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);
const LIMIT_HEADER = /^(anthropic-ratelimit-|x-ratelimit-|x-codex-|retry-after$|x-should-retry$)/i;
const MAX_TAP_BYTES = 4 * 1024 * 1024;
const DUMMY_TOKENS = new Set(["devy-gateway"]);

export class Gateway {
  readonly catalog: RouteDef[];
  readonly byId: Map<string, RouteDef>;
  state: GatewayState;
  readonly health = new Map<string, RouteHealth>();
  readonly log: LogEntry[] = [];
  readonly startedAt = Date.now();
  private logSeq = 0;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly stateFile: string;
  private readonly logSize: number;

  constructor(options: GatewayOptions) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.stateFile = options.stateFile;
    this.logSize = options.logSize ?? 300;
    this.catalog = options.catalog ?? routeCatalog(this.env);
    this.byId = new Map(this.catalog.map((route) => [route.id, route]));
    this.state = reconcileState(null, this.catalog);
    for (const route of this.catalog) {
      this.health.set(route.id, { status: "unknown", coolUntil: null, reason: null, limits: {}, limitsAt: null });
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.stateFile, "utf8");
      this.state = reconcileState(JSON.parse(raw) as Partial<GatewayState>, this.catalog);
    } catch {
      this.state = reconcileState(null, this.catalog);
    }
  }

  markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 500);
    this.saveTimer.unref();
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.stateFile);
  }

  // ── Route selection ──────────────────────────────────────────────────────

  isEnabled(route: RouteDef): boolean {
    return this.state.enabled[route.id] ?? route.defaultEnabled;
  }

  isAvailable(route: RouteDef): boolean {
    return !route.unavailableReason && Boolean(route.upstream) && this.isEnabled(route);
  }

  laneRoutes(lane: Lane): RouteDef[] {
    return this.state.order[lane].map((id) => this.byId.get(id)).filter((route): route is RouteDef => Boolean(route));
  }

  assignment(session: string): SessionAssignment | null {
    return this.state.assignments[session] ?? null;
  }

  /**
   * Routes to try for a request, in order. A passthrough route only works when
   * the session was launched with that route's login, because the gateway never
   * substitutes one subscription token for another.
   */
  candidates(lane: Lane, session: string, clientHasLogin: boolean): { primary: RouteDef | null; chain: RouteDef[]; mode: SessionMode; skipped: string[] } {
    const skipped: string[] = [];
    let assignment = this.assignment(session);
    if (!assignment && session.startsWith(PROBE_PREFIX)) {
      assignment = { route: session.slice(PROBE_PREFIX.length), mode: "pinned", account: null, updatedAt: Date.now() };
    }
    const primaryId = assignment?.route ?? this.state.defaults[lane];
    const primary = primaryId ? this.byId.get(primaryId) ?? null : null;
    const mode: SessionMode = assignment?.mode ?? "auto";
    const now = Date.now();

    const usable = (route: RouteDef): boolean => {
      if (route.lane !== lane) return false;
      if (!this.isAvailable(route)) {
        skipped.push(`${route.id}: ${route.unavailableReason ?? "disabled"}`);
        return false;
      }
      if (route.auth.type === "passthrough") {
        if (!clientHasLogin) {
          skipped.push(`${route.id}: session has no login token`);
          return false;
        }
        if (assignment?.account && route.account !== assignment.account) {
          skipped.push(`${route.id}: session was launched with ${assignment.account}`);
          return false;
        }
      }
      return true;
    };

    const chain: RouteDef[] = [];
    if (primary && usable(primary)) chain.push(primary);
    if (mode === "auto" && this.state.autoSwitch) {
      for (const route of this.laneRoutes(lane)) {
        if (chain.includes(route) || route === primary) continue;
        if (usable(route)) chain.push(route);
      }
    }
    // Cooling routes go last instead of being dropped, so a fully rate-limited
    // lane still gets a real upstream answer rather than a synthetic 503.
    const warm = chain.filter((route) => !this.isCooling(route, now));
    const cooling = chain.filter((route) => this.isCooling(route, now));
    return { primary, chain: [...warm, ...cooling], mode, skipped };
  }

  isCooling(route: RouteDef, now = Date.now()): boolean {
    const health = this.health.get(route.id);
    return Boolean(health?.coolUntil && health.coolUntil > now);
  }

  // ── Health bookkeeping ───────────────────────────────────────────────────

  counters(routeId: string): RouteCounters {
    return (this.state.counters[routeId] ??= emptyCounters());
  }

  noteLimits(route: RouteDef, headers: Headers): void {
    const health = this.health.get(route.id)!;
    let seen = false;
    headers.forEach((value, key) => {
      if (LIMIT_HEADER.test(key)) {
        health.limits[key.toLowerCase()] = value;
        seen = true;
      }
    });
    if (seen) health.limitsAt = Date.now();
  }

  noteOk(route: RouteDef): void {
    const health = this.health.get(route.id)!;
    health.status = "ok";
    health.coolUntil = null;
    health.reason = null;
    const counters = this.counters(route.id);
    counters.lastOkAt = Date.now();
    this.markDirty();
  }

  noteFailure(route: RouteDef, status: number, headers: Headers | null, reason: string): void {
    const health = this.health.get(route.id)!;
    const now = Date.now();
    let coolMs = status === 429 ? 5 * 60_000 : status >= 500 ? 60_000 : 30_000;
    if (headers) {
      const retryAfter = Number(headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) coolMs = retryAfter * 1000;
      // Anthropic's unified limit reports the reset as an epoch (seconds).
      const reset = Number(headers.get("anthropic-ratelimit-unified-reset"));
      if (status === 429 && Number.isFinite(reset) && reset * 1000 > now) coolMs = reset * 1000 - now;
      headers.forEach((value, key) => {
        if (/reset-after-seconds$/i.test(key) && Number(value) > 0) coolMs = Number(value) * 1000;
      });
    }
    coolMs = Math.min(coolMs, 6 * 60 * 60_000);
    health.status = status === 429 ? "cooling" : "error";
    health.coolUntil = now + coolMs;
    health.reason = reason;
    const counters = this.counters(route.id);
    counters.errors += 1;
    counters.lastErrorAt = now;
    counters.lastError = reason.slice(0, 300);
    this.markDirty();
  }

  resetHealth(routeId: string): void {
    const health = this.health.get(routeId);
    if (!health) return;
    health.status = "unknown";
    health.coolUntil = null;
    health.reason = null;
  }

  pushLog(entry: Omit<LogEntry, "id">): LogEntry {
    const full = { id: ++this.logSeq, ...entry };
    this.log.push(full);
    if (this.log.length > this.logSize) this.log.splice(0, this.log.length - this.logSize);
    return full;
  }

  // ── Admin views ──────────────────────────────────────────────────────────

  view() {
    const now = Date.now();
    return {
      ok: true,
      startedAt: this.startedAt,
      now,
      autoSwitch: this.state.autoSwitch,
      defaults: this.state.defaults,
      order: this.state.order,
      routes: this.catalog.map((route) => {
        const health = this.health.get(route.id)!;
        return {
          id: route.id,
          lane: route.lane,
          label: route.label,
          provider: route.provider,
          description: route.description,
          upstream: route.upstream,
          authType: route.auth.type,
          account: route.account ?? null,
          modelMap: route.modelMap ?? null,
          modelPrefix: route.modelPrefix ?? null,
          enabled: this.isEnabled(route),
          available: this.isAvailable(route),
          unavailableReason: route.unavailableReason,
          isDefault: this.state.defaults[route.lane] === route.id,
          health: { ...health, cooling: Boolean(health.coolUntil && health.coolUntil > now) },
          counters: this.counters(route.id)
        };
      }),
      assignments: this.state.assignments,
      log: this.log.slice(-120).reverse()
    };
  }

  // ── Admin mutations ──────────────────────────────────────────────────────

  updateSettings(patch: { autoSwitch?: boolean; defaults?: Partial<Record<Lane, string | null>> }): void {
    if (typeof patch.autoSwitch === "boolean") this.state.autoSwitch = patch.autoSwitch;
    for (const lane of ["claude", "codex"] as Lane[]) {
      const id = patch.defaults?.[lane];
      if (id === undefined) continue;
      if (id !== null && this.byId.get(id)?.lane !== lane) throw new Error(`unknown ${lane} route: ${id}`);
      this.state.defaults[lane] = id;
    }
    this.markDirty();
  }

  updateRoute(routeId: string, patch: { enabled?: boolean; position?: number }): void {
    const route = this.byId.get(routeId);
    if (!route) throw new Error(`unknown route: ${routeId}`);
    if (typeof patch.enabled === "boolean") this.state.enabled[routeId] = patch.enabled;
    if (typeof patch.position === "number") {
      const order = this.state.order[route.lane].filter((id) => id !== routeId);
      const index = Math.max(0, Math.min(order.length, Math.floor(patch.position)));
      order.splice(index, 0, routeId);
      this.state.order[route.lane] = order;
    }
    this.markDirty();
  }

  assign(session: string, patch: { route?: string | null; mode?: SessionMode; account?: string | null }): SessionAssignment {
    const current = this.state.assignments[session] ?? { route: null, mode: "auto" as SessionMode, account: null, updatedAt: 0 };
    if (patch.route !== undefined && patch.route !== null && !this.byId.has(patch.route)) throw new Error(`unknown route: ${patch.route}`);
    const next: SessionAssignment = {
      route: patch.route === undefined ? current.route : patch.route,
      mode: patch.mode ?? current.mode,
      account: patch.account === undefined ? current.account : patch.account,
      updatedAt: Date.now()
    };
    this.state.assignments[session] = next;
    this.markDirty();
    return next;
  }

  unassign(session: string): void {
    delete this.state.assignments[session];
    this.markDirty();
  }

  /** Drop assignments for sessions that no longer exist (the dashboard calls this with the live tmux list). */
  pruneAssignments(live: string[]): number {
    const keep = new Set(live);
    let removed = 0;
    for (const session of Object.keys(this.state.assignments)) {
      if (keep.has(session) || session.startsWith(PROBE_PREFIX)) continue;
      delete this.state.assignments[session];
      removed += 1;
    }
    if (removed) this.markDirty();
    return removed;
  }

  // ── Proxying ─────────────────────────────────────────────────────────────

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://gateway");
    if (url.pathname === "/healthz") {
      json(res, 200, { ok: true, uptimeMs: Date.now() - this.startedAt });
      return;
    }
    if (url.pathname.startsWith("/_gw/")) {
      await this.admin(req, res, url);
      return;
    }
    const match = /^\/(claude|codex)\/([A-Za-z0-9_.:-]+)(\/.*)?$/.exec(url.pathname);
    if (!match) {
      json(res, 404, { error: { type: "not_found", message: "expected /<claude|codex>/<session>/<path>" } });
      return;
    }
    const lane = match[1] as Lane;
    const session = match[2];
    const suffix = match[3] || "/";

    // Claude Code warms the connection with HEAD /api/hello; answer locally so
    // it never reaches an upstream that doesn't serve it.
    if (suffix === "/api/hello") {
      res.writeHead(200).end();
      return;
    }
    await this.proxy(req, res, lane, session, suffix + url.search);
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, lane: Lane, session: string, suffix: string): Promise<void> {
    const started = Date.now();
    const body = await readBody(req);
    const clientAuth = String(req.headers.authorization || "");
    const clientHasLogin = /^Bearer\s+\S+/i.test(clientAuth) && !DUMMY_TOKENS.has(clientAuth.replace(/^Bearer\s+/i, "").trim());
    const model = extractModel(body);
    const { chain, skipped, primary } = this.candidates(lane, session, clientHasLogin);

    if (chain.length === 0) {
      const reason = primary
        ? `route ${primary.id} is not usable for session ${session}: ${skipped.join("; ") || "disabled"}`
        : `no ${lane} route configured`;
      this.pushLog({ at: started, lane, session, route: primary?.id ?? "-", attempts: 0, status: 503, ms: 0, model, upstreamModel: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, error: reason });
      json(res, 503, { error: { type: "gateway_error", message: `Devy gateway: ${reason}` } });
      return;
    }

    const abort = new AbortController();
    req.on("close", () => abort.abort());
    let attempts = 0;
    let lastError = "";
    let lastStatus = 502;

    for (const route of chain) {
      attempts += 1;
      const upstreamModel = model ? mapModel(route, model) : null;
      const outBody = model && upstreamModel && upstreamModel !== model ? rewriteModel(body, upstreamModel) : body;
      const headers = this.upstreamHeaders(req, route);
      if (outBody !== body) headers.set("content-length", String(outBody.length));
      const target = `${route.upstream}${suffix}`;

      let upstream: Response;
      try {
        upstream = await this.fetchImpl(target, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(outBody),
          signal: abort.signal,
          redirect: "manual"
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        lastError = `${route.id}: ${(error as Error).message}`;
        this.noteFailure(route, 0, null, lastError);
        continue;
      }

      this.noteLimits(route, upstream.headers);
      const retryable = upstream.status === 429 || upstream.status === 529 || upstream.status >= 500 || (route.auth.type !== "passthrough" && (upstream.status === 401 || upstream.status === 403));
      if (retryable && attempts < chain.length) {
        const text = await upstream.text().catch(() => "");
        lastStatus = upstream.status;
        lastError = `${route.id}: HTTP ${upstream.status} ${text.slice(0, 200)}`;
        this.noteFailure(route, upstream.status, upstream.headers, lastError);
        continue;
      }

      // Final answer (success, or an error we pass through unchanged so the
      // client's own retry logic can read it).
      const counters = this.counters(route.id);
      counters.requests += 1;
      if (upstream.status >= 400) {
        this.noteFailure(route, upstream.status, upstream.headers, `HTTP ${upstream.status}`);
      }
      const tap = await this.relay(upstream, res, abort);
      const usage = tap.usage;
      if (upstream.status < 400) {
        this.noteOk(route);
        counters.inputTokens += usage.inputTokens ?? 0;
        counters.outputTokens += usage.outputTokens ?? 0;
        counters.cacheReadTokens += usage.cacheReadTokens ?? 0;
      }
      this.pushLog({
        at: started,
        lane,
        session,
        route: route.id,
        attempts,
        status: upstream.status,
        ms: Date.now() - started,
        model,
        upstreamModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        error: upstream.status >= 400 ? tap.text.slice(0, 300) : attempts > 1 ? `after failover: ${lastError}` : null
      });
      this.markDirty();
      return;
    }

    this.pushLog({ at: started, lane, session, route: chain[chain.length - 1].id, attempts, status: lastStatus, ms: Date.now() - started, model, upstreamModel: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, error: lastError });
    json(res, lastStatus === 429 ? 429 : 502, { error: { type: "gateway_error", message: `Devy gateway: all ${lane} routes failed. ${lastError}` } });
  }

  private upstreamHeaders(req: IncomingMessage, route: RouteDef): Headers {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key) || AUTH_HEADERS.has(key)) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    // We stream whatever bytes arrive; asking for identity avoids re-encoding.
    headers.set("accept-encoding", "identity");
    const upstreamHost = new URL(route.upstream!).host;
    headers.set("host", upstreamHost);

    switch (route.auth.type) {
      case "passthrough":
        if (req.headers.authorization) headers.set("authorization", String(req.headers.authorization));
        if (req.headers["x-api-key"]) headers.set("x-api-key", String(req.headers["x-api-key"]));
        break;
      case "bearer":
        headers.set("authorization", `Bearer ${this.env[route.auth.env] ?? ""}`);
        break;
      case "x-api-key":
        headers.set("x-api-key", this.env[route.auth.env] ?? "");
        break;
      case "api-key":
        headers.set("api-key", this.env[route.auth.env] ?? "");
        break;
    }
    // The OAuth beta flag only means something to Anthropic's own endpoint.
    if (route.auth.type !== "passthrough") {
      const beta = headers.get("anthropic-beta");
      if (beta) {
        const kept = beta.split(",").map((value) => value.trim()).filter((value) => value && !value.startsWith("oauth-"));
        if (kept.length) headers.set("anthropic-beta", kept.join(","));
        else headers.delete("anthropic-beta");
      }
    }
    return headers;
  }

  /** Stream the upstream response to the client while scanning it for token usage. */
  private async relay(upstream: Response, res: ServerResponse, abort: AbortController): Promise<{ usage: Usage; text: string }> {
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (HOP_BY_HOP.has(key) || key === "content-encoding" || key === "content-length") return;
      outHeaders[key] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    const chunks: Buffer[] = [];
    let tapped = 0;
    if (upstream.body) {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve));
          if (tapped < MAX_TAP_BYTES) {
            chunks.push(Buffer.from(value));
            tapped += value.length;
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) res.destroy(error as Error);
        const text = Buffer.concat(chunks).toString("utf8");
        return { usage: extractUsage(text), text };
      }
    }
    res.end();
    const text = Buffer.concat(chunks).toString("utf8");
    return { usage: extractUsage(text), text };
  }

  // ── Admin API ────────────────────────────────────────────────────────────

  private async admin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean); // ["_gw", ...]
    try {
      if (req.method === "GET" && parts[1] === "state") return json(res, 200, this.view());
      const body = req.method === "GET" ? {} : parseJson(await readBody(req));
      if (req.method === "PUT" && parts[1] === "settings") {
        this.updateSettings(body as Parameters<Gateway["updateSettings"]>[0]);
        return json(res, 200, { ok: true, autoSwitch: this.state.autoSwitch, defaults: this.state.defaults });
      }
      if (parts[1] === "routes" && parts[2]) {
        if (req.method === "PUT" && !parts[3]) {
          this.updateRoute(parts[2], body as Parameters<Gateway["updateRoute"]>[1]);
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && parts[3] === "reset") {
          this.resetHealth(parts[2]);
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && parts[3] === "probe") {
          return json(res, 200, await this.probe(parts[2]));
        }
      }
      if (parts[1] === "sessions") {
        if (req.method === "PUT" && parts[2]) return json(res, 200, { ok: true, assignment: this.assign(parts[2], body as Parameters<Gateway["assign"]>[1]) });
        if (req.method === "DELETE" && parts[2]) {
          this.unassign(parts[2]);
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && parts[2] === "prune") {
          const live = Array.isArray((body as { live?: unknown }).live) ? ((body as { live: unknown[] }).live.map(String)) : [];
          return json(res, 200, { ok: true, removed: this.pruneAssignments(live) });
        }
      }
      json(res, 404, { error: "unknown admin endpoint" });
    } catch (error) {
      json(res, 400, { error: (error as Error).message });
    }
  }

  /**
   * Cheapest possible real request through a key-based route. Passthrough
   * routes can't be probed here because the gateway holds no login; the
   * dashboard runs the real client for those.
   */
  async probe(routeId: string): Promise<{ ok: boolean; needsClient?: boolean; status?: number; ms?: number; model?: string; error?: string }> {
    const route = this.byId.get(routeId);
    if (!route) return { ok: false, error: `unknown route: ${routeId}` };
    if (route.auth.type === "passthrough") return { ok: false, needsClient: true };
    if (!this.isAvailable(route)) return { ok: false, error: route.unavailableReason ?? "route is disabled" };

    const started = Date.now();
    const model = route.lane === "claude" ? mapModel(route, "claude-haiku-4-5") : mapModel(route, "gpt-5.4-mini");
    const path = route.lane === "claude" ? "/v1/messages" : "/responses";
    const payload =
      route.lane === "claude"
        ? { model, max_tokens: 8, messages: [{ role: "user", content: "Reply with OK" }] }
        : { model, input: "Reply with OK", max_output_tokens: 16, store: false };
    const headers = new Headers({ "content-type": "application/json", "anthropic-version": "2023-06-01" });
    switch (route.auth.type) {
      case "bearer":
        headers.set("authorization", `Bearer ${this.env[route.auth.env] ?? ""}`);
        break;
      case "x-api-key":
        headers.set("x-api-key", this.env[route.auth.env] ?? "");
        break;
      case "api-key":
        headers.set("api-key", this.env[route.auth.env] ?? "");
        break;
    }
    try {
      const response = await this.fetchImpl(`${route.upstream}${path}`, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(45_000) });
      const text = await response.text();
      this.noteLimits(route, response.headers);
      const ms = Date.now() - started;
      if (response.ok) {
        this.noteOk(route);
        this.pushLog({ at: started, lane: route.lane, session: `${PROBE_PREFIX}${route.id}`, route: route.id, attempts: 1, status: response.status, ms, model, upstreamModel: model, ...tokensOf(extractUsage(text)), error: null });
        return { ok: true, status: response.status, ms, model };
      }
      const error = `HTTP ${response.status}: ${text.slice(0, 400)}`;
      this.noteFailure(route, response.status, response.headers, error);
      this.pushLog({ at: started, lane: route.lane, session: `${PROBE_PREFIX}${route.id}`, route: route.id, attempts: 1, status: response.status, ms, model, upstreamModel: model, inputTokens: null, outputTokens: null, cacheReadTokens: null, error });
      return { ok: false, status: response.status, ms, model, error };
    } catch (error) {
      const message = (error as Error).message;
      this.noteFailure(route, 0, null, message);
      return { ok: false, ms: Date.now() - started, model, error: message };
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

type Usage = { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null };

function tokensOf(usage: Usage) {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens };
}

export function extractModel(body: Buffer): string | null {
  if (!body.length) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return typeof parsed?.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

/** Re-serialize with only `model` changed; every other field is preserved as-is. */
export function rewriteModel(body: Buffer, model: string): Buffer {
  const parsed = JSON.parse(body.toString("utf8"));
  parsed.model = model;
  return Buffer.from(JSON.stringify(parsed));
}

/**
 * Pull token counts out of a JSON or SSE response. Anthropic reports input
 * tokens in message_start and output tokens in message_delta; OpenAI reports
 * everything in response.completed. Later "usage" objects override earlier
 * ones, which matches both shapes.
 */
export function extractUsage(text: string): Usage {
  const merged: Record<string, unknown> = {};
  const pattern = /"usage"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/g;
  let match: RegExpExecArray | null;
  let found = false;
  while ((match = pattern.exec(text))) {
    try {
      Object.assign(merged, JSON.parse(match[1]));
      found = true;
    } catch {
      /* partial chunk; ignore */
    }
  }
  if (!found) return { inputTokens: null, outputTokens: null, cacheReadTokens: null };
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const details = merged.input_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: num(merged.input_tokens),
    outputTokens: num(merged.output_tokens),
    cacheReadTokens: num(merged.cache_read_input_tokens) ?? num(details?.cached_tokens)
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(body: Buffer): unknown {
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function createGatewayServer(gateway: Gateway): Server {
  const server = createServer((req, res) => {
    gateway.handle(req, res).catch((error: Error) => {
      if (!res.headersSent) json(res, 500, { error: { type: "gateway_error", message: error.message } });
      else res.destroy();
    });
  });
  // Long thinking pauses: never time out an idle socket on our side.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;
  return server;
}
