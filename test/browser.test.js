'use strict';
// Real-browser tests for the things only a browser can confirm.
//
// Everything else in test/ checks logic and HTTP responses. None of that can
// tell you whether a toast actually appears, whether the typed-confirmation
// really blocks a destructive action, whether a field error lands next to its
// input, or whether a table breaks the layout on a phone. Those were all
// asserted from markup inspection alone until this file existed.
//
// Run with: npm run test:ui   (needs `npx playwright install chromium` once)

const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.UI_PORT || 3131);
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok  = (n, x) => { pass++; console.log(`  PASS: ${n}${x ? ` (${x})` : ''}`); };
const bad = (n, w) => { fail++; console.log(`  ** FAIL: ${n} — ${w}`); };

// ── Fixture ──────────────────────────────────────────────────────────────────
// A season far enough out that the 7-day change window is exercisable.
function seedSeason() {
  const today = new Date();
  const d = new Date(today);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7) + 28);
  const start = d.toISOString().slice(0, 10);
  global.__seededSeasonStart = start;
  const season = {
    season: { start, weeks: 8, target_games: 4, weekday_time: '18:30',
              saturday_times: { 'div-1': '10:00' }, blackout_dates: [] },
    divisions: [{ id: 'div-1', name: 'U10', target_games: 4 }],
    programs: [{ id: 'prog-1', name: 'Eastlake' }],
    directors: [{ id: 'dir-1', name: 'Dana Director', email: 'dana@example.com',
                  phone: '(555) 123-4567', program_id: 'prog-1', active: true }],
    fields: [{ id: 'field-1', name: 'Main Park', program_id: 'prog-1',
               address: '1 Main St', coordinates: '41.65,-81.45' }],
    teams: [
      { id: 'team-1', label: 'Wildcats', coach: 'Casey Coach', email: 'casey@example.com',
        phone: '(555) 222-3333', division_id: 'div-1', program_id: 'prog-1',
        home_field_id: 'field-1', confirmed: true },
      { id: 'team-2', label: 'Rockets', coach: 'Robin Coach', email: 'robin@example.com',
        phone: '(555) 444-5555', division_id: 'div-1', program_id: 'prog-1',
        home_field_id: 'field-1', confirmed: true },
    ],
  };
  fs.writeFileSync(path.join(ROOT, 'season.json'), JSON.stringify(season, null, 2));
  for (const f of ['schedule.json', 'change_requests.json', 'changes.json']) {
    try { fs.unlinkSync(path.join(ROOT, f)); } catch {}
  }
}

// This environment has no real RESEND_API_KEY, so the verify email never
// actually sends — same as test/e2e.sh, a throwaway instrumented copy logs the
// verification code to stdout so the test can drive the real verify-code
// endpoint without needing a real inbox. The committed server.js is untouched.
const INSTRUMENTED_COPY = path.join(ROOT, '.server.browsertest.js');

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
           ADMIN_PASSWORD: 'testpass', SESSION_SECRET: 'uitest', RESEND_API_KEY: '' },
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

// The login page is two-stage: enter the email, press Continue, and only an
// admin is then asked for a password. Coaches and directors go straight through.
async function loginAs(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#email-input', email);
  await page.click('#continue-btn');
  await page.waitForTimeout(600);
  if (password && await page.locator('#pw-section.show, #pw-input:visible').count()) {
    await page.fill('#pw-input', password);
    await page.click('#signin-btn');
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(300);
}

(async () => {
  seedSeason();
  const srv = await startServer();
  const browser = await chromium.launch();
  const errors = [];

  try {
    // ── Console health across every page ─────────────────────────────────────
    // A JS error on load means the page is broken regardless of how it looks.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(`${page.url()}: ${m.text()}`); });
    page.on('pageerror', e => errors.push(`${page.url()}: ${e.message}`));

    for (const p of ['/', '/login', '/guide']) {
      await page.goto(BASE + p, { waitUntil: 'networkidle' });
    }
    errors.length === 0
      ? ok('no JS errors on public pages')
      : bad('JS errors on load', errors.slice(0, 2).join(' | '));

    // ── Public guide renders director + coach only ───────────────────────────
    // Admin instructions moved to /admin-guide (requireAdmin, served from
    // views/ rather than public/) — Ted was explicit that only he needs them,
    // so the public guide must NOT mention them, and the admin page must be
    // unreachable without the admin session.
    await page.goto(`${BASE}/guide`, { waitUntil: 'networkidle' });
    const sections = await page.locator('h2').allTextContents();
    const wanted = ['Program Director', 'Coach'];
    wanted.every(w => sections.some(s => s.includes(w)))
      ? ok('public guide renders director + coach sections')
      : bad('guide sections missing', sections.join(', '));
    sections.some(s => s.includes('League Admin'))
      ? bad('admin section leaked into the public guide', sections.join(', '))
      : ok('admin section is not present in the public guide');

    // page.goto follows redirects, so response.status() reflects the final hop
    // (the login page, 200) rather than requireAdmin's actual 302 — checking
    // where navigation ends up is what proves the gate, not the last status
    // code in the chain.
    await page.goto(`${BASE}/admin-guide`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const landedUrl = page.url();
    const bodyHasAdminContent = await page.locator('body').textContent().then(t => t.includes('League Admin'));
    landedUrl.includes('/login') && !bodyHasAdminContent
      ? ok('/admin-guide redirects to login without an admin session')
      : bad('/admin-guide reachable without admin auth', `landed on ${landedUrl}`);
    await page.goto(`${BASE}/guide`, { waitUntil: 'networkidle' }); // back to a known page for the anchor check below

    // Anchor links must actually resolve to real targets.
    const anchors = await page.$$eval('a[href^="#"]', as => as.map(a => a.getAttribute('href').slice(1)));
    const missing = [];
    for (const id of anchors) {
      if (id && !(await page.locator(`#${id}`).count())) missing.push(id);
    }
    missing.length === 0
      ? ok('every in-page guide link resolves', `${anchors.length} links`)
      : bad('broken guide anchors', missing.join(', '));

    // ── Director flow: the real UI behaviours ────────────────────────────────
    const dctx = await browser.newContext();
    const dpage = await dctx.newPage();
    const derr = [];
    dpage.on('pageerror', e => derr.push(e.message));
    // A refused write logs a console error for the failed resource — that's the
    // auth guard doing its job, asserted explicitly below. request-verify also
    // 500s here since this environment has no real RESEND_API_KEY to send
    // through; the code is still generated and logged regardless (see
    // startServer's instrumented copy), which is what's actually being tested.
    dpage.on('console', m => {
      const t = m.text();
      const url = m.location()?.url || '';
      if (m.type() === 'error' && !/403|Forbidden/.test(t) && !url.includes('request-verify')) derr.push(t);
    });

    await loginAs(dpage, 'dana@example.com');
    await dpage.goto(`${BASE}/director`, { waitUntil: 'networkidle' });

    (await dpage.locator('#teams-list').count())
      ? ok('director page loads with its team list')
      : bad('director page did not render', 'no #teams-list');

    // ── Verification gates the form itself, not just the save ───────────────
    // Ted: filling in a whole Add Team form only to lose it at Save (because
    // the session wasn't verified) is the actual problem — the button should
    // refuse to open the form at all rather than let that happen.
    await dpage.click('#btn-add-team');
    await dpage.waitForTimeout(250);
    const formOpenedUnverified = await dpage.locator('#team-editor-form:not(.hidden)').count();
    formOpenedUnverified === 0
      ? ok('Add Team refuses to open while unverified')
      : bad('Add Team form opened for an unverified session', '');
    const toastShown = await dpage.locator('.toast').count();
    toastShown > 0
      ? ok('a toast explains why, instead of silence')
      : bad('no feedback shown when the gate blocks the click', '');

    // Defense in depth: the server must refuse an unverified write on its own,
    // independent of whether the client-side gate above is what actually
    // stopped it (e.g. a form left open from before a session's verification
    // lapsed shouldn't be able to save just because it's already open).
    const rawWriteStatus = await dpage.evaluate(async () => {
      const res = await fetch('api/season/fields', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Should be refused' }),
      });
      return res.status;
    });
    rawWriteStatus === 403
      ? ok('server refuses an unverified write independent of the UI gate', '403 as expected')
      : bad('unverified write was not refused server-side', `status ${rawWriteStatus}`);

    // Verify via the code endpoint directly — the real UI path (typing a code
    // sent by email) can't be driven here since there's no live inbox in this
    // environment, but this exercises the same server route a typed code
    // would hit, and unblocks the rest of this section's write-based checks.
    await dpage.evaluate(async () => {
      await fetch('api/auth/request-verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    });
    await dpage.waitForTimeout(200);
    const log = srv.__log || '';
    const codeLine = log.split('\n').reverse().find(l => l.includes('DEBUG_LOGIN_CODE:dana@example.com:'));
    const code = codeLine ? codeLine.split(':').pop().trim() : null;
    const verifyResult = await dpage.evaluate(async (c) => {
      const res = await fetch('api/auth/verify-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c }),
      });
      return res.json();
    }, code);
    verifyResult.ok
      ? ok('code-based verification succeeds against a real code')
      : bad('code verification failed', JSON.stringify(verifyResult));
    await dpage.reload({ waitUntil: 'networkidle' });

    // Readiness banner — added so a director can see what blocks the scheduler.
    const banner = await dpage.locator('.notice').first().textContent().catch(() => '');
    banner && banner.length
      ? ok('program readiness banner renders', banner.trim().slice(0, 58))
      : bad('readiness banner missing', 'no .notice found');

    // Inline field validation: the error must attach to the input, not a
    // far-away box. This is the behaviour I could only infer from markup before.
    await dpage.click('#btn-add-team').catch(() => {});
    await dpage.waitForTimeout(250);
    if (await dpage.locator('#tfe-email').count()) {
      await dpage.fill('#tfe-label', 'Test Team');
      await dpage.fill('#tfe-email', 'not-an-email');
      await dpage.click('#tfe-save');
      await dpage.waitForTimeout(300);
      const note = await dpage.evaluate(() => {
        const el = document.getElementById('tfe-email');
        const label = el.closest('label') || el.parentElement;
        const n = label && label.querySelector('.field-err');
        return n ? n.textContent : null;
      }).catch(() => null);
      note
        ? ok('invalid email shows an error on the field itself', note.trim().slice(0, 46))
        : bad('no inline field error appeared', 'expected .field-err beside #tfe-email');

      const flagged = await dpage.locator('#tfe-email.has-error').count();
      flagged ? ok('the offending input is visually marked')
              : bad('input not marked', 'expected .has-error on #tfe-email');

      // And it must clear once corrected, or the form nags forever.
      await dpage.fill('#tfe-email', 'valid@example.com');
      const [writeRes] = await Promise.all([
        dpage.waitForResponse(r => r.url().includes('/api/teams') && r.request().method() !== 'GET',
                              { timeout: 5000 }).catch(() => null),
        dpage.click('#tfe-save'),
      ]);
      await dpage.waitForTimeout(400);
      const stillErr = await dpage.locator('#tfe-email.has-error').count();
      stillErr === 0 ? ok('error clears once the value is corrected')
                     : bad('stale error persisted', 'has-error still set after a valid entry');

      // dana is verified by this point (see above), so the corrected form
      // should now actually save rather than be refused.
      writeRes && writeRes.ok()
        ? ok('save succeeds once verified and the input is valid')
        : bad('save was refused even though verified', `status ${writeRes && writeRes.status()}`);
    } else {
      bad('team form did not open', '#tfe-email not found');
    }

    // ── Typed confirmation genuinely blocks ──────────────────────────────────
    await dpage.goto(`${BASE}/director`, { waitUntil: 'networkidle' });
    await dpage.waitForTimeout(300);
    const delBtn = dpage.locator('button:has-text("Delete")').first();
    if (await delBtn.count()) {
      await delBtn.click();
      await dpage.waitForTimeout(300);
      const panelUp = await dpage.locator('#ui-panel').count();
      panelUp ? ok('destructive action opens a confirmation panel')
              : bad('no confirmation panel', 'expected #ui-panel');

      if (panelUp) {
        // Wrong word must not proceed — the whole point of typed confirmation.
        await dpage.fill('#ui-confirm-input', 'yes');
        await dpage.click('#ui-confirm-yes');
        await dpage.waitForTimeout(250);
        const stillOpen = await dpage.locator('#ui-panel').count();
        const errShown = await dpage.locator('#ui-confirm-err').isVisible().catch(() => false);
        stillOpen && errShown
          ? ok('wrong confirmation word is refused and explained')
          : bad('typed confirmation let a wrong word through', `panel=${stillOpen} err=${errShown}`);

        // Escape must dismiss — a modal with no exit is a trap on mobile.
        await dpage.keyboard.press('Escape');
        await dpage.waitForTimeout(250);
        (await dpage.locator('#ui-panel').count()) === 0
          ? ok('Escape dismisses the panel')
          : bad('panel would not close on Escape', 'still present');
      }
    } else {
      bad('no delete button found to test confirmation', 'director page had none');
    }

    // ── Coordinate lookup ────────────────────────────────────────────────────
    // The thing this whole feature replaced: a raw lat/lng paste field nobody
    // could reasonably fill in. Confirms the "Find" button actually geocodes a
    // real address and fills the coordinates box, live against Nominatim.
    await dpage.goto(`${BASE}/director`, { waitUntil: 'networkidle' });
    await dpage.click('#btn-add-field').catch(() => {});
    await dpage.waitForTimeout(250);
    if (await dpage.locator('#ffe-geocode-btn').count()) {
      await dpage.fill('#ffe-name', 'Chardon Community Park');
      await dpage.fill('#ffe-address', '12519 Chardon Windsor Rd, Chardon OH');
      await dpage.click('#ffe-geocode-btn');
      await dpage.waitForResponse(r => r.url().includes('/api/geocode'), { timeout: 8000 }).catch(() => {});
      await dpage.waitForTimeout(300);
      const coordsValue = await dpage.locator('#ffe-coords').inputValue();
      /^-?\d+\.\d+,-?\d+\.\d+$/.test(coordsValue)
        ? ok('Find button geocodes a real address into coordinates', coordsValue)
        : bad('geocoding did not fill coordinates', `got "${coordsValue}"`);

      const resultVisible = await dpage.locator('#ffe-geocode-result.good').count();
      resultVisible
        ? ok('geocode result shows a map link to confirm the pin')
        : bad('no confirmation shown after a successful lookup', '');

      // Manual fallback must still be reachable for addresses that don't match.
      const manualSteps = await dpage.locator('.coords-manual li').count();
      manualSteps >= 4
        ? ok('manual coordinate instructions are present as a fallback', `${manualSteps} steps`)
        : bad('manual fallback instructions missing or incomplete', `${manualSteps} steps found`);
    } else {
      bad('geocode button not found on the field form', 'expected #ffe-geocode-btn');
    }

    // ── Availability collapsed on Add, open on Edit ──────────────────────────
    // Ted: setting availability is the coach's job, later — a director adding
    // a team shouldn't be shown it as though it's part of registration.
    await dpage.goto(`${BASE}/director`, { waitUntil: 'networkidle' });
    await dpage.click('#btn-add-team');
    await dpage.waitForTimeout(250);
    const addOpenState = await dpage.locator('#tfe-availability-details').evaluate(el => el.open);
    addOpenState === false
      ? ok('availability is collapsed by default when adding a team')
      : bad('availability was expanded on Add', `open=${addOpenState}`);

    await dpage.locator('#team-editor-form #tfe-cancel').click();
    await dpage.waitForTimeout(200);
    const editBtn = dpage.locator('button:has-text("Edit")').first();
    if (await editBtn.count()) {
      await editBtn.click();
      await dpage.waitForTimeout(250);
      const editOpenState = await dpage.locator('#tfe-availability-details').evaluate(el => el.open).catch(() => null);
      editOpenState === true
        ? ok('availability is already open when editing an existing team')
        : bad('availability was not open on Edit', `open=${editOpenState}`);
    } else {
      bad('no existing team found to test Edit availability state', '');
    }

    derr.length === 0
      ? ok('no JS errors during the director flow')
      : bad('JS errors in director flow', derr.slice(0, 2).join(' | '));

    // ── Calendar view shows the real season, not a hardcoded one ─────────────
    // renderCalendarView used to hardcode April/May/June 2026 regardless of the
    // actual season — Ted found this with real data loaded and asked to
    // confirm it's fixed without needing live data to check it again.
    const seasonStart = global.__seededSeasonStart;
    const expectedMonth = new Date(seasonStart + 'T00:00:00Z')
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    fs.writeFileSync(path.join(ROOT, 'schedule.json'), JSON.stringify({
      games: [{
        game_id: 'g1', date: seasonStart, day: 'Monday', time: '18:30',
        division_id: 'div-1', field_id: 'field-1', field_name: 'Main Park',
        home_team_id: 'team-1', home_team_name: 'Wildcats',
        away_team_id: 'team-2', away_team_name: 'Rockets', status: 'scheduled',
      }],
      failures: [], generated_at: new Date().toISOString(), total_games: 1,
    }, null, 2));

    const vctx = await browser.newContext();
    const vpage = await vctx.newPage();
    const verr = [];
    vpage.on('pageerror', e => verr.push(e.message));
    await vpage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await vpage.click('button[data-view="calendar"]').catch(() => {});
    await vpage.waitForTimeout(400);
    const monthLabels = await vpage.locator('.cal-month-label').allTextContents();
    monthLabels.some(l => l.includes(expectedMonth))
      ? ok('calendar shows the actual season\'s month', monthLabels.join(', '))
      : bad('calendar month does not match the season', `expected "${expectedMonth}", got: ${monthLabels.join(', ')}`);
    monthLabels.some(l => l.includes('2026') && (l.includes('April') || l.includes('May') || l.includes('June')))
      ? bad('the old hardcoded April/May/June 2026 range is still showing', monthLabels.join(', '))
      : ok('no trace of the old hardcoded calendar range');
    const gameShown = await vpage.locator('.cal-game').count();
    gameShown > 0
      ? ok('the scheduled game itself renders on its date')
      : bad('scheduled game did not appear on the calendar', '');
    verr.length === 0
      ? ok('no JS errors on the calendar view')
      : bad('JS errors on calendar view', verr.slice(0, 2).join(' | '));

    // ── Mobile layout ────────────────────────────────────────────────────────
    // The specific failure this guards against: a wide table pushing the whole
    // page sideways on a phone, which is where coaches actually are.
    const mctx = await browser.newContext({ ...devices['iPhone 13'] });
    const mpage = await mctx.newPage();
    await loginAs(mpage, 'dana@example.com');
    await mpage.goto(`${BASE}/director`, { waitUntil: 'networkidle' });
    await mpage.waitForTimeout(400);

    const overflow = await mpage.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    overflow <= 2
      ? ok('no horizontal page overflow on iPhone', `${overflow}px`)
      : bad('page scrolls sideways on mobile', `${overflow}px overflow`);

    // Tables are allowed to scroll, but only inside their own container.
    const wrapped = await mpage.evaluate(() => {
      const tables = [...document.querySelectorAll('table')];
      return tables.every(t => t.closest('.table-wrap') !== null) || tables.length === 0;
    });
    wrapped ? ok('every table sits in a scrollable wrapper')
            : bad('an unwrapped table can break the layout', 'table outside .table-wrap');

    // Touch targets — the coarse-pointer rule should give real height.
    const smallTargets = await mpage.evaluate(() =>
      [...document.querySelectorAll('.btn')]
        .filter(b => b.offsetParent !== null && b.getBoundingClientRect().height < 32).length);
    smallTargets === 0
      ? ok('buttons meet a usable touch height')
      : bad('buttons too small to tap reliably', `${smallTargets} under 32px`);

    // iOS zooms the page when focusing an input under 16px. The coarse-pointer
    // rule exists to prevent that; confirm it actually applies.
    const smallFonts = await mpage.evaluate(() =>
      [...document.querySelectorAll('input')]
        .filter(i => i.offsetParent !== null && parseFloat(getComputedStyle(i).fontSize) < 16).length);
    smallFonts === 0
      ? ok('inputs are 16px+ so iOS will not zoom on focus')
      : bad('inputs would trigger iOS zoom', `${smallFonts} under 16px`);

    // ── Coach page ───────────────────────────────────────────────────────────
    const cctx = await browser.newContext({ ...devices['iPhone 13'] });
    const cpage = await cctx.newPage();
    const cerr = [];
    cpage.on('pageerror', e => cerr.push(e.message));
    await loginAs(cpage, 'casey@example.com');
    await cpage.goto(`${BASE}/my-team`, { waitUntil: 'networkidle' });
    await cpage.waitForTimeout(400);

    (await cpage.locator('#mte-availability').count())
      ? ok('coach page renders the availability editor')
      : bad('coach availability editor missing', 'no #mte-availability');

    // The mobile keyboard hints — the reason phone fields were changed to tel.
    const telType = await cpage.locator('#mte-phone').getAttribute('type').catch(() => null);
    telType === 'tel' ? ok('phone field requests the numeric keypad')
                      : bad('phone field would show a text keyboard', `type=${telType}`);

    const coverflow = await cpage.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    coverflow <= 2 ? ok('coach page has no horizontal overflow on iPhone', `${coverflow}px`)
                   : bad('coach page scrolls sideways', `${coverflow}px`);

    cerr.length === 0 ? ok('no JS errors on the coach page')
                     : bad('JS errors on coach page', cerr.slice(0, 2).join(' | '));

    // ── Toast ────────────────────────────────────────────────────────────────
    // Replaced alert(); confirm it actually renders and then goes away.
    await cpage.evaluate(() => toast('test message'));
    await cpage.waitForTimeout(200);
    const toastText = await cpage.locator('.toast').first().textContent().catch(() => null);
    toastText === 'test message'
      ? ok('toast renders without blocking the page')
      : bad('toast did not appear', String(toastText));

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
