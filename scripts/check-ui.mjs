// Against a running Devy instance. All writes and terminal sockets are mocked.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const base = process.env.DEVY_TEST_URL || "http://127.0.0.1:8787";
const artifacts = process.env.DEVY_TEST_ARTIFACTS;
if (artifacts) await mkdir(artifacts, { recursive: true });

function fixtures() {
  const sessions = [
    { name: "devy-ui-fixture", agent: "claude", state: "waiting_for_input", running: true,
      paneCommand: "claude", paneCurrentPath: "/home/ubuntu", paneTitle: "Test",
      lastOutput: "Waiting for input", outputHash: "fixture", git: {} },
    { name: "pinned-fixture", agent: "claude", state: "running", running: true,
      paneCommand: "claude", paneCurrentPath: "/home/ubuntu", lastOutput: "Working", git: {} },
    { name: "direct-fixture", agent: "codex", state: "running", running: true,
      paneCommand: "codex", paneCurrentPath: "/home/ubuntu", lastOutput: "Working", git: {} }
  ];
  const accounts = ["claude-personal", "claude-business", "chatgpt-personal", "chatgpt-business"].map((id) => ({
    id, label: id, lane: id.startsWith("claude") ? "claude" : "codex", signedIn: true,
    detail: "Fixture login", dir: `/home/ubuntu/.devy/accounts/${id}`, loginSession: `login-${id}`
  }));
  const routes = [
    { id: "claude-personal", lane: "claude", label: "Claude default account", authType: "passthrough", account: "claude-personal" },
    { id: "claude-api", lane: "claude", label: "Anthropic API", authType: "x-api-key", account: null },
    { id: "codex-azure", lane: "codex", label: "Azure OpenAI", authType: "api-key", account: null }
  ].map((route) => ({ ...route, provider: route.label, description: "Browser test fixture", enabled: true,
    available: true, unavailableReason: null, health: { status: "ok", cooling: false, reason: null, limits: {} },
    counters: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }));
  const gateway = {
    up: true, url: "http://127.0.0.1:8791", accounts, sessions,
    codexServer: { status: "restart-required", detail: "Reconnect Codex desktop to route new tasks through the gateway.", configuredProvider: "azure", loadedDirectCount: 2 },
    state: { ok: true, now: Date.now(), startedAt: Date.now() - 60_000, autoSwitch: true,
      defaults: { claude: "claude-personal", codex: "codex-azure" },
      order: { claude: ["claude-personal", "claude-api"], codex: ["codex-azure"] }, routes,
      assignments: {
        "devy-ui-fixture": { lane: "claude", route: "claude-personal", mode: "auto", account: "claude-personal" },
        "pinned-fixture": { lane: "claude", route: "claude-personal", mode: "pinned", account: "claude-personal" }
      }, log: [] }
  };
  return { sessions, gateway };
}

async function assertFitsViewport(page, label) {
  const size = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(size.content <= size.width + 1, `${label}: ${size.content}px content overflows ${size.width}px viewport`);
  if (artifacts) {
    if (label === "Gateway default result") await page.locator("#page-root").evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: path.join(artifacts, `${size.width}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`), fullPage: true,
      animations: "disabled", style: "#toasts { visibility: hidden !important; }" });
  }
}

const browser = await chromium.launch({
  executablePath: process.env.DEVY_TEST_BROWSER || undefined,
  headless: true,
  args: ["--no-sandbox"]
});
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    const { sessions, gateway } = fixtures();
    let failDefault = false;
    let releaseDefault;
    let holdDefault = true;
    let releaseInput;
    page.on("pageerror", (error) => errors.push(error.message));
    await context.addInitScript(() => localStorage.setItem("agentOpsToken", "stale-test-token"));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname.replace(/^\/remote(?=\/api\/)/, "");
      if (request.method() === "GET") {
        if (pathname === "/api/gateway/state") {
          gateway.state.now = Date.now();
          for (const provider of gateway.state.routes) provider.isDefault = gateway.state.defaults[provider.lane] === provider.id;
          return route.fulfill({ json: gateway });
        }
        if (pathname === "/api/health") {
          const response = await route.fetch();
          // Also test opening Settings before global health polling finishes.
          await new Promise((resolve) => setTimeout(resolve, 150));
          return route.fulfill({ json: { ...await response.json(), authentication: "cloudflare", tokenRequired: false, agentInputEnabled: true } });
        }
        if (pathname === "/api/status" || pathname === "/api/sessions") {
          const response = await route.fetch();
          return route.fulfill({ json: { ...await response.json(), sessions } });
        }
        return route.continue();
      }
      const body = request.postDataJSON();
      writes.push({ pathname, body, authorization: request.headers().authorization });
      if (pathname === "/api/gateway/settings") {
        if (holdDefault) await new Promise((resolve) => { releaseDefault = resolve; });
        if (failDefault) return route.fulfill({ status: 400, json: { error: "Simulated default change failure" } });
        if (body.defaults) {
          Object.assign(gateway.state.defaults, body.defaults);
          gateway.state.assignments["devy-ui-fixture"].route = null;
        }
        if (typeof body.autoSwitch === "boolean") gateway.state.autoSwitch = body.autoSwitch;
        return route.fulfill({ json: { ok: true, defaults: gateway.state.defaults, autoSwitch: gateway.state.autoSwitch,
          appliedSessions: ["devy-ui-fixture"], blockedSessions: [{ session: "pinned-fixture", reason: "Pinned to a provider" }], codexServer: gateway.codexServer } });
      }
      if (pathname.startsWith("/api/gateway/sessions/")) {
        Object.assign(gateway.state.assignments[pathname.split("/").at(-1)], body);
        return route.fulfill({ json: { ok: true } });
      }
      if (pathname.endsWith("/input")) {
        await new Promise((resolve) => { releaseInput = resolve; });
        return route.fulfill({ status: 503, json: { error: "Simulated send failure" } });
      }
      return route.fulfill({ json: { ok: true, session: "devy-ui-fixture" } });
    });

    await page.goto(`${base}/#settings`);
    await page.waitForFunction(() => window.Devy?.State.health?.authentication === "cloudflare");
    await page.locator(".settings").waitFor();
    assert.equal(await page.locator("#token-input").count(), 0, "Cloudflare Settings must not request a token");
    await assertFitsViewport(page, "Settings");

    for (const account of ["claude-personal", "claude-business", "chatgpt-personal", "chatgpt-business"]) {
      await page.goto(`${base}/#gateway`);
      const button = page.locator(`.gw-account[data-account="${account}"] [data-act="login"]`);
      await button.waitFor();
      await page.waitForFunction(() => window.Devy?.State.health?.authentication === "cloudflare");
      const before = writes.length;
      await button.click();
      await page.waitForURL("**/#terminal/devy-ui-fixture");
      assert.equal(writes.length - before, 1, `one login request for ${account}`);
      assert.equal(writes.at(-1).pathname, `/api/gateway/accounts/${account}/login`);
      assert.equal(writes.at(-1).authorization, undefined, "Cloudflare login must not send the stored write token");
    }

    await page.goto(`${base}/#gateway`);
    const defaultButton = page.locator('.gw-route[data-route="claude-api"] [data-act="default"]');
    await defaultButton.waitFor();
    const beforeDefault = writes.length;
    await defaultButton.click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-act="default"]')].every((button) => button.disabled));
    while (!releaseDefault) await page.waitForTimeout(10);
    await defaultButton.evaluate((button) => button.click());
    assert.equal(writes.length - beforeDefault, 1, "busy default button cannot submit duplicate writes");
    holdDefault = false;
    releaseDefault();
    await page.locator('.gw-route[data-route="claude-api"].is-default').waitFor();
    assert.equal(writes.length - beforeDefault, 1, "default change submits exactly one request");
    assert.deepEqual(writes.at(-1).body, { defaults: { claude: "claude-api" } });
    assert.equal(writes.at(-1).authorization, undefined, "default change uses verified Cloudflare access");
    assert.equal(await page.locator('.gw-session[data-session="devy-ui-fixture"] select').inputValue(), "claude-api");
    assert.equal(await page.locator('.gw-session[data-session="pinned-fixture"] select').inputValue(), "claude-personal");
    await page.locator("#gw-default-result").getByText(/1 automatic session will follow this default on its next request/).waitFor();
    assert.match(await page.locator("#gw-default-result").innerText(), /pinned-fixture: Pinned to a provider/);
    assert.match(await page.locator(".gw-desktop").innerText(), /Reconnect needed/);
    assert.match(await page.locator(".gw-desktop").innerText(), /2 loaded tasks still use their direct provider/);
    await assertFitsViewport(page, "Gateway default result");

    failDefault = true;
    await page.locator('.gw-route[data-route="claude-personal"] [data-act="default"]').click();
    await page.locator("#toasts").getByText(/Simulated default change failure/).waitFor();
    assert.equal(await page.locator('.gw-route[data-route="claude-api"].is-default').count(), 1, "failed default change keeps the previous selection");
    assert.equal(gateway.state.defaults.claude, "claude-api");
    failDefault = false;
    const beforeReapply = writes.length;
    await page.locator('.gw-route[data-route="claude-api"] [data-act="default"]').click();
    await page.locator("#gw-default-result").getByText(/1 automatic session will follow/).waitFor();
    assert.equal(writes.length - beforeReapply, 1, "the current default can be reapplied to existing sessions");

    await page.goto(`${base}/#sessions`);
    const input = page.locator('.reply[data-session="devy-ui-fixture"] input');
    await input.waitFor();
    await input.fill("First draft");
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector('.reply[data-session="devy-ui-fixture"]')?.dataset.busy);
    // Await the actual intercepted request before releasing the response.
    while (!releaseInput) await page.waitForTimeout(10);
    await input.fill("Newer draft");
    releaseInput();
    await page.waitForFunction(() => !document.querySelector('.reply[data-session="devy-ui-fixture"]')?.dataset.busy);
    assert.equal(await input.inputValue(), "Newer draft", "failed sends must preserve newer text");
    await assertFitsViewport(page, "Sessions");

    await page.goto(`${base}/#terminal/login-chatgpt-business`);
    await page.waitForURL("**/#gateway");

    await page.goto(`${base}/remote/`);
    await page.waitForFunction(() => document.querySelector("#open-token")?.hidden);
    assert.equal(await page.locator("#open-token").isVisible(), false);
    const card = page.locator('.card[data-session="devy-ui-fixture"]');
    await card.locator(".compose").waitFor();
    await assertFitsViewport(page, "Remote manager expanded session");
    await card.locator(".route-chip").click();
    await card.locator('.route-option[data-route="claude-personal"]').click();
    await page.locator("#toasts").getByText(/from its next request/).waitFor();
    assert.equal(writes.at(-1).pathname, "/api/gateway/sessions/devy-ui-fixture");
    assert.deepEqual(writes.at(-1).body, { route: "claude-personal" });
    assert.equal(writes.at(-1).authorization, undefined, "manager switching also uses verified Cloudflare access");

    await page.locator("#new-session").click();
    await page.locator("#create-dialog[open]").waitFor();
    assert.equal(await page.locator('#create-form select[name="route"]').inputValue(), "claude-api");
    await assertFitsViewport(page, "Remote manager create dialog");
    await page.locator("#create-dialog [data-close]").click();
    assert.deepEqual(errors, [], `browser errors at ${width}px`);
    console.log(`PASS ${width}px: Cloudflare auth, four login buttons, default success/failure, pinned sessions, reply draft, manager switching/creation, no overflow or browser errors`);
    await context.close();
  }
} finally {
  await browser.close();
}
