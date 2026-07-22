const sessionsEl = document.querySelector("#sessions");
const healthEl = document.querySelector("#health");
const refreshBtn = document.querySelector("#refresh");
const createSessionForm = document.querySelector("#create-session-form");
const updateBanner = document.querySelector("#update-banner");
let currentFilter = "all";
let sessions = [];
let selectedSession = null;
let systemStats = null;
const seenHashes = JSON.parse(localStorage.getItem("agentSessionsSeenHashes") || "{}");

const stateLabels = {
  running: "Running",
  waiting_for_input: "Needs input",
  error: "Error",
  idle: "Idle",
  unknown: "Unknown"
};

refreshBtn.addEventListener("click", () => refresh());
createSessionForm?.addEventListener("submit", (event) => createSession(event));
updateBanner?.addEventListener("click", () => window.location.reload());
document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then((registration) => {
    if (registration.waiting) showUpdateBanner(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(worker);
      });
    });
  }).catch(() => {});
}

async function refresh() {
  refreshBtn.disabled = true;
  try {
    const [health, result, stats] = await Promise.all([
      fetchJson("/api/health"),
      fetchJson("/api/sessions"),
      fetchJson("/api/system")
    ]);
    healthEl.textContent = `${health.app} on ${health.hostname} · ${new Date(health.time).toLocaleTimeString()}`;
    healthEl.className = "good";
    sessions = result.sessions || [];
    systemStats = stats;
    if (!selectedSession && sessions[0]) selectedSession = sessions[0].name;
    if (selectedSession && !sessions.some((session) => session.name === selectedSession)) {
      selectedSession = sessions[0]?.name || null;
    }
    render();
  } catch (error) {
    healthEl.textContent = `Unavailable: ${error.message}`;
    healthEl.className = "bad";
  } finally {
    refreshBtn.disabled = false;
  }
}

function showUpdateBanner(worker) {
  if (!updateBanner) return;
  updateBanner.hidden = false;
  updateBanner.onclick = () => {
    worker.postMessage({ type: "SKIP_WAITING" });
    window.location.reload();
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

function render() {
  const visible = sessions.filter((session) => {
    if (currentFilter === "all") return true;
    if (currentFilter === "waiting_for_input") return session.state === "waiting_for_input";
    return session.agent === currentFilter;
  });

  sessionsEl.innerHTML = visible.length
    ? `
      ${renderSystemStats()}
      <div class="session-list">${visible.map(renderSessionSummary).join("")}</div>
      ${renderSelectedSession(visible)}
    `
    : `<p class="empty">No matching tmux sessions.</p>`;

  document.querySelectorAll(".session-row").forEach((button) => {
    button.addEventListener("click", () => {
      selectedSession = button.dataset.session;
      render();
    });
  });
  document.querySelectorAll(".quick-key").forEach((button) => {
    button.addEventListener("click", () => sendKey(button.dataset.session, button.dataset.key));
  });
  document.querySelector(".stop-session")?.addEventListener("click", (event) => stopSession(event.currentTarget.dataset.session));
  const terminalInput = document.querySelector(".terminal-input");
  const terminalScreen = document.querySelector(".terminal-screen");
  terminalScreen?.addEventListener("click", () => terminalInput?.focus());
  terminalInput?.addEventListener("input", (event) => handleTerminalText(event));
  terminalInput?.addEventListener("keydown", (event) => handleTerminalKey(event));
  scrollTerminalToBottom();
}

function renderSessionSummary(session) {
  const branch = session.git?.branch || "unknown";
  const dirty = session.git?.dirty ? "dirty" : "clean";
  const active = session.name === selectedSession ? "active" : "";
  const unseen = seenHashes[session.name] && seenHashes[session.name] !== session.outputHash ? "unseen" : "";
  return `
    <button class="session-row ${session.agent} ${active} ${unseen}" data-session="${escapeHtml(session.name)}" type="button">
      <span class="rail"></span>
      <span class="row-main">
        <span class="row-title">
          <strong>${escapeHtml(session.name)}${unseen ? '<span class="activity-dot"></span>' : ""}</strong>
          <span class="badge ${session.state}">${stateLabels[session.state] || session.state}</span>
        </span>
        <span class="row-sub">${escapeHtml(branch)} · ${dirty} · ${escapeHtml(session.agent)}</span>
      </span>
    </button>
  `;
}

function renderSelectedSession(visible) {
  const session = visible.find((item) => item.name === selectedSession) || visible[0];
  if (!session) return "";
  selectedSession = session.name;
  const branch = session.git?.branch || "unknown";
  const dirty = session.git?.dirty ? "dirty" : "clean";
  const output = escapeHtml(session.lastOutput || "No pane output captured.");
  const prompt = escapeHtml(extractPrompt(session.lastOutput));
  seenHashes[session.name] = session.outputHash;
  localStorage.setItem("agentSessionsSeenHashes", JSON.stringify(seenHashes));
  return `
    <article class="session-detail ${session.agent}">
      <div class="detail-header">
        <div>
          <h2>${escapeHtml(session.name)}</h2>
          <p>${escapeHtml(session.paneCurrentPath)}</p>
        </div>
        <div class="detail-actions">
          <span class="badge ${session.state}">${stateLabels[session.state] || session.state}</span>
          <button class="stop-session" data-session="${escapeHtml(session.name)}" type="button">Stop</button>
        </div>
      </div>

      <div class="meta">
        <span><b>Branch</b>${escapeHtml(branch)}</span>
        <span><b>Status</b>${dirty}</span>
        <span><b>Agent</b>${escapeHtml(session.agent)}</span>
        <span><b>Command</b>${escapeHtml(session.paneCommand)}</span>
      </div>

      <section class="prompt-box">
        <span>Latest prompt</span>
        <p>${prompt || "No clear prompt detected. Check the pane preview below."}</p>
      </section>

      <section class="terminal-panel">
        <div class="terminal-bar">
          <span>Terminal</span>
          <div class="keys">
            ${["Enter", "Backspace", "C-c", "C-d", "Up", "Down", "Tab", "Escape"]
              .map((key) => `<button class="quick-key" data-session="${escapeHtml(session.name)}" data-key="${key}" type="button">${key}</button>`)
              .join("")}
          </div>
        </div>
        <pre class="terminal-screen" tabindex="0">${output}</pre>
        <input class="terminal-input" data-session="${escapeHtml(session.name)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Tap terminal, then type here" />
      </section>
    </article>
  `;
}

function renderSystemStats() {
  if (!systemStats) return "";
  return `
    <section class="stats-strip">
      <span><b>CPU</b>${systemStats.load1.toFixed(2)} / ${systemStats.cpuCount}</span>
      <span><b>Mem</b>${systemStats.memory.usedPercent}%</span>
      <span><b>Disk</b>${systemStats.disk.usedPercent}%</span>
      <span><b>Up</b>${formatUptime(systemStats.uptimeSeconds)}</span>
    </section>
  `;
}

async function createSession(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const agent = form.elements.agent.value;
  const name = form.elements.name.value;
  const directory = form.elements.directory.value;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, name, directory })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    selectedSession = name;
    form.elements.name.value = "";
    await refresh();
  } catch (error) {
    alert(`Create failed: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function stopSession(session) {
  if (!confirm(`Stop tmux session "${session}"?`)) return;
  const response = await fetch(`/api/sessions/${encodeURIComponent(session)}`, { method: "DELETE" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    alert(`Stop failed: ${body.error || response.status}`);
    return;
  }
  if (selectedSession === session) selectedSession = null;
  await refresh();
}

async function handleTerminalText(event) {
  const input = event.currentTarget;
  const value = input.value;
  if (!value) return;
  input.value = "";
  try {
    await sendText(input.dataset.session, value, false);
    appendTerminalText(value);
  } catch (error) {
    alert(`Terminal input failed: ${error.message}`);
  }
}

async function handleTerminalKey(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    await sendKey(event.currentTarget.dataset.session, "Enter");
    appendTerminalText("\n");
    return;
  }
  if (event.key === "Backspace") {
    event.preventDefault();
    await sendKey(event.currentTarget.dataset.session, "Backspace");
    backspaceTerminalText();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    await sendKey(event.currentTarget.dataset.session, "Tab");
    return;
  }
}

function appendTerminalText(value) {
  const screen = document.querySelector(".terminal-screen");
  if (!screen) return;
  screen.textContent += value;
  screen.scrollTop = screen.scrollHeight;
}

function backspaceTerminalText() {
  const screen = document.querySelector(".terminal-screen");
  if (!screen?.textContent) return;
  screen.textContent = screen.textContent.slice(0, -1);
  screen.scrollTop = screen.scrollHeight;
}

function scrollTerminalToBottom() {
  requestAnimationFrame(() => {
    const screen = document.querySelector(".terminal-screen");
    if (screen) screen.scrollTop = screen.scrollHeight;
  });
}

async function sendText(session, text, submit) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(session)}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, submit })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
}

async function sendKey(session, key) {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(session)}/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    await refresh();
  } catch (error) {
    alert(`Key failed: ${error.message}`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function extractPrompt(output) {
  const lines = String(output || "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return (
    lines
      .filter((line) =>
        /Do you want to proceed\?|Approve|Requires approval|Waiting for input|Continue\?|Permission required|Allow this command\?|Select an option|Would you like to (run|make)|\by\/n\b/i.test(
          line
        )
      )
      .at(-1) ||
    lines.at(-1) ||
    ""
  ).slice(0, 360);
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  return `${hours}h`;
}

refresh();
setInterval(refresh, 5000);
