#!/usr/bin/env bash
set -u

cd /home/ubuntu/apps/devy || exit 1

while true; do
  echo "===== $(date -Is) agent-sessions smoke ====="
  curl -fsS http://127.0.0.1:8790/api/health || true
  echo
  curl -fsS http://127.0.0.1:8790/api/system \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(`system cpu=${j.load1}/${j.cpuCount} mem=${j.memory.usedPercent}% disk=${j.disk.usedPercent}%`)})' || true
  curl -fsS http://127.0.0.1:8790/api/sessions \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(j.sessions.map(x=>`${x.name}:${x.state}:${x.agent}`).join("\n"))})' || true

  node - <<'NODE' || true
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/snap/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3
  });
  const failures = [];
  page.on('dialog', async (dialog) => {
    failures.push(dialog.message());
    await dialog.dismiss();
  });
  page.on('response', async (response) => {
    if (response.url().includes('/api/sessions/') && response.request().method() === 'POST' && response.status() >= 400) {
      failures.push(`${response.status()} ${await response.text().catch(() => '')}`);
    }
  });
  await page.goto(`http://127.0.0.1:8790/?loop=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const metrics = await page.evaluate(() => {
    const screen = document.querySelector('.terminal-screen');
    return {
      viewport: document.documentElement.clientWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      hasTerminal: !!screen,
      hasTerminalInput: !!document.querySelector('.terminal-input'),
      hasStats: !!document.querySelector('.stats-strip'),
      statCards: document.querySelectorAll('.stats-strip span').length,
      hasStop: !!document.querySelector('.stop-session'),
      hasUpdateBanner: !!document.querySelector('#update-banner'),
      atBottom: screen ? Math.abs(screen.scrollHeight - screen.clientHeight - screen.scrollTop) < 4 : false,
      overflowOffenders: [...document.querySelectorAll('*')].filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (r.right > document.documentElement.clientWidth + 1 || r.left < -1 || r.width > document.documentElement.clientWidth + 1) && style.overflowX !== 'auto';
      }).length
    };
  });
  console.log(JSON.stringify({ metrics, failures }, null, 2));
  await browser.close();
})();
NODE

  echo
  sleep "${AGENT_SESSIONS_TEST_INTERVAL:-60}"
done
