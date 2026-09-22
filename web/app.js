// Devy PWA — app shell, hash router and pages.
// The one idea: sessions that need you are loud; everything else is quiet.

// ─── State ────────────────────────────────────────────────────────────────
// A damaged value or blocked storage must not prevent the app from opening.
const storage = {
  get(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* keep the session usable */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage is optional */ } },
  json(key, fallback) { try { return JSON.parse(this.get(key)) ?? fallback; } catch { return fallback; } },
};
const State = {
  sessions: [],
  projects: [],
  events: [],
  system: null,
  health: null,
  aiStatus: { enabled: false, model: "" },
  conversations: [],
  memories: [],
  currentConv: null,
  filter: "all",
  eventFilter: "all",
  expanded: new Set(Array.isArray(storage.json("agentOpsExpanded", [])) ? storage.json("agentOpsExpanded", []) : []),
  queueSeen: new Set(),
  selectedSession: storage.get("agentOpsSelectedSession") || null,
  seenHashes: (() => { const value = storage.json("agentOpsSeen", {}); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; })(),
  notifySound: storage.get("agentOpsNotifySound") !== "false",
  notifyPush: storage.get("agentOpsNotifyPush") === "true",
  eventsSeenId: Number(storage.get("agentOpsEventsSeenId") || 0),
  writeToken: storage.get("agentOpsToken") || "",
  online: navigator.onLine !== false,
};

function persist() {
  storage.set("agentOpsSeen", JSON.stringify(State.seenHashes));
  storage.set("agentOpsExpanded", JSON.stringify([...State.expanded]));
  if (State.selectedSession) storage.set("agentOpsSelectedSession", State.selectedSession);
}

// ─── Utils ────────────────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
const h = (html) => {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
};
const escapeHtml = (value) =>
  String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const stateLabels = {
  running: "Working",
  waiting_for_input: "Needs you",
  error: "Error",
  idle: "Idle",
  unknown: "Unknown",
};

function relTime(iso) {
  if (!iso) return "";
  const t = new Date(iso.endsWith("Z") || iso.includes("T") ? iso : iso + "Z");
  const diff = (Date.now() - t.getTime()) / 1000;
  if (diff < 60) return `${Math.max(1, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Compact duration from an epoch-ms timestamp: 45s · 4m · 2h · 3d.
function durSince(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return "—";
  const hrs = Math.floor(seconds / 3600);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ${hrs % 24}h`;
  return `${hrs}h`;
}

function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (State.health?.authentication !== "cloudflare" && State.writeToken && opts.method && opts.method !== "GET") {
    headers["authorization"] = `Bearer ${State.writeToken}`;
  }
  const res = await fetch(url, { ...opts, headers, cache: "no-store" });
  if (res.status === 401 && State.health?.authentication === "cloudflare") {
    throw new Error("Your Cloudflare login has expired. Reload Devy to sign in again.");
  }
  if (res.status === 401 && opts.method && opts.method !== "GET") {
    State.writeToken = "";
    storage.remove("agentOpsToken");
    const token = await promptToken();
    if (token) {
      State.writeToken = token;
      storage.set("agentOpsToken", token);
      headers["authorization"] = `Bearer ${token}`;
      const retry = await fetch(url, { ...opts, headers, cache: "no-store" });
      if (!retry.ok) {
        const body = await retry.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${retry.status}`);
      }
      if (retry.status === 204) return null;
      return retry.json();
    }
    throw new Error("auth required");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// In-app dialog instead of window.prompt (which iOS home-screen apps render
// poorly and some standalone contexts block outright).
function promptToken() {
  return new Promise((resolve) => {
    const { modal, close } = openModal(`
      <div class="overlay modal">
        <div class="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="tok-title">
          <h3 id="tok-title">Access token needed</h3>
          <p class="sub">Writing to a session needs the server's AGENT_OPS_TOKEN. It's saved in this browser only.</p>
          <form class="dialog-form" id="tok-form">
            <label>Token<input name="token" type="password" autocomplete="off" placeholder="paste token" required /></label>
            <div class="btn-row dialog-actions">
              <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
              <button type="submit" class="btn btn-primary">Save and retry</button>
            </div>
          </form>
        </div>
      </div>`, () => resolve(""));
    $("[data-cancel]", modal).addEventListener("click", () => { close(); resolve(""); });
    $("#tok-form", modal).addEventListener("submit", (e) => {
      e.preventDefault();
      const v = e.currentTarget.elements.token.value.trim();
      resolve(v);
      close();
    });
  });
}

// Confirm dialog with the destructive action named on the button.
function confirmDialog({ title, body, action = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const { modal, close } = openModal(`
      <div class="overlay modal">
        <div class="sheet dialog" role="alertdialog" aria-modal="true" aria-labelledby="cf-title">
          <h3 id="cf-title">${escapeHtml(title)}</h3>
          ${body ? `<p class="sub">${escapeHtml(body)}</p>` : ""}
          <div class="btn-row dialog-actions">
            <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
            <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-ok>${escapeHtml(action)}</button>
          </div>
        </div>
      </div>`, () => resolve(false));
    $("[data-cancel]", modal).addEventListener("click", () => { close(); resolve(false); });
    $("[data-ok]", modal).addEventListener("click", () => { resolve(true); close(); });
  });
}

// ─── Toasts ───────────────────────────────────────────────────────────────
// opts: { sticky, action: { label, onClick }, id, duration } — an id replaces
// a previous toast with the same id so a flapping network doesn't stack them.
function toast(msg, kind = "", opts = {}) {
  if (opts.id) $(`#toasts [data-toast-id="${opts.id}"]`)?.remove();
  const el = h(`
    <div class="toast ${kind}" ${opts.id ? `data-toast-id="${escapeHtml(opts.id)}"` : ""}>
      <span class="toast-msg">${escapeHtml(msg)}</span>
      ${opts.action ? `<button class="btn toast-action">${escapeHtml(opts.action.label)}</button>` : ""}
      ${opts.sticky ? `<button class="icon-btn toast-close" aria-label="Dismiss">×</button>` : ""}
    </div>
  `);
  const dismiss = () => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 200);
  };
  $(".toast-action", el)?.addEventListener("click", () => { opts.action.onClick(); dismiss(); });
  $(".toast-close", el)?.addEventListener("click", dismiss);
  $("#toasts").appendChild(el);
  if (!opts.sticky) setTimeout(dismiss, opts.duration || 3500);
  return dismiss;
}

// ─── Modals ───────────────────────────────────────────────────────────────
// Escape closes, focus moves in and returns to the opener, tapping the
// backdrop closes. `onClose` fires however the dialog is dismissed.
function openModal(markup, onClose) {
  const opener = document.activeElement;
  const modal = h(markup);
  document.body.appendChild(modal);
  let closed = false;
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    if (e.key !== "Tab") return;
    const items = $$("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']", modal).filter((node) => node.getClientRects().length);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    modal.remove();
    try { opener?.focus?.(); } catch {/* */}
    onClose?.();
  };
  document.addEventListener("keydown", onKey, true);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  setTimeout(() => $("input, select, textarea, button", modal)?.focus(), 0);
  return { modal, close };
}

// ─── Router ───────────────────────────────────────────────────────────────
const routes = {};
function route(name, opts) { routes[name] = opts; }

function currentRoute() {
  const hash = location.hash.slice(1) || "sessions";
  const [name, ...rest] = hash.split("/");
  return { name: routes[name] ? name : "sessions", args: rest };
}

let activeRoute = null;
async function navigate() {
  const r = currentRoute();
  if (activeRoute && activeRoute !== r.name) {
    try { routes[activeRoute]?.leave?.(); } catch {/* */}
  }
  activeRoute = r.name;
  document.body.dataset.route = r.name;
  $$(".nav-item, .tabs a").forEach((a) => {
    const active = a.dataset.route === r.name;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $("#crumb-page").textContent = routes[r.name]?.title || r.name;
  $("#crumb-context").textContent = "";
  document.title = r.name === "sessions" ? "Devy" : `${routes[r.name]?.title || "Devy"} · Devy`;
  const root = $("#page-root");
  root.classList.remove("enter");
  root.innerHTML = routes[r.name]?.skeleton?.() || `<div class="empty"><div class="spinner" role="status" aria-label="Loading"></div></div>`;
  root.scrollTop = 0;
  void root.offsetWidth;
  root.classList.add("enter");
  try {
    await routes[r.name].render(root, r.args);
  } catch (error) {
    root.innerHTML = `<div class="empty"><h3>This page didn't load</h3><p>${escapeHtml(error.message)}</p><button class="btn" data-reload>Reload</button></div>`;
  }
}

window.addEventListener("hashchange", navigate);
document.addEventListener("click", (event) => { if (event.target.closest("[data-reload]")) location.reload(); });

// ─── Global polling ───────────────────────────────────────────────────────
// Self-rescheduling: a slow /api/status can't stack requests, a hidden tab
// polls slowly (SSE still delivers events), and waking refreshes at once.
const POLL_VISIBLE_MS = 5000;
const POLL_HIDDEN_MS = 30000;
let pollTimer = null;
let polling = false;
let pollFailures = 0;

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  const base = document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
  const backoff = pollFailures ? Math.min(30000, base * 2 ** Math.min(pollFailures, 3)) : base;
  pollTimer = setTimeout(refreshGlobal, delay ?? backoff);
}

async function refreshGlobal() {
  if (polling) return;
  polling = true;
  try {
    const [health, status, ai, system] = await Promise.all([
      api("/api/health"),
      api("/api/status"),
      api("/api/ai/status"),
      api("/api/system").catch(() => null),
      Gateway.state().catch(() => null),
    ]);
    State.health = health;
    State.sessions = (status.sessions || []).map((session) => {
      const atShell = ["bash", "zsh", "sh", "fish", "dash"].includes(session.paneCommand);
      return atShell && !["waiting_for_input", "error"].includes(session.state) ? { ...session, state: "idle" } : session;
    });
    State.aiStatus = ai;
    State.system = system;
    if (pollFailures) toast("Connected again", "ok", { id: "net" });
    pollFailures = 0;
    detectAttention(State.sessions);
    renderSidebar();
    if (currentRoute().name === "sessions") renderSessions();
    if (currentRoute().name === "terminal") {
      const login = Gateway.data?.accounts?.find((account) => account.loginSession === State.selectedSession);
      if (login && !State.sessions.some((session) => session.name === login.loginSession)) {
        await Gateway.state(true);
        if (currentRoute().name === "terminal" && State.selectedSession === login.loginSession) {
          toast(Gateway.account(login.id)?.signedIn ? `${login.label} signed in` : "Sign-in terminal closed", "ok");
          location.hash = "#gateway";
        }
      } else {
        refreshTerminalList();
        renderTerminalMeta();
      }
    }
  } catch (error) {
    pollFailures++;
    renderSidebar({ error: error.message });
    if (pollFailures === 2) toast("Can't reach Devy — retrying", "error", { id: "net", sticky: true });
  } finally {
    polling = false;
    schedulePoll();
  }
}

function detectAttention(sessions) {
  for (const s of sessions) {
    const last = State.seenHashes[s.name];
    if (s.state === "waiting_for_input" && last !== s.outputHash) {
      if (State.notifySound) beep();
      notifyNeedsInput(s);
      State.seenHashes[s.name] = s.outputHash;
      persist();
    }
  }
}

// ─── Gateway state (shared with gateway.js) ───────────────────────────────
// One cached fetch of /api/gateway/state so session rows, the terminal header
// and the Gateway page all agree on which provider a session is using.
const Gateway = {
  data: null,
  at: 0,
  pending: null,
  ttl: 5000,
  async state(force = false) {
    if (!force && this.data && Date.now() - this.at < this.ttl) return this.data;
    if (this.pending) return this.pending;
    this.pending = api("/api/gateway/state")
      .then((d) => { this.data = d; this.at = Date.now(); return d; })
      .catch((error) => { this.data = { up: false, error: error.message }; this.at = Date.now(); return this.data; })
      .finally(() => { this.pending = null; });
    return this.pending;
  },
  invalidate() { this.at = 0; },
  get up() { return Boolean(this.data?.up); },
  routes(lane) {
    if (!this.up) return [];
    const st = this.data.state;
    return (st.order[lane] || []).map((id) => st.routes.find((r) => r.id === id)).filter(Boolean);
  },
  route(id) { return this.up ? this.data.state.routes.find((r) => r.id === id) || null : null; },
  account(id) { return (this.data?.accounts || []).find((a) => a.id === id) || null; },
  // Assignment for a session, decorated with its route's label + health.
  assignment(name) {
    if (!this.up) return null;
    const a = this.data.state?.assignments?.[name];
    if (!a) return null;
    const lane = State.sessions.find((s) => s.name === name)?.agent;
    const routeId = a.route || this.data.state?.defaults?.[lane];
    const r = this.route(routeId);
    return { ...a, route: routeId, label: r?.label || routeId, provider: r?.provider || "", health: routeHealth(r), available: Boolean(r?.available) };
  },
  eligible(r, a) {
    return r.available && r.enabled !== false && (r.authType !== "passthrough" || r.account === a?.account);
  },
  async switchRoute(session, routeId) {
    await api(`/api/gateway/sessions/${encodeURIComponent(session)}`, { method: "PUT", body: JSON.stringify({ route: routeId }) });
    this.invalidate();
  },
  async setMode(session, mode) {
    await api(`/api/gateway/sessions/${encodeURIComponent(session)}`, { method: "PUT", body: JSON.stringify({ mode }) });
    this.invalidate();
  },
};

function routeHealth(r) {
  if (!r) return "";
  if (!r.available) return "bad";
  if (r.health?.cooling) return "warn";
  if (r.health?.status === "error") return "bad";
  if (r.health?.status === "ok") return "ok";
  return "";
}

function routeChipHTML(name, { large = false } = {}) {
  const a = Gateway.assignment(name);
  const cls = `route-chip ${large ? "route-lg" : ""}`;
  if (!a) {
    const reason = Gateway.up ? "Direct to provider" : "Gateway offline";
    return `<button class="${cls} direct" data-act="route" title="${reason} — tap for details"><span class="rdot"></span>${Gateway.up ? "direct" : "gateway off"}</button>`;
  }
  return `<button class="${cls}" data-act="route" title="Provider route — tap to switch"><span class="rdot ${a.health}"></span>${escapeHtml(a.label)}<span class="mode">${a.mode === "auto" ? "auto" : "pinned"}</span></button>`;
}

// Bottom sheet: pick a provider route for one session, toggle auto-switch.
async function openRouteSwitcher(session) {
  const s = State.sessions.find((x) => x.name === session);
  await Gateway.state(true);
  const a = Gateway.assignment(session);
  const lane = s?.agent === "claude" || s?.agent === "codex" ? s.agent : null;
  let body;
  if (!Gateway.up) {
    body = `<p class="sub">The gateway is unavailable. Sessions connected through it need the gateway to recover before requests can continue.</p>`;
  } else if (!lane) {
    body = `<p class="sub">Only Claude Code and Codex sessions can be routed through the gateway.</p>`;
  } else {
    // Routes the gateway can switch to between requests are plain options. A
    // different subscription login, or any route for a session that runs
    // directly on its own login, needs the CLI restarted through the gateway
    // with the conversation resumed — offered as a "restart" option.
    const opts = Gateway.routes(lane).map((r) => {
      const signedIn = !r.account || Boolean(Gateway.account(r.account)?.signedIn);
      const usable = r.available && r.enabled !== false && signedIn;
      const live = a ? Gateway.eligible(r, a) : false;
      const current = Boolean(a) && r.id === a.route;
      const relaunch = usable && !live;
      const acct = r.account ? Gateway.account(r.account) : null;
      const sub = [r.provider, acct ? (acct.signedIn ? acct.label : `${acct.label} — not signed in`) : null, r.health?.cooling ? "cooling down" : r.health?.status === "error" ? "erroring" : null, relaunch ? "restarts & resumes the session" : null]
        .filter(Boolean).join(", ");
      return `
        <button class="route-opt" data-route="${r.id}" ${relaunch ? 'data-relaunch="1"' : ""} ${usable && !current ? "" : "disabled"} aria-pressed="${current}">
          <span class="rdot ${routeHealth(r)}"></span>
          <span class="lbl">${escapeHtml(r.label)}<span class="sub">${escapeHtml(sub)}</span></span>
          ${current ? `<span class="cur">current</span>` : relaunch ? `<span class="cur">restart</span>` : ""}
        </button>`;
    }).join("");
    body = `
      ${a ? "" : `<p class="sub">This session runs directly on its own login. Picking a provider restarts the CLI through the gateway and resumes its conversation.</p>`}
      <div class="routes">${opts}</div>
      ${a ? `<label class="check-row" style="margin-top:4px;">
        <input type="checkbox" id="rs-auto" ${a.mode === "auto" ? "checked" : ""} />
        <span>Switch automatically on rate limits and errors<small>When a login hits its limit Devy fails over inside the gateway, or restarts the session on the next signed-in account and resumes the conversation. Pinned sessions stay put.</small></span>
      </label>
      <p class="sheet-note">Routes on the same login apply on the session's next request. Options marked <b>restart</b> stop the CLI and relaunch it with the conversation resumed.</p>` : ""}`;
  }
  const { modal, close } = openModal(`
    <div class="overlay modal">
      <div class="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="rs-title">
        <h3 id="rs-title">Provider for <span class="mono">${escapeHtml(session)}</span></h3>
        ${body}
        <div class="btn-row dialog-actions">
          <a class="btn btn-ghost" href="#gateway">Gateway page</a>
          <button type="button" class="btn" data-cancel>Done</button>
        </div>
      </div>
    </div>`);
  $("[data-cancel]", modal).addEventListener("click", close);
  $("a[href='#gateway']", modal).addEventListener("click", close);
  modal.addEventListener("click", async (e) => {
    const opt = e.target.closest(".route-opt");
    if (!opt || opt.disabled) return;
    const r = Gateway.route(opt.dataset.route);
    if (opt.dataset.relaunch) {
      const ok = await confirmDialog({
        title: `Restart ${session} on ${r.label}?`,
        body: "The running CLI is stopped and relaunched in the same tmux window through the gateway, with its conversation resumed. A turn in progress is interrupted.",
        action: "Restart & resume"
      });
      if (!ok) return;
    }
    $$(".route-opt", modal).forEach((b) => { b.disabled = true; });
    try {
      if (opt.dataset.relaunch) {
        const res = await api(`/api/sessions/${encodeURIComponent(session)}/relaunch`, { method: "POST", body: JSON.stringify({ route: r.id }) });
        Gateway.invalidate();
        toast(`${session} restarted on ${r.label}${res.conversationId ? ", conversation resumed" : ""}`, "ok", { duration: 6000 });
      } else {
        await Gateway.switchRoute(session, r.id);
        toast(`${session} → ${r.label} on its next request`, "ok", { duration: 5000 });
      }
      close();
      refreshGlobal();
    } catch (error) {
      toast(`Couldn't switch: ${error.message}`, "error");
      close();
    }
  });
  $("#rs-auto", modal)?.addEventListener("change", async (e) => {
    const box = e.target;
    try {
      await Gateway.setMode(session, box.checked ? "auto" : "pinned");
      toast(box.checked ? `${session} will auto-switch` : `${session} pinned to its route`, "ok");
      refreshGlobal();
    } catch (error) {
      box.checked = !box.checked;
      toast(`Couldn't change mode: ${error.message}`, "error");
    }
  });
}

// ─── System notifications ─────────────────────────────────────────────────
// Opt-in from Settings. Fires only while Devy is backgrounded; in the
// foreground the queue and the beep already say it. Prefers the service
// worker path (the only one iOS home-screen apps support).
function notificationsSupported() { return "Notification" in window; }
function notificationsGranted() { return notificationsSupported() && Notification.permission === "granted" && State.notifyPush; }

async function requestNotifications() {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

async function notifyNeedsInput(s) {
  if (!notificationsGranted()) return;
  if (!document.hidden && document.hasFocus()) return;
  const tail = (s.lastOutput || "").trim().split("\n").filter(Boolean).slice(-3).join("\n").slice(-180);
  const options = {
    body: tail || "Waiting for your input",
    tag: `devy-needs-input-${s.name}`,
    renotify: true,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: `/#terminal/${encodeURIComponent(s.name)}` },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) { await reg.showNotification(`${s.name} needs you`, options); return; }
    const n = new Notification(`${s.name} needs you`, options);
    n.onclick = () => { window.focus(); location.hash = options.data.url.replace(/^[^#]*/, ""); n.close(); };
  } catch {/* permission revoked mid-flight, or unsupported */}
}

let audioCtx = null;
function beep() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 660;
    g.gain.value = 0.06;
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.frequency.exponentialRampToValueAtTime(440, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.stop(t + 0.25);
  } catch {/* ignore */}
}

// ─── Sidebar / tabs ───────────────────────────────────────────────────────
function renderSidebar(extra = {}) {
  const sessions = State.sessions;
  const waiting = sessions.filter((s) => s.state === "waiting_for_input" || s.state === "error").length;
  const sessionBadge = $('[data-badge="sessions"]');
  sessionBadge.textContent = String(sessions.length);
  sessionBadge.classList.toggle("hot", waiting > 0);
  const tabBadge = $('[data-badge="sessions-tab"]');
  tabBadge.textContent = waiting ? String(waiting) : "";
  tabBadge.classList.toggle("hot", waiting > 0);

  const projectsBadge = $('[data-badge="projects"]');
  if (State.projects.length) projectsBadge.textContent = String(State.projects.length);

  const aiBadge = $('[data-badge="ai-on"]');
  aiBadge.textContent = State.aiStatus.enabled ? "on" : "off";
  aiBadge.classList.toggle("accent", State.aiStatus.enabled);

  const unseen = State.events.filter((e) => e.id > State.eventsSeenId && eventKind(e) === "attention").length;
  for (const sel of ['[data-badge="events"]', '[data-badge="events-tab"]']) {
    const b = $(sel);
    b.textContent = unseen ? String(unseen) : "";
    b.classList.toggle("hot", unseen > 0);
  }

  const dot = $("#health-dot");
  const barDot = $("#bar-health");
  const healthText = $("#health-text");
  if (extra.error || !State.online) {
    dot.className = "dot bad"; barDot.className = "bar-health bad";
    healthText.textContent = State.online ? "Server unreachable" : "Offline";
  } else if (State.health?.ok) {
    dot.className = "dot on"; barDot.className = "bar-health on";
    healthText.textContent = `${State.health.hostname} · ${new Date(State.health.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } else {
    dot.className = "dot warn"; barDot.className = "bar-health";
    healthText.textContent = "Connecting…";
  }
  $("#brand-host").textContent = State.health?.hostname || location.host;

  if (State.system) {
    $("#stat-cpu").textContent = State.system.load1?.toFixed(2) ?? "—";
    $("#stat-mem").textContent = `${State.system.memory.usedPercent}%`;
    $("#stat-disk").textContent = `${State.system.disk.usedPercent}%`;
    $("#stat-up").textContent = formatUptime(State.system.uptimeSeconds);
  }
}

// ─── Sessions page ────────────────────────────────────────────────────────
const FILTERS = [["all", "All"], ["waiting_for_input", "Needs you"], ["running", "Working"], ["idle", "Idle"], ["error", "Errors"], ["claude", "Claude"], ["codex", "Codex"]];

route("sessions", {
  title: "Sessions",
  skeleton: () => `<div class="wrap"><div class="skeleton sk-line" style="width:40%;height:28px"></div><div class="skeleton sk-line" style="width:60%"></div><div class="skeleton sk-block" style="margin-top:20px"></div><div class="skeleton sk-row"></div><div class="skeleton sk-row"></div><div class="skeleton sk-row"></div></div>`,
  async render(root) {
    root.innerHTML = `
      <div class="wrap">
        <header class="hero session-hero">
          <span class="eyebrow">Your agent workspace</span>
          <h1 id="hero-title" aria-live="polite"></h1>
          <p class="hero-sub" id="hero-sub"></p>
          <div class="hero-actions">
            <button class="btn btn-primary" id="new-session-btn">New session</button>
          </div>
        </header>
        <div class="filters" id="filters" role="group" aria-label="Filter sessions"></div>
        <div class="queue" id="queue" aria-label="Sessions that need you"></div>
        <div id="groups"></div>
      </div>
    `;
    $("#filters").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-filter]");
      if (!btn) return;
      State.filter = btn.dataset.filter;
      renderSessions();
    });
    $("#new-session-btn").addEventListener("click", () => openNewSessionModal());
    const onAct = (e) => {
      if (e.target.closest("[data-create-session]")) { openNewSessionModal(); return; }
      if (e.target.closest("[data-retry-sessions]")) { refreshGlobal(); return; }
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const name = btn.closest("[data-session]")?.dataset.session;
      if (!name) return;
      handleSessionAction(btn.dataset.act, name, btn);
    };
    $("#queue").addEventListener("click", onAct);
    $("#groups").addEventListener("click", (e) => {
      const main = e.target.closest(".row-main");
      if (main) {
        const row = main.closest(".row");
        const open = !row.classList.contains("open");
        row.classList.toggle("open", open);
        main.setAttribute("aria-expanded", String(open));
        if (open) State.expanded.add(row.dataset.session); else State.expanded.delete(row.dataset.session);
        persist();
        return;
      }
      onAct(e);
    });
    const onSubmit = (e) => { if (e.target.matches(".reply")) quickSend(e); };
    $("#queue").addEventListener("submit", onSubmit);
    $("#groups").addEventListener("submit", onSubmit);
    if (!State.sessions.length && !State.health) await refreshGlobal();
    renderSessions();
  },
});

async function handleSessionAction(act, name, btn) {
  if (act === "stop") return stopSession(name);
  if (act === "restart") return restartSession(name);
  if (act === "route") return openRouteSwitcher(name);
  if (act === "terminal") {
    State.selectedSession = name;
    persist();
    location.hash = `#terminal/${encodeURIComponent(name)}`;
    return;
  }
  if (act === "copy") {
    const s = State.sessions.find((x) => x.name === name);
    try { await navigator.clipboard.writeText((s?.lastOutput || "").trim()); toast("Copied last output", "ok"); }
    catch { toast("Couldn't copy", "error"); }
    return;
  }
  if (act === "answer") {
    btn.disabled = true;
    try {
      await api(`/api/sessions/${encodeURIComponent(name)}/input`, { method: "POST", body: JSON.stringify({ text: btn.dataset.text, submit: true }) });
      toast(`Sent "${btn.dataset.text}" to ${name}`, "ok");
      refreshGlobal();
    } catch (error) { toast(`Couldn't send: ${error.message}`, "error"); }
    finally { btn.disabled = false; }
    return;
  }
  if (act === "key") {
    btn.disabled = true;
    try { await sendKeyTo(name, btn.dataset.key); toast(`Sent ${btn.dataset.key} to ${name}`, "ok", { duration: 1800 }); }
    finally { btn.disabled = false; }
  }
}

function stateRank(state) {
  return { waiting_for_input: 0, error: 1, running: 2, idle: 3, unknown: 4 }[state] ?? 5;
}

function matchesFilter(s) {
  if (State.filter === "all") return true;
  if (["waiting_for_input", "running", "error", "idle", "unknown"].includes(State.filter)) return s.state === State.filter;
  return s.agent === State.filter;
}

function renderSessions() {
  const queue = $("#queue");
  if (!queue) return;
  const sessions = State.sessions;
  const counts = {};
  for (const s of sessions) counts[s.state] = (counts[s.state] || 0) + 1;
  for (const s of sessions) counts[s.agent] = (counts[s.agent] || 0) + 1;
  const needs = (counts.waiting_for_input || 0) + (counts.error || 0);

  // Hero: one plain sentence about what matters right now.
  const title = $("#hero-title");
  const sub = $("#hero-sub");
  if (!State.health && pollFailures) {
    title.textContent = "Connect to your workspace";
    title.className = "calm";
    sub.textContent = "The server is unreachable. Check your connection and try again.";
    $("#filters").innerHTML = "";
    queue.innerHTML = "";
    $("#groups").innerHTML = `<div class="empty"><h3>Session status is unavailable</h3><p>Devy will reconnect automatically.</p><button class="btn" data-retry-sessions>Try again</button></div>`;
    return;
  }
  if (!sessions.length) {
    title.textContent = "No sessions running";
    title.className = "calm";
    sub.textContent = "Start a Claude Code or Codex session and it shows up here.";
  } else if (needs) {
    title.innerHTML = `<span class="n">${needs}</span> ${needs === 1 ? "session needs" : "sessions need"} you`;
    title.className = "hot";
    sub.textContent = `${plural(counts.running || 0, "agent is working", "agents are working")}, ${counts.idle || 0} idle.`;
  } else {
    title.textContent = "All quiet";
    title.className = "calm";
    sub.textContent = `${plural(counts.running || 0, "agent is working", "agents are working")}, ${counts.idle || 0} idle. Nothing is waiting on you.`;
  }

  // Filters with counts; hide ones that would be empty except All / Needs you.
  const filters = $("#filters");
  filters.innerHTML = FILTERS.map(([key, label]) => {
    const n = key === "all" ? sessions.length : (counts[key] || 0);
    if (!n && key !== "all" && key !== "waiting_for_input") return "";
    return `<button class="chip ${State.filter === key ? "active" : ""}" data-filter="${key}" aria-pressed="${State.filter === key}">${label}<span class="n">${n}</span></button>`;
  }).join("");

  const visible = sessions.filter(matchesFilter).slice()
    .sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.name.localeCompare(b.name));
  const loud = visible.filter((s) => s.state === "waiting_for_input" || s.state === "error");
  const quiet = visible.filter((s) => !loud.includes(s));

  // Queue — replaced by key; a session newly entering the queue pulses once.
  patchList(queue, loud, {
    key: (s) => s.name,
    sig: (s) => cardSignature(s),
    render: (s) => {
      const arrived = !State.queueSeen.has(s.name);
      return requestHTML(s, arrived);
    },
    preserve: preserveReply,
  });
  State.queueSeen = new Set(loud.map((s) => s.name));

  const groups = $("#groups");
  if (!visible.length) {
    groups.innerHTML = sessions.length
      ? `<div class="empty"><h3>Nothing matches this filter</h3><p>Try another filter, or start a new session.</p></div>`
      : `<div class="empty"><h3>No tmux sessions</h3><p>Start one here, or from a project.</p><button class="btn btn-primary" data-create-session>New session</button></div>`;
    return;
  }
  if (!quiet.length) { groups.innerHTML = ""; return; }
  $(".empty", groups)?.remove();
  const sections = [["running", "Working"], ["idle", "Idle"], ["unknown", "Unknown"]]
    .map(([state, label]) => [state, label, quiet.filter((s) => s.state === state)])
    .filter(([, , items]) => items.length);
  // Ensure one container per section, keyed by state, then patch rows inside.
  const wantedIds = new Set(sections.map(([state]) => `group-${state}`));
  $$(".group", groups).forEach((g) => { if (!wantedIds.has(g.id)) g.remove(); });
  for (const [state, label, items] of sections) {
    let g = $(`#group-${state}`, groups);
    if (!g) {
      g = h(`<section class="group" id="group-${state}"><div class="group-head"><h2>${label}</h2><span class="count"></span></div><div class="list"></div></section>`);
      groups.appendChild(g);
    }
    $(".count", g).textContent = String(items.length);
    patchList($(".list", g), items, {
      key: (s) => s.name,
      sig: (s) => cardSignature(s) + (State.expanded.has(s.name) ? "|open" : ""),
      render: rowHTML,
      preserve: preserveReply,
      tick: (el, s) => { const st = $(".row-state .age", el); if (st) st.textContent = whenText(s); },
    });
  }
  // Keep section order stable: running, idle, unknown.
  const ordered = sections.map(([state]) => $(`#group-${state}`, groups));
  if (!ordered.every((el, i) => el === groups.children[i])) ordered.forEach((el) => groups.appendChild(el));
}

// Keyed, in-place list patching. An item is only re-rendered when its
// signature changed, so half-typed replies, scroll positions and expanded
// state survive the 5-second poll. Nodes are only moved when order changed.
function patchList(container, items, { key, sig, render, preserve, tick }) {
  const existing = new Map($$("[data-key]", container).filter((el) => el.parentElement === container).map((el) => [el.dataset.key, el]));
  if (!existing.size && container.firstChild) container.innerHTML = "";
  const wanted = new Set(items.map(key));
  for (const [k, el] of existing) if (!wanted.has(k)) { el.remove(); existing.delete(k); }
  const nodes = items.map((item) => {
    const k = key(item);
    const s = sig(item);
    const el = existing.get(k);
    if (el && el.dataset.sig === s) { tick?.(el, item); return el; }
    const fresh = h(render(item));
    fresh.dataset.key = k;
    fresh.dataset.sig = s;
    if (el) { preserve?.(el, fresh); el.replaceWith(fresh); }
    return fresh;
  });
  const current = Array.from(container.children);
  if (current.length === nodes.length && current.every((el, i) => el === nodes[i])) return;
  for (const node of nodes) container.appendChild(node);
}

// Carry the half-typed reply (and its focus/caret) into the replacement node.
function preserveReply(oldEl, newEl) {
  const oldInput = $(".reply input", oldEl);
  const newInput = $(".reply input", newEl);
  if (!oldInput || !newInput) return;
  newInput.value = oldInput.value;
  if (document.activeElement === oldInput) {
    const pos = oldInput.selectionStart;
    setTimeout(() => { newInput.focus(); try { newInput.setSelectionRange(pos, pos); } catch {/* */} }, 0);
  }
}

function cardSignature(s) {
  const a = Gateway.assignment(s.name);
  return [s.state, s.agent, s.outputHash, s.paneCommand, s.paneCurrentPath, s.git?.branch, s.git?.dirty,
    s.git?.unstagedCount, s.git?.stagedCount, (s.lastOutput || "").length, a?.route, a?.mode, a?.health, Gateway.up].join("|");
}

function whenText(s) {
  const dur = durSince(s.lastActivity);
  if (!dur) return "";
  const verb = { waiting_for_input: "waiting", error: "since", idle: "idle", running: "active" }[s.state] || "";
  return `${verb} ${dur}`;
}

function factsHTML(s) {
  const repo = (s.paneCurrentPath || "").split("/").filter(Boolean).pop() || "—";
  const branch = s.git?.branch;
  const dirty = s.git?.dirty;
  return `
    <div class="facts">
      <span class="tag ${s.agent}">${escapeHtml(s.agent)}</span>
      <span class="mono">${escapeHtml(repo)}${branch ? ` <span class="muted">on</span> ${escapeHtml(branch)}` : ""}</span>
      ${branch ? (dirty ? `<span class="tag dirty">${s.git.unstagedCount || s.git.stagedCount ? `${(s.git.unstagedCount || 0) + (s.git.stagedCount || 0)} changed` : "uncommitted changes"}</span>` : `<span class="muted">clean</span>`) : ""}
      ${s.paneCommand && s.paneCommand !== "unknown" ? `<span class="mono muted">${escapeHtml(s.paneCommand)}</span>` : ""}
      ${routeChipHTML(s.name)}
    </div>`;
}

function excerptHTML(s, lines = 14) {
  const out = (s.lastOutput || "").trim().split("\n");
  const tail = out.slice(-lines).join("\n").slice(-1600);
  return `<pre class="excerpt" tabindex="0" aria-label="Last output of ${escapeHtml(s.name)}">${escapeHtml(tail || "(no output yet)")}</pre>`;
}

function replyHTML(s) {
  return `
    <form class="reply" data-session="${escapeHtml(s.name)}">
      <input name="text" placeholder="Reply to ${escapeHtml(s.name)}" aria-label="Reply to ${escapeHtml(s.name)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" />
      <button type="submit" class="btn" aria-label="Send">↵</button>
    </form>`;
}

function extractPrompt(output) {
  const lines = String(output || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.filter((line) => /proceed\?|approve|permission|continue\?|waiting for input|select an option|\by\/n\b/i.test(line)).at(-1) || "Review the output and reply when you’re ready.").slice(0, 280);
}

// A session waiting on you: name, what it's asking, one-tap answers.
function requestHTML(s, arrived) {
  const isError = s.state === "error";
  return `
    <article class="req ${isError ? "is-error" : ""} ${arrived ? "arrived" : ""}" data-session="${escapeHtml(s.name)}" aria-label="${escapeHtml(s.name)} ${isError ? "hit an error" : "needs you"}">
      <div class="req-head">
        <span class="req-name">${escapeHtml(s.name)}</span>
        <span class="tag ${s.state}">${stateLabels[s.state]}</span>
        <span class="req-age">${whenText(s)}</span>
      </div>
      ${factsHTML(s)}
      ${!isError ? `<p class="request-prompt">${escapeHtml(extractPrompt(s.lastOutput))}</p>` : ""}
      ${excerptHTML(s, 10)}
      ${replyHTML(s)}
      <div class="answers">
        ${isError ? "" : `
        <button class="key yes" data-act="answer" data-text="y" title="Send y + Enter">y</button>
        <button class="key no" data-act="answer" data-text="n" title="Send n + Enter">n</button>`}
        <button class="key" data-act="key" data-key="Enter" title="Send Enter">⏎</button>
        <span class="sep"></span>
        <button class="btn" data-act="terminal">Terminal</button>
        <button class="btn btn-ghost" data-act="restart" title="Relaunch the CLI in this tmux window through the gateway and resume its conversation">Restart</button>
        <button class="btn btn-danger" data-act="stop">Stop</button>
      </div>
    </article>`;
}

// A quiet session: one line, expands to the same tools as a request.
function rowHTML(s) {
  const open = State.expanded.has(s.name);
  const repo = (s.paneCurrentPath || "").split("/").filter(Boolean).pop() || "";
  return `
    <article class="row ${open ? "open" : ""}" data-state="${s.state}" data-session="${escapeHtml(s.name)}">
      <span class="row-rule" aria-hidden="true"></span>
      <button class="row-main" aria-expanded="${open}" aria-controls="body-${escapeHtml(s.name)}">
        <span class="row-name"><b>${escapeHtml(s.name)}</b><span class="tag ${s.agent}">${escapeHtml(s.agent)}</span></span>
        <span class="row-sub"><span class="mono">${escapeHtml(repo)}${s.git?.branch ? ` on ${escapeHtml(s.git.branch)}` : ""}</span>${s.git?.dirty ? `<span class="mono" style="color:var(--amber)">changes</span>` : ""}</span>
        <span class="row-state"><span class="st">${stateLabels[s.state] || s.state}</span><span class="age">${whenText(s)}</span></span>
      </button>
      <div class="row-body" id="body-${escapeHtml(s.name)}">
        ${factsHTML(s)}
        ${excerptHTML(s, 18)}
        ${replyHTML(s)}
        <div class="answers">
          <button class="key" data-act="key" data-key="Enter" title="Send Enter">⏎</button>
          <button class="key" data-act="key" data-key="Escape" title="Send Escape">esc</button>
          <button class="key" data-act="key" data-key="C-c" title="Send Ctrl-C">^C</button>
          <span class="sep"></span>
          <button class="btn" data-act="terminal">Terminal</button>
          <button class="btn btn-ghost" data-act="copy">Copy output</button>
          <button class="btn btn-ghost" data-act="restart" title="Relaunch the CLI in this tmux window through the gateway and resume its conversation">Restart</button>
          <button class="btn btn-danger" data-act="stop">Stop</button>
        </div>
      </div>
    </article>`;
}

// Optimistic quick reply: the text appears in the excerpt immediately and is
// rolled back (with the input restored) if the server rejects it.
async function quickSend(e) {
  e.preventDefault();
  const form = e.target;
  if (form.dataset.busy) return;
  const session = form.dataset.session;
  const input = form.elements.text;
  const text = input.value.trim();
  if (!text) return;
  form.dataset.busy = "true";
  $("button", form).disabled = true;
  const excerpt = form.parentElement.querySelector(".excerpt");
  const pending = h(`<span class="pending">\n› ${escapeHtml(text)}</span>`);
  excerpt?.appendChild(pending);
  if (excerpt) excerpt.scrollTop = excerpt.scrollHeight;
  input.value = "";
  try {
    await api(`/api/sessions/${encodeURIComponent(session)}/input`, {
      method: "POST",
      body: JSON.stringify({ text, submit: true }),
    });
    toast(`Sent to ${session}`, "ok", { duration: 1800 });
    refreshGlobal();
  } catch (error) {
    pending.remove();
    if (!input.value) input.value = text;
    toast(`Couldn't send: ${error.message}`, "error");
  } finally {
    delete form.dataset.busy;
    $("button", form).disabled = false;
  }
}

async function stopSession(session) {
  const ok = await confirmDialog({ title: `Stop ${session}?`, body: "This kills the tmux session. Anything unsaved in it is lost.", action: "Stop session", danger: true });
  if (!ok) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(session)}`, { method: "DELETE" });
    toast(`Stopped ${session}`, "ok");
    State.expanded.delete(session);
    refreshGlobal();
  } catch (error) {
    toast(`Couldn't stop: ${error.message}`, "error");
  }
}

// Relaunch the CLI in place (same tmux window, same provider login, through the
// gateway) and resume its conversation. A turn in progress is interrupted.
async function restartSession(session) {
  const ok = await confirmDialog({ title: `Restart ${session}?`, body: "The CLI is stopped and relaunched in the same tmux window through the gateway, with its conversation resumed. A turn in progress is interrupted.", action: "Restart & resume" });
  if (!ok) return;
  try {
    const res = await api(`/api/sessions/${encodeURIComponent(session)}/relaunch`, { method: "POST", body: JSON.stringify({}) });
    Gateway.invalidate();
    toast(`${session} restarted${res.conversationId ? ", conversation resumed" : ""}`, "ok", { duration: 6000 });
    refreshGlobal();
  } catch (error) {
    toast(`Couldn't restart: ${error.message}`, "error");
  }
}

function openNewSessionModal(prefill = {}) {
  const { modal, close } = openModal(`
    <div class="overlay modal" id="modal">
      <div class="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h3 id="modal-title">New session</h3>
        <p class="sub">Starts the agent in a fresh tmux session on the server.</p>
        <form id="new-session-form" class="dialog-form">
          <label>Name<input name="name" required pattern="[A-Za-z0-9_.:\\-]+" value="${escapeHtml(prefill.name || "")}" placeholder="claude-feature-x" autocapitalize="off" autocorrect="off" /></label>
          <label>Agent
            <select name="agent">
              <option value="claude" ${prefill.agent !== "codex" ? "selected" : ""}>Claude Code</option>
              <option value="codex" ${prefill.agent === "codex" ? "selected" : ""}>Codex</option>
            </select>
          </label>
          <label>Directory<input name="directory" required value="${escapeHtml(prefill.directory || State.projects[0]?.path || "/home/ubuntu/apps")}" autocapitalize="off" autocorrect="off" /></label>
          <label>Provider
            <select name="route"><option value="direct">Loading routes…</option></select>
          </label>
          <div class="btn-row dialog-actions">
            <button type="button" class="btn btn-ghost" id="modal-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Start session</button>
          </div>
        </form>
      </div>
    </div>
  `);
  $("#modal-cancel", modal).addEventListener("click", close);
  const routeSelect = $('select[name="route"]', modal);
  const agentSelect = $('select[name="agent"]', modal);
  async function fillRoutes() {
    routeSelect.disabled = true;
    const lane = agentSelect.value;
    await Gateway.state();
    if (lane !== agentSelect.value) return;
    const routes = Gateway.routes(lane).filter((r) => r.available);
    const opts = routes.map((r) => {
      const acct = r.account ? Gateway.account(r.account) : null;
      const needsLogin = acct && !acct.signedIn;
      return `<option value="${r.id}" ${r.isDefault && !needsLogin ? "selected" : ""} ${needsLogin ? "disabled" : ""}>${escapeHtml(r.label)}${needsLogin ? " — sign in first" : ""}</option>`;
    });
    routeSelect.innerHTML = `${opts.join("")}<option value="direct" ${opts.length ? "" : "selected"}>Direct (no gateway)</option>`;
    routeSelect.disabled = false;
  }
  agentSelect.addEventListener("change", fillRoutes);
  fillRoutes();
  $("#new-session-form", modal).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    if (routeSelect.disabled) return;
    const submit = $('button[type="submit"]', f);
    submit.disabled = true;
    submit.textContent = "Starting…";
    try {
      await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          name: f.elements.name.value.trim(),
          agent: f.elements.agent.value,
          directory: f.elements.directory.value.trim(),
          route: f.elements.route.value,
        }),
      });
      toast(`Started ${f.elements.name.value}`, "ok");
      close();
      State.selectedSession = f.elements.name.value;
      persist();
      Gateway.invalidate();
      refreshGlobal();
    } catch (error) {
      toast(`Couldn't start: ${error.message}`, "error");
      submit.disabled = false;
      submit.textContent = "Start session";
    }
  });
}

// ─── Terminal page ────────────────────────────────────────────────────────
let terminalState = null; // { term, fit, ws, session, ro, search, canWrite, reconnectTimer, attempts }

route("terminal", {
  title: "Terminal",
  async render(root, args) {
    if (args[0]) State.selectedSession = decodeURIComponent(args[0]);
    root.innerHTML = `
      <div class="terminal-page">
        <div class="tlist">
          <div class="tlist-head"><h2>Sessions</h2><button class="btn btn-sm btn-ghost" id="term-new">New</button></div>
          <div id="term-session-list" role="list"></div>
        </div>
        <div class="tty">
          <div class="tty-head">
            <span class="tty-name" id="term-title">${escapeHtml(State.selectedSession || "No session")}</span>
            <span class="tty-status warn" id="term-status" role="status">connecting</span>
            <span id="term-route"></span>
            <div class="right">
              <button class="btn btn-sm btn-ghost" id="term-detach">Pop out</button>
            </div>
          </div>
          <div class="tty-host" id="term-host"></div>
        </div>
      </div>
    `;
    refreshTerminalList();
    $("#term-new").addEventListener("click", () => openNewSessionModal());
    $("#term-detach").addEventListener("click", () => {
      const s = State.selectedSession;
      if (s) window.open(`#terminal/${encodeURIComponent(s)}`, "_blank", "width=1000,height=700");
    });
    $("#term-route").addEventListener("click", (e) => { if (e.target.closest("[data-act='route']") && State.selectedSession) openRouteSwitcher(State.selectedSession); });
    // The terminal is the whole page: tapping it focuses xterm, whose own
    // hidden textarea raises the phone keyboard and takes desktop keystrokes.
    $("#term-host").addEventListener("click", () => { try { terminalState?.term?.focus(); } catch {/* */} });
    bootTerminal();
  },
  // Leaving drops the socket so the server stops polling tmux for a client
  // that isn't looking; the next visit starts clean.
  leave() { teardownTerminal(); },
});

let termListSig = "";
function refreshTerminalList() {
  const list = $("#term-session-list");
  if (!list) return;
  const sig = State.sessions.map((s) => `${s.name}|${s.state}|${s.agent}|${s.git?.branch || ""}|${s.name === State.selectedSession}`).join(";");
  if (sig === termListSig && list.childElementCount) return;
  termListSig = sig;
  if (!State.sessions.length) {
    list.innerHTML = `<div class="empty compact">No tmux sessions.</div>`;
    return;
  }
  const sorted = State.sessions.slice().sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.name.localeCompare(b.name));
  list.innerHTML = sorted.map((s) => `
    <button class="pick ${s.name === State.selectedSession ? "active" : ""}" data-state="${s.state}" data-session="${escapeHtml(s.name)}" role="listitem" aria-current="${s.name === State.selectedSession}">
      <span class="row1"><b>${escapeHtml(s.name)}</b><span class="st" title="${stateLabels[s.state] || s.state}"></span></span>
      <span class="row2"><span class="tag ${s.agent}">${escapeHtml(s.agent)}</span><span class="mono">${escapeHtml(s.git?.branch || "")}</span></span>
    </button>
  `).join("");
  $$(".pick", list).forEach((b) => b.addEventListener("click", () => {
    State.selectedSession = b.dataset.session;
    persist();
    location.hash = `#terminal/${encodeURIComponent(b.dataset.session)}`;
  }));
}

let termRouteSig = "";
function renderTerminalMeta() {
  const el = $("#term-route");
  if (!el || !State.selectedSession) return;
  const html = routeChipHTML(State.selectedSession, { large: false });
  if (html !== termRouteSig) { termRouteSig = html; el.innerHTML = html; }
}

function setTermStatus(text, cls) {
  const el = $("#term-status");
  if (el) { el.textContent = text; el.className = `tty-status ${cls || ""}`; }
}

function teardownTerminal() {
  if (!terminalState) return;
  clearTimeout(terminalState.reconnectTimer);
  try { terminalState.ro?.disconnect(); } catch {/* */}
  try { terminalState.ws?.close(); } catch {/* */}
  try { terminalState.term?.dispose(); } catch {/* */}
  terminalState = null;
}

// Build the xterm instance for the selected session, then attach a socket.
// Reconnects reuse the terminal and only redo the socket, so the screen
// doesn't blank between attempts.
function bootTerminal() {
  const host = $("#term-host");
  if (!host) return;
  teardownTerminal();
  termRouteSig = "";
  const session = State.selectedSession;
  const input = $("#term-input");
  if (!session) {
    setTermStatus("no session", "");
    host.innerHTML = `<div class="empty"><h3>Pick a session</h3><p>Choose one above, or start a new one.</p></div>`;
    if (input) { input.disabled = true; input.placeholder = "Pick a session first"; }
    return;
  }
  $("#term-title").textContent = session;
  $("#crumb-context").textContent = session;
  renderTerminalMeta();

  const term = new window.Terminal({
    fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace',
    fontSize: window.matchMedia("(max-width: 720px)").matches ? 11 : 13,
    lineHeight: 1.2,
    cursorBlink: true,
    convertEol: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: "#000000",
      foreground: "#e8edf2",
      cursor: "#3ddc97",
      cursorAccent: "#000000",
      selectionBackground: "rgba(168,180,255,0.35)",
      black: "#0f141b", red: "#ff6b6b", green: "#3ddc97", yellow: "#ffb454",
      blue: "#a8b4ff", magenta: "#c792ea", cyan: "#5fd3d3", white: "#e8edf2",
      brightBlack: "#6d7886", brightRed: "#ff8a8a", brightGreen: "#7af0c0",
      brightYellow: "#ffd089", brightBlue: "#c3cbff", brightMagenta: "#dab3f3",
      brightCyan: "#8fe6e6", brightWhite: "#ffffff",
    },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new window.WebLinksAddon.WebLinksAddon()); } catch {/* */}
  try { term.loadAddon(new window.Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = "11"; } catch {/* */}
  let search = null;
  try { search = new window.SearchAddon.SearchAddon(); term.loadAddon(search); } catch {/* */}

  term.open(host);
  fit.fit();
  terminalState = { term, fit, ws: null, session, search, canWrite: false, reconnectTimer: null, attempts: 0 };

  term.onData((data) => {
    const ws = terminalState?.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    if (!terminalState.canWrite) {
      toast("Read-only — save the access token in Settings to type", "error", { id: "term-ro" });
      return;
    }
    ws.send(JSON.stringify({ type: "data", data }));
  });
  const ro = new ResizeObserver(() => {
    try {
      fit.fit();
      const ws = terminalState?.ws;
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    } catch {/* */}
  });
  ro.observe(host);
  terminalState.ro = ro;
  connectTerminal();
}

function connectTerminal() {
  const st = terminalState;
  if (!st) return;
  clearTimeout(st.reconnectTimer);
  try { st.ws?.close(); } catch {/* */}
  const { term, session } = st;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const tokenParam = State.health?.authentication !== "cloudflare" && State.writeToken ? `&token=${encodeURIComponent(State.writeToken)}` : "";
  const ws = new WebSocket(`${proto}://${location.host}/ws/terminal?session=${encodeURIComponent(session)}${tokenParam}`);
  st.ws = ws;
  setTermStatus(st.attempts ? `reconnecting (${st.attempts})` : "connecting", "warn");

  ws.onopen = () => {
    st.attempts = 0;
    setTermStatus("live", "on");
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    if (payload.type === "ready") {
      st.canWrite = payload.canWrite;
      setTermStatus(payload.canWrite ? "live" : "read-only", payload.canWrite ? "on" : "warn");
      const input = $("#term-input");
      if (input) {
        input.disabled = !payload.canWrite;
        input.placeholder = payload.canWrite ? "Type to this session" : "Read-only — save the access token in Settings";
      }
      return;
    }
    if (payload.type === "snapshot") {
      // Repaint the visible screen in place inside a DEC 2026 synchronized
      // update (whole frame at once, no flicker), then restore tmux's cursor.
      const cursor = payload.cursor || { x: 0, y: 0 };
      const lines = payload.output.split("\n");
      let frame = "\x1b[?2026h\x1b[H\x1b[2J\x1b[3J";
      frame += lines.join("\r\n");
      frame += `\x1b[${cursor.y + 1};${cursor.x + 1}H`;
      frame += "\x1b[?2026l";
      term.write(frame);
    } else if (payload.type === "error") {
      toast(payload.message, "error", { id: "term-err" });
    }
  };
  ws.onclose = () => {
    if (terminalState !== st || st.ws !== ws) return;
    setTermStatus("disconnected", "bad");
    scheduleTerminalReconnect();
  };
}

// Backoff 1s → 15s while visible; a hidden tab waits for visibilitychange or
// `online` instead of burning reconnects in the background.
function scheduleTerminalReconnect(immediate = false) {
  const st = terminalState;
  if (!st || currentRoute().name !== "terminal" || State.selectedSession !== st.session) return;
  clearTimeout(st.reconnectTimer);
  if (document.hidden && !immediate) return;
  const delay = immediate ? 0 : Math.min(15000, 1000 * 2 ** Math.min(st.attempts, 4));
  st.attempts += 1;
  st.reconnectTimer = setTimeout(() => {
    if (terminalState === st && currentRoute().name === "terminal") connectTerminal();
  }, delay);
}

function ensureTerminalConnected() {
  const st = terminalState;
  if (!st || currentRoute().name !== "terminal") return;
  const ws = st.ws;
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify({ type: "resize", cols: st.term.cols, rows: st.term.rows })); } catch {/* */}
    return;
  }
  if (ws && ws.readyState === ws.CONNECTING) return;
  st.attempts = 0;
  scheduleTerminalReconnect(true);
}

async function sendKeyTo(session, key) {
  if (!session) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(session)}/key`, { method: "POST", body: JSON.stringify({ key }) });
  } catch (error) {
    toast(`Couldn't send ${key}: ${error.message}`, "error");
  }
}

// ─── Projects page ────────────────────────────────────────────────────────
route("projects", {
  title: "Projects",
  skeleton: () => `<div class="wrap">${[1, 2, 3, 4].map(() => `<div class="skeleton sk-row" style="height:72px;margin-bottom:8px"></div>`).join("")}</div>`,
  async render(root) {
    root.innerHTML = `
      <div class="wrap">
        <header class="hero">
          <h1>Projects</h1>
          <p class="hero-sub">Repos under ~/work/repos and ~/apps. Start an agent in any of them.</p>
        </header>
        <div id="projects-content"></div>
      </div>
    `;
    loadProjects();
  },
});

async function loadProjects() {
  const wrap = $("#projects-content");
  if (!wrap) return;
  try {
    const { projects } = await api("/api/projects");
    State.projects = projects;
    renderSidebar();
    if (!projects.length) {
      wrap.innerHTML = `<div class="empty"><h3>No projects found</h3><p>Clone a repo under ~/work/repos or ~/apps and it appears here.</p></div>`;
      return;
    }
    const groups = {};
    for (const p of projects) (groups[p.group] ||= []).push(p);
    wrap.innerHTML = Object.entries(groups).map(([group, items]) => `
      <section class="group">
        <div class="group-head"><h2>${escapeHtml(group)}</h2><span class="count">${items.length}</span></div>
        <div class="list">${items.map(renderProjectRow).join("")}</div>
      </section>
    `).join("");
    wrap.addEventListener("click", (e) => {
      const spawn = e.target.closest(".project-spawn");
      if (spawn) return openNewSessionModal({ directory: spawn.dataset.dir, agent: spawn.dataset.agent, name: defaultSessionName(spawn.dataset.agent, spawn.dataset.dir) });
      const jump = e.target.closest(".project-jump");
      if (jump) { State.selectedSession = jump.dataset.session; persist(); location.hash = `#terminal/${encodeURIComponent(jump.dataset.session)}`; }
    });
  } catch (error) {
    wrap.innerHTML = `<div class="empty"><h3>Couldn't load projects</h3><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function defaultSessionName(agent, dir) {
  const base = dir.split("/").filter(Boolean).pop() || "session";
  const stamp = String(Date.now()).slice(-4);
  return `${agent}-${base.toLowerCase().replace(/[^a-z0-9]/g, "")}-${stamp}`;
}

function renderProjectRow(p) {
  const sessions = (p.sessions || []).map((s) => `
    <button class="tag ${s.agent} project-jump" data-session="${escapeHtml(s.name)}" title="Open terminal">${escapeHtml(s.name)}</button>
  `).join("");
  return `
    <div class="project">
      <div>
        <div class="name">
          ${escapeHtml(p.name)}
          ${p.isGitRepo ? `<span class="tag mono">${escapeHtml(p.git.branch)}</span>` : ""}
          ${p.git?.dirty ? `<span class="tag dirty">uncommitted changes</span>` : ""}
        </div>
        <div class="path">${escapeHtml(p.path)}</div>
        <div class="meta">
          ${p.hasClaudeSettings ? `<span>Claude settings</span>` : ""}
          ${p.hasCodexConfig ? `<span>Codex config</span>` : ""}
          ${p.hasReadme ? `<span>README</span>` : ""}
          ${p.lastModified ? `<span>changed ${relTime(p.lastModified)}</span>` : ""}
        </div>
        ${sessions ? `<div class="on">${sessions}</div>` : ""}
      </div>
      <div class="actions">
        <button class="btn project-spawn" data-dir="${escapeHtml(p.path)}" data-agent="claude">Start Claude</button>
        <button class="btn project-spawn" data-dir="${escapeHtml(p.path)}" data-agent="codex">Start Codex</button>
      </div>
    </div>
  `;
}

// ─── Events page ──────────────────────────────────────────────────────────
const eventFilters = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs you" },
  { key: "error", label: "Errors" },
  { key: "ok", label: "Done" },
  { key: "info", label: "Info" },
];

route("events", {
  title: "Events",
  skeleton: () => `<div class="wrap">${[1, 2, 3, 4, 5, 6].map(() => `<div class="skeleton sk-row"></div>`).join("")}</div>`,
  async render(root) {
    root.innerHTML = `
      <div class="wrap events">
        <header class="hero">
          <h1>Events</h1>
          <p class="hero-sub">Hook notifications and monitor alerts, newest first. Repeats are folded into one line.</p>
        </header>
        <div class="filters" id="event-filters" role="group" aria-label="Filter events">
          ${eventFilters.map((f) => `<button class="chip ${State.eventFilter === f.key ? "active" : ""}" data-filter="${f.key}" aria-pressed="${State.eventFilter === f.key}">${f.label}</button>`).join("")}
        </div>
        <div id="events-panel"></div>
      </div>
    `;
    $("#event-filters").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-filter]");
      if (!chip) return;
      State.eventFilter = chip.dataset.filter;
      $$("#event-filters .chip").forEach((c) => { const on = c.dataset.filter === State.eventFilter; c.classList.toggle("active", on); c.setAttribute("aria-pressed", String(on)); });
      renderEvents();
    });
    $("#events-panel").addEventListener("click", (e) => {
      const open = e.target.closest("[data-open-session]");
      if (open) { State.selectedSession = open.dataset.openSession; persist(); location.hash = `#terminal/${encodeURIComponent(open.dataset.openSession)}`; }
    });
    await loadEvents();
    markEventsSeen();
    renderSidebar();
  },
});

// The raw type is coarse (most things are "notification"), so also sniff the
// message to separate the ones that want you from ambient chatter.
function eventKind(e) {
  if (e.type === "error") return "error";
  if (e.type === "completed") return "ok";
  if (e.type === "approval_required" || /waiting for your input|needs your (permission|approval|input)|approval for/i.test(e.message || "")) return "attention";
  return "info";
}
const eventIcons = { attention: "!", error: "×", ok: "✓", info: "·" };

function eventDayLabel(iso) {
  const d = new Date((iso || "").includes("T") ? (iso.endsWith("Z") ? iso : iso + "Z") : iso + "Z");
  const now = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, now)) return "Today";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

async function loadEvents() {
  const panel = $("#events-panel");
  if (!panel) return;
  try {
    const { events } = await api("/api/events?limit=100");
    State.events = events;
    renderEvents();
  } catch (error) {
    panel.innerHTML = `<div class="empty"><h3>Couldn't load events</h3><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderEvents() {
  const panel = $("#events-panel");
  if (!panel) return;
  const filtered = State.events.filter((e) => State.eventFilter === "all" || eventKind(e) === State.eventFilter);
  if (!filtered.length) {
    panel.innerHTML = State.events.length
      ? `<div class="empty"><h3>Nothing here</h3><p>No events match this filter.</p></div>`
      : `<div class="empty"><h3>No events yet</h3><p>Hook notifications and monitor alerts appear here as they happen.</p></div>`;
    return;
  }
  const groups = [];
  for (const e of filtered) {
    const prev = groups[groups.length - 1];
    if (prev && prev.agent === e.agent && prev.message === e.message && eventKind(prev) === eventKind(e)) {
      prev.count++;
      prev.firstAt = e.createdAt;
    } else {
      groups.push({ ...e, count: 1, firstAt: e.createdAt });
    }
  }
  let html = "";
  let lastDay = null;
  for (const e of groups) {
    const day = eventDayLabel(e.createdAt);
    if (day !== lastDay) { html += `<div class="event-day">${day}</div>`; lastDay = day; }
    const kind = eventKind(e);
    const abs = new Date(e.createdAt + "Z").toLocaleString();
    html += `
      <div class="event kind-${kind}">
        <span class="event-ic ${kind}" aria-label="${kind}">${eventIcons[kind]}</span>
        <div class="event-main">
          <div class="event-meta">
            <span class="agent ${escapeHtml(e.agent)}">${escapeHtml(e.session || e.agent)}</span>
            ${e.count > 1 ? `<span class="count">×${e.count}</span>` : ""}
            ${e.session ? `<button class="open" data-open-session="${escapeHtml(e.session)}">open terminal</button>` : ""}
          </div>
          <div class="msg">${escapeHtml(e.message)}</div>
        </div>
        <span class="ts" title="${escapeHtml(abs)}">${relTime(e.createdAt)}</span>
      </div>`;
  }
  panel.innerHTML = html;
}

// Global SSE feed, app-wide so badges and attention toasts work everywhere.
// EventSource reconnects on its own but reuses the original `since`, which
// would replay what we already have — so on error we rebuild it from the
// newest id, with backoff, and dedupe by id.
let eventSource = null;
let eventRetry = 0;
let eventRetryTimer = null;
function startEventStream() {
  if (eventSource) return;
  clearTimeout(eventRetryTimer);
  try {
    const es = new EventSource(`/api/events/stream?since=${State.events[0]?.id || 0}`);
    eventSource = es;
    es.onopen = () => { eventRetry = 0; };
    es.addEventListener("event", (ev) => {
      try {
        const e = JSON.parse(ev.data);
        if (State.events.some((x) => x.id === e.id)) return;
        State.events = [e, ...State.events].slice(0, 200);
        if (currentRoute().name === "events") { renderEvents(); markEventsSeen(); }
        renderSidebar();
        if (e.type === "approval_required" && currentRoute().name !== "events") {
          toast(`${e.session || e.agent}: ${e.message.slice(0, 80)}`, "", {
            duration: 6000,
            action: e.session ? { label: "Open", onClick: () => { location.hash = `#terminal/${encodeURIComponent(e.session)}`; } } : undefined,
          });
        }
      } catch {/* ignore */}
    });
    es.onerror = () => {
      es.close();
      if (eventSource === es) eventSource = null;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(eventRetry++, 5));
      eventRetryTimer = setTimeout(startEventStream, document.hidden ? Math.max(delay, 15000) : delay);
    };
  } catch {/* */}
}

function markEventsSeen() {
  const top = State.events[0]?.id || 0;
  if (top > State.eventsSeenId) {
    State.eventsSeenId = top;
    storage.set("agentOpsEventsSeenId", String(top));
  }
}

// ─── AI page ──────────────────────────────────────────────────────────────
route("ai", {
  title: "AI",
  async render(root) {
    try { State.aiStatus = await api("/api/ai/status"); } catch {/* keep cached */}
    const providerLine = State.aiStatus.enabled
      ? `${State.aiStatus.provider === "openai" ? "OpenAI" : "Anthropic"} · ${State.aiStatus.model}`
      : `Off — set ${State.aiStatus.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} on the server`;
    root.innerHTML = `
      <div class="ai-page">
        <div class="ai-side ai-conv-side">
          <div class="ai-side-head"><h2>Chats</h2><button class="btn btn-sm btn-ghost" id="ai-new">New</button></div>
          <div id="ai-conv-list" class="list"></div>
        </div>
        <div class="ai-conv">
          <div class="ai-model"><span>${escapeHtml(providerLine)}</span><span class="spacer"></span><button class="btn btn-sm btn-ghost" id="ai-new-m">New chat</button></div>
          <div class="ai-stream" id="ai-stream">
            <div class="empty"><h3>Your operator for this box</h3><p>It can run commands, read and write files, search the web, and drive the other agents. Try "what's eating disk in ~/work?" or "check what claude-pilot-1 is stuck on and unblock it". <code>/remember</code> saves a note.</p></div>
          </div>
          <form class="ai-composer" id="ai-composer">
            <textarea name="message" placeholder="Ask, or tell it what to do" aria-label="Message" required rows="1"></textarea>
            <button class="btn btn-primary" type="submit">Send</button>
          </form>
        </div>
        <div class="ai-side ai-memory-side">
          <div class="ai-side-head"><h2>Memory</h2><button class="btn btn-sm btn-ghost" id="mem-add">Add note</button></div>
          <input id="mem-search" placeholder="Search memory" aria-label="Search memory" autocomplete="off" style="margin-bottom:8px" />
          <div id="ai-mem-list" class="list"></div>
        </div>
      </div>
    `;
    $("#ai-new").addEventListener("click", () => newAIConversation());
    $("#ai-new-m").addEventListener("click", () => newAIConversation());
    $("#mem-add").addEventListener("click", () => addMemoryPrompt());
    $("#ai-composer").addEventListener("submit", aiSubmit);
    const ta = $("#ai-composer textarea");
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        $("#ai-composer").dispatchEvent(new Event("submit", { cancelable: true }));
      }
    });
    // Grow with the text up to the CSS max-height.
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = `${Math.min(200, ta.scrollHeight)}px`; });
    let searchTimer;
    $("#mem-search").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      const q = e.target.value;
      searchTimer = setTimeout(() => loadMemories(q), 180);
    });
    await loadConversations();
    await loadMemories();
  },
});

async function loadConversations() {
  try {
    const { conversations } = await api("/api/ai/conversations");
    State.conversations = conversations;
    renderConvList();
    if (!State.currentConv && conversations[0]) selectConversation(conversations[0].id);
  } catch (error) {
    $("#ai-conv-list").innerHTML = `<div class="empty compact"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderConvList() {
  const list = $("#ai-conv-list");
  if (!list) return;
  if (!State.conversations.length) {
    list.innerHTML = `<div class="empty compact"><p>No chats yet</p></div>`;
    return;
  }
  list.innerHTML = State.conversations.map((c) => `
    <button class="conv ${c.id === State.currentConv?.id ? "active" : ""}" data-id="${escapeHtml(c.id)}" aria-current="${c.id === State.currentConv?.id}">
      <span class="title">${escapeHtml(c.title)}</span>
      <span class="ts">${relTime(c.updatedAt)}</span>
    </button>
  `).join("");
  $$(".conv", list).forEach((row) => row.addEventListener("click", () => selectConversation(row.dataset.id)));
}

async function selectConversation(id) {
  try {
    const { conversation } = await api(`/api/ai/conversations/${id}`);
    State.currentConv = conversation;
    renderConvList();
    renderStream(conversation);
  } catch (error) {
    toast(`Couldn't open chat: ${error.message}`, "error");
  }
}

function renderStream(conv) {
  const stream = $("#ai-stream");
  if (!stream) return;
  if (!conv || !conv.turns.length) {
    stream.innerHTML = `<div class="empty"><h3>New chat</h3><p>Say what you need.</p></div>`;
    return;
  }
  stream.innerHTML = itemsFromTurns(conv.turns).map(renderItem).join("");
  stream.scrollTop = stream.scrollHeight;
}

// Flatten stored turns into display items: text bubbles and tool cards.
// tool_result blocks live in a later user turn, so match them by id.
function itemsFromTurns(turns) {
  const items = [];
  const toolsById = {};
  for (const turn of turns) {
    const content = turn.content;
    if (typeof content === "string") {
      if (content.trim()) items.push({ kind: "text", role: turn.role, text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "text" && block.text) {
        items.push({ kind: "text", role: turn.role, text: block.text });
      } else if (block.type === "tool") {
        items.push({ kind: "tool", id: block.id, name: block.name, input: block.input, output: block.output || "", done: true, isError: Boolean(block.isError) });
      } else if (block.type === "tool_use" || block.type === "server_tool_use") {
        const item = { kind: "tool", id: block.id, name: block.name, input: block.input, output: "", done: block.type === "server_tool_use", isError: false };
        toolsById[block.id] = item;
        items.push(item);
      } else if (block.type === "tool_result") {
        const item = toolsById[block.tool_use_id];
        if (item) {
          item.output = blockText(block.content);
          item.done = true;
          item.isError = Boolean(block.is_error);
        }
      }
    }
  }
  return items;
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? b : b.text || "")).join("");
  return "";
}

function renderItem(item) {
  if (item.kind === "text") {
    return `<div class="ai-turn ${item.role}"><div class="role">${item.role === "user" ? "you" : "agent"}</div><div class="body">${renderMarkdownish(item.text)}</div></div>`;
  }
  return toolCardHTML(item);
}

const toolIcons = {
  bash: "$", read_file: "◇", write_file: "✎", list_sessions: "▤",
  capture_session: "▮", send_session: "➤", web_search: "⌕",
};

function toolCardHTML(item) {
  const icon = toolIcons[item.name] || "•";
  const label = toolLabel(item);
  const status = !item.done ? "running" : item.isError ? "error" : "done";
  const statusText = !item.done ? "running" : item.isError ? "failed" : "done";
  const output = (item.output || "").trim();
  const body = output ? `<pre class="tool-output">${escapeHtml(output.slice(-6000))}</pre>` : "";
  const longOutput = output.split("\n").length > 8 || output.length > 500;
  const collapsed = item.done && !item.isError && longOutput;
  return `
    <div class="tool-card ${status} ${collapsed ? "collapsed" : ""}" data-tool="${escapeHtml(item.id)}">
      <div class="tool-head" ${body ? `role="button" tabindex="0" aria-expanded="${!collapsed}"` : ""}>
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${escapeHtml(item.name)}</span>
        <span class="tool-label">${escapeHtml(label)}</span>
        <span class="tool-status ${status}">${statusText}</span>
        ${body ? '<span class="tool-caret">▾</span>' : ""}
      </div>
      <div class="tool-body">${body}</div>
    </div>
  `;
}

function toolLabel(item) {
  const i = item.input || {};
  if (item.name === "bash") return i.command || "";
  if (item.name === "read_file" || item.name === "write_file") return i.path || "";
  if (item.name === "capture_session" || item.name === "send_session") return i.session || "";
  if (item.name === "web_search") return i.query || "";
  return "";
}

function renderMarkdownish(text) {
  let s = escapeHtml(text);
  s = s.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => `<pre>${code.replace(/\n$/, "")}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/^###?\s+(.+)$/gm, "<strong>$1</strong>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

async function newAIConversation() {
  try {
    const { conversation } = await api("/api/ai/conversations", { method: "POST", body: JSON.stringify({ title: "New chat" }) });
    State.currentConv = conversation;
    State.conversations = [conversation, ...State.conversations];
    renderConvList();
    renderStream(conversation);
    $("#ai-composer textarea")?.focus();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function aiSubmit(e) {
  e.preventDefault();
  const ta = e.currentTarget.elements.message;
  const message = ta.value.trim();
  if (!message) return;
  ta.value = "";
  ta.style.height = "";

  let conv = State.currentConv;
  if (!conv) {
    try {
      const { conversation } = await api("/api/ai/conversations", { method: "POST", body: JSON.stringify({ title: "New chat" }) });
      conv = conversation;
      State.currentConv = conv;
      State.conversations = [conv, ...State.conversations];
      renderConvList();
    } catch (error) { toast(error.message, "error"); return; }
  }
  const stream = $("#ai-stream");
  if (stream.querySelector(".empty")) stream.innerHTML = "";
  stream.insertAdjacentHTML("beforeend", `<div class="ai-turn user"><div class="role">you</div><div class="body">${renderMarkdownish(message)}</div></div>`);

  const agentBlock = h(`<div class="ai-agent-block"></div>`);
  stream.appendChild(agentBlock);
  const scroll = () => { stream.scrollTop = stream.scrollHeight; };
  scroll();

  let textNode = null;
  let accumulatedText = "";
  const cards = {};
  const ensureText = () => {
    if (!textNode) {
      textNode = h(`<div class="ai-turn assistant"><div class="role">agent</div><div class="body"></div></div>`);
      agentBlock.appendChild(textNode);
    }
    return textNode.querySelector(".body");
  };
  const ensureCard = (id, name) => {
    if (cards[id]) return cards[id];
    const item = { id, name, input: {}, output: "", done: false, isError: false };
    const node = h(toolCardHTML(item));
    agentBlock.appendChild(node);
    cards[id] = { item, node };
    textNode = null;
    return cards[id];
  };
  // Re-render a card in place, but coalesce bursts of tool output so a chatty
  // command doesn't rebuild the DOM for every chunk.
  const dirty = new Set();
  let flushTimer = null;
  const refreshCard = (id) => {
    dirty.add(id);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      for (const cid of dirty) {
        const entry = cards[cid];
        if (!entry) continue;
        const fresh = h(toolCardHTML(entry.item));
        entry.node.replaceWith(fresh);
        entry.node = fresh;
      }
      dirty.clear();
      scroll();
    }, 80);
  };

  const headers = { "content-type": "application/json" };
  if (State.health?.authentication !== "cloudflare" && State.writeToken) headers.authorization = `Bearer ${State.writeToken}`;
  let res;
  try {
    res = await fetch("/api/ai/ask", { method: "POST", headers, body: JSON.stringify({ message, conversationId: conv.id }) });
  } catch (error) {
    ensureText().innerHTML = `<span class="ai-error">Couldn't reach the server: ${escapeHtml(error.message)}</span>`;
    return;
  }
  if (res.status === 401) {
    if (State.health?.authentication === "cloudflare") {
      ensureText().innerHTML = `<span class="ai-error">Your Cloudflare login has expired. Reload Devy to sign in again.</span>`;
      ta.value = message;
      return;
    }
    agentBlock.remove();
    const t = await promptToken();
    if (t) { State.writeToken = t; storage.set("agentOpsToken", t); ta.value = message; aiSubmit(e); }
    return;
  }
  if (!res.ok || !res.body) {
    ensureText().innerHTML = `<span class="ai-error">Request failed (${res.status})</span>`;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (event, payload) => {
    if (event === "delta") {
      accumulatedText += payload.text;
      ensureText().innerHTML = renderMarkdownish(accumulatedText);
    } else if (event === "tool_start") {
      ensureCard(payload.id, payload.name);
      accumulatedText = "";
    } else if (event === "tool_use") {
      const entry = ensureCard(payload.id, payload.name);
      entry.item.input = payload.input || {};
      refreshCard(payload.id);
    } else if (event === "tool_output") {
      const entry = cards[payload.id];
      if (entry) { entry.item.output = (entry.item.output + payload.chunk).slice(-12000); refreshCard(payload.id); }
    } else if (event === "tool_result") {
      const entry = ensureCard(payload.id, "tool");
      if (payload.content) entry.item.output = payload.content;
      entry.item.done = true;
      entry.item.isError = payload.isError;
      refreshCard(payload.id);
    } else if (event === "usage") {
      updateUsage(payload);
    } else if (event === "memory") {
      toast(`Remembered: ${payload.topic}`, "ok");
      loadMemories();
    } else if (event === "error") {
      toast(payload.message, "error");
      ensureText().insertAdjacentHTML("beforeend", `<div class="ai-error">${escapeHtml(payload.message)}</div>`);
    } else if (event === "done") {
      for (const id in cards) {
        if (!cards[id].item.done) { cards[id].item.done = true; refreshCard(id); }
      }
      loadConversations();
    }
    scroll();
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const eventMatch = chunk.match(/^event: (\S+)/m);
      const dataMatch = chunk.match(/^data: (.+)$/m);
      if (!eventMatch || !dataMatch) continue;
      let payload;
      try { payload = JSON.parse(dataMatch[1]); } catch { continue; }
      handle(eventMatch[1], payload);
    }
  }
}

function updateUsage(u) {
  let el = $("#ai-usage");
  if (!el) {
    const head = $(".ai-model");
    if (!head) return;
    el = h(`<span id="ai-usage" class="ai-usage"></span>`);
    head.insertBefore(el, $(".spacer", head));
  }
  const total = (updateUsage.total = (updateUsage.total || 0) + (u.output || 0));
  el.textContent = `${total} tokens out`;
}

async function loadMemories(q = "") {
  try {
    const path = q ? `/api/ai/memories?q=${encodeURIComponent(q)}` : "/api/ai/memories";
    const { memories } = await api(path);
    State.memories = memories;
    renderMemories();
  } catch (error) {
    const list = $("#ai-mem-list");
    if (list) list.innerHTML = `<div class="empty compact"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderMemories() {
  const list = $("#ai-mem-list");
  if (!list) return;
  if (!State.memories.length) {
    list.innerHTML = `<div class="empty compact"><p>Nothing remembered yet</p></div>`;
    return;
  }
  list.innerHTML = State.memories.map((m) => `
    <div class="memory" data-id="${escapeHtml(m.id)}">
      <div class="top"><span class="topic">${escapeHtml(m.topic)}</span>
        <button class="icon-btn mem-del" data-id="${escapeHtml(m.id)}" title="Forget" aria-label="Forget ${escapeHtml(m.topic)}" style="width:30px;height:30px;border:0">×</button>
      </div>
      <div class="body">${escapeHtml(m.body)}</div>
      ${m.tags?.length ? `<div class="tags">${m.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    </div>
  `).join("");
  $$(".mem-del", list).forEach((btn) => btn.addEventListener("click", async () => {
    if (!(await confirmDialog({ title: "Forget this memory?", action: "Forget", danger: true }))) return;
    try {
      await api(`/api/ai/memories/${btn.dataset.id}`, { method: "DELETE" });
      loadMemories();
    } catch (error) {
      toast(error.message, "error");
    }
  }));
}

function addMemoryPrompt() {
  const { modal, close } = openModal(`
    <div class="overlay modal">
      <div class="sheet dialog" role="dialog" aria-modal="true" aria-labelledby="mem-title">
        <h3 id="mem-title">Remember something</h3>
        <form class="dialog-form" id="mem-form">
          <label>Topic<input name="topic" required maxlength="200" placeholder="deploy checklist" /></label>
          <label>Note<textarea name="body" required maxlength="8000" rows="4"></textarea></label>
          <label>Tags<input name="tags" placeholder="ops, pilot (optional)" /></label>
          <div class="btn-row dialog-actions">
            <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
            <button type="submit" class="btn btn-primary">Save note</button>
          </div>
        </form>
      </div>
    </div>`);
  $("[data-cancel]", modal).addEventListener("click", close);
  $("#mem-form", modal).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      await api("/api/ai/memories", {
        method: "POST",
        body: JSON.stringify({
          topic: f.elements.topic.value.trim().slice(0, 200),
          body: f.elements.body.value.trim().slice(0, 8000),
          tags: f.elements.tags.value.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      close();
      loadMemories();
      toast("Saved note", "ok");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

// ─── Settings page ────────────────────────────────────────────────────────
route("settings", {
  title: "Settings",
  async render(root) {
    State.health ??= await api("/api/health");
    if (currentRoute().name !== "settings") return;
    const allowsInput = State.health?.agentInputEnabled;
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    const denied = notificationsSupported() && Notification.permission === "denied";
    root.innerHTML = `
      <div class="settings">
        <section class="group">
          <div class="group-head"><h2>Access</h2></div>
          <div class="group-body">
            ${State.health?.authentication === "cloudflare" ? `<p class="help">Signed in through Cloudflare Access. Your login enables session controls and the AI; no separate token is needed.</p>` : `<div class="field">
              <label>Access token<input id="token-input" type="password" placeholder="paste AGENT_OPS_TOKEN" value="${escapeHtml(State.writeToken)}" autocomplete="off" /></label>
              <p class="help">Needed to type into sessions, start or stop them, and talk to the AI. Stored only in this browser.</p>
              <div class="btn-row">
                <button class="btn btn-primary" id="save-token">Save token</button>
                <button class="btn btn-ghost" id="clear-token">Remove</button>
              </div>
            </div>`}
          </div>
        </section>

        <section class="group">
          <div class="group-head"><h2>Alerts</h2></div>
          <div class="group-body">
            <label class="check-row">
              <input type="checkbox" id="notify-sound" ${State.notifySound ? "checked" : ""} />
              <span>Beep when a session starts waiting for you</span>
            </label>
            ${notificationsSupported() ? `
            <label class="check-row">
              <input type="checkbox" id="notify-push" ${notificationsGranted() ? "checked" : ""} ${denied ? "disabled" : ""} />
              <span>Notify me when a session needs me while Devy is in the background
                <small>${denied ? "Blocked in your browser settings — allow notifications for this site to turn it on." : "Uses system notifications; tap one to jump to that session's terminal."}</small></span>
            </label>` : `
            <div class="field"><p class="help">System notifications aren't available here.${!standalone ? " On iPhone, add Devy to your Home Screen first, then enable them from the installed app." : ""}</p></div>`}
          </div>
        </section>

        <section class="group">
          <div class="group-head"><h2>Server</h2></div>
          <div class="group-body">
            <div class="kv"><span>Host</span><b class="mono">${escapeHtml(State.health?.hostname || "—")}</b></div>
            <div class="kv"><span>Typing into sessions</span><b>${allowsInput ? "Enabled" : "Disabled on the server (ENABLE_AGENT_INPUT)"}</b></div>
            <div class="kv"><span>AI operator</span><b>${State.aiStatus.enabled ? `${State.aiStatus.provider === "openai" ? "OpenAI" : "Anthropic"} · ${escapeHtml(State.aiStatus.model || "")}` : "Off — no API key on the server"}</b></div>
            <div class="kv"><span>Tailscale only</span><b>${State.health?.tailscaleOnly ? "Yes" : "No"}</b></div>
          </div>
        </section>

        <section class="group">
          <div class="group-head"><h2>This app</h2></div>
          <div class="group-body">
            <div class="kv"><span>Running as</span><b>${standalone ? "Installed app" : "Browser tab"}</b></div>
            <div class="kv"><span>Connection</span><b>${State.online ? "Online" : "Offline"}</b></div>
            <div class="field">
              ${!standalone ? `<p class="help">Install Devy for full-screen use and notifications: on iPhone, Share → Add to Home Screen; on desktop Chrome, use the install icon in the address bar.</p>` : ""}
              <div class="btn-row"><button class="btn" id="check-updates">Check for updates</button></div>
            </div>
          </div>
        </section>

        <section class="group">
          <div class="group-head"><h2>Keyboard</h2></div>
          <div class="group-body">
            <div class="kv"><span>Command palette</span><b class="mono">⌘K / Ctrl+K</b></div>
            <div class="kv"><span>Go to Sessions</span><b class="mono">g s</b></div>
            <div class="kv"><span>Go to Terminal</span><b class="mono">g t</b></div>
            <div class="kv"><span>Go to AI</span><b class="mono">g a</b></div>
            <div class="kv"><span>Go to Events</span><b class="mono">g e</b></div>
            <div class="kv"><span>Go to Projects</span><b class="mono">g p</b></div>
            <div class="kv"><span>Send in AI chat</span><b class="mono">⌘↩</b></div>
          </div>
        </section>
      </div>
    `;
    $("#save-token")?.addEventListener("click", () => {
      State.writeToken = $("#token-input").value.trim();
      storage.set("agentOpsToken", State.writeToken);
      toast("Token saved", "ok");
    });
    $("#clear-token")?.addEventListener("click", () => {
      State.writeToken = "";
      storage.remove("agentOpsToken");
      $("#token-input").value = "";
      toast("Token removed", "ok");
    });
    $("#notify-sound").addEventListener("change", (e) => {
      State.notifySound = e.target.checked;
      storage.set("agentOpsNotifySound", String(State.notifySound));
    });
    $("#notify-push")?.addEventListener("change", async (e) => {
      const box = e.target;
      if (box.checked) {
        const ok = await requestNotifications();
        if (!ok) { box.checked = false; toast("Notifications weren't allowed", "error"); return; }
        toast("You'll be notified when a session needs you", "ok");
      }
      State.notifyPush = box.checked;
      storage.set("agentOpsNotifyPush", String(State.notifyPush));
    });
    $("#check-updates").addEventListener("click", async () => {
      try {
        await window.checkForUpdates?.();
        toast("Checked — a Reload prompt appears if there's a new version", "ok");
      } catch { toast("Couldn't check for updates", "error"); }
    });
  },
});

// ─── Command palette ──────────────────────────────────────────────────────
function openPalette() {
  $("#palette").hidden = false;
  $("#palette-input").value = "";
  $("#palette-input").focus();
  renderPalette("");
}
function closePalette() { $("#palette").hidden = true; }
function paletteItems() {
  const items = [
    { kind: "page", label: "Sessions", href: "#sessions" },
    { kind: "page", label: "Terminal", href: "#terminal" },
    { kind: "page", label: "AI", href: "#ai" },
    { kind: "page", label: "Events", href: "#events" },
    { kind: "page", label: "Projects", href: "#projects" },
    { kind: "page", label: "Routing", href: "#routing" },
    { kind: "page", label: "Gateway", href: "#gateway" },
    { kind: "page", label: "Settings", href: "#settings" },
    { kind: "action", label: "New session", action: () => openNewSessionModal() },
  ];
  for (const s of State.sessions) items.push({ kind: "session", label: s.name, href: `#terminal/${encodeURIComponent(s.name)}` });
  for (const s of State.sessions) items.push({ kind: "provider", label: `Switch provider: ${s.name}`, action: () => openRouteSwitcher(s.name) });
  for (const p of State.projects) items.push({ kind: "project", label: p.name, action: () => openNewSessionModal({ directory: p.path, agent: "claude", name: defaultSessionName("claude", p.path) }) });
  return items;
}
let paletteActions = [];
function renderPalette(query) {
  const items = paletteItems().filter((i) => i.label.toLowerCase().includes(query.toLowerCase())).slice(0, 30);
  const list = $("#palette-list");
  list.innerHTML = items.map((i, idx) => `
    <li data-idx="${idx}" class="${idx === 0 ? "active" : ""}" role="option" aria-selected="${idx === 0}"><span class="kind">${i.kind}</span><span>${escapeHtml(i.label)}</span></li>
  `).join("") || `<li class="muted" style="cursor:default">Nothing matches</li>`;
  list.dataset.items = JSON.stringify(items.map(({ kind, label, href }) => ({ kind, label, href })));
  paletteActions = items.map((i) => i.action || null);
}
let gMode = 0;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (e.key === "Escape" && !$("#palette").hidden) { closePalette(); return; }
  if (!$("#palette").hidden) {
    const list = $("#palette-list");
    const items = JSON.parse(list.dataset.items || "[]");
    const active = list.querySelector(".active");
    let idx = active ? Number(active.dataset.idx) : 0;
    if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); }
    if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(0, idx - 1); }
    if (e.key === "Enter") {
      const item = items[idx];
      if (!item) return;
      if (item.href) location.hash = item.href;
      paletteActions[idx]?.();
      closePalette();
      return;
    }
    $$("#palette-list li").forEach((li) => {
      const on = Number(li.dataset.idx) === idx;
      li.classList.toggle("active", on);
      li.setAttribute("aria-selected", String(on));
      if (on) li.scrollIntoView({ block: "nearest" });
    });
    return;
  }
  if (gMode && Date.now() - gMode < 1200) {
    gMode = 0;
    const map = { s: "sessions", t: "terminal", p: "projects", a: "ai", e: "events" };
    const target = map[e.key.toLowerCase()];
    if (target) { e.preventDefault(); location.hash = `#${target}`; }
    return;
  }
  if (e.key === "g" && !e.target.matches("input, textarea")) gMode = Date.now();
});
$("#palette-input").addEventListener("input", (e) => renderPalette(e.target.value));
$("#palette-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-idx]");
  if (!li) return;
  const items = JSON.parse($("#palette-list").dataset.items || "[]");
  const idx = Number(li.dataset.idx);
  const item = items[idx];
  if (item?.href) location.hash = item.href;
  paletteActions[idx]?.();
  closePalette();
});
$("#palette").addEventListener("click", (e) => { if (e.target === $("#palette")) closePalette(); });

// ─── "More" tab (phone) ───────────────────────────────────────────────────
function openMoreSheet() {
  const { modal, close } = openModal(`
    <div class="overlay modal">
      <div class="sheet dialog" role="dialog" aria-modal="true" aria-label="More">
        <nav class="more-list" aria-label="More pages">
          <a href="#projects"><span class="nav-ic" aria-hidden="true">⬡</span>Projects</a>
          <a href="#routing"><span class="nav-ic" aria-hidden="true">◎</span>Routing</a>
          <a href="#gateway"><span class="nav-ic" aria-hidden="true">⇄</span>Gateway</a>
          <a href="#settings"><span class="nav-ic" aria-hidden="true">⚙</span>Settings</a>
          <a href="/remote/"><span class="nav-ic" aria-hidden="true">↗</span>Quick remote</a>
        </nav>
        <div class="health" style="padding:12px 8px 0"><span class="dot ${$("#health-dot").className.replace("dot", "").trim()}"></span><span>${escapeHtml($("#health-text").textContent)}</span></div>
      </div>
    </div>`);
  modal.addEventListener("click", (e) => { if (e.target.closest("a")) close(); });
}

// ─── Boot ─────────────────────────────────────────────────────────────────
function spinnerHTML() { return `<div class="empty"><div class="spinner"></div></div>`; }

$("#refresh").addEventListener("click", () => {
  const r = currentRoute().name;
  refreshGlobal();
  Gateway.invalidate();
  if (r === "projects") loadProjects();
  if (r === "events") loadEvents();
  if (r === "gateway") navigate();
});
function setNavOpen(open) {
  document.body.classList.toggle("nav-open", open);
  $("#nav-toggle")?.setAttribute("aria-expanded", String(open));
}
$("#nav-toggle")?.addEventListener("click", () => setNavOpen(!document.body.classList.contains("nav-open")));
$("#nav-scrim")?.addEventListener("click", () => setNavOpen(false));
$("#palette-open")?.addEventListener("click", openPalette);
$("#more-tab")?.addEventListener("click", openMoreSheet);

// Some standalone PWA contexts swallow `<a href="#…">` navigation; force the
// hash update from JS so nav always works. Same route → re-render.
$$(".nav-item, .tabs a").forEach((a) => {
  a.addEventListener("click", (e) => {
    const href = a.getAttribute("href");
    if (!href || !href.startsWith("#")) return;
    e.preventDefault();
    if (location.hash === href) navigate(); else location.hash = href;
    setNavOpen(false);
  });
});

// Helpers shared with pages that live in their own module (see gateway.js).
window.Devy = { route, api, $, $$, h, escapeHtml, toast, formatUptime, stateLabels, currentRoute, navigate, State, Gateway, routeHealth, confirmDialog, openModal, relTime };

// ─── Service worker: install + "update available" flow ────────────────────
// The worker no longer skipWaiting()s on its own; a new version waits until
// the user taps Reload, so a running page never mixes old app.js with a
// new shell mid-session.
let swReloading = false;
function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").then((reg) => {
    const offerUpdate = (worker) => {
      toast("A new version of Devy is ready", "ok", {
        id: "sw-update",
        sticky: true,
        action: { label: "Reload", onClick: () => { swReloading = true; worker.postMessage({ type: "SKIP_WAITING" }); } },
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) offerUpdate(worker);
      });
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
    window.checkForUpdates = () => reg.update();
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (swReloading) location.reload(); });
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "NAVIGATE" && typeof e.data.url === "string") location.hash = e.data.url.replace(/^[^#]*/, "");
  });
}
setupServiceWorker();

// ─── Wake / network handling ──────────────────────────────────────────────
// Phones suspend timers and drop sockets when the screen locks. Coming back:
// poll now, make sure the terminal socket and event stream are alive.
function wakeUp() {
  schedulePoll(0);
  ensureTerminalConnected();
  if (!eventSource) { eventRetry = 0; startEventStream(); }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) wakeUp();
  else schedulePoll();
});
window.addEventListener("focus", () => { if (!document.hidden) ensureTerminalConnected(); });
window.addEventListener("pageshow", (e) => { if (e.persisted) wakeUp(); });
window.addEventListener("online", () => {
  State.online = true;
  toast("Back online", "ok", { id: "net" });
  wakeUp();
});
window.addEventListener("offline", () => {
  State.online = false;
  renderSidebar();
  toast("You're offline — showing the last known state", "error", { id: "net", sticky: true });
});

// ─── iPhone / mobile keyboard handling ────────────────────────────────────
// iOS Safari doesn't reflow the layout viewport when the keyboard appears;
// mirror visualViewport into CSS vars so the layout can shrink and inputs
// stay above the keyboard.
(function setupVisualViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const apply = () => {
    const innerH = window.innerHeight;
    const vvH = vv ? vv.height : innerH;
    root.style.setProperty("--vvh", `${vvH}px`);
    const kbd = Math.max(0, innerH - vvH - (vv?.offsetTop || 0));
    root.style.setProperty("--kbd", `${kbd}px`);
    document.body.classList.toggle("kbd-open", kbd > 80);
  };
  apply();
  vv?.addEventListener?.("resize", apply);
  vv?.addEventListener?.("scroll", apply);
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", () => setTimeout(apply, 250));
})();

// Scroll focused inputs into view above the keyboard.
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (!el.matches("input, textarea, [contenteditable=true]")) return;
  if (el.closest(".overlay")) return;
  setTimeout(() => { try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch {/* */} }, 280);
});

// Collapse/expand an AI tool-call card by clicking (or Enter/Space on) its head.
document.addEventListener("click", (e) => {
  const head = e.target.closest?.(".tool-head[role='button']");
  if (head) { const open = head.parentElement.classList.toggle("collapsed"); head.setAttribute("aria-expanded", String(!open)); }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const head = e.target.closest?.(".tool-head[role='button']");
  if (head) { e.preventDefault(); const open = head.parentElement.classList.toggle("collapsed"); head.setAttribute("aria-expanded", String(!open)); }
});

refreshGlobal();
navigate();
// Seed the event list so badges and the stream's `since` are right from the
// first paint, then keep the stream open app-wide.
api("/api/events?limit=100").then(({ events }) => {
  if (!State.events.length) { State.events = events; renderSidebar(); }
}).catch(() => {}).finally(startEventStream);
