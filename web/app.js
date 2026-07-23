// agent-ops PWA — unified app shell with router and pages.

// ─── State ────────────────────────────────────────────────────────────────
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
  selectedSession: localStorage.getItem("agentOpsSelectedSession") || null,
  seenHashes: JSON.parse(localStorage.getItem("agentOpsSeen") || "{}"),
  notifySound: localStorage.getItem("agentOpsNotifySound") !== "false",
  writeToken: localStorage.getItem("agentOpsToken") || "",
};

function persist() {
  localStorage.setItem("agentOpsSeen", JSON.stringify(State.seenHashes));
  if (State.selectedSession) localStorage.setItem("agentOpsSelectedSession", State.selectedSession);
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
  running: "Running",
  waiting_for_input: "Needs input",
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

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return "—";
  const h = Math.floor(seconds / 3600);
  const days = Math.floor(h / 24);
  if (days > 0) return `${days}d ${h % 24}h`;
  return `${h}h`;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (State.writeToken && opts.method && opts.method !== "GET") {
    headers["authorization"] = `Bearer ${State.writeToken}`;
  }
  const res = await fetch(url, { ...opts, headers, cache: "no-store" });
  if (res.status === 401) {
    State.writeToken = "";
    localStorage.removeItem("agentOpsToken");
    const token = await promptToken();
    if (token) {
      State.writeToken = token;
      localStorage.setItem("agentOpsToken", token);
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

async function promptToken() {
  return new Promise((resolve) => {
    const v = prompt("Enter AGENT_OPS_TOKEN for write actions");
    resolve(v ? v.trim() : "");
  });
}

// ─── Toasts ───────────────────────────────────────────────────────────────
function toast(msg, kind = "") {
  const el = h(`<div class="toast ${kind}">${escapeHtml(msg)}</div>`);
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 200);
  }, 3500);
}

// ─── Router ───────────────────────────────────────────────────────────────
const routes = {};
function route(name, opts) { routes[name] = opts; }

function currentRoute() {
  const hash = location.hash.slice(1) || "sessions";
  const [name, ...rest] = hash.split("/");
  return { name: routes[name] ? name : "sessions", args: rest };
}

async function navigate() {
  const r = currentRoute();
  document.body.dataset.route = r.name;
  $$(".nav-item, .bottom-tabs a").forEach((a) => a.classList.toggle("active", a.dataset.route === r.name));
  $("#crumb-page").textContent = routes[r.name]?.title || r.name;
  $("#crumb-context").textContent = "";
  const root = $("#page-root");
  root.innerHTML = `<div class="empty"><div class="spinner"></div></div>`;
  try {
    await routes[r.name].render(root, r.args);
  } catch (error) {
    root.innerHTML = `<div class="empty"><h3>Page error</h3><p>${escapeHtml(error.message)}</p></div>`;
  }
}

window.addEventListener("hashchange", navigate);

// ─── Sidebar updates / global polling ─────────────────────────────────────
async function refreshGlobal() {
  try {
    const [health, status, ai, system] = await Promise.all([
      api("/api/health"),
      api("/api/status"),
      api("/api/ai/status"),
      api("/api/system").catch(() => null),
    ]);
    State.health = health;
    State.sessions = status.sessions || [];
    State.aiStatus = ai;
    State.system = system;
    detectAttention(State.sessions);
    renderSidebar();
    if (currentRoute().name === "sessions") renderSessions();
    if (currentRoute().name === "terminal") refreshTerminalList();
  } catch (error) {
    renderSidebar({ error: error.message });
  }
}

function detectAttention(sessions) {
  for (const s of sessions) {
    const last = State.seenHashes[s.name];
    if (s.state === "waiting_for_input" && last !== s.outputHash) {
      if (State.notifySound) beep();
      State.seenHashes[s.name] = s.outputHash;
      persist();
    } else if (s.state !== "waiting_for_input") {
      // keep last hash
    }
  }
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

function renderSidebar(extra = {}) {
  const sessions = State.sessions;
  const waiting = sessions.filter((s) => s.state === "waiting_for_input").length;
  const sessionBadge = $('[data-badge="sessions"]');
  sessionBadge.textContent = String(sessions.length);
  sessionBadge.classList.toggle("hot", waiting > 0);

  const projectsBadge = $('[data-badge="projects"]');
  if (State.projects.length) projectsBadge.textContent = String(State.projects.length);

  const aiBadge = $('[data-badge="ai-on"]');
  aiBadge.textContent = State.aiStatus.enabled ? "on" : "off";
  aiBadge.classList.toggle("accent", State.aiStatus.enabled);

  const dot = $("#health-dot");
  const healthText = $("#health-text");
  if (extra.error) {
    dot.className = "dot bad";
    healthText.textContent = "offline";
  } else if (State.health?.ok) {
    dot.className = "dot on";
    healthText.textContent = `${State.health.hostname} · ${new Date(State.health.time).toLocaleTimeString()}`;
  } else {
    dot.className = "dot warn";
    healthText.textContent = "connecting…";
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
route("sessions", {
  title: "Sessions",
  async render(root) {
    root.innerHTML = `
      <div class="sessions-hero">
        <div class="hero-left">
          <h1>Sessions</h1>
          <p class="hero-sub" id="hero-sub">—</p>
        </div>
        <div class="stat-row" id="state-stats"></div>
        <div class="hero-actions">
          <div class="chip-row" id="filters">
            <button class="chip ${State.filter==='all'?'active':''}" data-filter="all">All</button>
            <button class="chip ${State.filter==='waiting_for_input'?'active':''}" data-filter="waiting_for_input">Needs input</button>
            <button class="chip ${State.filter==='running'?'active':''}" data-filter="running">Running</button>
            <button class="chip ${State.filter==='error'?'active':''}" data-filter="error">Errors</button>
            <button class="chip ${State.filter==='claude'?'active':''}" data-filter="claude">Claude</button>
            <button class="chip ${State.filter==='codex'?'active':''}" data-filter="codex">Codex</button>
          </div>
          <button class="btn btn-primary" id="new-session-btn">+ New session</button>
        </div>
      </div>
      <div id="sessions-grid" class="grid"></div>
    `;
    $("#filters").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-filter]");
      if (!btn) return;
      State.filter = btn.dataset.filter;
      renderSessions();
    });
    $("#new-session-btn").addEventListener("click", () => openNewSessionModal());
    renderSessions();
  },
});

function renderSessions() {
  const grid = $("#sessions-grid");
  if (!grid) return;
  const sessions = State.sessions;
  const counts = {
    waiting_for_input: 0, running: 0, error: 0, idle: 0, unknown: 0,
  };
  for (const s of sessions) counts[s.state] = (counts[s.state] || 0) + 1;

  const hsub = $("#hero-sub");
  if (hsub) hsub.textContent = `${sessions.length} tmux session${sessions.length === 1 ? "" : "s"} across ${new Set(sessions.map(s => s.paneCurrentPath)).size} director${new Set(sessions.map(s => s.paneCurrentPath)).size === 1 ? "y" : "ies"}`;

  const stats = $("#state-stats");
  if (stats) {
    stats.innerHTML = [
      ["waiting_for_input", counts.waiting_for_input, "Needs input"],
      ["running", counts.running, "Running"],
      ["error", counts.error, "Errors"],
      ["idle", counts.idle, "Idle"],
    ].map(([cls, n, label]) => `
      <div class="stat-card ${cls} ${n ? "" : "muted"}">
        <span class="stat-num">${n}</span>
        <span class="stat-lab">${label}</span>
      </div>
    `).join("");
  }

  const visible = sessions
    .filter((s) => {
      if (State.filter === "all") return true;
      if (["waiting_for_input", "running", "error", "idle", "unknown"].includes(State.filter)) return s.state === State.filter;
      return s.agent === State.filter;
    })
    .slice()
    .sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.name.localeCompare(b.name));

  if (!visible.length) {
    grid.innerHTML = `<div class="empty"><h3>No matching sessions</h3><p>Adjust the filter, or hit <b>+ New session</b>.</p></div>`;
    return;
  }
  grid.innerHTML = visible.map(renderSessionCard).join("");

  $$(".session-card .stop-btn").forEach((btn) =>
    btn.addEventListener("click", () => stopSession(btn.dataset.session))
  );
  $$(".session-card .quick-input").forEach((form) =>
    form.addEventListener("submit", (e) => quickSend(e))
  );
  $$(".session-card .open-terminal").forEach((btn) =>
    btn.addEventListener("click", () => {
      State.selectedSession = btn.dataset.session;
      persist();
      location.hash = `#terminal/${encodeURIComponent(btn.dataset.session)}`;
    })
  );
  $$(".session-card .copy-output").forEach((btn) =>
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(btn.dataset.output || "");
      toast("Copied last output", "ok");
    })
  );
}

function stateRank(state) {
  return { waiting_for_input: 0, error: 1, running: 2, idle: 3, unknown: 4 }[state] ?? 5;
}

function renderSessionCard(s) {
  const branch = s.git?.branch || "—";
  const lastOutput = (s.lastOutput || "").trim();
  const tail = lastOutput.slice(-1400);
  const attention = s.state === "waiting_for_input" ? "attention" : s.state === "error" ? "alert" : "";
  const repoName = (s.paneCurrentPath || "").split("/").filter(Boolean).pop() || "—";
  const dirtyChip = s.git?.dirty
    ? `<span class="meta-chip warn">dirty${s.git.unstagedCount ? ` · ${s.git.unstagedCount}` : ""}${s.git.stagedCount ? ` · ${s.git.stagedCount} staged` : ""}</span>`
    : (s.git?.branch ? `<span class="meta-chip ok">clean</span>` : "");
  return `
    <article class="session-card ${attention}" data-state="${s.state}">
      <div class="card-top">
        <div class="card-title">
          <span class="dot ${s.state === 'running' ? 'on' : s.state === 'waiting_for_input' ? 'warn' : s.state === 'error' ? 'bad' : ''}"></span>
          <h3>${escapeHtml(s.name)}</h3>
          <span class="badge ${s.agent}">${escapeHtml(s.agent)}</span>
        </div>
        <span class="badge ${s.state}">${stateLabels[s.state] || s.state}</span>
      </div>
      <div class="card-sub">
        <span class="meta-chip">${escapeHtml(repoName)}</span>
        <span class="meta-chip">${escapeHtml(branch)}</span>
        ${dirtyChip}
        <span class="meta-chip muted" title="pane command">${escapeHtml(s.paneCommand || "?")}</span>
      </div>
      <div class="card-path" title="${escapeHtml(s.paneCurrentPath || "")}">${escapeHtml(s.paneCurrentPath || "")}</div>
      <pre class="preview">${escapeHtml(tail || "(no recent output)")}</pre>
      <form class="quick-input" data-session="${escapeHtml(s.name)}">
        <input name="text" placeholder="Reply to ${escapeHtml(s.name)} and press ↵" autocomplete="off" />
        <button type="submit" class="btn btn-primary" title="Send + Enter">↵</button>
      </form>
      <div class="actions">
        <button class="btn open-terminal" data-session="${escapeHtml(s.name)}" title="Open xterm.js terminal"><span class="i">▣</span> Terminal</button>
        <button class="btn copy-output" data-output="${escapeHtml(lastOutput)}" title="Copy last pane output"><span class="i">⧉</span></button>
        <button class="btn btn-danger stop-btn" data-session="${escapeHtml(s.name)}" title="tmux kill-session">Stop</button>
      </div>
    </article>
  `;
}

async function quickSend(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const session = form.dataset.session;
  const text = form.elements.text.value.trim();
  if (!text) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(session)}/input`, {
      method: "POST",
      body: JSON.stringify({ text, submit: true }),
    });
    form.reset();
    toast(`Sent to ${session}`, "ok");
    refreshGlobal();
  } catch (error) {
    toast(`Send failed: ${error.message}`, "error");
  }
}

async function stopSession(session) {
  if (!confirm(`Stop tmux session "${session}"?`)) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(session)}`, { method: "DELETE" });
    toast(`Stopped ${session}`, "ok");
    refreshGlobal();
  } catch (error) {
    toast(`Stop failed: ${error.message}`, "error");
  }
}

function openNewSessionModal(prefill = {}) {
  const modal = h(`
    <div class="palette" id="modal">
      <div class="palette-card" style="width: min(440px,92vw); padding: 18px;">
        <h3 style="margin: 0 0 12px;">New tmux session</h3>
        <form id="new-session-form" style="display:flex; flex-direction:column; gap:10px;">
          <label>Name<input name="name" required pattern="[A-Za-z0-9_.:-]+" value="${escapeHtml(prefill.name || "")}" placeholder="codex-feature-x" /></label>
          <label>Agent
            <select name="agent">
              <option value="claude" ${prefill.agent==="claude"?"selected":""}>Claude</option>
              <option value="codex" ${prefill.agent!=="claude"?"selected":""}>Codex</option>
            </select>
          </label>
          <label>Directory<input name="directory" required value="${escapeHtml(prefill.directory || "/home/ubuntu/work/repos/Pilot")}" /></label>
          <div class="btn-row" style="justify-content:flex-end;">
            <button type="button" class="btn btn-ghost" id="modal-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>
  `);
  document.body.appendChild(modal);
  const close = () => modal.remove();
  $("#modal-cancel", modal).addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  $("#new-session-form", modal).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          name: f.elements.name.value.trim(),
          agent: f.elements.agent.value,
          directory: f.elements.directory.value.trim(),
        }),
      });
      toast(`Created ${f.elements.name.value}`, "ok");
      close();
      State.selectedSession = f.elements.name.value;
      persist();
      refreshGlobal();
    } catch (error) {
      toast(`Create failed: ${error.message}`, "error");
    }
  });
}

// ─── Terminal page ────────────────────────────────────────────────────────
let terminalState = null; // { term, fit, ws, session }

route("terminal", {
  title: "Terminal",
  async render(root, args) {
    if (args[0]) State.selectedSession = decodeURIComponent(args[0]);
    root.innerHTML = `
      <div class="terminal-page">
        <div class="panel session-list-panel">
          <div class="panel-header"><h2>Sessions</h2><span class="spacer"></span>
            <button class="btn btn-ghost" id="term-new">+ new</button>
          </div>
          <div id="term-session-list"></div>
        </div>
        <div class="terminal-wrap">
          <div class="terminal-bar">
            <div class="left">
              <span class="term-status warn" id="term-status">connecting…</span>
              <strong id="term-title">${escapeHtml(State.selectedSession || "—")}</strong>
              <span class="badge" id="term-sub" style="font-size:10.5px;"></span>
            </div>
            <div class="right">
              <button class="quick-key" data-key="Escape">Esc</button>
              <button class="quick-key" data-key="Tab">Tab</button>
              <button class="quick-key" data-key="Up">↑</button>
              <button class="quick-key" data-key="Down">↓</button>
              <button class="quick-key" data-key="C-c">Ctrl-C</button>
              <button class="quick-key" data-key="C-d">Ctrl-D</button>
              <button class="quick-key" data-key="Enter">⏎</button>
              <button class="btn btn-ghost" id="term-detach">↗ pop-out</button>
            </div>
          </div>
          <div class="terminal-host" id="term-host"></div>
          <form class="term-input-row" id="term-input-row">
            <input id="term-input" placeholder="Type to this session…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" />
            <button type="submit" class="btn btn-primary" title="Send Enter">↵</button>
          </form>
        </div>
      </div>
    `;
    refreshTerminalList();
    $("#term-new").addEventListener("click", () => openNewSessionModal());
    $("#term-detach").addEventListener("click", () => {
      const s = State.selectedSession;
      if (s) window.open(`#terminal/${encodeURIComponent(s)}`, "_blank", "width=1000,height=700");
    });
    $$(".quick-key").forEach((b) => b.addEventListener("click", () => { sendKey(b.dataset.key); $("#term-input")?.focus(); }));
    // Tap the screen to focus xterm on desktop/tablet; the input row drives phones.
    $("#term-host").addEventListener("click", () => { try { terminalState?.term?.focus(); } catch {/* */} });
    wireTerminalInput();
    bootTerminal();
  },
});

// A plain text input that types straight into the tmux session over the
// WebSocket. xterm's own hidden textarea is unreliable on phones (keyboard
// won't open, IME conflicts), so this is the dependable path to type on mobile —
// and a handy composer on desktop too.
function wireTerminalInput() {
  const input = $("#term-input");
  const row = $("#term-input-row");
  if (!input || !row) return;
  let last = "";
  const sendData = (data) => {
    const ws = terminalState?.ws;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    if (!terminalState.canWrite) { toast("Read-only. Save AGENT_OPS_TOKEN in Settings to type.", "error"); return false; }
    ws.send(JSON.stringify({ type: "data", data }));
    return true;
  };
  // Send characters as they're typed so TUIs (Claude Code, prompts) update live.
  input.addEventListener("input", () => {
    const v = input.value;
    if (v.startsWith(last)) sendData(v.slice(last.length));
    else if (last.startsWith(v)) { for (let i = 0; i < last.length - v.length; i++) sendData("\x7f"); }
    else { for (let i = 0; i < last.length; i++) sendData("\x7f"); sendData(v); }
    last = v;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendData("\r"); input.value = ""; last = ""; }
  });
  row.addEventListener("submit", (e) => {
    e.preventDefault();
    sendData("\r");
    input.value = ""; last = "";
    input.focus();
  });
}

function refreshTerminalList() {
  const list = $("#term-session-list");
  if (!list) return;
  if (!State.sessions.length) {
    list.innerHTML = `<div class="empty" style="padding:30px 12px;">No tmux sessions.</div>`;
    return;
  }
  list.innerHTML = State.sessions.map((s) => `
    <button class="session-pick ${s.name===State.selectedSession?'active':''}" data-session="${escapeHtml(s.name)}">
      <div class="row">
        <strong>${escapeHtml(s.name)}</strong>
        <span class="badge ${s.state}" style="font-size:10px;">${stateLabels[s.state]||s.state}</span>
      </div>
      <div class="row">
        <small>${escapeHtml(s.agent)}</small>
        <small>${escapeHtml(s.git?.branch || "")}</small>
      </div>
    </button>
  `).join("");
  $$(".session-pick").forEach((b) => b.addEventListener("click", () => {
    State.selectedSession = b.dataset.session;
    persist();
    location.hash = `#terminal/${encodeURIComponent(b.dataset.session)}`;
  }));
}

function bootTerminal() {
  const host = $("#term-host");
  if (!host) return;
  const session = State.selectedSession;
  if (!session) {
    host.innerHTML = `<div class="empty"><h3>Pick a session</h3><p>Choose one from the list.</p></div>`;
    return;
  }
  $("#term-title").textContent = session;
  const meta = State.sessions.find((s) => s.name === session);
  $("#term-sub").textContent = meta ? `${meta.agent} · ${meta.git?.branch || ""}` : "";

  if (terminalState) {
    clearTimeout(terminalState.reconnectTimer);
    try { terminalState.ro?.disconnect(); } catch {/* */}
    try { terminalState.ws?.close(); } catch {/* */}
    try { terminalState.term?.dispose(); } catch {/* */}
    terminalState = null;
  }

  const term = new window.Terminal({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    convertEol: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: "#000000",
      foreground: "#e6edf3",
      cursor: "#50e3c2",
      cursorAccent: "#0a0d12",
      selectionBackground: "rgba(124,142,255,0.35)",
      black: "#0a0d12", red: "#ff6b81", green: "#50e3c2", yellow: "#f6b86b",
      blue: "#7c8eff", magenta: "#c792ea", cyan: "#5cdcff", white: "#e6edf3",
      brightBlack: "#6b7382", brightRed: "#ff8aa2", brightGreen: "#7af0d2",
      brightYellow: "#ffd089", brightBlue: "#a3b1ff", brightMagenta: "#dab3f3",
      brightCyan: "#88e7ff", brightWhite: "#ffffff",
    },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new window.WebLinksAddon.WebLinksAddon()); } catch {/* */}
  try { term.loadAddon(new window.Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = "11"; } catch {/* */}
  try { terminalState ??= {}; terminalState.search = new window.SearchAddon.SearchAddon(); term.loadAddon(terminalState.search); } catch {/* */}

  term.open(host);
  fit.fit();

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const tokenParam = State.writeToken ? `&token=${encodeURIComponent(State.writeToken)}` : "";
  const ws = new WebSocket(`${proto}://${location.host}/ws/terminal?session=${encodeURIComponent(session)}${tokenParam}`);
  terminalState = { term, fit, ws, session, search: terminalState?.search, canWrite: false, reconnectAt: 0 };

  const setStatus = (text, cls) => {
    const el = $("#term-status");
    if (el) { el.textContent = text; el.className = `term-status ${cls || ""}`; }
  };
  setStatus("connecting…", "warn");

  ws.onopen = () => {
    setStatus("live", "on");
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    if (payload.type === "ready") {
      terminalState.canWrite = payload.canWrite;
      setStatus(payload.canWrite ? "live" : "read-only", payload.canWrite ? "on" : "warn");
      const input = $("#term-input");
      if (input) {
        input.disabled = !payload.canWrite;
        input.placeholder = payload.canWrite ? "Type to this session…" : "Read-only — save token in Settings";
      }
      return;
    }
    if (payload.type === "snapshot") {
      // Repaint the visible screen in place, wrapped in a DEC 2026 synchronized
      // update so the terminal shows the whole frame at once (no flicker), then
      // restore the real cursor position from tmux.
      const cursor = payload.cursor || { x: 0, y: 0 };
      const lines = payload.output.split("\n");
      let frame = "\x1b[?2026h\x1b[H\x1b[2J\x1b[3J";
      frame += lines.join("\r\n");
      frame += `\x1b[${cursor.y + 1};${cursor.x + 1}H`;
      frame += "\x1b[?2026l";
      term.write(frame);
    } else if (payload.type === "error") {
      toast(payload.message, "error");
    }
  };
  ws.onclose = () => {
    setStatus("disconnected", "bad");
    // Auto-reconnect while the terminal page is still showing this session, so a
    // phone waking from sleep reattaches without a manual refresh.
    if (terminalState && terminalState.ws === ws && currentRoute().name === "terminal" && State.selectedSession === session) {
      clearTimeout(terminalState.reconnectTimer);
      terminalState.reconnectTimer = setTimeout(() => {
        if (currentRoute().name === "terminal" && State.selectedSession === session) bootTerminal();
      }, 1200);
    }
  };
  term.onData((data) => {
    if (ws.readyState !== ws.OPEN) return;
    if (!terminalState.canWrite) {
      toast("Read-only. Save AGENT_OPS_TOKEN in Settings to type.", "error");
      return;
    }
    ws.send(JSON.stringify({ type: "data", data }));
  });
  const ro = new ResizeObserver(() => {
    try { fit.fit(); if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })); } catch {/* */}
  });
  ro.observe(host);
  terminalState.ro = ro;
}

async function sendKey(key) {
  if (!State.selectedSession) return;
  if (key === "Backspace" || key === "BSpace") key = "Backspace";
  try {
    await api(`/api/sessions/${encodeURIComponent(State.selectedSession)}/key`, {
      method: "POST",
      body: JSON.stringify({ key }),
    });
  } catch (error) {
    toast(`Key failed: ${error.message}`, "error");
  }
}

// ─── Projects page ────────────────────────────────────────────────────────
route("projects", {
  title: "Projects",
  async render(root) {
    root.innerHTML = `
      <div class="page-head">
        <h1>Projects</h1>
        <div class="sub">Repos under /home/ubuntu/work/repos and /home/ubuntu/apps</div>
        <div class="toolbar">
          <button class="btn" id="projects-refresh">Refresh</button>
        </div>
      </div>
      <div id="projects-content">${spinnerHTML()}</div>
    `;
    $("#projects-refresh").addEventListener("click", loadProjects);
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
      wrap.innerHTML = `<div class="empty"><h3>No projects discovered</h3></div>`;
      return;
    }
    const groups = {};
    for (const p of projects) {
      (groups[p.group] ||= []).push(p);
    }
    wrap.innerHTML = Object.entries(groups).map(([group, items]) => `
      <div class="section-divider">${escapeHtml(group)}</div>
      <div class="panel">
        ${items.map(renderProjectRow).join("")}
      </div>
    `).join("");
    $$(".project-spawn").forEach((b) =>
      b.addEventListener("click", () => openNewSessionModal({
        directory: b.dataset.dir,
        agent: b.dataset.agent,
        name: defaultSessionName(b.dataset.agent, b.dataset.dir),
      }))
    );
    $$(".project-jump").forEach((b) =>
      b.addEventListener("click", () => {
        State.selectedSession = b.dataset.session;
        persist();
        location.hash = `#terminal/${encodeURIComponent(b.dataset.session)}`;
      })
    );
  } catch (error) {
    wrap.innerHTML = `<div class="empty"><h3>Failed</h3><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function defaultSessionName(agent, dir) {
  const base = dir.split("/").filter(Boolean).pop() || "session";
  const stamp = String(Date.now()).slice(-4);
  return `${agent}-${base.toLowerCase().replace(/[^a-z0-9]/g, "")}-${stamp}`;
}

function renderProjectRow(p) {
  const sessions = (p.sessions || []).map((s) => `
    <button class="badge ${s.agent} project-jump" data-session="${escapeHtml(s.name)}" title="Open terminal">${escapeHtml(s.name)}</button>
  `).join("");
  return `
    <div class="project-row">
      <div>
        <div class="name">
          ${escapeHtml(p.name)}
          ${p.isGitRepo ? `<span class="badge">${escapeHtml(p.git.branch)}</span>` : ""}
          ${p.git?.dirty ? `<span class="badge waiting_for_input" style="animation:none;">dirty</span>` : (p.isGitRepo ? `<span class="badge running">clean</span>` : "")}
        </div>
        <div class="path">${escapeHtml(p.path)}</div>
        <div class="meta">
          ${p.hasClaudeSettings ? `<span>● .claude</span>` : ""}
          ${p.hasCodexConfig ? `<span>● .codex</span>` : ""}
          ${p.hasReadme ? `<span>● README</span>` : ""}
          ${p.lastModified ? `<span>${relTime(p.lastModified)}</span>` : ""}
        </div>
        ${sessions ? `<div class="sessions-on">${sessions}</div>` : ""}
      </div>
      <div class="actions">
        <button class="btn project-spawn" data-dir="${escapeHtml(p.path)}" data-agent="claude">+ Claude</button>
        <button class="btn project-spawn" data-dir="${escapeHtml(p.path)}" data-agent="codex">+ Codex</button>
      </div>
    </div>
  `;
}

// ─── Events page ──────────────────────────────────────────────────────────
route("events", {
  title: "Events",
  async render(root) {
    root.innerHTML = `
      <div class="page-head">
        <h1>Event log</h1>
        <div class="sub">Hook + monitor events</div>
        <div class="toolbar">
          <button class="btn" id="events-refresh">Refresh</button>
        </div>
      </div>
      <div class="panel" id="events-panel">${spinnerHTML()}</div>
    `;
    $("#events-refresh").addEventListener("click", loadEvents);
    loadEvents();
    startEventStream();
  },
});

async function loadEvents() {
  const panel = $("#events-panel");
  if (!panel) return;
  try {
    const { events } = await api("/api/events?limit=100");
    State.events = events;
    renderEvents();
  } catch (error) {
    panel.innerHTML = `<div class="empty"><h3>Failed</h3><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderEvents() {
  const panel = $("#events-panel");
  if (!panel) return;
  if (!State.events.length) {
    panel.innerHTML = `<div class="empty"><h3>No events yet</h3><p>Hooks and the tmux monitor will appear here.</p></div>`;
    return;
  }
  panel.innerHTML = State.events.map((e) => `
    <div class="event-row">
      <span class="ts">${relTime(e.createdAt)}</span>
      <span class="type-tag ${e.type}">${escapeHtml(e.type)}</span>
      <span class="msg"><span class="agent-tag">${escapeHtml(e.agent)}</span> ${escapeHtml(e.message)}</span>
      <span class="ts">${new Date(e.createdAt + "Z").toLocaleString()}</span>
    </div>
  `).join("");
}

let eventSource = null;
function startEventStream() {
  if (eventSource) return;
  try {
    eventSource = new EventSource(`/api/events/stream?since=${State.events[0]?.id || 0}`);
    eventSource.addEventListener("event", (ev) => {
      try {
        const e = JSON.parse(ev.data);
        if (State.events[0]?.id === e.id) return;
        State.events = [e, ...State.events].slice(0, 200);
        if (currentRoute().name === "events") renderEvents();
        if (e.type === "approval_required") toast(`${e.agent}: ${e.message.slice(0, 80)}`, "");
      } catch {/* ignore */}
    });
  } catch {/* */}
}

// ─── AI page ──────────────────────────────────────────────────────────────
route("ai", {
  title: "AI",
  async render(root) {
    // Ensure provider/model is known before drawing the header (avoids a flash
    // of "…KEY not set" when the page opens before global status has loaded).
    try { State.aiStatus = await api("/api/ai/status"); } catch {/* keep cached */}
    root.innerHTML = `
      <div class="page-head">
        <h1>AI assistant</h1>
        <div class="sub">${State.aiStatus.enabled ? escapeHtml((State.aiStatus.provider === "openai" ? "OpenAI · " : "Anthropic · ") + State.aiStatus.model) : escapeHtml((State.aiStatus.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY") + " not set")}</div>
        <div class="toolbar">
          <button class="btn" id="ai-new">+ new chat</button>
        </div>
      </div>
      <div class="ai-page">
        <div class="panel ai-side ai-conv-side">
          <div class="panel-header"><h2>Conversations</h2></div>
          <div id="ai-conv-list">${spinnerHTML()}</div>
        </div>
        <div class="ai-conv">
          <div class="ai-stream" id="ai-stream"><div class="empty"><h3>Agentic operator for this box</h3><p>It can run shell commands, read/write files, search the web, and drive your other tmux agents. Try “what’s eating disk in ~/work?”, “tail the agent-ops logs and tell me if anything’s wrong”, or “check what claude-pilot-1 is stuck on and unblock it”. <code>/remember</code> saves a note; <code>/help</code> lists commands.</p></div></div>
          <form class="ai-composer" id="ai-composer">
            <textarea name="message" placeholder="Ask or tell the agent to do something · ⌘↩ to send" required></textarea>
            <button class="btn btn-primary" type="submit">Send</button>
          </form>
        </div>
        <div class="panel ai-side ai-memory-side">
          <div class="panel-header"><h2>Memory</h2><span class="spacer"></span><button class="btn btn-ghost" id="mem-add">+ note</button></div>
          <div style="padding: 8px 8px 0;"><input id="mem-search" placeholder="Search memories…" autocomplete="off" /></div>
          <div id="ai-mem-list" style="padding: 8px;">${spinnerHTML()}</div>
        </div>
      </div>
    `;
    $("#ai-new").addEventListener("click", () => newAIConversation());
    $("#mem-add").addEventListener("click", () => addMemoryPrompt());
    $("#ai-composer").addEventListener("submit", aiSubmit);
    $("#ai-composer textarea")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        $("#ai-composer").dispatchEvent(new Event("submit", { cancelable: true }));
      }
    });
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
    $("#ai-conv-list").innerHTML = `<div class="empty"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderConvList() {
  const list = $("#ai-conv-list");
  if (!list) return;
  if (!State.conversations.length) {
    list.innerHTML = `<div class="empty" style="padding: 20px 12px;"><p>No chats yet</p></div>`;
    return;
  }
  list.innerHTML = State.conversations.map((c) => `
    <div class="ai-conv-row ${c.id===State.currentConv?.id?'active':''}" data-id="${escapeHtml(c.id)}">
      <span class="title">${escapeHtml(c.title)}</span>
      <span class="ts">${relTime(c.updatedAt)}</span>
    </div>
  `).join("");
  $$(".ai-conv-row").forEach((row) => row.addEventListener("click", () => selectConversation(row.dataset.id)));
}

async function selectConversation(id) {
  try {
    const { conversation } = await api(`/api/ai/conversations/${id}`);
    State.currentConv = conversation;
    renderConvList();
    renderStream(conversation);
  } catch (error) {
    toast(`Load failed: ${error.message}`, "error");
  }
}

function renderStream(conv) {
  const stream = $("#ai-stream");
  if (!stream) return;
  if (!conv || !conv.turns.length) {
    stream.innerHTML = `<div class="empty"><h3>Empty conversation</h3><p>Say something.</p></div>`;
    return;
  }
  stream.innerHTML = itemsFromTurns(conv.turns).map(renderItem).join("");
  stream.scrollTop = stream.scrollHeight;
}

// Flatten stored turns (strings or content-block arrays) into a linear list of
// display items: user/assistant text bubbles and tool cards. tool_result blocks
// live in a later user turn, so we match them back to their tool_use by id.
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
      // Neutral persisted shape (provider-independent).
      if (block.type === "text" && block.text) {
        items.push({ kind: "text", role: turn.role, text: block.text });
      } else if (block.type === "tool") {
        items.push({ kind: "tool", id: block.id, name: block.name, input: block.input, output: block.output || "", done: true, isError: Boolean(block.isError) });
      // Legacy Anthropic-block shape from earlier saved conversations.
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
  bash: "⌘", read_file: "◇", write_file: "✎", list_sessions: "▤",
  capture_session: "▣", send_session: "➤", web_search: "⌕",
};

function toolCardHTML(item) {
  const icon = toolIcons[item.name] || "•";
  const label = toolLabel(item);
  const status = !item.done ? "running" : item.isError ? "error" : "done";
  const statusText = !item.done ? "running…" : item.isError ? "error" : "done";
  const output = (item.output || "").trim();
  const body = output ? `<pre class="tool-output">${escapeHtml(output.slice(-6000))}</pre>` : "";
  return `
    <div class="tool-card ${status}" data-tool="${escapeHtml(item.id)}">
      <div class="tool-head">
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${escapeHtml(item.name)}</span>
        <span class="tool-label">${escapeHtml(label)}</span>
        <span class="tool-status ${status}">${statusText}</span>
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
  // Minimal markdown-ish: fenced code, inline code, bold, headings, links.
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
  // Clear the empty-state placeholder on the first message.
  if (stream.querySelector(".empty")) stream.innerHTML = "";
  stream.insertAdjacentHTML("beforeend", `<div class="ai-turn user"><div class="role">you</div><div class="body">${renderMarkdownish(message)}</div></div>`);

  // Live agent output: a growing assistant text node plus one card per tool.
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
    // Next assistant text after a tool goes into a fresh node below the card.
    textNode = null;
    return cards[id];
  };
  const refreshCard = (id) => {
    const entry = cards[id];
    if (!entry) return;
    const fresh = h(toolCardHTML(entry.item));
    entry.node.replaceWith(fresh);
    entry.node = fresh;
  };

  const headers = { "content-type": "application/json" };
  if (State.writeToken) headers.authorization = `Bearer ${State.writeToken}`;
  const res = await fetch("/api/ai/ask", {
    method: "POST",
    headers,
    body: JSON.stringify({ message, conversationId: conv.id }),
  });
  if (res.status === 401) {
    agentBlock.remove();
    const t = await promptToken();
    if (t) { State.writeToken = t; localStorage.setItem("agentOpsToken", t); aiSubmit(e); }
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
      if (entry) { entry.item.output += payload.chunk; refreshCard(payload.id); }
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
      // Server tools (web_search) never send a tool_result; settle their cards.
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
    const head = $(".page-head .sub");
    if (!head) return;
    el = h(`<span id="ai-usage" class="ai-usage"></span>`);
    head.appendChild(el);
  }
  const total = (updateUsage.total = (updateUsage.total || 0) + (u.output || 0));
  el.textContent = ` · ${total} out tok`;
}

async function loadMemories(q = "") {
  try {
    const path = q ? `/api/ai/memories?q=${encodeURIComponent(q)}` : "/api/ai/memories";
    const { memories } = await api(path);
    State.memories = memories;
    renderMemories();
  } catch (error) {
    $("#ai-mem-list").innerHTML = `<div class="empty"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderMemories() {
  const list = $("#ai-mem-list");
  if (!list) return;
  if (!State.memories.length) {
    list.innerHTML = `<div class="empty" style="padding: 20px 8px;"><p>No memories yet</p></div>`;
    return;
  }
  list.innerHTML = State.memories.map((m) => `
    <div class="memory-card" data-id="${escapeHtml(m.id)}">
      <div class="row"><span class="topic">${escapeHtml(m.topic)}</span>
        <button class="btn btn-ghost mem-del" data-id="${escapeHtml(m.id)}" title="Delete">×</button>
      </div>
      <div class="body">${escapeHtml(m.body)}</div>
      ${m.tags?.length ? `<div class="tags">${m.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    </div>
  `).join("");
  $$(".mem-del").forEach((btn) => btn.addEventListener("click", async () => {
    if (!confirm("Delete this memory?")) return;
    try {
      await api(`/api/ai/memories/${btn.dataset.id}`, { method: "DELETE" });
      loadMemories();
    } catch (error) {
      toast(error.message, "error");
    }
  }));
}

async function addMemoryPrompt() {
  const topic = prompt("Memory topic (1-line)");
  if (!topic) return;
  const body = prompt("Memory body");
  if (!body) return;
  const tagsRaw = prompt("Tags (comma-separated, optional)") || "";
  try {
    await api("/api/ai/memories", {
      method: "POST",
      body: JSON.stringify({
        topic: topic.slice(0, 200),
        body: body.slice(0, 8000),
        tags: tagsRaw.split(",").map((s) => s.trim()).filter(Boolean),
      }),
    });
    loadMemories();
    toast("Saved memory", "ok");
  } catch (error) {
    toast(error.message, "error");
  }
}

// ─── Settings page ────────────────────────────────────────────────────────
route("settings", {
  title: "Settings",
  async render(root) {
    const allowsInput = State.health?.agentInputEnabled;
    root.innerHTML = `
      <div class="page-head">
        <h1>Settings</h1>
      </div>
      <div class="settings-grid">
        <div class="panel">
          <div class="panel-header"><h2>Server</h2></div>
          <div class="panel-pad">
            <div class="kv"><span>Host</span><b>${escapeHtml(State.health?.hostname || "—")}</b></div>
            <div class="kv"><span>App</span><b>${escapeHtml(State.health?.app || "agent-ops")}</b></div>
            <div class="kv"><span>AI enabled</span><b>${State.aiStatus.enabled ? "yes" : "no — set ANTHROPIC_API_KEY"}</b></div>
            <div class="kv"><span>Agent input</span><b>${allowsInput ? "enabled" : "disabled — set ENABLE_AGENT_INPUT=true"}</b></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header"><h2>Auth</h2></div>
          <div class="panel-pad">
            <label>AGENT_OPS_TOKEN (used for write requests from this browser)
              <input id="token-input" type="password" placeholder="paste token" value="${escapeHtml(State.writeToken)}" />
            </label>
            <div class="btn-row" style="margin-top:8px;">
              <button class="btn btn-primary" id="save-token">Save</button>
              <button class="btn btn-ghost" id="clear-token">Clear</button>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header"><h2>Notifications</h2></div>
          <div class="panel-pad">
            <label style="flex-direction:row; align-items:center; gap:8px;">
              <input type="checkbox" id="notify-sound" ${State.notifySound ? "checked" : ""} style="width:auto;" />
              Beep on Needs-input transitions
            </label>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header"><h2>Shortcuts</h2></div>
          <div class="panel-pad">
            <div class="kv"><span>Sessions</span><b>g s</b></div>
            <div class="kv"><span>Terminal</span><b>g t</b></div>
            <div class="kv"><span>Projects</span><b>g p</b></div>
            <div class="kv"><span>AI</span><b>g a</b></div>
            <div class="kv"><span>Events</span><b>g e</b></div>
            <div class="kv"><span>Command palette</span><b>⌘K / Ctrl+K</b></div>
          </div>
        </div>
      </div>
    `;
    $("#save-token").addEventListener("click", () => {
      State.writeToken = $("#token-input").value.trim();
      localStorage.setItem("agentOpsToken", State.writeToken);
      toast("Token saved", "ok");
    });
    $("#clear-token").addEventListener("click", () => {
      State.writeToken = "";
      localStorage.removeItem("agentOpsToken");
      $("#token-input").value = "";
      toast("Token cleared", "ok");
    });
    $("#notify-sound").addEventListener("change", (e) => {
      State.notifySound = e.target.checked;
      localStorage.setItem("agentOpsNotifySound", String(State.notifySound));
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
    { kind: "page", label: "Projects", href: "#projects" },
    { kind: "page", label: "AI", href: "#ai" },
    { kind: "page", label: "Events", href: "#events" },
    { kind: "page", label: "Settings", href: "#settings" },
    { kind: "action", label: "New session…", action: () => openNewSessionModal() },
  ];
  for (const s of State.sessions) items.push({ kind: "session", label: s.name, href: `#terminal/${encodeURIComponent(s.name)}` });
  for (const p of State.projects) items.push({ kind: "project", label: p.name, action: () => openNewSessionModal({ directory: p.path, agent: "claude", name: defaultSessionName("claude", p.path) }) });
  return items;
}
function renderPalette(query) {
  const items = paletteItems().filter((i) => i.label.toLowerCase().includes(query.toLowerCase()));
  const list = $("#palette-list");
  list.innerHTML = items.slice(0, 30).map((i, idx) => `
    <li data-idx="${idx}" class="${idx===0?'active':''}"><span class="kind">${i.kind}</span><span>${escapeHtml(i.label)}</span></li>
  `).join("");
  list.dataset.items = JSON.stringify(items.slice(0, 30));
}
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
      if (item.action) item.action();
      closePalette();
      return;
    }
    $$("#palette-list li").forEach((li) => li.classList.toggle("active", Number(li.dataset.idx) === idx));
    return;
  }
  // gX combos
  if (gMode && Date.now() - gMode < 1200) {
    gMode = 0;
    const map = { s: "sessions", t: "terminal", p: "projects", a: "ai", e: "events" };
    const target = map[e.key.toLowerCase()];
    if (target) { e.preventDefault(); location.hash = `#${target}`; }
    return;
  }
  if (e.key === "g" && !e.target.matches("input, textarea")) gMode = Date.now();
});
let gMode = 0;
$("#palette-input").addEventListener("input", (e) => renderPalette(e.target.value));
$("#palette-list").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  const items = JSON.parse($("#palette-list").dataset.items || "[]");
  const item = items[Number(li.dataset.idx)];
  if (item?.href) location.hash = item.href;
  if (item?.action) item.action();
  closePalette();
});
$("#palette").addEventListener("click", (e) => { if (e.target === $("#palette")) closePalette(); });

// ─── Boot ─────────────────────────────────────────────────────────────────
function spinnerHTML() { return `<div class="empty"><div class="spinner"></div></div>`; }

$("#refresh").addEventListener("click", () => { refreshGlobal(); if (currentRoute().name === "projects") loadProjects(); if (currentRoute().name === "events") loadEvents(); });
$("#nav-toggle")?.addEventListener("click", () => document.body.classList.toggle("nav-open"));

// Some standalone PWA contexts (iOS, some Android browsers) swallow
// `<a href="#…">` navigation; force the hash update from JS so nav always works.
$$(".nav-item, .bottom-tabs a").forEach((a) => {
  a.addEventListener("click", (e) => {
    const href = a.getAttribute("href");
    if (!href || !href.startsWith("#")) return;
    e.preventDefault();
    if (location.hash === href) {
      // Same route — force a re-render.
      navigate();
    } else {
      location.hash = href;
    }
    document.body.classList.remove("nav-open");
  });
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// ─── iPhone / mobile keyboard handling ────────────────────────────────────
// iOS Safari (including PWA standalone) does not reflow the viewport when the
// on-screen keyboard appears. We mirror visualViewport into CSS vars so the
// layout can shrink and inputs can scroll into view above the keyboard.
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
  // Wait for the keyboard to appear before measuring.
  setTimeout(() => {
    try {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {/* */}
  }, 280);
});

refreshGlobal();
navigate();
setInterval(refreshGlobal, 5000);
