// Against a running Devy instance. All writes and terminal sockets are mocked.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.DEVY_TEST_URL || "http://127.0.0.1:8787";
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
    let releaseInput;
    page.on("pageerror", (error) => errors.push(error.message));
    await context.addInitScript(() => localStorage.setItem("agentOpsToken", "stale-test-token"));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "GET") {
        if (pathname === "/api/health") {
          const response = await route.fetch();
          // Also test opening Settings before global health polling finishes.
          await new Promise((resolve) => setTimeout(resolve, 150));
          return route.fulfill({ json: { ...await response.json(), authentication: "cloudflare", tokenRequired: false } });
        }
        if (pathname === "/api/status") {
          const response = await route.fetch();
          return route.fulfill({ json: { ...await response.json(), sessions: [{
            name: "devy-ui-fixture", agent: "claude", state: "waiting_for_input", running: true,
            paneCommand: "claude", paneCurrentPath: "/home/ubuntu", paneTitle: "Test",
            lastOutput: "Waiting for input", outputHash: "fixture", git: {}
          }] } });
        }
        return route.continue();
      }
      writes.push({ pathname, authorization: request.headers().authorization });
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

    await page.goto(`${base}/#terminal/login-chatgpt-business`);
    await page.waitForURL("**/#gateway");

    await page.goto(`${base}/remote/`);
    await page.waitForFunction(() => document.querySelector("#open-token")?.hidden);
    assert.equal(await page.locator("#open-token").isVisible(), false);
    assert.deepEqual(errors, [], `browser errors at ${width}px`);
    console.log(`PASS ${width}px: Cloudflare token-free UI, four account login buttons, login completion, newer reply draft`);
    await context.close();
  }
} finally {
  await browser.close();
}
