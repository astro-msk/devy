// ─── Gateway page ─────────────────────────────────────────────────────────
// Provider routing for Claude Code / Codex sessions: sign in to accounts,
// validate routes, switch a running session, and watch usage. Talks to
// /api/gateway/* which proxies the loopback gateway's admin API. Day-to-day
// switching lives on the Sessions/Terminal pages (route chip → sheet); this
// page is the management view.
(function gatewayPage() {
  const { route, api, $, escapeHtml, toast, formatUptime, stateLabels, currentRoute, navigate, Gateway, routeHealth, confirmDialog } = window.Devy;
  const LANES = [
    { id: "claude", label: "Claude Code", client: "claude" },
    { id: "codex", label: "Codex", client: "codex" }
  ];
  let gw = null; // last /api/gateway/state payload (shared cache in app.js)
  let pollTimer = null;
  let busy = new Set();
  let wireController = null;
  let defaultResult = null;

  async function load() {
    gw = await Gateway.state(true);
    return gw;
  }

  function fmtTokens(n) {
    if (n == null) return "—";
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
  }

  function until(ts) {
    const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  }

  // Rate-limit headers differ per provider; show the few that mean something to a human.
  function limitSummary(limits) {
    const out = [];
    const pct = (v) => (v == null ? null : Math.round(Number(v) * (Number(v) <= 1 ? 100 : 1)));
    if (limits["anthropic-ratelimit-unified-5h-utilization"]) out.push(`5h window ${pct(limits["anthropic-ratelimit-unified-5h-utilization"])}% used`);
    if (limits["anthropic-ratelimit-unified-7d-utilization"]) out.push(`7d window ${pct(limits["anthropic-ratelimit-unified-7d-utilization"])}% used`);
    if (limits["anthropic-ratelimit-unified-status"] && limits["anthropic-ratelimit-unified-status"] !== "allowed") out.push(limits["anthropic-ratelimit-unified-status"]);
    if (limits["x-codex-primary-used-percent"]) out.push(`5h window ${Math.round(Number(limits["x-codex-primary-used-percent"]))}% used`);
    if (limits["x-codex-secondary-used-percent"]) out.push(`7d window ${Math.round(Number(limits["x-codex-secondary-used-percent"]))}% used`);
    if (limits["x-ratelimit-remaining-requests"]) out.push(`${limits["x-ratelimit-remaining-requests"]} requests left`);
    if (limits["x-ratelimit-remaining-tokens"]) out.push(`${fmtTokens(Number(limits["x-ratelimit-remaining-tokens"]))} tokens left`);
    if (!out.length && limits["retry-after"]) out.push(`retry after ${limits["retry-after"]}s`);
    return out.join(", ");
  }

  function healthTag(r) {
    if (!r.available) return `<span class="tag idle" title="${escapeHtml(r.unavailableReason || "disabled")}">${r.enabled ? "unavailable" : "off"}</span>`;
    const hl = r.health;
    if (hl.cooling) return `<span class="tag dirty" title="${escapeHtml(hl.reason || "")}">cooling ${until(hl.coolUntil)}</span>`;
    if (hl.status === "error") return `<span class="tag error" title="${escapeHtml(hl.reason || "")}">error</span>`;
    if (hl.status === "ok") return `<span class="tag running">ok</span>`;
    return `<span class="tag idle">untested</span>`;
  }

  function accountFor(id) {
    return (gw?.accounts || []).find((a) => a.id === id) || null;
  }

  // Routes are a failover sequence, so they're numbered in try order.
  function routeRow(r, index, count) {
    const c = r.counters || {};
    const acct = r.account ? accountFor(r.account) : null;
    const acctLine = acct
      ? `<div class="gw-line ${acct.signedIn ? "dim" : "warn"}">${escapeHtml(acct.label)} — ${escapeHtml(acct.detail || (acct.signedIn ? "signed in" : "not signed in"))}</div>`
      : "";
    const limits = limitSummary(r.health.limits || {});
    const usage = c.requests
      ? `<div class="gw-line muted">${c.requests} requests, ${c.errors} failed. ${fmtTokens(c.inputTokens)} in, ${fmtTokens(c.outputTokens)} out${c.cacheReadTokens ? `, ${fmtTokens(c.cacheReadTokens)} from cache` : ""}.</div>`
      : `<div class="gw-line muted">No traffic yet.</div>`;
    return `
      <article class="gw-route ${r.isDefault ? "is-default" : ""} ${r.enabled ? "" : "is-off"}" data-route="${r.id}">
        <span class="gw-num" aria-label="Position ${index + 1}">${index + 1}</span>
        <div class="gw-route-body">
          <div class="gw-title">
            <b>${escapeHtml(r.label)}</b>
            ${r.isDefault ? `<span class="tag accent">default</span>` : ""}
            ${healthTag(r)}
            <span class="gw-line dim">${escapeHtml(r.provider)}</span>
          </div>
          ${acctLine}
          ${!r.available && r.unavailableReason ? `<div class="gw-line warn">${escapeHtml(r.unavailableReason)}</div>` : ""}
          ${limits ? `<div class="gw-line">${escapeHtml(limits)}</div>` : ""}
          ${usage}
          ${r.health.reason && (r.health.status === "error" || r.health.cooling) ? `<div class="gw-line bad mono">${escapeHtml(r.health.reason.slice(0, 160))}</div>` : ""}
        </div>
        <div class="gw-order">
          <button class="icon-btn" data-act="up" title="Try earlier" aria-label="Move earlier" ${index === 0 ? "disabled" : ""}>↑</button>
          <button class="icon-btn" data-act="down" title="Try later" aria-label="Move later" ${index === count - 1 ? "disabled" : ""}>↓</button>
        </div>
        <div class="btn-row gw-actions">
          <button class="btn btn-sm" data-act="test" ${r.available ? "" : "disabled"}>Test</button>
          <button class="btn btn-sm" data-act="default" ${busy.has("default") || !r.available ? "disabled" : ""}>${r.isDefault ? "Apply default again" : "Make default"}</button>
          <button class="btn btn-sm btn-ghost" data-act="toggle">${r.enabled ? "Disable" : "Enable"}</button>
          ${r.health.cooling || r.health.status === "error" ? `<button class="btn btn-sm btn-ghost" data-act="reset">Clear status</button>` : ""}
        </div>
      </article>`;
  }

  function accountCard(a) {
    return `
      <article class="gw-account ${a.signedIn ? "on" : ""}" data-account="${a.id}">
        <div class="gw-title">
          <span class="dot ${a.signedIn ? "on" : ""}" aria-hidden="true"></span>
          <b>${escapeHtml(a.label)}</b>
          <span class="tag ${a.lane}">${a.lane}</span>
        </div>
        <div class="gw-line ${a.signedIn ? "dim" : "warn"}">${escapeHtml(a.detail || (a.signedIn ? "Signed in" : "Not signed in"))}</div>
        <div class="gw-line muted mono" title="${escapeHtml(a.dir)}">${escapeHtml(a.dir.replace("/home/ubuntu", "~"))}</div>
        <div class="btn-row gw-actions">
          <button class="btn btn-sm ${a.signedIn ? "" : "btn-primary"}" data-act="login">${a.signedIn ? "Sign in again" : "Sign in"}</button>
          ${a.signedIn ? `<button class="btn btn-sm btn-ghost" data-act="logout">Sign out</button>` : ""}
        </div>
      </article>`;
  }

  function sessionRow(s) {
    const lane = s.agent === "claude" || s.agent === "codex" ? s.agent : null;
    const a = Gateway.assignment(s.name);
    const routes = lane ? gw.state.routes.filter((r) => r.lane === lane) : [];
    const viaGateway = Boolean(a);
    const options = routes.map((r) => {
      const eligible = Gateway.eligible(r, a);
      return `<option value="${r.id}" ${a?.route === r.id ? "selected" : ""} ${eligible ? "" : "disabled"}>${escapeHtml(r.label)}${eligible ? "" : " (not available)"}</option>`;
    }).join("");
    return `
      <div class="gw-session" data-session="${escapeHtml(s.name)}">
        <div class="gw-session-name">
          <b>${escapeHtml(s.name)}</b>
          <span class="tag ${s.agent}">${escapeHtml(s.agent)}</span>
          <span class="tag ${s.state}">${stateLabels[s.state] || s.state}</span>
        </div>
        ${viaGateway ? `
          <select data-act="route" aria-label="Route for ${escapeHtml(s.name)}" ${lane ? "" : "disabled"}>${options}</select>
          <label class="gw-check"><input type="checkbox" data-act="mode" ${a.mode === "auto" ? "checked" : ""} /> auto-switch</label>
          <span class="gw-line muted">${a.account ? `Signed in as ${escapeHtml(a.account)}` : "No login — API-key routes only"}</span>
        ` : `<span class="gw-line muted">Not via the gateway — using its own login directly. Open its provider chip on Sessions to move it (restarts &amp; resumes), or wait: it is moved automatically when that login hits its limit.</span>`}
      </div>`;
  }

  function logRow(e) {
    const t = new Date(e.at);
    const status = e.outcome === "cancelled" ? "muted" : e.outcome === "failed" && e.status < 400 ? "bad" : e.status < 300 ? "ok" : e.status === 429 ? "warn" : "bad";
    const result = e.outcome === "cancelled" ? "Client stopped" : e.outcome === "failed" && e.status < 400 ? `${e.status} · stream failed` : e.status === 429 ? "429 · rate limit" : e.status;
    return `<tr class="${status}">
      <td class="mono">${t.toLocaleTimeString([], { hour12: false })}</td>
      <td class="mono">${escapeHtml(e.session)}</td>
      <td>${escapeHtml(e.route)}${e.attempts > 1 ? ` <span class="tag dirty" title="${escapeHtml(e.error || "")}">failover ×${e.attempts}</span>` : ""}</td>
      <td class="mono" title="${escapeHtml(e.error || "")}">${result}</td>
      <td class="mono">${(e.ms / 1000).toFixed(1)}s</td>
      <td class="mono">${fmtTokens(e.inputTokens)} / ${fmtTokens(e.outputTokens)}</td>
      <td class="mono dim" title="${escapeHtml(e.error || e.upstreamModel || "")}">${escapeHtml(e.upstreamModel && e.upstreamModel !== e.model ? `${e.model} → ${e.upstreamModel}` : e.model || "")}</td>
    </tr>`;
  }

  function codexStatusHTML(status) {
    if (!status) return "";
    const label = { connected: "Gateway connected", "restart-required": "Reconnect needed", unavailable: "Status unavailable", error: "Connection error" }[status.status] || "Status unavailable";
    return `<section class="panel gw-desktop" aria-label="Codex desktop connection">
      <div class="panel-pad">
        <div class="gw-title"><b>Codex desktop</b><span class="tag ${status.status === "connected" ? "running" : "dirty"}">${label}</span><span class="spacer"></span><button class="btn btn-sm" data-act="codex-restart" title="Send SIGINT to the codex app-server daemon; the desktop respawns it and threads reload their provider">Restart Codex server</button></div>
        <p class="gw-line">${escapeHtml(status.detail || "Connection status could not be confirmed.")}</p>
        ${status.configuredProvider ? `<p class="gw-line muted">Configured provider: ${escapeHtml(status.configuredProvider)}</p>` : ""}
        ${status.loadedDirectCount > 0 ? `<p class="gw-line warn">${status.loadedDirectCount} loaded ${status.loadedDirectCount === 1 ? "task still uses its" : "tasks still use their"} direct provider. Reconnect through the gateway to use these defaults.</p>` : ""}
      </div>
    </section>`;
  }

  function defaultResultHTML() {
    if (!defaultResult) return "";
    if (defaultResult.error) return `<div class="panel gw-bad" role="alert"><div class="panel-pad"><b>Default could not be changed</b><p class="gw-line bad">${escapeHtml(defaultResult.error)}</p></div></div>`;
    const result = defaultResult.result;
    const applied = Array.isArray(result.appliedSessions) ? result.appliedSessions : null;
    const blocked = Array.isArray(result.blockedSessions) ? result.blockedSessions : [];
    return `<div class="panel gw-ok" role="status"><div class="panel-pad">
      <b>${escapeHtml(defaultResult.label)} is the default</b>
      <p class="gw-line">${applied === null ? "Default saved. Session updates were not reported by the server." : applied.length ? `${applied.length} automatic ${applied.length === 1 ? "session will" : "sessions will"} follow this default on ${applied.length === 1 ? "its" : "their"} next request.` : "No existing automatic sessions were updated."}</p>
      ${blocked.length ? `<p class="gw-line warn">${blocked.length} ${blocked.length === 1 ? "session kept its" : "sessions kept their"} current provider:</p><ul class="gw-result-list">${blocked.map((item) => `<li><b>${escapeHtml(item.session)}</b>: ${escapeHtml(item.reason)}</li>`).join("")}</ul>` : ""}
      ${result.codexServer ? `<p class="gw-line ${result.codexServer.status === "connected" ? "muted" : "warn"}">Codex desktop: ${escapeHtml(result.codexServer.detail || "Check the desktop connection status.")}</p>` : ""}
    </div></div>`;
  }

  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${(s / 3600).toFixed(1)}h ago`;
  }

  // "Active now": per lane, the provider new and automatic sessions use, which
  // live sessions sit on which provider, and the last real request that went out.
  function directCount(st) {
    return gw.sessions.filter((s) => (s.agent === "claude" || s.agent === "codex") && !s.name.startsWith("login-") && !st.assignments[s.name]).length;
  }

  function activeNowHTML(st) {
    return `<section class="group gw-now" aria-label="Active providers">
      <div class="group-head"><h2>Active now</h2><span class="spacer"></span>${directCount(st) ? `<button class="btn btn-sm" data-act="adopt" title="Restart each direct session through the gateway on its own login and resume its conversation">Move ${directCount(st)} direct onto gateway</button>` : `<span class="small muted">everything runs through the gateway</span>`}</div>
      <div class="gw-now-grid">${LANES.map((lane) => {
        const def = st.routes.find((r) => r.id === st.defaults[lane.id]) || null;
        const sessions = gw.sessions.filter((s) => s.agent === lane.id && !s.name.startsWith("login-"));
        const byRoute = new Map();
        for (const s of sessions) {
          const a = st.assignments[s.name];
          const key = a ? (a.route || st.defaults[lane.id] || "—") : "direct";
          if (!byRoute.has(key)) byRoute.set(key, []);
          byRoute.get(key).push(s);
        }
        const groups = [...byRoute.entries()].sort((x, y) => (x[0] === "direct") - (y[0] === "direct") || y[1].length - x[1].length).map(([key, list]) => {
          const r = st.routes.find((item) => item.id === key);
          const label = key === "direct" ? "direct, own login" : r ? r.label : key;
          const dot = key === "direct" ? "" : routeHealth(r);
          return `<li><span class="rdot ${dot}"></span><b>${escapeHtml(label)}</b><span class="gw-now-sess mono">${list.map((s) => escapeHtml(s.name)).join(", ")}</span></li>`;
        }).join("");
        const last = st.log.find((e) => e.lane === lane.id && !e.session.startsWith("probe-") && e.outcome !== "cancelled");
        const lastLine = last
          ? `Last request ${ago(last.at)} via <b>${escapeHtml(st.routes.find((r) => r.id === last.route)?.label || last.route)}</b>${last.status >= 400 ? ` <span class="bad">· ${last.status === 429 ? "rate limited" : `HTTP ${last.status}`}</span>` : ""}`
          : "No requests through the gateway yet.";
        return `<div class="gw-now-lane">
          <div class="gw-title"><span class="tag ${lane.id}">${lane.label}</span>${def ? `<b>${escapeHtml(def.label)}</b>${healthTag(def)}` : `<b class="muted">no default provider</b>`}</div>
          <p class="gw-line muted">${def ? `Default: new and automatic sessions use this${def.account ? `, signed in as ${escapeHtml(def.account)}` : ""}.` : "Pick one with “Make default” below."}</p>
          ${groups ? `<ul class="gw-now-list">${groups}</ul>` : `<p class="gw-line muted">No ${lane.label} sessions running.</p>`}
          <p class="gw-line">${lastLine}</p>
        </div>`;
      }).join("")}</div>
    </section>`;
  }

  function render(root) {
    if (!gw.up) {
      root.innerHTML = `
        <div class="wrap">
          <header class="hero"><h1>Gateway</h1></header>
          <div class="empty"><h3>The gateway is offline</h3><p>${escapeHtml(gw.error || "")} Sessions started without it talk to their provider directly. Start it with <code>sudo systemctl start agent-gateway</code>.</p></div>
        </div>`;
      return;
    }
    const st = gw.state;
    const ready = st.routes.filter((r) => r.available).length;
    root.innerHTML = `
      <div class="wrap">
        <header class="hero gw-head">
          <h1>Gateway</h1>
          <p class="hero-sub">${escapeHtml(gw.url)}, up ${formatUptime(Math.round((st.now - st.startedAt) / 1000))}. ${ready} of ${st.routes.length} routes ready.</p>
          <label class="gw-auto"><span class="switch ${st.autoSwitch ? "on" : ""}" aria-hidden="true"></span><input type="checkbox" id="gw-auto" class="sr-only" ${st.autoSwitch ? "checked" : ""} /> Switch sessions automatically on rate limits and errors</label>
        </header>

        <p class="gw-policy gw-line muted"><a href="#routing">Routing</a> shows which provider each lane and session is on and lets you switch or restart sessions. Defaults apply to automatic gateway sessions on their next request. Pinned sessions keep their provider. When a login hits its usage limit, Devy fails over inside the gateway or restarts the session on the next signed-in account and resumes its conversation; sessions running directly are moved onto the gateway the same way.</p>
        ${codexStatusHTML(gw.codexServer)}
        <div id="gw-default-result" aria-live="polite">${defaultResultHTML()}</div>

        <section class="group">
          <div class="group-head"><h2>Accounts</h2><span class="spacer"></span><span class="small muted">Signing in opens a terminal; finish the login there.</span></div>
          <div class="gw-accounts" id="gw-accounts">${gw.accounts.map(accountCard).join("")}</div>
        </section>

        ${LANES.map((lane) => {
          const routes = st.order[lane.id].map((id) => st.routes.find((r) => r.id === id)).filter(Boolean);
          return `
          <section class="group">
            <div class="group-head"><h2>${lane.label} routes</h2><span class="count">${routes.length}</span><span class="spacer"></span><span class="small muted">tried in this order</span></div>
            <div class="list" data-lane="${lane.id}">${routes.map((r, i) => routeRow(r, i, routes.length)).join("")}</div>
          </section>`;
        }).join("")}

        <section class="group">
          <div class="group-head"><h2>Sessions</h2><span class="count">${gw.sessions.length}</span></div>
          <div class="list">${gw.sessions.length ? gw.sessions.map(sessionRow).join("") : `<div class="empty compact"><p>No tmux sessions.</p></div>`}</div>
        </section>

        <section class="group">
          <div class="group-head"><h2>Recent traffic</h2></div>
          <div class="gw-log-wrap">
            <table class="gw-log">
              <thead><tr><th>time</th><th>session</th><th>route</th><th>status</th><th>took</th><th>tokens in / out</th><th>model</th></tr></thead>
              <tbody>${st.log.length ? st.log.map(logRow).join("") : `<tr><td colspan="7" class="muted">Nothing yet.</td></tr>`}</tbody>
            </table>
          </div>
        </section>
        <div id="gw-probe" hidden></div>
      </div>
    `;
    wire(root);
  }

  async function act(root, label, fn, rerender = null) {
    if (busy.has(label)) return;
    busy.add(label);
    try {
      await fn();
      if (rerender) { await load(); if (document.body.contains(root)) rerender(root); }
      else await refresh(root);
    } catch (error) {
      toast(`${label}: ${error.message}`, "error");
    } finally {
      busy.delete(label);
    }
  }

  async function changeDefault(root, provider) {
    if (busy.has("default")) return;
    busy.add("default");
    root.querySelectorAll('[data-act="default"]').forEach((button) => { button.disabled = true; });
    const button = root.querySelector(`.gw-route[data-route="${provider.id}"] [data-act="default"]`);
    if (button) button.textContent = "Applying…";
    defaultResult = null;
    $("#gw-default-result", root).innerHTML = "";
    try {
      const result = await api("/api/gateway/settings", { method: "PUT", body: JSON.stringify({ defaults: { [provider.lane]: provider.id } }) });
      defaultResult = { label: provider.label, result };
      toast(`${provider.label} default saved`, "ok");
    } catch (error) {
      defaultResult = { error: error.message };
      toast(`Default change failed: ${error.message}`, "error");
    } finally {
      busy.delete("default");
      await refresh(root);
      $("#gw-default-result", root)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function wire(root) {
    wireController?.abort();
    wireController = new AbortController();
    const listenerOptions = { signal: wireController.signal };
    $("#gw-auto", root).addEventListener("change", (e) => {
      $(".gw-auto .switch", root)?.classList.toggle("on", e.target.checked);
      act(root, "auto-switch", () => api("/api/gateway/settings", { method: "PUT", body: JSON.stringify({ autoSwitch: e.target.checked }) }));
    });

    root.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const routeEl = btn.closest(".gw-route[data-route]");
      const acctEl = btn.closest(".gw-account[data-account]");
      const actName = btn.dataset.act;
      if (actName === "adopt" || actName === "codex-restart") return handleSharedAction(root, actName);
      if (routeEl) {
        const id = routeEl.dataset.route;
        const r = gw.state.routes.find((x) => x.id === id);
        const lane = gw.state.order[r.lane];
        const idx = lane.indexOf(id);
        if (actName === "toggle") return act(root, `toggle ${id}`, () => api(`/api/gateway/routes/${id}`, { method: "PUT", body: JSON.stringify({ enabled: !r.enabled }) }));
        if (actName === "default") return changeDefault(root, r);
        if (actName === "reset") return act(root, `reset ${id}`, () => api(`/api/gateway/routes/${id}/reset`, { method: "POST" }));
        if (actName === "up" || actName === "down") {
          const position = actName === "up" ? idx - 1 : idx + 1;
          return act(root, `move ${id}`, () => api(`/api/gateway/routes/${id}`, { method: "PUT", body: JSON.stringify({ position }) }));
        }
        if (actName === "test") return testRoute(root, r, btn);
      }
      if (acctEl) {
        const id = acctEl.dataset.account;
        if (actName === "login") {
          return act(root, `login ${id}`, async () => {
            const res = await api(`/api/gateway/accounts/${id}/login`, { method: "POST" });
            toast("Finish signing in inside the terminal", "ok");
            location.hash = `#terminal/${encodeURIComponent(res.session)}`;
          });
        }
        if (actName === "logout") {
          const ok = await confirmDialog({ title: `Sign out of ${id}?`, body: "Running sessions using this login will need to sign in again.", action: "Sign out", danger: true });
          if (!ok) return;
          return act(root, `logout ${id}`, () => api(`/api/gateway/accounts/${id}/logout`, { method: "POST" }));
        }
      }
    }, listenerOptions);

    root.addEventListener("change", (e) => {
      const el = e.target.closest("[data-act]");
      const row = e.target.closest("[data-session]");
      if (!el || !row) return;
      const session = row.dataset.session;
      if (el.dataset.act === "route") {
        act(root, `switch ${session}`, async () => {
          await Gateway.switchRoute(session, el.value);
          toast(`${session} → ${el.options[el.selectedIndex].text} on its next request`, "ok", { duration: 5000 });
        });
      }
      if (el.dataset.act === "mode") {
        act(root, `mode ${session}`, () => Gateway.setMode(session, el.checked ? "auto" : "pinned"));
      }
    }, listenerOptions);
  }

  async function testRoute(root, r, btn) {
    const box = $("#gw-probe", root);
    btn.disabled = true;
    btn.textContent = "Testing…";
    box.hidden = false;
    box.innerHTML = `<div class="panel"><div class="panel-pad"><span class="spinner"></span> Testing <b>${escapeHtml(r.label)}</b>${r.authType === "passthrough" ? " with the real client — this takes 10–60s" : ""}</div></div>`;
    try {
      const res = await api(`/api/gateway/routes/${r.id}/test`, { method: "POST" });
      box.innerHTML = `
        <div class="panel ${res.ok ? "gw-ok" : "gw-bad"}">
          <div class="panel-header"><h2>${res.ok ? "Works:" : "Failed:"} ${escapeHtml(r.label)}</h2><span class="spacer"></span><span class="small">${res.via === "client" ? "end-to-end via the real client" : "gateway → upstream"}, ${(res.ms / 1000).toFixed(1)}s${res.model ? `, ${escapeHtml(res.model)}` : ""}</span></div>
          <div class="panel-pad">
            ${res.error ? `<div class="gw-line bad">${escapeHtml(res.error)}</div>` : `<div class="gw-line">The route answered.</div>`}
            ${res.output ? `<pre class="excerpt">${escapeHtml(res.output)}</pre>` : ""}
          </div>
        </div>`;
      toast(res.ok ? `${r.label} works` : `${r.label} failed`, res.ok ? "ok" : "error");
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      box.innerHTML = `<div class="panel gw-bad"><div class="panel-pad">${escapeHtml(error.message)}</div></div>`;
    } finally {
      await refresh(root);
    }
  }

  // Re-render only when the page is still mounted; keep a visible probe result.
  async function refresh(root) {
    const probe = $("#gw-probe", root);
    const keep = probe && !probe.hidden ? probe.innerHTML : null;
    await load();
    if (!document.body.contains(root) || currentRoute().name !== "gateway") return;
    render(root);
    if (keep) {
      const box = $("#gw-probe", root);
      box.hidden = false;
      box.innerHTML = keep;
    }
  }

  async function handleSharedAction(root, actName, rerender = null) {
    if (actName === "adopt") {
      const n = directCount(gw.state);
      const ok = await confirmDialog({ title: `Move ${n} direct ${n === 1 ? "session" : "sessions"} onto the gateway?`, body: "Each CLI is stopped and relaunched in its tmux window through the gateway on the login it already uses, with its conversation resumed. A turn in progress is interrupted.", action: "Move & resume" });
      if (!ok) return;
      return act(root, "adopt", async () => {
        const res = await api("/api/gateway/adopt", { method: "POST", body: JSON.stringify({}) });
        const moved = res.results.filter((r) => r.ok).length;
        const failed = res.results.filter((r) => !r.ok && r.error);
        Gateway.invalidate();
        toast(`${moved} moved onto the gateway${failed.length ? `, ${failed.length} failed: ${failed.map((r) => `${r.session} (${r.error})`).join("; ")}` : ""}`, failed.length ? "error" : "ok", { duration: 8000 });
      }, rerender);
    }
    if (actName === "codex-restart") {
      const ok = await confirmDialog({ title: "Restart the Codex desktop server?", body: "The app-server daemon behind the Codex desktop app is interrupted; the desktop reconnects and reloads threads with the current provider. Nothing is lost on disk.", action: "Restart" });
      if (!ok) return;
      return act(root, "codex-restart", async () => {
        const res = await api("/api/gateway/codex-server/restart", { method: "POST" });
        toast(res.restarted ? `Codex server restarted (${res.restarted})` : "No Codex app-server daemon was running; the desktop starts it on demand", "ok", { duration: 6000 });
      }, rerender);
    }
  }

  // ── Routing page: per-session provider, switch or restart ────────────────
  function routingSessionRow(s) {
    const st = gw.state;
    const lane = s.agent === "claude" || s.agent === "codex" ? s.agent : null;
    if (!lane) return "";
    const a = st.assignments[s.name] || null;
    const currentId = a ? (a.route || st.defaults[lane]) : null;
    const current = currentId ? st.routes.find((r) => r.id === currentId) : null;
    const options = st.order[lane].map((id) => st.routes.find((r) => r.id === id)).filter(Boolean).map((r) => {
      const signedIn = !r.account || Boolean(Gateway.account(r.account)?.signedIn);
      const usable = r.available && r.enabled !== false && signedIn;
      const live = a ? Gateway.eligible(r, a) : false;
      const relaunch = usable && !live;
      return `<option value="${r.id}" data-relaunch="${relaunch ? 1 : 0}" ${r.id === currentId ? "selected" : ""} ${usable ? "" : "disabled"}>${escapeHtml(r.label)}${!usable ? " (unavailable)" : relaunch ? " — restart" : ""}</option>`;
    }).join("");
    const status = a
      ? `<span class="rdot ${routeHealth(current)}"></span>${escapeHtml(current?.label || currentId || "—")}<span class="muted"> · ${a.mode === "auto" ? "auto-switch" : "pinned"}${a.account ? ` · ${escapeHtml(a.account)}` : ""}</span>`
      : `<span class="rdot"></span><span class="warn">Not via the gateway</span><span class="muted"> · own login, cannot fail over</span>`;
    return `
      <div class="gw-session rt-session" data-session="${escapeHtml(s.name)}" data-lane="${lane}">
        <div class="gw-session-name">
          <b>${escapeHtml(s.name)}</b>
          <span class="tag ${s.agent}">${escapeHtml(s.agent)}</span>
          <span class="tag ${s.state}">${stateLabels[s.state] || s.state}</span>
        </div>
        <span class="gw-line rt-status">${status}</span>
        <div class="rt-actions">
          <select data-act="route" aria-label="Provider for ${escapeHtml(s.name)}">${a ? "" : `<option value="" selected disabled>Move onto the gateway…</option>`}${options}</select>
          ${a ? `<label class="gw-check"><input type="checkbox" data-act="mode" ${a.mode === "auto" ? "checked" : ""} /> auto</label>` : ""}
          <button class="btn btn-sm btn-ghost" data-act="restart" title="Relaunch the CLI in its tmux window through the gateway and resume its conversation">Restart</button>
          <a class="btn btn-sm btn-ghost" href="#terminal/${encodeURIComponent(s.name)}">Terminal</a>
        </div>
      </div>`;
  }

  function renderRouting(root) {
    if (!gw.up) {
      root.innerHTML = `<div class="wrap"><header class="hero"><h1>Routing</h1></header><div class="empty"><h3>The gateway is offline</h3><p>${escapeHtml(gw.error || "")} Start it with <code>sudo systemctl start agent-gateway</code>.</p></div></div>`;
      return;
    }
    const st = gw.state;
    const sessions = gw.sessions.filter((s) => (s.agent === "claude" || s.agent === "codex") && !s.name.startsWith("login-"));
    root.innerHTML = `
      <div class="wrap">
        <header class="hero gw-head">
          <h1>Routing</h1>
          <p class="hero-sub">Which provider answers each lane and each session. Pick a provider to switch; options marked <b>restart</b> relaunch the CLI in place and resume its conversation.</p>
          <label class="gw-auto"><span class="switch ${st.autoSwitch ? "on" : ""}" aria-hidden="true"></span><input type="checkbox" id="gw-auto" class="sr-only" ${st.autoSwitch ? "checked" : ""} /> Fail over automatically on usage limits and errors</label>
        </header>
        ${activeNowHTML(st)}
        ${codexStatusHTML(gw.codexServer)}
        <section class="group">
          <div class="group-head"><h2>Sessions</h2><span class="count">${sessions.length}</span><span class="spacer"></span><a class="small" href="#gateway">Accounts &amp; route order →</a></div>
          <div class="list">${sessions.length ? sessions.map(routingSessionRow).join("") : `<div class="empty compact"><p>No Claude Code or Codex sessions running.</p></div>`}</div>
        </section>
      </div>`;
    wireRouting(root);
  }

  function wireRouting(root) {
    wireController?.abort();
    wireController = new AbortController();
    const listenerOptions = { signal: wireController.signal };
    $("#gw-auto", root).addEventListener("change", (e) => {
      $(".gw-auto .switch", root)?.classList.toggle("on", e.target.checked);
      act(root, "auto-switch", () => api("/api/gateway/settings", { method: "PUT", body: JSON.stringify({ autoSwitch: e.target.checked }) }), renderRouting);
    }, listenerOptions);
    root.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const row = btn.closest("[data-session]");
      const actName = btn.dataset.act;
      if (actName === "adopt" || actName === "codex-restart") return handleSharedAction(root, actName, renderRouting);
      if (actName === "restart" && row) {
        const session = row.dataset.session;
        const ok = await confirmDialog({ title: `Restart ${session}?`, body: "The CLI is stopped and relaunched in the same tmux window through the gateway, with its conversation resumed. A turn in progress is interrupted.", action: "Restart & resume" });
        if (!ok) return;
        return act(root, `restart ${session}`, async () => {
          const res = await api(`/api/sessions/${encodeURIComponent(session)}/relaunch`, { method: "POST", body: JSON.stringify({}) });
          Gateway.invalidate();
          toast(`${session} restarted${res.conversationId ? ", conversation resumed" : ""}`, "ok", { duration: 6000 });
        }, renderRouting);
      }
    }, listenerOptions);
    root.addEventListener("change", async (e) => {
      const el = e.target.closest("[data-act]");
      const row = e.target.closest("[data-session]");
      if (!el || !row) return;
      const session = row.dataset.session;
      if (el.dataset.act === "route") {
        const opt = el.options[el.selectedIndex];
        const r = gw.state.routes.find((x) => x.id === el.value);
        if (!r) return;
        if (opt.dataset.relaunch === "1") {
          const ok = await confirmDialog({ title: `Restart ${session} on ${r.label}?`, body: "The CLI is stopped and relaunched in the same tmux window through the gateway on this provider, with its conversation resumed. A turn in progress is interrupted.", action: "Restart & resume" });
          if (!ok) { renderRouting(root); return; }
          return act(root, `switch ${session}`, async () => {
            const res = await api(`/api/sessions/${encodeURIComponent(session)}/relaunch`, { method: "POST", body: JSON.stringify({ route: r.id }) });
            Gateway.invalidate();
            toast(`${session} restarted on ${r.label}${res.conversationId ? ", conversation resumed" : ""}`, "ok", { duration: 6000 });
          }, renderRouting);
        }
        return act(root, `switch ${session}`, async () => {
          await Gateway.switchRoute(session, r.id);
          toast(`${session} → ${r.label} on its next request`, "ok", { duration: 5000 });
        }, renderRouting);
      }
      if (el.dataset.act === "mode") act(root, `mode ${session}`, () => Gateway.setMode(session, el.checked ? "auto" : "pinned"), renderRouting);
    }, listenerOptions);
  }

  route("routing", {
    title: "Routing",
    skeleton: () => `<div class="wrap"><div class="skeleton sk-line" style="width:30%;height:28px"></div><div class="skeleton sk-line" style="width:55%"></div>${[1, 2, 3].map(() => `<div class="skeleton sk-row" style="height:88px;margin-top:10px"></div>`).join("")}</div>`,
    async render(root) {
      clearInterval(pollTimer);
      await load();
      renderRouting(root);
      pollTimer = setInterval(() => {
        if (document.hidden || currentRoute().name !== "routing" || busy.size) return;
        if (document.activeElement?.tagName === "SELECT" && root.contains(document.activeElement)) return;
        load().then(() => { if (currentRoute().name === "routing" && document.body.contains(root)) renderRouting(root); }).catch(() => {});
      }, 6000);
    },
    leave() { clearInterval(pollTimer); wireController?.abort(); }
  });
  if (location.hash.startsWith("#routing")) navigate();

  route("gateway", {
    title: "Gateway",
    skeleton: () => `<div class="wrap"><div class="skeleton sk-line" style="width:30%;height:28px"></div><div class="skeleton sk-line" style="width:55%"></div>${[1, 2, 3, 4].map(() => `<div class="skeleton sk-row" style="height:88px;margin-top:10px"></div>`).join("")}</div>`,
    async render(root) {
      clearInterval(pollTimer);
      await load();
      render(root);
      pollTimer = setInterval(() => {
        if (document.hidden || currentRoute().name !== "gateway" || busy.size) return;
        // Don't yank a <select> out from under an open dropdown.
        if (document.activeElement?.tagName === "SELECT" && root.contains(document.activeElement)) return;
        refresh(root).catch(() => {});
      }, 6000);
    },
    leave() { clearInterval(pollTimer); wireController?.abort(); }
  });

  // app.js already navigated before this module registered the page; a deep
  // link to #gateway would otherwise land on Sessions.
  if (location.hash.startsWith("#gateway")) navigate();

  // Kept for older callers: routes for a lane, from the shared cache.
  window.gatewayRoutesFor = async function gatewayRoutesFor(lane) {
    try {
      await Gateway.state();
      return Gateway.routes(lane).filter((r) => r.available)
        .map((r) => ({ id: r.id, label: r.label, isDefault: r.isDefault, account: r.account ? Gateway.account(r.account) : null }));
    } catch {
      return [];
    }
  };
})();
