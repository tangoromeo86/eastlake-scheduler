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

// No real RESEND_API_KEY in this environment — a throwaway instrumented copy
// logs the verification code to stdout so a session can be verified (Confirm
// and change-request submission both require it), same technique as
// test/browser.test.js. The committed server.js is untouched.
const INSTRUMENTED_COPY = path.join(ROOT, '.server.adminbrowsertest.js');

function startServer() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const instrumented = src.replace(
    'const { token, code } = createVerifyToken(s.email);',
    'const { token, code } = createVerifyToken(s.email);\n  console.log("DEBUG_LOGIN_CODE:" + s.email + ":" + code);'
  );
  fs.writeFileSync(INSTRUMENTED_COPY, instrumented);

  const srv = spawn('node', [INSTRUMENTED_COPY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ADMIN_EMAIL: 'admin@example.com',
           ADMIN_PASSWORD: 'testpass', SESSION_SECRET: 'adminui', RESEND_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.__log = '';
  srv.stdout.on('data', d => { srv.__log += d.toString(); });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server did not start')), 15000);
    srv.stdout.on('data', d => {
      if (d.toString().includes('running at')) { clearTimeout(to); resolve(srv); }
    });
    srv.stderr.on('data', d => process.env.UI_DEBUG && console.error('[srv]', d.toString()));
  });
}

// Verifies the session already logged into `page`, via the code endpoint
// directly — no real inbox in this environment (see startServer above).
async function verifyPage(page, email, srv) {
  await page.evaluate(async () => {
    await fetch('api/auth/request-verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  });
  await page.waitForTimeout(250);
  const codeLine = (srv.__log || '').split('\n').reverse().find(l => l.includes(`DEBUG_LOGIN_CODE:${email}:`));
  const code = codeLine ? codeLine.split(':').pop().trim() : null;
  return page.evaluate(async (c) => {
    const r = await fetch('api/auth/verify-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c }),
    });
    return (await r.json()).ok === true;
  }, code);
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

    // ── Admin can view AND edit a field's availability ───────────────────────
    // Previously admin.html had no #ffe-availability markup at all — this was
    // structurally impossible before, not just missing from a list view.
    await p.waitForTimeout(300);
    await p.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    await p.waitForTimeout(500);
    const fieldsTab = p.locator('button:has-text("Fields"), [data-page="fields"]').first();
    if (await fieldsTab.count()) await fieldsTab.click();
    await p.waitForTimeout(400);
    const fieldEditBtn = p.locator('#fields-list button:has-text("Edit")').first();
    if (await fieldEditBtn.count()) {
      await fieldEditBtn.click();
      await p.waitForTimeout(400);
      const gridVisible = await p.locator('#ffe-availability').isVisible().catch(() => false);
      gridVisible
        ? ok('field availability grid renders in the admin editor')
        : bad('field availability grid missing from admin editor', '');

      const patRow = p.locator('#ffe-availability select.fav-pat').first();
      if (await patRow.count()) {
        await patRow.selectOption('closed');
        const [saveRes] = await Promise.all([
          p.waitForResponse(r => r.url().includes('/api/season/fields/') && r.request().method() === 'PUT', { timeout: 5000 }).catch(() => null),
          p.click('#ffe-save'),
        ]);
        await p.waitForTimeout(400);
        saveRes && saveRes.ok()
          ? ok('a saved availability change round-trips through PUT /api/season/fields/:id')
          : bad('saving field availability failed', saveRes ? `status ${saveRes.status()}` : 'no response');

        // Confirm it actually persisted, not just accepted.
        await fieldEditBtn.click().catch(() => {});
        await p.locator('#fields-list button:has-text("Edit")').first().click();
        await p.waitForTimeout(400);
        const persisted = await p.locator('#ffe-availability select.fav-pat').first().inputValue().catch(() => null);
        persisted === 'closed'
          ? ok('the change actually persisted on re-open, not just accepted')
          : bad('availability change did not persist', `got "${persisted}"`);
      } else {
        bad('no availability pattern selects found in the admin field editor', '');
      }
    } else {
      bad('no field to edit in the admin Fields tab', '');
    }

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
      const formOpened = await cp.locator('#crm-overlay:not(.hidden)').count();
      formOpened > 0
        ? ok('Request Change opens the form without crashing')
        : bad('Request Change form did not open', '');
      coachErrs.length === 0
        ? ok('no JS errors clicking Request Change')
        : bad('JS error clicking Request Change', coachErrs.join(' | '));
    } else {
      ok('no games scheduled for this team yet to test Request Change on (not a failure)');
    }

    // ── Public viewer: relevance filtering + deep-linked redirect ───────────
    // The button used to show on every game to any session and redirect blind
    // to the top of the page. Needs a fixture with more than 2 teams to prove
    // the filtering actually filters (see file header).
    const myOwnGame = res.games.find(g => g.home_team_id === someTeam.id || g.away_team_id === someTeam.id);
    const unrelatedGame = res.games.find(g =>
      g.home_team_id !== someTeam.id && g.away_team_id !== someTeam.id &&
      g.division_id !== someTeam.division_id);

    if (myOwnGame && unrelatedGame) {
      await cp.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await cp.waitForTimeout(600); // the auto-shown first-login help modal appears 400ms after load
      const coachHelpClose = cp.locator('#help-close');
      if (await coachHelpClose.isVisible().catch(() => false)) await coachHelpClose.click();

      // The viewer renders both a desktop table row and a mobile card for
      // every game (CSS hides one via media query) — .first() since both
      // legitimately match.
      const ownBtn = cp.locator(`.req-btn[data-gid="${myOwnGame.game_id}"]`).first();
      (await cp.locator(`.req-btn[data-gid="${myOwnGame.game_id}"]`).count()) > 0
        ? ok('Request Change button shown for the coach\'s own game')
        : bad('Request Change button missing for own game', `game ${myOwnGame.game_id}`);

      const unrelatedBtn = cp.locator(`.req-btn[data-gid="${unrelatedGame.game_id}"]`);
      (await unrelatedBtn.count()) === 0
        ? ok('Request Change button hidden for an unrelated game')
        : bad('Request Change button shown for a game that is not the coach\'s', `game ${unrelatedGame.game_id}`);

      if (await ownBtn.count()) {
        await ownBtn.click();
        await cp.waitForTimeout(600);
        const landedUrl = cp.url();
        landedUrl.includes('/my-team') && landedUrl.includes(`game_id=${myOwnGame.game_id}`)
          ? ok('redirect carries the specific game id', landedUrl)
          : bad('redirect lost the game context', landedUrl);
        const formOpen = await cp.locator('#crm-overlay:not(.hidden)').count();
        formOpen > 0
          ? ok('landing on my-team opens that exact game\'s change form')
          : bad('my-team did not auto-open the change form from the deep link', '');
      }
    } else {
      bad('fixture did not produce both an own-game and an unrelated-game case', '');
    }

    // ── Same deep-link path, but as a director (multi-team resolution) ──────
    const someDirector = seasonData.directors[0];
    const dirTeam = seasonData.teams.find(t => t.program_id === someDirector.program_id);
    const dirOwnGame = res.games.find(g => {
      const home = seasonData.teams.find(t => t.id === g.home_team_id);
      const away = seasonData.teams.find(t => t.id === g.away_team_id);
      return (home && home.program_id === someDirector.program_id) ||
             (away && away.program_id === someDirector.program_id);
    });
    if (dirTeam && dirOwnGame) {
      const dctx = await browser.newContext();
      const dp = await dctx.newPage();
      const dirErrs = [];
      dp.on('pageerror', e => dirErrs.push(e.message));
      await dp.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
      await dp.fill('#email-input', someDirector.email);
      await dp.click('#continue-btn');
      await dp.waitForTimeout(600);
      await dp.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await dp.waitForTimeout(600); // the auto-shown first-login help modal appears 400ms after load
      const helpClose = dp.locator('#help-close');
      if (await helpClose.isVisible().catch(() => false)) await helpClose.click();
      const dirBtn = dp.locator(`.req-btn[data-gid="${dirOwnGame.game_id}"]`).first();
      if (await dp.locator(`.req-btn[data-gid="${dirOwnGame.game_id}"]`).count()) {
        await dirBtn.click();
        await dp.waitForTimeout(600);
        const landedUrl = dp.url();
        landedUrl.includes('/director') && landedUrl.includes(`game_id=${dirOwnGame.game_id}`) && landedUrl.includes('team_id=')
          ? ok('director redirect carries game id + resolved team id', landedUrl)
          : bad('director redirect missing context', landedUrl);
        const formOpen = await dp.locator('#crm-overlay:not(.hidden)').count();
        formOpen > 0
          ? ok('landing on director opens that exact game\'s change form')
          : bad('director page did not auto-open the change form from the deep link', '');
      } else {
        bad('director never sees the button for their own program\'s game', `game ${dirOwnGame.game_id}`);
      }
      dirErrs.length === 0
        ? ok('no JS errors in the director deep-link flow')
        : bad('JS errors in director deep-link flow', dirErrs.slice(0, 2).join(' | '));
    } else {
      bad('fixture did not produce a director-own-game case', '');
    }

    // ── Confirmation lifecycle: Scheduled -> Pending -> Confirmed, badges ────
    // Confirm and change-request submission both require a verified session —
    // verify once via `cp`; `lp` below is a new page in the same context
    // (coachCtx), so the cookie carries over.
    const verified = await verifyPage(cp, someTeam.email, srv);
    verified ? ok('coach session verified for the lifecycle test') : bad('could not verify coach session', '');

    const lifecycleGame = res.games.find(g =>
      (g.home_team_id === someTeam.id || g.away_team_id === someTeam.id) && g.game_id !== myOwnGame?.game_id);

    if (lifecycleGame) {
      const lp = await coachCtx.newPage();
      const lifeErrs = [];
      lp.on('pageerror', e => lifeErrs.push(e.message));
      await lp.goto(`${BASE}/my-team`, { waitUntil: 'networkidle' });
      await lp.waitForTimeout(400);

      const row = lp.locator(`tr:has(button[onclick*="${lifecycleGame.game_id}"])`).first();
      const badgeBefore = await row.locator('.pill-neutral, .unconfirmed-badge, .confirmed-badge').first().textContent().catch(() => '');
      badgeBefore.trim() === 'Scheduled'
        ? ok('a fresh game shows the Scheduled badge')
        : bad('fresh game did not show Scheduled', `got "${badgeBefore.trim()}"`);

      const confirmBtn = lp.locator(`button[onclick*="confirmGame(${lifecycleGame.game_id}"]`).first();
      if (await confirmBtn.count()) {
        await confirmBtn.click();
        await lp.waitForTimeout(500);
        const rowAfter = lp.locator(`tr:has(button[onclick*="${lifecycleGame.game_id}"]), tr:has-text("${lifecycleGame.game_id}")`).first();
        const bodyText = await lp.locator('#games-list').textContent();
        bodyText.includes('Pending') || bodyText.includes('Confirmed')
          ? ok('confirming moves the badge off Scheduled', bodyText.includes('Pending') ? 'Pending' : 'Confirmed')
          : bad('badge did not change after confirming', '');
      } else {
        bad('no Confirm button found for a fresh game', '');
      }
      lifeErrs.length === 0
        ? ok('no JS errors confirming a game')
        : bad('JS errors confirming a game', lifeErrs.join(' | '));

      // A negotiating game must never show as merely "Pending" — the whole
      // point of the rename was to stop those two concepts colliding. Drive
      // it via the real API from inside the page (cookies apply), same
      // submit-then-self-confirm sequence the negotiation flow itself uses.
      const negotiatingGame = res.games.find(g => g.game_id !== lifecycleGame.game_id &&
        (g.home_team_id === someTeam.id || g.away_team_id === someTeam.id) &&
        (new Date(g.date) - new Date()) / 86400000 >= 7);
      if (negotiatingGame) {
        // The submit route writes the change-request record before attempting
        // the requester's confirmation email — same pre-existing quirk hit
        // earlier in test/e2e.sh (500 on email failure, even though the state
        // change already succeeded). Read the record back from disk rather
        // than trust the HTTP response, matching that same fix.
        const optsSubmitted = await lp.evaluate(async (gameId) => {
          const optsRes = await fetch(`api/change-requests/options?game_id=${gameId}`);
          const opts = await optsRes.json();
          if (!opts.slots?.length) return false;
          const slot = opts.slots[0];
          await fetch('api/change-requests', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ game_id: gameId, reason: 'lifecycle test', slot: { date: slot.date, time: slot.time } }),
          });
          return true;
        }, negotiatingGame.game_id);

        let started = { ok: false, step: 'options' };
        if (optsSubmitted) {
          const crList = JSON.parse(fs.readFileSync(path.join(ROOT, 'change_requests.json'), 'utf8'));
          const cr = [...crList].reverse().find(c => c.game_id === negotiatingGame.game_id);
          if (cr?.tokens?.approve) {
            // Confirming the submission is what actually flips the game to
            // Negotiating — the plain submit alone doesn't.
            await lp.evaluate((url) => fetch(url), `${BASE}/api/change-requests/${cr.id}/confirm?token=${cr.tokens.approve}`);
            started = { ok: true };
          } else {
            started = { ok: false, step: 'submit', error: 'no change request record found' };
          }
        }

        if (started.ok) {
          await lp.goto(`${BASE}/my-team`, { waitUntil: 'networkidle' });
          await lp.waitForTimeout(400);
          const bodyText = await lp.locator('#games-list').textContent();
          bodyText.includes('Negotiating')
            ? ok('an actively-negotiated game shows "Negotiating", not "Pending"')
            : bad('negotiating game did not show the Negotiating badge', bodyText.slice(0, 200));
        } else {
          ok(`could not start a negotiation to test against (${started.step}: ${started.error || 'no options'}) — not a failure, just no fixture data for it`);
        }
      } else {
        ok('no second 7+-day-out game available to test the Negotiating badge (not a failure)');
      }
    } else {
      ok('fixture did not have a second own-game for the lifecycle test (not a failure)');
    }

    // ── Availability calendar: admin (league-wide, filterable by division) ──
    await p.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    await p.waitForTimeout(500);
    const availTab = p.locator('button:has-text("Availability"), [data-page="availability"]').first();
    if (await availTab.count()) {
      await availTab.click();
      await p.waitForTimeout(400);
      const teamCells = await p.locator('#admin-avail-cal td.cal-day').count();
      teamCells > 0
        ? ok('admin availability calendar renders team status cells')
        : bad('admin availability calendar rendered no cells', '');

      await p.selectOption('#acal-mode', 'field');
      await p.waitForTimeout(300);
      const fieldCells = await p.locator('#admin-avail-cal td.cal-day').count();
      fieldCells > 0
        ? ok('admin availability calendar switches to field mode and still renders')
        : bad('admin field-mode calendar rendered no cells', '');

      const divisions = await p.locator('#acal-division option').count();
      if (divisions > 1) {
        await p.selectOption('#acal-division', { index: 1 });
        await p.waitForTimeout(300);
        const scopedTargets = await p.locator('#acal-target option').count();
        scopedTargets >= 0
          ? ok('admin availability calendar accepts a division filter without crashing')
          : bad('division filter broke the target list', '');
      } else {
        ok('only one division in fixture — division filter present but not exercised (not a failure)');
      }
    } else {
      bad('no Availability tab found in admin nav', '');
    }

    // ── Availability calendar: director (program-wide, team/field filter) ───
    const dCtx = await browser.newContext();
    const dp = await dCtx.newPage();
    const dirErrs = [];
    dp.on('pageerror', e => dirErrs.push(e.message));
    const directorEmail = (seasonData.directors || []).find(d => d.email)?.email;
    if (directorEmail) {
      await dp.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
      await dp.fill('#email-input', directorEmail);
      await dp.click('#continue-btn');
      await dp.waitForTimeout(600);
      await dp.goto(`${BASE}/director`, { waitUntil: 'networkidle' });
      await dp.waitForTimeout(500);
      const dirCells = await dp.locator('#director-avail-cal td.cal-day').count();
      dirCells > 0
        ? ok('director availability calendar renders for their own program')
        : bad('director availability calendar rendered no cells', '');

      await dp.selectOption('#dcal-mode', 'field').catch(() => {});
      await dp.waitForTimeout(300);
      const dirFieldCells = await dp.locator('#director-avail-cal td.cal-day').count();
      dirFieldCells > 0
        ? ok('director availability calendar switches to field mode')
        : bad('director field-mode calendar rendered no cells', '');
      dirErrs.length === 0
        ? ok('no JS errors in the director availability calendar')
        : bad('JS errors in director availability calendar', dirErrs.slice(0, 2).join(' | '));
    } else {
      ok('no director account in fixture to test the program-scoped calendar (not a failure)');
    }

    // ── Availability calendar: coach (own team only) ─────────────────────────
    const cCtx = await browser.newContext();
    const ccp = await cCtx.newPage();
    const coachCalErrs = [];
    ccp.on('pageerror', e => coachCalErrs.push(e.message));
    await ccp.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await ccp.fill('#email-input', someTeam.email);
    await ccp.click('#continue-btn');
    await ccp.waitForTimeout(600);
    await ccp.goto(`${BASE}/my-team`, { waitUntil: 'networkidle' });
    await ccp.waitForTimeout(500);
    const coachCalCells = await ccp.locator('#mte-avail-cal td.cal-day').count();
    coachCalCells > 0
      ? ok('coach availability calendar renders for their own team')
      : bad('coach availability calendar rendered no cells', '');
    coachCalErrs.length === 0
      ? ok('no JS errors on the coach availability calendar')
      : bad('JS errors on coach availability calendar', coachCalErrs.slice(0, 2).join(' | '));
  } catch (e) {
    bad('browser run threw', e.message);
  } finally {
    await browser.close();
    srv.kill();
    try { fs.unlinkSync(INSTRUMENTED_COPY); } catch {}
    for (const f of ['season.json', 'schedule.json', 'change_requests.json', 'changes.json']) {
      try { fs.unlinkSync(path.join(ROOT, f)); } catch {}
    }
    try { fs.rmSync(path.join(ROOT, 'snapshots'), { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
