// ─── Gateway page ─────────────────────────────────────────────────────────
// Provider routing for Claude Code / Codex sessions: sign in to accounts,
// validate routes, switch a running session, and watch usage. Talks to
// /api/gateway/* which proxies the loopback gateway's admin API.
(function gatewayPage() {
  const { route, api, $, escapeHtml, toast, formatUptime, stateLabels, currentRoute, navigate } = window.Devy;
  const LANES = [
    { id: "claude", label: "Claude Code", client: "claude" },
    { id: "codex", label: "Codex", client: "codex" }
  ];
  let gw = null; // last /api/gateway/state payload
  let pollTimer = null;
  let busy = new Set();

  async function load() {
    gw = await api("/api/gateway/state");
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
    if (limits["anthropic-ratelimit-unified-5h-utilization"]) out.push(`5h ${pct(limits["anthropic-ratelimit-unified-5h-utilization"])}%`);
    if (limits["anthropic-ratelimit-unified-7d-utilization"]) out.push(`7d ${pct(limits["anthropic-ratelimit-unified-7d-utilization"])}%`);
    if (limits["anthropic-ratelimit-unified-status"] && limits["anthropic-ratelimit-unified-status"] !== "allowed") out.push(limits["anthropic-ratelimit-unified-status"]);
    if (limits["x-codex-primary-used-percent"]) out.push(`5h ${Math.round(Number(limits["x-codex-primary-used-percent"]))}%`);
    if (limits["x-codex-secondary-used-percent"]) out.push(`7d ${Math.round(Number(limits["x-codex-secondary-used-percent"]))}%`);
    if (limits["x-ratelimit-remaining-requests"]) out.push(`${limits["x-ratelimit-remaining-requests"]} req left`);
    if (limits["x-ratelimit-remaining-tokens"]) out.push(`${fmtTokens(Number(limits["x-ratelimit-remaining-tokens"]))} tok left`);
    if (!out.length && limits["retry-after"]) out.push(`retry after ${limits["retry-after"]}s`);
    return out.join(" · ");
  }

  function healthBadge(r) {
    if (!r.available) return `<span class="badge idle" title="${escapeHtml(r.unavailableReason || "disabled")}">${r.enabled ? "unavailable" : "off"}</span>`;
    const h = r.health;
    if (h.cooling) return `<span class="badge waiting_for_input" title="${escapeHtml(h.reason || "")}">cooling ${until(h.coolUntil)}</span>`;
    if (h.status === "error") return `<span class="badge error" title="${escapeHtml(h.reason || "")}">error</span>`;
    if (h.status === "ok") return `<span class="badge running">ok</span>`;
    return `<span class="badge unknown">untested</span>`;
  }

  function accountFor(id) {
    return (gw?.accounts || []).find((a) => a.id === id) || null;
  }

  function routeCard(r, index, count) {
    const c = r.counters || {};
    const acct = r.account ? accountFor(r.account) : null;
    const acctLine = acct
      ? `<div class="gw-line ${acct.signedIn ? "" : "warn"}">${acct.signedIn ? "●" : "○"} ${escapeHtml(acct.label)} — ${escapeHtml(acct.detail || (acct.signedIn ? "signed in" : "not signed in"))}</div>`
      : "";
    const limits = limitSummary(r.health.limits || {});
    const usage = c.requests
      ? `<div class="gw-line muted">${c.requests} req · ${c.errors} err · in ${fmtTokens(c.inputTokens)} · out ${fmtTokens(c.outputTokens)}${c.cacheReadTokens ? ` · cache ${fmtTokens(c.cacheReadTokens)}` : ""}</div>`
      : `<div class="gw-line muted">no traffic yet</div>`;
    return `
      <article class="gw-route ${r.isDefault ? "is-default" : ""} ${r.enabled ? "" : "is-off"}" data-route="${r.id}">
        <div class="gw-route-head">
          <div class="gw-route-title">
            <b>${escapeHtml(r.label)}</b>
            ${r.isDefault ? `<span class="badge accent">default</span>` : ""}
            ${healthBadge(r)}
          </div>
          <div class="gw-order">
            <button class="icon-btn" data-act="up" title="Try earlier" ${index === 0 ? "disabled" : ""}>↑</button>
            <button class="icon-btn" data-act="down" title="Try later" ${index === count - 1 ? "disabled" : ""}>↓</button>
          </div>
        </div>
        <div class="gw-line dim">${escapeHtml(r.provider)}</div>
        ${acctLine}
        ${limits ? `<div class="gw-line">${escapeHtml(limits)}</div>` : ""}
        ${usage}
        ${r.health.reason && (r.health.status === "error" || r.health.cooling) ? `<div class="gw-line bad mono">${escapeHtml(r.health.reason.slice(0, 160))}</div>` : ""}
        <div class="btn-row gw-actions">
          <button class="btn" data-act="test" ${r.available ? "" : "disabled"}>Test</button>
          <button class="btn" data-act="default" ${r.isDefault || !r.available ? "disabled" : ""}>Set default</button>
          <button class="btn btn-ghost" data-act="toggle">${r.enabled ? "Disable" : "Enable"}</button>
          ${r.health.cooling || r.health.status === "error" ? `<button class="btn btn-ghost" data-act="reset">Clear</button>` : ""}
        </div>
      </article>`;
  }

  function accountCard(a) {
    return `
      <article class="gw-account ${a.signedIn ? "on" : ""}" data-account="${a.id}">
        <div class="gw-route-title">
          <span class="dot ${a.signedIn ? "on" : ""}"></span>
          <b>${escapeHtml(a.label)}</b>
          <span class="badge ${a.lane}">${a.lane === "claude" ? "claude" : "codex"}</span>
        </div>
        <div class="gw-line ${a.signedIn ? "muted" : "warn"}">${escapeHtml(a.detail || (a.signedIn ? "signed in" : "not signed in"))}</div>
        <div class="gw-line dim mono" title="${escapeHtml(a.dir)}">${escapeHtml(a.dir.replace("/home/ubuntu", "~"))}</div>
        <div class="btn-row gw-actions">
          <button class="btn btn-primary" data-act="login">${a.signedIn ? "Re-sign in" : "Sign in"}</button>
          ${a.signedIn ? `<button class="btn btn-ghost" data-act="logout">Sign out</button>` : ""}
        </div>
      </article>`;
  }

  function sessionRow(s) {
    const lane = s.agent === "claude" || s.agent === "codex" ? s.agent : null;
    const a = gw.assignments?.[s.name];
    const routes = lane ? gw.state.routes.filter((r) => r.lane === lane) : [];
    const viaGateway = Boolean(a);
    const options = routes.map((r) => {
      const eligible = r.available && (r.authType !== "passthrough" || !a?.account || r.account === a.account);
      return `<option value="${r.id}" ${a?.route === r.id ? "selected" : ""} ${eligible ? "" : "disabled"}>${escapeHtml(r.label)}${eligible ? "" : " (n/a)"}</option>`;
    }).join("");
    return `
      <div class="gw-session" data-session="${escapeHtml(s.name)}">
        <div class="gw-session-name">
          <span class="badge ${s.state}">${stateLabels[s.state] || s.state}</span>
          <b>${escapeHtml(s.name)}</b>
          <span class="badge ${s.agent}">${escapeHtml(s.agent)}</span>
        </div>
        ${viaGateway ? `
          <select data-act="route" ${lane ? "" : "disabled"}>${options}</select>
          <label class="gw-check"><input type="checkbox" data-act="mode" ${a.mode === "auto" ? "checked" : ""} /> auto-switch</label>
          <span class="gw-line dim">${a.account ? `login: ${escapeHtml(a.account)}` : "no login (API-key routes only)"}</span>
        ` : `<span class="gw-line muted">not via gateway — started outside Devy or before the gateway existed; recreate it to route</span>`}
      </div>`;
  }

  function logRow(e) {
    const t = new Date(e.at);
    const status = e.status < 300 ? "ok" : e.status === 429 ? "warn" : "bad";
    return `<tr class="${status}">
      <td class="mono">${t.toLocaleTimeString([], { hour12: false })}</td>
      <td>${escapeHtml(e.session)}</td>
      <td>${escapeHtml(e.route)}${e.attempts > 1 ? ` <span class="badge waiting_for_input" title="${escapeHtml(e.error || "")}">failover ×${e.attempts}</span>` : ""}</td>
      <td class="mono">${e.status}</td>
      <td class="mono">${(e.ms / 1000).toFixed(1)}s</td>
      <td class="mono">${fmtTokens(e.inputTokens)}/${fmtTokens(e.outputTokens)}</td>
      <td class="mono dim" title="${escapeHtml(e.error || e.upstreamModel || "")}">${escapeHtml(e.upstreamModel && e.upstreamModel !== e.model ? `${e.model} → ${e.upstreamModel}` : e.model || "")}</td>
    </tr>`;
  }

  function render(root) {
    if (!gw.up) {
      root.innerHTML = `
        <div class="page-head"><h1>Gateway</h1></div>
        <div class="empty"><h3>Gateway is offline</h3><p>${escapeHtml(gw.error || "")}</p><p class="muted">Start it with <code>sudo systemctl start agent-gateway</code>. Sessions created without it talk to their provider directly.</p></div>`;
      return;
    }
    const st = gw.state;
    root.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Gateway</h1>
          <div class="sub">${escapeHtml(gw.url)} · up ${formatUptime(Math.round((st.now - st.startedAt) / 1000))} · ${st.routes.filter((r) => r.available).length} routes ready</div>
        </div>
        <label class="gw-check gw-auto"><input type="checkbox" id="gw-auto" ${st.autoSwitch ? "checked" : ""} /> Auto-switch on rate limits &amp; errors</label>
      </div>

      <div class="panel">
        <div class="panel-header"><h2>Accounts</h2><span class="spacer"></span><span class="muted small">Sign-in opens a terminal; finish the login there.</span></div>
        <div class="gw-grid" id="gw-accounts">${gw.accounts.map(accountCard).join("")}</div>
      </div>

      ${LANES.map((lane) => {
        const routes = st.order[lane.id].map((id) => st.routes.find((r) => r.id === id)).filter(Boolean);
        return `
        <div class="panel">
          <div class="panel-header"><h2>${lane.label} routes</h2><span class="spacer"></span><span class="muted small">order = failover order</span></div>
          <div class="gw-grid" data-lane="${lane.id}">${routes.map((r, i) => routeCard(r, i, routes.length)).join("")}</div>
        </div>`;
      }).join("")}

      <div class="panel">
        <div class="panel-header"><h2>Sessions</h2></div>
        <div class="gw-sessions">${gw.sessions.length ? gw.sessions.map(sessionRow).join("") : `<div class="empty"><p>No tmux sessions.</p></div>`}</div>
      </div>

      <div class="panel">
        <div class="panel-header"><h2>Recent traffic</h2></div>
        <div class="gw-log-wrap">
          <table class="gw-log">
            <thead><tr><th>time</th><th>session</th><th>route</th><th>status</th><th>took</th><th>in/out</th><th>model</th></tr></thead>
            <tbody>${st.log.length ? st.log.map(logRow).join("") : `<tr><td colspan="7" class="muted">nothing yet</td></tr>`}</tbody>
          </table>
        </div>
      </div>
      <div id="gw-probe" hidden></div>
    `;
    wire(root);
  }

  async function act(root, label, fn) {
    if (busy.has(label)) return;
    busy.add(label);
    try {
      await fn();
      await refresh(root);
    } catch (error) {
      toast(`${label}: ${error.message}`, "error");
    } finally {
      busy.delete(label);
    }
  }

  function wire(root) {
    $("#gw-auto", root).addEventListener("change", (e) =>
      act(root, "auto-switch", () => api("/api/gateway/settings", { method: "PUT", body: JSON.stringify({ autoSwitch: e.target.checked }) })));

    root.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const routeEl = btn.closest("[data-route]");
      const acctEl = btn.closest("[data-account]");
      const actName = btn.dataset.act;
      if (routeEl) {
        const id = routeEl.dataset.route;
        const r = gw.state.routes.find((x) => x.id === id);
        const lane = gw.state.order[r.lane];
        const idx = lane.indexOf(id);
        if (actName === "toggle") return act(root, `toggle ${id}`, () => api(`/api/gateway/routes/${id}`, { method: "PUT", body: JSON.stringify({ enabled: !r.enabled }) }));
        if (actName === "default") return act(root, `default ${id}`, () => api("/api/gateway/settings", { method: "PUT", body: JSON.stringify({ defaults: { [r.lane]: id } }) }));
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
            toast("Follow the sign-in steps in the terminal", "ok");
            location.hash = `#terminal/${encodeURIComponent(res.session)}`;
          });
        }
        if (actName === "logout") {
          if (!confirm(`Sign out of ${id}? Running sessions using this login will need to re-authenticate.`)) return;
          return act(root, `logout ${id}`, () => api(`/api/gateway/accounts/${id}/logout`, { method: "POST" }));
        }
      }
    });

    root.addEventListener("change", (e) => {
      const el = e.target.closest("[data-act]");
      const row = e.target.closest("[data-session]");
      if (!el || !row) return;
      const session = row.dataset.session;
      if (el.dataset.act === "route") {
        act(root, `switch ${session}`, async () => {
          await api(`/api/gateway/sessions/${encodeURIComponent(session)}`, { method: "PUT", body: JSON.stringify({ route: el.value }) });
          toast(`${session} → ${el.value} (applies to its next request)`, "ok");
        });
      }
      if (el.dataset.act === "mode") {
        act(root, `mode ${session}`, () => api(`/api/gateway/sessions/${encodeURIComponent(session)}`, { method: "PUT", body: JSON.stringify({ mode: el.checked ? "auto" : "pinned" }) }));
      }
    });
  }

  async function testRoute(root, r, btn) {
    const box = $("#gw-probe", root);
    btn.disabled = true;
    btn.textContent = "Testing…";
    box.hidden = false;
    box.innerHTML = `<div class="panel"><div class="panel-pad"><div class="spinner"></div> Testing <b>${escapeHtml(r.label)}</b>${r.authType === "passthrough" ? " with the real client (10–60s)…" : "…"}</div></div>`;
    try {
      const res = await api(`/api/gateway/routes/${r.id}/test`, { method: "POST" });
      box.innerHTML = `
        <div class="panel ${res.ok ? "gw-ok" : "gw-bad"}">
          <div class="panel-header"><h2>${res.ok ? "✓" : "✕"} ${escapeHtml(r.label)}</h2><span class="spacer"></span><span class="muted small">${res.via === "client" ? "end-to-end via real client" : "gateway → upstream"} · ${(res.ms / 1000).toFixed(1)}s${res.model ? ` · ${escapeHtml(res.model)}` : ""}</span></div>
          <div class="panel-pad">
            ${res.error ? `<div class="gw-line bad">${escapeHtml(res.error)}</div>` : `<div class="gw-line">Route works.</div>`}
            ${res.output ? `<pre class="preview">${escapeHtml(res.output)}</pre>` : ""}
          </div>
        </div>`;
      toast(res.ok ? `${r.label}: OK` : `${r.label}: failed`, res.ok ? "ok" : "error");
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      box.innerHTML = `<div class="panel gw-bad"><div class="panel-pad">${escapeHtml(error.message)}</div></div>`;
    } finally {
      await refresh(root);
    }
  }

  // Re-render only the parts that change on their own (health, usage, log, sessions).
  async function refresh(root) {
    const probe = $("#gw-probe", root);
    const keep = probe && !probe.hidden ? probe.innerHTML : null;
    await load();
    if (!document.body.contains(root)) return;
    render(root);
    if (keep) {
      const box = $("#gw-probe", root);
      box.hidden = false;
      box.innerHTML = keep;
    }
  }

  route("gateway", {
    title: "Gateway",
    async render(root) {
      clearInterval(pollTimer);
      await load();
      render(root);
      pollTimer = setInterval(() => {
        if (document.hidden || currentRoute().name !== "gateway" || busy.size) return;
        refresh(root).catch(() => {});
      }, 6000);
    }
  });

  // app.js already navigated before this module registered the page; a deep
  // link to #gateway would otherwise land on Sessions.
  if (location.hash.startsWith("#gateway")) navigate();

  // Exposed for the new-session modal: routes for a lane, cached from the last load.
  window.gatewayRoutesFor = async function gatewayRoutesFor(lane) {
    try {
      if (!gw) await load();
      if (!gw.up) return [];
      return gw.state.order[lane].map((id) => gw.state.routes.find((r) => r.id === id)).filter((r) => r && r.available)
        .map((r) => ({ id: r.id, label: r.label, isDefault: r.isDefault, account: r.account ? accountFor(r.account) : null }));
    } catch {
      return [];
    }
  };
})();
