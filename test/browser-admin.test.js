'use strict';
// Real-browser tests for admin-only views that need a realistic multi-team,
// multi-opponent fixture to actually catch bugs — test/browser.test.js's
// fixture (2 teams, 1 division) can't distinguish the matrix pairKey bug from
// correct behavior, since with only one possible matchup even the broken
// version happens to look right. Uses the same seed script + real scheduler
// run Ted's dev environment uses, so these checks reflect what he actually saw.
//
// Run with: npm run test:ui:admin (needs `npx playwright install chromium` once)

const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.UI_ADMIN_PORT || 3132);
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok  = (n, x) => { pass++; console.log(`  PASS: ${n}${x ? ` (${x})` : ''}`); };
const bad = (n, w) => { fail++; console.log(`  ** FAIL: ${n} — ${w}`); };

function startServer() {
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ADMIN_EMAIL: 'admin@example.com',
           ADMIN_PASSWORD: 'testpass', SESSION_SECRET: 'adminui', RESEND_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server did not start')), 15000);
    srv.stdout.on('data', d => {
      if (d.toString().includes('running at')) { clearTimeout(to); resolve(srv); }
    });
    srv.stderr.on('data', d => process.env.UI_DEBUG && console.error('[srv]', d.toString()));
  });
}

(async () => {
  // Real seed (10 programs, 40 teams, real fields) + a real scheduleAll() run —
  // same shape as Ted's dev environment, so a division has several teams with
  // genuinely different opponents and different per-pair game counts.
  execSync('node scripts/seed-full-registration-stage.js > season.json', { cwd: ROOT });
  const { scheduleAll } = require(path.join(ROOT, 'lib/scheduler'));
  const seasonData = JSON.parse(fs.readFileSync(path.join(ROOT, 'season.json'), 'utf8'));
  const res = scheduleAll(seasonData);
  fs.writeFileSync(path.join(ROOT, 'schedule.json'), JSON.stringify({
    games: res.games, failures: res.failures || [], warnings: res.warnings || [],
    generated_at: new Date().toISOString(), total_games: (res.games || []).length,
  }, null, 2));

  const srv = await startServer();
  const browser = await chromium.launch();

  try {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await p.fill('#email-input', 'admin@example.com');
    await p.click('#continue-btn');
    await p.waitForTimeout(600);
    await p.fill('#pw-input', 'testpass');
    await p.click('#signin-btn');
    await p.waitForLoadState('networkidle');

    await p.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(500);

    // ── Matrix view: cells must differ, not all show the division total ────
    const matrixBtn = p.locator('button:has-text("Matrix"), [data-view="matrix"]').first();
    if (await matrixBtn.count()) {
      await matrixBtn.click();
      await p.waitForTimeout(500);
      const cellTexts = await p.locator('.matrix-cell .matrix-count').allTextContents();
      const nonZero = cellTexts.filter(t => t.trim() && t.trim() !== '0');
      const distinctValues = new Set(nonZero.map(t => t.trim()));
      nonZero.length > 0 && distinctValues.size > 1
        ? ok('matrix cells show different per-opponent counts', `${distinctValues.size} distinct values across ${nonZero.length} cells`)
        : bad('matrix cells are all identical (NaN pairKey bug)', `values: ${[...distinctValues].join(',')}`);
    } else {
      bad('matrix view button not found', '');
    }

    // ── Calendar view: real season months, not hardcoded spring 2026 ────────
    const calBtn = p.locator('button:has-text("Calendar"), [data-view="calendar"]').first();
    if (await calBtn.count()) {
      await calBtn.click();
      await p.waitForTimeout(500);
      const monthLabels = await p.locator('.cal-month-label').allTextContents();
      const seasonStart = seasonData.season.start; // e.g. "2026-08-31"
      const expectedMonth = new Date(seasonStart + 'T00:00:00Z')
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      monthLabels.some(l => l.includes(expectedMonth))
        ? ok('admin calendar shows the actual season\'s month', monthLabels.join(', '))
        : bad('admin calendar does not match the season', `expected "${expectedMonth}", got: ${monthLabels.join(', ')}`);
      monthLabels.some(l => /April 2026|May 2026|June 2026/.test(l))
        ? bad('old hardcoded spring-2026 calendar still showing', monthLabels.join(', '))
        : ok('no trace of the old hardcoded admin calendar range');
    } else {
      bad('admin calendar view button not found', '');
    }

    errs.length === 0
      ? ok('no JS errors in the admin matrix/calendar views')
      : bad('JS errors in admin views', errs.slice(0, 2).join(' | '));

    // ── Request Change no longer crashes on the coach page ──────────────────
    const coachCtx = await browser.newContext();
    const cp = await coachCtx.newPage();
    const coachErrs = [];
    cp.on('pageerror', e => coachErrs.push(e.message));
    const someTeam = seasonData.teams[0];
    await cp.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await cp.fill('#email-input', someTeam.email);
    await cp.click('#continue-btn');
    await cp.waitForTimeout(600);
    await cp.goto(`${BASE}/my-team`, { waitUntil: 'networkidle' });
    await cp.waitForTimeout(500);
    const reqBtn = cp.locator('button:has-text("Request Change")').first();
    if (await reqBtn.count()) {
      await reqBtn.click();
      await cp.waitForTimeout(500);
      const formOpened = await cp.locator('#cr-form:not(.hidden)').count();
      formOpened > 0
        ? ok('Request Change opens the form without crashing')
        : bad('Request Change form did not open', '');
      coachErrs.length === 0
        ? ok('no JS errors clicking Request Change')
        : bad('JS error clicking Request Change', coachErrs.join(' | '));
    } else {
      ok('no games scheduled for this team yet to test Request Change on (not a failure)');
    }
  } catch (e) {
    bad('browser run threw', e.message);
  } finally {
    await browser.close();
    srv.kill();
    for (const f of ['season.json', 'schedule.json', 'change_requests.json', 'changes.json']) {
      try { fs.unlinkSync(path.join(ROOT, f)); } catch {}
    }
    try { fs.rmSync(path.join(ROOT, 'snapshots'), { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
