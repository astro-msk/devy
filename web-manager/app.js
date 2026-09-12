// Devy remote: the quick-actions companion to the full PWA in web/.
// One feed of tmux sessions. The ones that need you sort to the top and open
// with their last screen, the prompt, a key strip and a reply box in place.
// Vanilla JS, no build step, shares every /api route with the main app.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// Storage keys shared with the main PWA where the meaning is identical. Each
// origin (port) has its own localStorage, so the token is entered once per app.
const STORAGE = {
  token: "agentOpsToken",
  seen: "agentOpsSeen",
  filter: "agentOpsRemoteFilter"
};

const POLL_MS = 4000;
const POLL_MAX_MS = 60000;
const GATEWAY_TTL_MS = 15000;
const KEYS = ["Enter", "Escape", "Up", "Down", "Tab", "C-c", "Backspace", "C-d"];
const KEY_LABEL = { Escape: "Esc", Backspace: "⌫", Up: "↑", Down: "↓" };
const ARMED_KEYS = new Set(["C-d"]);
const QUICK_TEXT = ["y", "n", "1", "2", "3"];
const SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash"]);

const STATE_LABEL = {
  waiting_for_input: "needs you",
  running: "working",
  error: "error",
  idle: "idle",
  exited: "exited",
  shell: "shell",
  unknown: "unknown"
};
const STATE_RANK = { waiting_for_input: 0, error: 1, running: 2, idle: 3, exited: 4, shell: 5, unknown: 6 };

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null || value === "") localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* private mode or storage disabled: keep working in memory */
    }
  },
  json(key) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
};

const State = {
  sessions: [],
  health: null,
  gateway: { up: false, error: null, routes: [], order: {}, defaults: {}, assignments: {}, accounts: [], loadedAt: 0 },
  filter: storage.get(STORAGE.filter) || "all",
  token: storage.get(STORAGE.token) || "",
  seen: storage.json(STORAGE.seen),
  loaded: false,
  lastError: null,
  offline: navigator.onLine === false,
  open: new Set(),
  userClosed: new Set(),
  current: null,
  busy: new Set(),
  openRouteMenu: null,
  updateWorker: null
};

const el = {
  health: $("#health"),
  refresh: $("#refresh"),
  newSession: $("#new-session"),
  openToken: $("#open-token"),
  notices: $("#notices"),
  filters: $$(".filter"),
  feed: $("#feed"),
  template: $("#card-template"),
  createDialog: $("#create-dialog"),
  createForm: $("#create-form"),
  createError: $("#create-error"),
  routeHint: $("#route-hint"),
  tokenDialog: $("#token-dialog"),
  tokenForm: $("#token-form"),
  tokenInput: $("#token-input"),
  tokenMessage: $("#token-message"),
  tokenClear: $("#token-clear"),
  helpDialog: $("#help-dialog"),
  toasts: $("#toasts")
};

const isLocalhost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// ─── HTTP ─────────────────────────────────────────────────────────────────

async function api(url, options = {}) {
  const method = options.method || "GET";
  const headers = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (State.health?.authentication !== "cloudflare" && method !== "GET" && State.token) headers.authorization = `Bearer ${State.token}`;
  const init = { method, headers, cache: "no-store", body: options.body === undefined ? undefined : JSON.stringify(options.body) };

  let response = await fetch(url, init);
  if (response.status === 401 && State.health?.authentication === "cloudflare") {
    throw new Error("Your Cloudflare login has expired. Reload to sign in again.");
  }
  if (response.status === 401 && method !== "GET") {
    const token = await requestToken(
      State.token ? "The saved token was rejected. Enter the current AGENT_OPS_TOKEN." : "This action needs AGENT_OPS_TOKEN from the server's env file."
    );
    if (!token) throw new Error("write token required");
    headers.authorization = `Bearer ${token}`;
    response = await fetch(url, init);
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  if (response.status === 204) return null;
  return response.json();
}

async function errorMessage(response) {
  const body = await response.json().catch(() => null);
  const error = body?.error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    // zod's flatten(): { formErrors: [], fieldErrors: { field: [] } }
    const fields = Object.entries(error.fieldErrors || {}).map(([field, messages]) => `${field}: ${[].concat(messages).join(", ")}`);
    const text = [...(error.formErrors || []), ...fields].join("; ");
    if (text) return text;
  }
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
}

function describe(error) {
  if (error instanceof TypeError) return "server unreachable";
  return error.message || String(error);
}

// ─── Polling ──────────────────────────────────────────────────────────────
// One timer, one in-flight request. Failures back off up to a minute; a hidden
// tab stops polling and the next visibility/online/focus event refreshes.

const poll = { timer: null, inFlight: null, failures: 0, lastAt: 0, nextAt: 0 };
let soonTimer = null;

function schedule() {
  clearTimeout(poll.timer);
  poll.timer = null;
  if (document.hidden) return;
  const delay = poll.failures ? Math.min(POLL_MAX_MS, POLL_MS * 2 ** poll.failures) : POLL_MS;
  poll.nextAt = Date.now() + delay;
  poll.timer = setTimeout(() => refresh(), delay);
}

function refresh() {
  if (poll.inFlight) return poll.inFlight;
  clearTimeout(poll.timer);
  poll.timer = null;
  el.refresh.classList.add("busy");
  poll.inFlight = loadSessions().finally(() => {
    poll.inFlight = null;
    poll.lastAt = Date.now();
    el.refresh.classList.remove("busy");
    schedule();
  });
  return poll.inFlight;
}

// A quick follow-up poll after an action so the pane shows the effect without
// waiting for the regular tick.
function soon(delay = 700) {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => refresh(), delay);
}

async function loadSessions() {
  try {
    const [health, result] = await Promise.all([api("/api/health"), api("/api/sessions")]);
    State.health = health;
    el.openToken.hidden = health.authentication === "cloudflare";
    State.lastError = null;
    poll.failures = 0;
    const sessions = (result.sessions || []).map(decorate).sort(bySortOrder);
    applyAutoOpen(sessions);
    State.sessions = sessions;
    State.loaded = true;
    if (Date.now() - State.gateway.loadedAt > GATEWAY_TTL_MS) loadGateway();
  } catch (error) {
    poll.failures += 1;
    State.lastError = describe(error);
  }
  render();
}

async function loadGateway() {
  State.gateway.loadedAt = Date.now();
  try {
    const payload = await api("/api/gateway/state");
    const state = payload.state || {};
    State.gateway = {
      ...State.gateway,
      up: Boolean(payload.up),
      error: payload.error || null,
      routes: state.routes || [],
      order: state.order || {},
      defaults: state.defaults || {},
      assignments: state.assignments || {},
      accounts: payload.accounts || []
    };
  } catch (error) {
    State.gateway = { ...State.gateway, up: false, error: describe(error) };
  }
  renderFeed();
}

// A pane sitting at a shell prompt is an agent that exited (or never ran). A
// shell that is asking something still needs you, so waiting wins.
function decorate(session) {
  const shell = SHELLS.has(session.paneCommand) && session.state !== "waiting_for_input";
  const uiState = shell ? (session.agent === "unknown" ? "shell" : "exited") : session.state;
  return { ...session, uiState };
}

function bySortOrder(a, b) {
  return (STATE_RANK[a.uiState] ?? 9) - (STATE_RANK[b.uiState] ?? 9);
}

// A session that starts needing input opens itself; one the user collapsed
// stays collapsed until it stops waiting. First load opens whatever needs you,
// or the top card so the screen is never a wall of closed rows.
function applyAutoOpen(sessions) {
  const live = new Set(sessions.map((session) => session.name));
  for (const name of State.open) if (!live.has(name)) State.open.delete(name);
  for (const name of State.userClosed) if (!live.has(name)) State.userClosed.delete(name);
  for (const session of sessions) {
    const waiting = session.uiState === "waiting_for_input";
    if (!waiting) State.userClosed.delete(session.name);
    if (waiting && !State.userClosed.has(session.name)) State.open.add(session.name);
  }
  if (!State.loaded && sessions[0] && !State.open.size) State.open.add(sessions[0].name);
  if (!State.current || !live.has(State.current)) State.current = sessions[0]?.name || null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(poll.timer);
    poll.timer = null;
    return;
  }
  poll.failures = 0;
  refresh();
});
window.addEventListener("online", () => {
  State.offline = false;
  poll.failures = 0;
  renderNotices();
  refresh();
});
window.addEventListener("offline", () => {
  State.offline = true;
  renderNotices();
});
window.addEventListener("focus", () => {
  if (!poll.inFlight && Date.now() - poll.lastAt > POLL_MS) refresh();
});

// ─── Filters ──────────────────────────────────────────────────────────────

function visibleSessions() {
  return State.sessions.filter((session) => {
    if (State.filter === "all") return true;
    if (State.filter === "waiting_for_input") return session.uiState === "waiting_for_input";
    return session.agent === State.filter;
  });
}

function setFilter(filter) {
  State.filter = filter;
  storage.set(STORAGE.filter, filter);
  el.filters.forEach((button) => {
    const active = button.dataset.filter === filter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  render();
}

el.filters.forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.filter)));

function filterLabel() {
  return { claude: "Claude", codex: "Codex", waiting_for_input: "waiting" }[State.filter] || "";
}

// ─── Rendering ────────────────────────────────────────────────────────────

function render() {
  renderHealth();
  renderNotices();
  renderCounts();
  renderFeed();
}

function renderHealth() {
  if (State.lastError) {
    const wait = Math.max(0, Math.round((poll.nextAt - Date.now()) / 1000));
    // The feed's error card carries the reason on first load; once there is
    // stale data to show, the header names the problem instead.
    setText(el.health, State.loaded ? `Can't reach Devy (${State.lastError})${wait ? `, retrying in ${wait}s` : ""}` : "Can't reach Devy");
    setClass(el.health, "health bad");
    document.title = "Devy Remote";
    return;
  }
  if (!State.loaded) {
    setText(el.health, "Connecting");
    setClass(el.health, "health");
    return;
  }
  const counts = countStates();
  const parts = [];
  if (counts.waiting_for_input) parts.push(`${counts.waiting_for_input} need${counts.waiting_for_input === 1 ? "s" : ""} you`);
  if (counts.running) parts.push(`${counts.running} working`);
  if (counts.error) parts.push(`${counts.error} in error`);
  const rest = State.sessions.length - counts.waiting_for_input - counts.running - counts.error;
  if (rest) parts.push(`${rest} idle`);
  if (!State.sessions.length) parts.push("no sessions");
  setText(el.health, `${State.health?.hostname || "devy"}: ${parts.join(", ")}`);
  setClass(el.health, `health ${counts.waiting_for_input ? "warn" : "good"}`);
  document.title = counts.waiting_for_input ? `(${counts.waiting_for_input}) Devy Remote` : "Devy Remote";
}

function countStates() {
  const counts = { waiting_for_input: 0, running: 0, error: 0, claude: 0, codex: 0 };
  for (const session of State.sessions) {
    if (session.uiState in counts) counts[session.uiState] += 1;
    if (session.agent in counts) counts[session.agent] += 1;
  }
  return counts;
}

let noticeSignature = "";
function renderNotices() {
  const notices = [];
  if (State.updateWorker) notices.push({ id: "update", text: "A new version is ready.", action: "Reload", tone: "info" });
  if (State.offline) notices.push({ id: "offline", text: "You're offline. This is the last state seen.", tone: "warn" });
  if (State.health && State.health.agentInputEnabled === false) {
    notices.push({ id: "input", text: "Typing into sessions is switched off on the server (ENABLE_AGENT_INPUT=false).", tone: "warn" });
  }
  if (State.health?.tokenRequired && !State.token && !isLocalhost) {
    notices.push({ id: "token", text: "Replying, keys, creating and killing need the write token.", action: "Add token", tone: "info" });
  }
  const signature = notices.map((notice) => notice.id).join("|");
  if (signature === noticeSignature) return;
  noticeSignature = signature;
  el.notices.innerHTML = notices
    .map(
      (notice) => `
        <div class="notice ${notice.tone}" data-notice="${notice.id}">
          <span>${escapeHtml(notice.text)}</span>
          ${notice.action ? `<button type="button" data-notice-action="${notice.id}">${escapeHtml(notice.action)}</button>` : ""}
        </div>`
    )
    .join("");
}

el.notices.addEventListener("click", (event) => {
  const button = event.target.closest("[data-notice-action]");
  if (!button) return;
  if (button.dataset.noticeAction === "update") applyUpdate();
  if (button.dataset.noticeAction === "token") openTokenSettings();
});

function renderCounts() {
  const counts = countStates();
  counts.all = State.sessions.length;
  $$("[data-count]").forEach((node) => {
    const count = counts[node.dataset.count] || 0;
    setText(node, State.loaded && count ? String(count) : "");
  });
  el.filters.find((button) => button.dataset.filter === "waiting_for_input")?.classList.toggle("attention", counts.waiting_for_input > 0);
}

// Cards are keyed by session name and patched in place: a poll never rebuilds
// a card that has a half-typed reply, an open route menu or keyboard focus.
const cards = new Map();

function renderFeed() {
  if (!State.loaded) {
    cards.clear();
    el.feed.innerHTML = State.lastError
      ? `<div class="empty bad"><strong>Can't reach Devy</strong><p>${escapeHtml(State.lastError)}. Check that the service is running and you are on the tailnet.</p><button type="button" data-retry>Retry now</button></div>`
      : Array.from({ length: 3 }, (_, index) => `<div class="card skeleton" aria-hidden="true" style="--i:${index}"><span class="rail"></span><span class="head-main"><span class="sk sk-title"></span><span class="sk sk-sub"></span></span></div>`).join("");
    return;
  }
  const visible = visibleSessions();
  if (!visible.length) {
    cards.clear();
    el.feed.innerHTML = State.sessions.length
      ? `<div class="empty"><strong>No ${escapeHtml(filterLabel())} sessions right now</strong><p>Everything else is under All.</p></div>`
      : `<div class="empty"><strong>No tmux sessions</strong><p>Start an agent in a repo and it shows up here.</p><button type="button" data-create class="primary">New session</button></div>`;
    return;
  }
  const keep = new Set(visible.map((session) => session.name));
  for (const node of Array.from(el.feed.children)) {
    const name = node.dataset?.session;
    if (!name || !keep.has(name)) {
      node.remove();
      if (name) cards.delete(name);
    }
  }
  visible.forEach((session, index) => {
    let card = cards.get(session.name);
    if (!card) {
      card = createCard(session.name);
      cards.set(session.name, card);
    }
    updateCard(card, session);
    if (el.feed.children[index] !== card) el.feed.insertBefore(card, el.feed.children[index] || null);
  });
}

function createCard(name) {
  const card = el.template.content.firstElementChild.cloneNode(true);
  card.dataset.session = name;
  $(".keys", card).innerHTML =
    KEYS.map((key) => `<button type="button" class="key" data-key="${key}" title="Send ${key}">${KEY_LABEL[key] || key}</button>`).join("") +
    `<span class="keys-gap" aria-hidden="true"></span>` +
    QUICK_TEXT.map((text) => `<button type="button" class="key text" data-text="${text}" title="Type ${text} without Enter">${text}</button>`).join("");
  return card;
}

function updateCard(card, session) {
  const name = session.name;
  const open = State.open.has(name);
  const unseen = !open && State.seen[name] && State.seen[name] !== session.outputHash;
  const assignment = assignmentFor(name);
  const busy = State.busy.has(name);
  setClass(
    card,
    `card agent-${session.agent} state-${session.uiState}${open ? " open" : ""}${unseen ? " unseen" : ""}${State.current === name ? " current" : ""}${State.openRouteMenu === name ? " menu-open" : ""}${busy ? " busy" : ""}`
  );

  const head = $(".head", card);
  head.setAttribute("aria-expanded", String(open));
  setText($(".name", card), name);
  setText($(".state-label", card), STATE_LABEL[session.uiState] || session.uiState);
  setText($(".state-age", card), durSince(session.lastActivity));
  const branch = $(".branch", card);
  const branchName = session.git?.branch && session.git.branch !== "unknown" ? session.git.branch : "";
  branch.hidden = !branchName;
  setText(branch, branchName);
  $(".dirty", card).hidden = !session.git?.dirty;
  const command = $(".command", card);
  command.hidden = !session.paneCommand || session.paneCommand === "unknown";
  setText(command, session.paneCommand || "");
  const summary = $(".route-summary", card);
  summary.hidden = !assignment;
  setText(summary, assignment ? routeChipText(session, assignment) : "");

  const body = $(".body", card);
  body.hidden = !open;
  if (!open) {
    if (State.openRouteMenu === name) State.openRouteMenu = null;
    return;
  }

  const chip = $(".route-chip", card);
  const routable = Boolean(assignment) && (session.agent === "claude" || session.agent === "codex");
  setText(chip, assignment ? routeChipText(session, assignment) : "Direct, no gateway");
  setClass(chip, `route-chip${routable ? "" : " direct"}${assignment?.mode === "pinned" ? " pinned" : ""}`);
  chip.title = routable
    ? `Provider route${assignment.mode === "pinned" ? ", pinned" : ""}. Tap to switch.`
    : "Started outside the gateway. Create a new session with a route to switch providers.";
  chip.setAttribute("aria-expanded", String(State.openRouteMenu === name));
  const menu = $(".route-menu", card);
  menu.hidden = State.openRouteMenu !== name;
  if (!menu.hidden) renderRouteMenu(menu, session, assignment);

  setText($(".path", card), session.paneCurrentPath || "");

  const waiting = session.uiState === "waiting_for_input";
  const prompt = $(".prompt", card);
  prompt.hidden = !waiting;
  if (waiting) setText($("p", prompt), extractPrompt(session.lastOutput) || "The agent stopped and is waiting on you.");
  $(".compose", card).placeholder = waiting ? "Your answer…" : "Your reply…";

  const screen = $(".screen", card);
  if (card.dataset.hash !== session.outputHash) {
    const atBottom = !card.dataset.hash || screen.scrollHeight - screen.scrollTop - screen.clientHeight < 48;
    screen.textContent = session.lastOutput || "Nothing on screen yet.";
    if (atBottom) screen.scrollTop = screen.scrollHeight;
    card.dataset.hash = session.outputHash;
    State.seen[name] = session.outputHash;
    pruneSeen();
    storage.set(STORAGE.seen, JSON.stringify(State.seen));
  }

  const inputDisabled = State.health?.agentInputEnabled === false;
  $$(".key, .send, .type-only", card).forEach((button) => {
    button.disabled = busy || inputDisabled;
  });
  $(".kill", card).disabled = busy;
}

function pruneSeen() {
  const live = new Set(State.sessions.map((session) => session.name));
  for (const name of Object.keys(State.seen)) if (!live.has(name)) delete State.seen[name];
}

function toggleOpen(name, force) {
  const open = force ?? !State.open.has(name);
  if (open) {
    State.open.add(name);
    State.userClosed.delete(name);
  } else {
    State.open.delete(name);
    State.userClosed.add(name);
    if (State.openRouteMenu === name) State.openRouteMenu = null;
  }
  State.current = name;
  renderFeed();
  if (open) {
    const card = cards.get(name);
    if (card) requestAnimationFrame(() => card.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "nearest" }));
  }
}

function setCurrent(name) {
  if (State.current === name) return;
  State.current = name;
  renderFeed();
}

// ─── Gateway routes ───────────────────────────────────────────────────────

function assignmentFor(name) {
  return State.gateway.assignments?.[name] || null;
}

function routeById(id) {
  return State.gateway.routes.find((route) => route.id === id) || null;
}

function routeLabel(id) {
  return routeById(id)?.label || id || "direct";
}

function routesFor(lane) {
  const order = State.gateway.order?.[lane] || [];
  const ordered = order.map(routeById).filter(Boolean);
  return ordered.length ? ordered : State.gateway.routes.filter((route) => route.lane === lane);
}

function routeChipText(session, assignment) {
  if (!assignment) return "direct";
  if (assignment.route) return routeLabel(assignment.route);
  const fallback = State.gateway.defaults?.[session.agent];
  return fallback ? `${routeLabel(fallback)} (lane default)` : "lane default";
}

// Why a route cannot be picked right now, or null when it can. Mirrors the
// gateway's own candidate rules: passthrough routes forward the login the
// session was launched with, so they only work for that account.
function routeUnavailable(route, assignment = null) {
  if (route.enabled === false) return "switched off";
  if (!route.available) return route.unavailableReason || "unavailable";
  if (route.authType === "passthrough" && route.account) {
    if (assignment && route.account !== assignment.account) return `needs the ${route.account} login`;
    const account = State.gateway.accounts.find((item) => item.id === route.account);
    if (account && !account.signedIn) return "sign in first";
  }
  return null;
}

function renderRouteMenu(menu, session, assignment) {
  const lane = session.agent;
  if (!assignment || (lane !== "claude" && lane !== "codex")) {
    menu.innerHTML = `<p class="route-note">This session was started outside the gateway, so its traffic can't be re-routed. Create a new session with a route to switch providers.</p>`;
    return;
  }
  if (!State.gateway.up) {
    menu.innerHTML = `<p class="route-note bad">The gateway is offline${State.gateway.error ? ` (${escapeHtml(State.gateway.error)})` : ""}.</p>`;
    return;
  }
  const effective = assignment.route ?? State.gateway.defaults?.[lane] ?? null;
  const items = routesFor(lane).map((route) => {
    const why = routeUnavailable(route, assignment);
    const isCurrent = route.id === effective;
    return `
      <button type="button" class="route-option${isCurrent ? " current" : ""}" data-route="${escapeHtml(route.id)}" ${why ? "disabled" : ""} aria-pressed="${isCurrent}">
        <span class="check" aria-hidden="true"></span>
        <span class="route-label">${escapeHtml(route.label)}<small>${escapeHtml(route.provider || "")}${why ? `, ${escapeHtml(why)}` : ""}</small></span>
      </button>`;
  });
  const auto = assignment.mode !== "pinned";
  items.push(`
    <button type="button" class="route-option mode" data-mode="${auto ? "pinned" : "auto"}" aria-pressed="${auto}">
      <span class="check" aria-hidden="true"></span>
      <span class="route-label">Switch routes automatically on failure<small>${auto ? "On, falls back down the lane order" : "Off, pinned to the chosen route"}</small></span>
    </button>`);
  menu.innerHTML = items.join("");
}

function toggleRouteMenu(name) {
  State.openRouteMenu = State.openRouteMenu === name ? null : name;
  if (State.openRouteMenu && Date.now() - State.gateway.loadedAt > 3000) loadGateway();
  renderFeed();
}

async function switchRoute(name, routeId) {
  const previous = assignmentFor(name);
  if (!previous) return;
  const route = routeById(routeId);
  State.gateway.assignments[name] = { ...previous, route: routeId, updatedAt: Date.now() };
  State.openRouteMenu = null;
  renderFeed();
  try {
    await api(`/api/gateway/sessions/${encodeURIComponent(name)}`, { method: "PUT", body: { route: routeId } });
    toast(`${name} now uses ${route?.label || routeId} from its next request`, "ok");
  } catch (error) {
    State.gateway.assignments[name] = previous;
    renderFeed();
    toast(`Couldn't switch route: ${describe(error)}`, "bad");
  }
  loadGateway();
}

async function switchMode(name, mode) {
  const previous = assignmentFor(name);
  if (!previous) return;
  State.gateway.assignments[name] = { ...previous, mode, updatedAt: Date.now() };
  renderFeed();
  try {
    await api(`/api/gateway/sessions/${encodeURIComponent(name)}`, { method: "PUT", body: { mode } });
    toast(mode === "auto" ? `${name} switches routes automatically on failure` : `${name} is pinned to its route`, "ok");
  } catch (error) {
    State.gateway.assignments[name] = previous;
    renderFeed();
    toast(`Couldn't change mode: ${describe(error)}`, "bad");
  }
  loadGateway();
}

// ─── Actions ──────────────────────────────────────────────────────────────

async function act(name, run, okMessage) {
  if (State.busy.has(name)) return false;
  State.busy.add(name);
  renderFeed();
  try {
    await run();
    if (okMessage) toast(okMessage, "ok");
    soon();
    return true;
  } catch (error) {
    toast(describe(error), "bad");
    return false;
  } finally {
    State.busy.delete(name);
    renderFeed();
  }
}

async function submitCompose(card, submit) {
  const name = card.dataset.session;
  if (State.busy.has(name)) return;
  const compose = $(".compose", card);
  const text = compose.value;
  if (!text.trim()) {
    // Enter on an empty box is the most common quick action: accept the default.
    if (submit) sendKey(card, "Enter");
    return;
  }
  compose.value = "";
  autoGrow(compose);
  echo(card, text + (submit ? "\n" : ""));
  const ok = await act(
    name,
    () => api(`/api/sessions/${encodeURIComponent(name)}/input`, { method: "POST", body: { text, submit } }),
    submit ? "Sent" : "Typed, no Enter"
  );
  if (!ok && !compose.value) {
    compose.value = text;
    autoGrow(compose);
  }
}

async function sendKey(card, key) {
  const name = card.dataset.session;
  if (key === "Enter") echo(card, "\n");
  await act(name, () => api(`/api/sessions/${encodeURIComponent(name)}/key`, { method: "POST", body: { key } }), `Sent ${KEY_LABEL[key] || key}`);
}

async function sendQuickText(card, text) {
  const name = card.dataset.session;
  echo(card, text);
  await act(name, () => api(`/api/sessions/${encodeURIComponent(name)}/input`, { method: "POST", body: { text, submit: false } }), `Typed ${text}`);
}

// Local echo makes a tap feel instant; the next poll replaces it with the
// real pane contents.
function echo(card, text) {
  const screen = $(".screen", card);
  if (!screen || !text) return;
  screen.textContent += text;
  screen.scrollTop = screen.scrollHeight;
}

async function killSession(name) {
  const removed = State.sessions.find((session) => session.name === name);
  if (!removed) return;
  State.sessions = State.sessions.filter((session) => session.name !== name);
  State.open.delete(name);
  if (State.current === name) State.current = State.sessions[0]?.name || null;
  render();
  try {
    await api(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast(`Killed ${name}`, "ok");
  } catch (error) {
    toast(`Couldn't kill ${name}: ${describe(error)}`, "bad");
  }
  refresh();
}

function showKillConfirm(card) {
  $(".kill", card).hidden = true;
  const confirm = $(".kill-confirm", card);
  confirm.hidden = false;
  $(".kill-yes", card).focus();
  clearTimeout(Number(card.dataset.killTimer));
  card.dataset.killTimer = String(setTimeout(() => hideKillConfirm(card), 6000));
}

function hideKillConfirm(card) {
  clearTimeout(Number(card.dataset.killTimer));
  $(".kill", card).hidden = false;
  $(".kill-confirm", card).hidden = true;
}

function armKey(button, key) {
  button.classList.add("armed");
  button.textContent = "Sure?";
  clearTimeout(button.disarm);
  button.disarm = setTimeout(() => disarmKey(button, key), 2500);
}

function disarmKey(button, key) {
  clearTimeout(button.disarm);
  button.classList.remove("armed");
  button.textContent = KEY_LABEL[key] || key;
}

function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(160, Math.max(44, textarea.scrollHeight))}px`;
}

// One listener per event type for the whole feed.
el.feed.addEventListener("click", (event) => {
  if (event.target.closest("[data-retry]")) {
    poll.failures = 0;
    refresh();
    return;
  }
  if (event.target.closest("[data-create]")) {
    openCreate();
    return;
  }
  const card = event.target.closest(".card[data-session]");
  if (!card) return;
  const name = card.dataset.session;
  if (event.target.closest(".head")) {
    toggleOpen(name);
    return;
  }
  State.current = name;
  if (event.target.closest(".route-chip")) {
    toggleRouteMenu(name);
    return;
  }
  const option = event.target.closest(".route-option");
  if (option) {
    if (option.disabled) return;
    if (option.dataset.route) switchRoute(name, option.dataset.route);
    else if (option.dataset.mode) switchMode(name, option.dataset.mode);
    return;
  }
  if (event.target.closest(".kill")) {
    showKillConfirm(card);
    return;
  }
  if (event.target.closest(".kill-yes")) {
    hideKillConfirm(card);
    killSession(name);
    return;
  }
  if (event.target.closest(".kill-no")) {
    hideKillConfirm(card);
    return;
  }
  if (event.target.closest(".screen-toggle")) {
    const tall = card.classList.toggle("tall");
    event.target.closest(".screen-toggle").textContent = tall ? "Less" : "More";
    const screen = $(".screen", card);
    screen.scrollTop = screen.scrollHeight;
    return;
  }
  if (event.target.closest(".type-only")) {
    submitCompose(card, false);
    return;
  }
  const key = event.target.closest("[data-key]");
  if (key && !key.disabled) {
    const value = key.dataset.key;
    // Destructive keys take a second tap so a mis-tap never closes the agent.
    if (ARMED_KEYS.has(value) && !key.classList.contains("armed")) {
      armKey(key, value);
      return;
    }
    if (key.classList.contains("armed")) disarmKey(key, value);
    sendKey(card, value);
    return;
  }
  const quick = event.target.closest("[data-text]");
  if (quick && !quick.disabled) sendQuickText(card, quick.dataset.text);
});

el.feed.addEventListener("submit", (event) => {
  const composer = event.target.closest(".composer");
  if (!composer) return;
  event.preventDefault();
  submitCompose(composer.closest(".card"), true);
});

el.feed.addEventListener("keydown", (event) => {
  const compose = event.target.closest(".compose");
  if (!compose) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitCompose(compose.closest(".card"), !(event.ctrlKey || event.metaKey));
    return;
  }
  if (event.key === "Escape") compose.blur();
});

el.feed.addEventListener("input", (event) => {
  const compose = event.target.closest(".compose");
  if (compose) autoGrow(compose);
});

el.feed.addEventListener("focusin", (event) => {
  const card = event.target.closest(".card[data-session]");
  if (card) setCurrent(card.dataset.session);
});

document.addEventListener("click", (event) => {
  if (State.openRouteMenu && !event.target.closest(".card.menu-open")) {
    State.openRouteMenu = null;
    renderFeed();
  }
});

// ─── Create session ───────────────────────────────────────────────────────

async function openCreate() {
  el.createError.hidden = true;
  fillRoutes("loading");
  openDialog(el.createDialog);
  await loadGateway();
  fillRoutes();
  const nameField = el.createForm.elements.name;
  if (!nameField.value) nameField.focus();
}

function fillRoutes(mode) {
  const select = el.createForm.elements.route;
  const lane = el.createForm.elements.agent.value;
  if (mode === "loading") {
    select.innerHTML = `<option value="direct">Loading routes</option>`;
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const gateway = State.gateway;
  if (!gateway.up) {
    select.innerHTML = `<option value="direct" selected>Direct, no gateway</option>`;
    el.routeHint.textContent = `The gateway is offline${gateway.error ? ` (${gateway.error})` : ""}, so the agent launches with its own login.`;
    return;
  }
  const laneDefault = gateway.defaults?.[lane] || null;
  const options = routesFor(lane).map((route) => {
    const why = routeUnavailable(route);
    const isDefault = route.id === laneDefault;
    return `<option value="${escapeHtml(route.id)}" ${why ? "disabled" : ""} ${isDefault && !why ? "selected" : ""}>${escapeHtml(route.label)}${isDefault ? " (lane default)" : ""}${why ? `, ${escapeHtml(why)}` : ""}</option>`;
  });
  select.innerHTML = `${options.join("")}<option value="direct">Direct, no gateway</option>`;
  if (!select.value || select.selectedOptions[0]?.disabled) select.value = "direct";
  el.routeHint.textContent = "A route sends the agent's traffic through the gateway and can be switched later. Direct uses the agent's own login.";
}

el.createForm.elements.agent.addEventListener("change", () => {
  if (!el.createForm.elements.route.disabled) fillRoutes();
});

el.createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = el.createForm;
  const body = {
    agent: form.elements.agent.value,
    name: form.elements.name.value.trim(),
    directory: form.elements.directory.value.trim(),
    route: form.elements.route.value || "direct"
  };
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  el.createError.hidden = true;
  try {
    const result = await api("/api/sessions", { method: "POST", body });
    el.createDialog.close();
    form.elements.name.value = "";
    const via = result?.route && result.route !== "direct" ? ` on ${routeLabel(result.route)}` : "";
    toast(`Created ${body.name}${via}`, "ok");
    State.open.add(body.name);
    State.current = body.name;
    State.gateway.loadedAt = 0;
    await refresh();
    cards.get(body.name)?.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
  } catch (error) {
    el.createError.textContent = describe(error);
    el.createError.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

el.newSession.addEventListener("click", openCreate);

// ─── Token dialog ─────────────────────────────────────────────────────────

let tokenResolver = null;

function requestToken(message) {
  return new Promise((resolve) => {
    tokenResolver?.(null);
    tokenResolver = resolve;
    el.tokenMessage.textContent = message;
    el.tokenInput.value = State.token;
    openDialog(el.tokenDialog);
    el.tokenInput.focus();
  });
}

function openTokenSettings() {
  if (State.health?.authentication === "cloudflare") {
    toast("Signed in through Cloudflare. No separate token is needed.", "ok");
    return;
  }
  requestToken(
    State.token
      ? "A token is saved in this browser. Replace it, or clear it to be asked again."
      : "Replying, keys, creating and killing need AGENT_OPS_TOKEN when you are not on localhost. It stays in this browser."
  );
}

function settleToken(value) {
  const resolve = tokenResolver;
  tokenResolver = null;
  if (el.tokenDialog.open) el.tokenDialog.close();
  resolve?.(value);
}

el.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = el.tokenInput.value.trim();
  State.token = token;
  storage.set(STORAGE.token, token);
  el.tokenInput.value = "";
  toast(token ? "Token saved" : "Token cleared", "ok");
  renderNotices();
  settleToken(token || null);
});
el.tokenClear.addEventListener("click", () => {
  State.token = "";
  storage.set(STORAGE.token, null);
  el.tokenInput.value = "";
  toast("Token cleared", "ok");
  renderNotices();
  settleToken(null);
});
el.tokenDialog.addEventListener("close", () => {
  el.tokenInput.value = "";
  settleToken(null);
});
el.openToken.addEventListener("click", openTokenSettings);

// ─── Dialogs ──────────────────────────────────────────────────────────────

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

$$("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  $$("[data-close]", dialog).forEach((button) => button.addEventListener("click", () => dialog.close()));
});

function anyDialogOpen() {
  return $$("dialog").some((dialog) => dialog.open);
}

// ─── Keyboard ─────────────────────────────────────────────────────────────

function moveCurrent(offset) {
  const visible = visibleSessions();
  if (!visible.length) return;
  const index = visible.findIndex((session) => session.name === State.current);
  const next = visible[Math.min(visible.length - 1, Math.max(0, (index < 0 ? 0 : index) + offset))];
  setCurrent(next.name);
  const card = cards.get(next.name);
  $(".head", card)?.focus();
  card?.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "nearest" });
}

document.addEventListener("keydown", (event) => {
  if (anyDialogOpen() || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.matches("input, textarea, select")) return;
  const card = State.current ? cards.get(State.current) : null;
  switch (event.key) {
    case "j":
    case "ArrowDown":
      event.preventDefault();
      moveCurrent(1);
      break;
    case "k":
    case "ArrowUp":
      event.preventDefault();
      moveCurrent(-1);
      break;
    case "o":
      if (State.current) toggleOpen(State.current);
      break;
    case "/":
    case "i":
      event.preventDefault();
      if (State.current) {
        toggleOpen(State.current, true);
        $(".compose", cards.get(State.current))?.focus();
      }
      break;
    case "r":
      event.preventDefault();
      poll.failures = 0;
      refresh();
      break;
    case "n":
      event.preventDefault();
      openCreate();
      break;
    case "?":
      event.preventDefault();
      openDialog(el.helpDialog);
      break;
    case "Escape":
      if (State.openRouteMenu) {
        State.openRouteMenu = null;
        renderFeed();
      }
      if (card) hideKillConfirm(card);
      break;
    default:
      break;
  }
});

el.refresh.addEventListener("click", () => {
  poll.failures = 0;
  refresh();
});

// ─── Service worker & updates ─────────────────────────────────────────────

let updateRequested = false;

function applyUpdate() {
  updateRequested = true;
  if (State.updateWorker) State.updateWorker.postMessage({ type: "SKIP_WAITING" });
  else location.reload();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register(new URL("./sw.js", location.href))
    .then((registration) => {
      const offer = (worker) => {
        State.updateWorker = worker;
        renderNotices();
      };
      if (registration.waiting) offer(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) offer(worker);
        });
      });
    })
    .catch(() => {});
  // Only reload when the user asked for the update; the first install also
  // fires controllerchange and must not bounce the page.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updateRequested) location.reload();
  });
}

// ─── Toasts ───────────────────────────────────────────────────────────────

function toast(message, tone = "info") {
  const node = document.createElement("div");
  node.className = `toast ${tone}`;
  node.textContent = message;
  el.toasts.appendChild(node);
  while (el.toasts.children.length > 3) el.toasts.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add("out");
    setTimeout(() => node.remove(), 250);
  }, tone === "bad" ? 6000 : 2600);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function setClass(node, className) {
  if (node.className !== className) node.className = className;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Compact "how long in this state" from tmux session_activity (epoch ms).
function durSince(ms) {
  if (!ms) return "";
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// Same prompt patterns the server uses to flag waiting_for_input, applied to
// the last screen so the card can show what is being asked.
const PROMPT_PATTERN =
  /Do you want to proceed\?|Approve|Requires approval|Waiting for input|Continue\?|Permission required|Allow this command\?|Select an option|Would you like to (run|make)|\by\/n\b/i;

function extractPrompt(output) {
  const lines = String(output || "")
    .split("\n")
    .map((line) => line.replace(/[│┃┆┊|]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const hit = lines.filter((line) => PROMPT_PATTERN.test(line)).at(-1);
  return (hit || lines.at(-1) || "").slice(0, 360);
}

// ─── Boot ─────────────────────────────────────────────────────────────────

setFilter(State.filter);
refresh();
