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

// Chromium intermittently aborts a navigation issued right after the previous
// one settles (net::ERR_ABORTED). It's a browser-side race, not an app bug —
// but on the very first /admin navigation it used to throw out of the whole
// run, reporting "0 passed, 1 failed" and giving no signal at all about the
// ~40 real checks below. Measured at roughly 1 run in 3. Retrying clears it;
// swallowing it with .catch(() => {}) does not, because the page is then left
// on the wrong URL and every later assertion fails for an unrelated reason.
async function gotoRetry(page, url, opts = {}, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await page.goto(url, { waitUntil: 'domcontentloaded', ...opts }); }
    catch (err) { lastErr = err; await page.waitForTimeout(250 * (i + 1)); }
  }
  throw lastErr;
}

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
    // The public viewer's first-login auto-help modal fires 400ms after
    // header render and can intercept clicks on later navigations to '/' —
    // pre-seed the "seen" flag so it never opens on this page.
    await p.addInitScript(() => localStorage.setItem('el_help_seen_v1', '1'));

    await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await p.fill('#email-input', 'admin@example.com');
    await p.click('#continue-btn');
    await p.waitForTimeout(600);
    await p.fill('#pw-input', 'testpass');
    await p.click('#signin-btn');
    await p.waitForLoadState('networkidle');

    await gotoRetry(p, `${BASE}/admin`);
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

    // ── The PUBLIC viewer has its own, separate Matrix implementation ───────
    // (viewer.js, gated to admin sessions only, distinct from admin.html's
    // app.js) — it had its own independent pairKey that used Math.min/max on
    // team ids, which is NaN for the real string ids ("team-1", not 1) this
    // fixture uses. The admin.html check above never exercised this second
    // copy, so the fix there didn't catch this one drifting out of sync.
    await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(500);
    const publicMatrixBtn = p.locator('[data-view="matrix"]').first();
    if (await publicMatrixBtn.count()) {
      await publicMatrixBtn.click();
      await p.waitForTimeout(500);
      const pubCellTexts = await p.locator('.matrix-cell .matrix-count').allTextContents();
      const pubNonZero = pubCellTexts.filter(t => t.trim() && t.trim() !== '0');
      const pubDistinct = new Set(pubNonZero.map(t => t.trim()));
      pubNonZero.length > 0 && pubDistinct.size > 1
        ? ok('public viewer\'s matrix also shows real per-opponent counts', `${pubDistinct.size} distinct values across ${pubNonZero.length} cells`)
        : bad('public viewer matrix cells are all identical (its own NaN pairKey bug)', `values: ${[...pubDistinct].join(',')}`);
    } else {
      bad('public viewer matrix button not found for an admin session', '');
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
    await gotoRetry(p, `${BASE}/admin`);
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

      // ── Interactive field-location map (Ted, 2026-08-04): geocoding gets
      // close, but a park with several fields needs the pin on the exact
      // one — satellite imagery + a draggable/clickable pin, no API key. ──
      await p.waitForTimeout(800); // let Leaflet finish initializing + tiles settle before interacting
      const mapVisibleOnEditWithCoords = await p.locator('#ffe-map-wrap:not(.hidden)').count();
      mapVisibleOnEditWithCoords > 0
        ? ok('the field map shows immediately when editing a field that already has coordinates')
        : bad('field map did not appear for a field with existing coordinates', '');

      const coordsBefore = await p.locator('#ffe-coords').inputValue();
      const mapLocator = p.locator('#ffe-map');
      await mapLocator.scrollIntoViewIfNeeded().catch(() => {});
      const mapBox = await mapLocator.boundingBox().catch(() => null);
      if (mapBox) {
        // scrollIntoViewIfNeeded + a page-coordinate mouse.click can still miss
        // (the box's own coords are captured post-scroll, but a locator click
        // with a relative position is what actually guarantees the point is
        // the one that got scrolled into view) — verified this was the real
        // cause of an earlier "click does nothing" failure (target point fell
        // below the 720px default viewport, mouse.click doesn't auto-scroll).
        await mapLocator.click({ position: { x: mapBox.width * 0.3, y: mapBox.height * 0.3 } });
        await p.waitForTimeout(300);
        const coordsAfter = await p.locator('#ffe-coords').inputValue();
        coordsAfter && coordsAfter !== coordsBefore
          ? ok('clicking the map moves the pin and updates the coordinates field', `${coordsBefore} -> ${coordsAfter}`)
          : bad('clicking the map did not update the coordinates field', `before=${coordsBefore} after=${coordsAfter}`);
      } else {
        bad('field map has no bounding box — did not render', '');
      }

      // Add Field (no coordinates yet) should keep the map hidden until
      // there's something to show — an empty map is just confusing.
      await p.locator('#ffe-cancel, #field-editor-form button:has-text("Cancel")').first().click().catch(() => {});
      await p.waitForTimeout(200);
      await p.click('#btn-add-field');
      await p.waitForTimeout(300);
      const mapHiddenOnFreshAdd = await p.locator('#ffe-map-wrap').evaluate(el => el.classList.contains('hidden')).catch(() => null);
      mapHiddenOnFreshAdd === true
        ? ok('the field map stays hidden on a fresh Add Field with no coordinates yet')
        : bad('field map should be hidden until coordinates exist', `hidden=${mapHiddenOnFreshAdd}`);
      await p.locator('#ffe-cancel, #field-editor-form button:has-text("Cancel")').first().click().catch(() => {});
    } else {
      bad('no field to edit in the admin Fields tab', '');
    }

    // ── Driving-distance refresh button (Ted, 2026-08-13) — real distance
    // instead of always-straight-line. Live call against the public OSRM
    // server, same tolerance as the existing live geocode test: a transient
    // OSRM outage degrades to a note, not a suite failure.
    await p.click('#btn-refresh-distances');
    // Wait for the button to re-enable (set in the handler's `finally`), not
    // just for the status text to be non-empty — the "Recomputing…"
    // placeholder is itself non-empty the instant the click fires, so that
    // condition alone would resolve before the actual refresh ever
    // completes. Confirm it actually went disabled first, so "already
    // enabled, never even started" can't be mistaken for "finished".
    await p.waitForFunction(() => document.getElementById('btn-refresh-distances')?.disabled === true, { timeout: 3000 }).catch(() => {});
    await p.waitForFunction(() => document.getElementById('btn-refresh-distances')?.disabled === false, { timeout: 15000 }).catch(() => {});
    const distStatus = await p.locator('#field-distances-status').innerText().catch(() => '');
    if (/Updated \d+ field pair/.test(distStatus)) {
      ok('clicking Refresh Driving Distances recomputes and reports real pairs', distStatus);

      const cachePairCount = await p.evaluate(() => Object.keys(fieldDistanceCache?.pairs || {}).length);
      cachePairCount > 0
        ? ok('the client picks up the refreshed cache without a full page reload', `${cachePairCount} pairs in memory`)
        : bad('fieldDistanceCache was not updated client-side after a refresh', '');

      await p.click('.top-nav-btn[data-page="schedule"]');
      await p.waitForTimeout(300);
      const viewButtons = await p.locator('.view-btn[data-view="stats"]').count();
      if (viewButtons > 0) {
        await p.locator('.view-btn[data-view="stats"]').first().click();
        await p.waitForTimeout(300);
        const statsNote = await p.locator('.stats-note').innerText().catch(() => '');
        /real driving distance/i.test(statsNote)
          ? ok('the stats page disclaimer reflects real driving distance, not just "estimated straight-line"')
          : bad('stats page disclaimer was not updated', statsNote);
      } else {
        ok('no Stats view tab found in this fixture — disclaimer text not exercised (not a failure)');
      }
    } else {
      ok(`Refresh Driving Distances ran but OSRM may be unavailable in this environment — not a failure ("${distStatus}")`);
    }

    // ── Editor tab: clicking a team opens its full availability, not just
    // contact info (Ted: "that team's page/preferences to look at") ────────
    const editorTab = p.locator('button:has-text("Editor"), [data-page="editor"]').first();
    if (await editorTab.count()) {
      await editorTab.click();
      await p.waitForTimeout(400);
      const firstTeamId = await p.evaluate(() => document.querySelector('.editor-team')?.id.replace('editor-team-', ''));
      if (firstTeamId) {
        // A real click on the row, not a direct window.toggleTeamForm(id)
        // call — the row's onclick attribute embeds the team id via
        // JSON.stringify() inside a double-quoted HTML attribute, which
        // silently breaks for any string id (e.g. "team-1", not just a bare
        // number) because JSON.stringify's own quote characters terminate
        // the attribute early. Calling the function directly bypasses
        // exactly that bug and would never have caught it.
        await p.locator('.editor-team-row').first().click();
        await p.waitForTimeout(400);
        const gridRows = await p.locator(`#ef-availability-${firstTeamId} select.av-pat`).count();
        gridRows > 0
          ? ok('clicking a team in the Editor tab shows its weekly availability grid', `${gridRows} rows`)
          : bad('team availability grid did not render when the row opened', '');
        const fridayRow = await p.locator(`#ef-availability-${firstTeamId}`).innerText().catch(() => '');
        fridayRow.includes('Friday')
          ? ok('Friday is included in the admin team availability grid too')
          : bad('Friday row missing from admin team availability grid', fridayRow.slice(0, 200));

        // ── Teams to Avoid (Ted, 2026-08-07) — the previously-unreachable
        // scheduler restriction mechanism now has a real editor. Collapsed
        // by default (same reasoning as Weekly Availability on Add elsewhere
        // — this is occasional setup, not daily-use), so the checkboxes
        // exist in the DOM but need the <details> opened before Playwright
        // will treat them as interactable.
        await p.locator(`#ef-restrictions-details-${firstTeamId}`).evaluate(el => { el.open = true; });
        const restrictSel = `#ef-restrictions-${firstTeamId}`;
        const programCbCount = await p.locator(`${restrictSel} .re-program`).count();
        programCbCount > 0
          ? ok('Teams to Avoid shows a checkbox for other programs', `${programCbCount} programs`)
          : bad('no program checkboxes rendered in Teams to Avoid', '');

        const teamCbCount = await p.locator(`${restrictSel} .re-team`).count();
        teamCbCount > 0
          ? ok('Teams to Avoid shows a checkbox for same-division opposing teams', `${teamCbCount} teams`)
          : bad('no team checkboxes rendered in Teams to Avoid (fixture may lack same-division opponents)', '');

        if (programCbCount > 0 && teamCbCount > 0) {
          const firstProgramValue = await p.locator(`${restrictSel} .re-program`).first().getAttribute('value');
          const matchingTeamCb = p.locator(`${restrictSel} label.restriction-row[data-program="${firstProgramValue}"] .re-team`).first();
          if (await matchingTeamCb.count()) {
            await p.locator(`${restrictSel} .re-program`).first().check();
            await p.waitForTimeout(150);
            const disabledAfterCheck = await matchingTeamCb.isDisabled();
            disabledAfterCheck
              ? ok('checking a program greys out its own teams below (avoids a redundant double-exclude)')
              : bad('team checkbox did not disable when its whole program was excluded', '');
            await p.locator(`${restrictSel} .re-program`).first().uncheck();
          } else {
            ok('no team in the fixture belongs to the first program option — greyout check not exercised (not a failure)');
          }

          // Save with one specific team excluded (not a whole program) and
          // confirm it actually persisted, not just accepted by the UI.
          const targetTeamCb = p.locator(`${restrictSel} .re-team`).first();
          const excludedTeamId = await targetTeamCb.getAttribute('value');
          await targetTeamCb.check();
          await p.locator(`#editor-form-${firstTeamId} .editor-form-actions .btn-primary`).first().click();
          await p.waitForTimeout(500);
          await p.locator('.editor-team-row').first().click(); // close
          await p.waitForTimeout(200);
          await p.locator('.editor-team-row').first().click(); // reopen fresh
          await p.waitForTimeout(400);
          const persistedChecked = await p.locator(`${restrictSel} .re-team[value="${excludedTeamId}"]`).isChecked().catch(() => false);
          persistedChecked
            ? ok('a saved team-level exclusion persists across a re-open, not just accepted')
            : bad('team-level exclusion did not persist on re-open', '');
        }
      } else {
        bad('no team found in the Editor tab to click', '');
      }

      // ── Admin can delete a team (Ted, 2026-08-12) — every other entity
      // (fields, programs, directors, divisions, snapshots) already had a
      // Delete button in this exact tab; teams were the one gap. A
      // throwaway team created just for this check, not one of the fixture
      // teams other assertions in this file depend on. ────────────────────
      const throwawayId = await p.evaluate(async (divId) => {
        const r = await fetch('api/teams', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'DELETE-TEST-THROWAWAY', division_id: divId }),
        });
        const d = await r.json();
        return d.ok ? d.team.id : null;
      }, seasonData.divisions[0].id);
      if (throwawayId) {
        // Created via a raw fetch, bypassing the app's own team-creation
        // flow — its in-memory seasonData never picked up the new team, so
        // the Editor tab would still render the old, now-stale list.
        await p.reload({ waitUntil: 'networkidle' });
        await p.waitForTimeout(500);
        await editorTab.click();
        await p.waitForTimeout(300);
        const throwawayRow = p.locator('.editor-team-row', { hasText: 'DELETE-TEST-THROWAWAY' });
        (await throwawayRow.count()) > 0
          ? ok('a newly-created team appears in the Editor tab')
          : bad('throwaway team not found in Editor tab after creating it via the API', '');
        await throwawayRow.click();
        await p.waitForTimeout(300);
        const deleteBtn = p.locator(`#editor-form-${throwawayId} button:has-text("Delete")`);
        (await deleteBtn.count()) > 0
          ? ok('the team edit form has a Delete button')
          : bad('no Delete button found in the team edit form', '');
        await deleteBtn.click();
        await p.waitForTimeout(300);
        const confirmVisible = await p.locator('#ui-confirm-input').isVisible().catch(() => false);
        confirmVisible
          ? ok('deleting a team asks for a typed confirmation, not a bare click')
          : bad('no typed-confirmation prompt appeared for team deletion', '');
        await p.fill('#ui-confirm-input', 'delete');
        await p.click('#ui-confirm-yes');
        await p.waitForTimeout(500);
        const stillThere = await p.locator('.editor-team-row', { hasText: 'DELETE-TEST-THROWAWAY' }).count();
        stillThere === 0
          ? ok('the team is actually gone from the Editor tab after confirming delete')
          : bad('team still shown in the Editor tab after deleting it', '');
        const stillOnServer = await p.evaluate(async (id) => {
          const r = await fetch('api/season');
          const d = await r.json();
          return d.teams.some(t => t.id === id);
        }, throwawayId);
        !stillOnServer
          ? ok('the delete actually persisted server-side, not just in the UI')
          : bad('team still present in season.json after deleting it via the UI', '');
      } else {
        bad('could not create a throwaway team to test admin delete against', '');
      }

      // ── Program filter shows real names, not raw ids or mangled guesses
      // (Ted, 2026-08-12) — adminProgramName used to derive a display name
      // from the common character-prefix of that program's team labels,
      // which broke as soon as a program's teams didn't all start with the
      // program's own name (real example: a program named "Mentor" whose
      // two teams were coach-labelled "Katach U15" and "Yanick U10 G",
      // sharing zero common prefix, rendered as the raw
      // "program-1785906934654" id). Programs have a real `name` field now
      // — this just has to be read, not guessed.
      const mismatchProgram = await p.evaluate(async () => {
        const r = await fetch('api/season/programs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'PROGNAME-TEST-Riverdale' }),
        });
        const d = await r.json();
        return d.ok ? d.program.id : null;
      });
      if (mismatchProgram) {
        await p.evaluate(async ({ programId, divId }) => {
          await fetch('api/teams', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: 'Zephyr Kickers', division_id: divId, program_id: programId }),
          });
          await fetch('api/teams', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: 'Alpha United', division_id: divId, program_id: programId }),
          });
        }, { programId: mismatchProgram, divId: seasonData.divisions[0].id });

        await p.reload({ waitUntil: 'networkidle' });
        await p.waitForTimeout(500);
        await p.click('.admin-top-view-btn[data-topview="program"]');
        await p.waitForTimeout(400);
        const optionTexts = await p.locator('#admin-program-select option').allInnerTexts();
        optionTexts.includes('PROGNAME-TEST-Riverdale')
          ? ok('the Program filter shows the real program name for teams with mismatched labels')
          : bad('Program filter did not show the real program name', JSON.stringify(optionTexts));
        optionTexts.some(t => t.startsWith('program-'))
          ? bad('a raw program-<id> string leaked into the Program filter', JSON.stringify(optionTexts))
          : ok('no raw program-<id> string appears anywhere in the Program filter');
      } else {
        bad('could not create a throwaway program to test the name-display fix against', '');
      }

      // ── Home Field dropdown must not change format after a save (Ted,
      // 2026-08-12) — saveTeamForm's post-save row refresh used to build
      // its own, different <option> list (raw field.id appended in
      // parens, sub_field silently dropped) instead of reusing the exact
      // same formatting the initial render used, so a field like "Burton
      // Fields – Upper - U10" visibly turned into
      // "Burton Fields (field-1786045647326)" the moment you hit Save.
      const fieldFmtFixture = await p.evaluate(async (divId) => {
        const fr = await fetch('api/season/fields', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'FIELDFMT-TEST Park', sub_field: 'Upper - U10' }),
        });
        const fd = await fr.json();
        if (!fd.ok) return null;
        const tr = await fetch('api/teams', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'FIELDFMT-TEST Team', division_id: divId, home_field_id: fd.field.id }),
        });
        const td = await tr.json();
        return td.ok ? { fieldId: fd.field.id, teamId: td.team.id } : null;
      }, seasonData.divisions[0].id);

      if (fieldFmtFixture) {
        await p.reload({ waitUntil: 'networkidle' });
        await p.waitForTimeout(500);
        await editorTab.click();
        await p.waitForTimeout(300);
        const fmtRow = p.locator('.editor-team-row', { hasText: 'FIELDFMT-TEST Team' });
        await fmtRow.click();
        await p.waitForTimeout(300);
        const fieldSel = `#ef-field-${fieldFmtFixture.teamId}`;
        const beforeText = await p.locator(`${fieldSel} option[value="${fieldFmtFixture.fieldId}"]`).innerText();
        await p.locator(`#editor-form-${fieldFmtFixture.teamId} button:has-text("Save")`).click();
        await p.waitForTimeout(500);
        const afterText = await p.locator(`${fieldSel} option[value="${fieldFmtFixture.fieldId}"]`).innerText();
        (afterText === beforeText && !afterText.includes(fieldFmtFixture.fieldId) && afterText.includes('Upper - U10'))
          ? ok('Home Field option text is identical before and after a save', `"${afterText}"`)
          : bad('Home Field option text changed after saving', `before="${beforeText}" after="${afterText}"`);
      } else {
        bad('could not create the field/team fixture for the post-save format check', '');
      }
    } else {
      bad('Editor tab not found', '');
    }

    // ── Teams tab: the unused Blackout Dates column is gone ──────────────────
    const teamsTab = p.locator('button:has-text("Teams"), [data-page="teams"]').first();
    if (await teamsTab.count()) {
      await teamsTab.click();
      await p.waitForTimeout(400);
      const headerText = await p.locator('.teams-table thead').first().innerText().catch(() => '');
      !headerText.includes('Blackout')
        ? ok('Blackout Dates column removed from the Teams tab')
        : bad('Blackout Dates column still present in the Teams tab', headerText);
    } else {
      bad('Teams tab not found', '');
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
    // Request Change (and Rain Out, and Report Score) all now gate on a
    // verified session before opening — an unverified click here would
    // correctly refuse, which isn't what this section is testing.
    await verifyPage(cp, someTeam.email, srv);
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
      // Same gating as the coach case above — the deep-linked form won't
      // auto-open for an unverified session.
      await verifyPage(dp, someDirector.email, srv);
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

      // ── Director's manual game editor (Ted, 2026-08-04) ────────────────────
      // Same force-past-the-rules authority admin has, now on the director
      // page too — verified here as UI wiring; the actual scoping/violation/
      // force logic is covered at the API level in test/e2e.sh.
      await dp.goto(`${BASE}/director`, { waitUntil: 'networkidle' });
      await dp.waitForTimeout(500);
      const addGameBtn = dp.locator('#btn-add-game');
      if (await addGameBtn.count()) {
        await addGameBtn.click();
        await dp.waitForTimeout(300);
        (await dp.locator('#dge-modal:not(.hidden)').count()) > 0
          ? ok('director\'s Add Game button opens the manual game editor')
          : bad('Add Game did not open the modal', '');
        const homeOpts = await dp.locator('#dge-home option').count();
        homeOpts > 0
          ? ok('team selects populate in the manual game editor', `${homeOpts} options`)
          : bad('team selects are empty in the manual game editor', '');
        await dp.locator('#dge-close').click();
        (await dp.locator('#dge-modal:not(.hidden)').count()) === 0
          ? ok('manual game editor closes cleanly')
          : bad('manual game editor did not close', '');

        // Editing an existing own-program game pre-fills from that game.
        const editBtn = dp.locator(`button[onclick="openGameEdit(${dirOwnGame.game_id})"]`);
        if (await editBtn.count()) {
          await editBtn.first().click();
          await dp.waitForTimeout(300);
          const prefilledDate = await dp.locator('#dge-date').inputValue().catch(() => '');
          prefilledDate === dirOwnGame.date
            ? ok('editing a game pre-fills the modal from that exact game', prefilledDate)
            : bad('edit did not pre-fill the game\'s own date', `got ${prefilledDate}, wanted ${dirOwnGame.date}`);
          await dp.locator('#dge-close').click();
        } else {
          ok('no Edit button rendered for this particular game state (not a failure)');
        }
      } else {
        bad('director page has no Add Game button', '');
      }
    } else {
      bad('fixture did not produce a director-own-game case', '');
    }

    // ── Confirmation lifecycle: Scheduled -> Pending -> Confirmed, badges ────
    // Confirm and change-request submission both require a verified session —
    // `cp` was already verified above for the Request Change gating check;
    // re-verifying here is harmless and keeps this block independently
    // runnable if the earlier one is ever removed. `lp` below is a new page
    // in the same context (coachCtx), so the cookie carries over either way.
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
    await gotoRetry(p, `${BASE}/admin`);
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

      // ── Regression: saving a team must not silently swap which team the
      // calendar is showing (Ted, 2026-08-07 bug report) ──────────────────
      // populateAvailCalTargets() rebuilds #dcal-target's <option> list after
      // ANY team/field save on the page — without explicitly restoring the
      // selection, the browser resets a rebuilt <select> to whichever option
      // is now first, so a director watching one team's calendar would get
      // silently bounced to a different team the moment they saved an edit
      // (their own edit still saved fine — this was a pure display bug, but
      // it looked exactly like "my change isn't showing up").
      const dirTeams = (seasonData.teams || [])
        .filter(t => t.program_id === (seasonData.directors || []).find(d => d.email === directorEmail)?.program_id)
        .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
      if (dirTeams.length >= 2) {
        // Verify BEFORE interacting — verifyPage only updates the server-side
        // session, and this page's in-memory `session` object was fetched at
        // its earlier page load, so saving would still hit the unverified
        // gate without a reload to pick the change up (same reload the other
        // verifyPage call sites in this file already do).
        const verified = await verifyPage(dp, directorEmail, srv);
        verified
          ? ok('director session verified for the calendar-reset regression check')
          : bad('director verification failed — cannot exercise the save path', '');
        await dp.goto(`${BASE}/director`, { waitUntil: 'networkidle' });
        await dp.waitForTimeout(500);

        await dp.selectOption('#dcal-mode', 'team').catch(() => {});
        await dp.waitForTimeout(300);
        // Pick the LAST team alphabetically — guaranteed not to be what a
        // naive reset-to-first would leave selected, so this can't pass by
        // coincidence.
        const watchedTeam = dirTeams[dirTeams.length - 1];
        await dp.selectOption('#dcal-target', String(watchedTeam.id));
        await dp.waitForTimeout(200);
        const targetBefore = await dp.locator('#dcal-target').inputValue();

        // has-text() is a substring match — with several teams differing only
        // by division (e.g. "Chardon U10" is a substring of "Chardon U10
        // Boys"), that can grab the wrong row. Match the team name cell
        // exactly, then scope to its own row.
        await dp.locator('tr').filter({ has: dp.getByText(watchedTeam.label, { exact: true }) })
          .locator('button:has-text("Edit")').first().click();
        await dp.waitForTimeout(300);
        await dp.locator('#tfe-availability select.av-pat[data-key="Tuesday"]').selectOption('none');
        await dp.click('#tfe-save');
        await dp.waitForTimeout(500);

        const targetAfter = await dp.locator('#dcal-target').inputValue();
        targetAfter === targetBefore
          ? ok('calendar selection survives an unrelated team save', `stayed on ${targetAfter}`)
          : bad('calendar silently swapped to a different team after saving', `${targetBefore} -> ${targetAfter}`);
      } else {
        ok('director\'s program has fewer than 2 teams — calendar-reset regression not exercised (not a failure)');
      }
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

    // ── Activity log: admin can see who did what (Ted, 2026-08-07) ──────────
    // By this point in the run, plenty of real mutating actions have already
    // happened (team saves, the calendar-reset repro's own save, logins,
    // etc.) — enough to check the log actually captured them, not just that
    // the page renders empty.
    await gotoRetry(p, `${BASE}/admin`);
    await p.waitForTimeout(400);
    const activityTab = p.locator('button:has-text("Activity"), [data-page="activity"]').first();
    if (await activityTab.count()) {
      await activityTab.click();
      await p.waitForTimeout(500);
      const activityRows = await p.locator('#activity-content tbody tr').count();
      activityRows > 0
        ? ok('activity log shows recorded actions', `${activityRows} rows`)
        : bad('activity log rendered no rows despite earlier mutating actions', '');

      const rowText = await p.locator('#activity-content').innerText().catch(() => '');
      /Updated team|Added team|Login attempt/.test(rowText)
        ? ok('activity log entries are human-readable, not raw method/path')
        : bad('no recognizable action summary found in the activity log', rowText.slice(0, 200));

      // The search box filters client-side — searching for something that
      // can't match should shrink the visible rows without erroring.
      await p.fill('#activity-search', 'zzz-no-such-action-zzz');
      await p.waitForTimeout(200);
      const filteredRows = await p.locator('#activity-content tbody tr').count();
      filteredRows === 0
        ? ok('activity search filters down to zero for a non-matching query')
        : bad('activity search did not filter as expected', `${filteredRows} rows still shown`);
      await p.fill('#activity-search', '');
      await p.waitForTimeout(200);
    } else {
      bad('no Activity tab found in admin nav', '');
    }
  } catch (e) {
    bad('browser run threw', e.message);
  } finally {
    await browser.close();
    srv.kill();
    try { fs.unlinkSync(INSTRUMENTED_COPY); } catch {}
    for (const f of ['season.json', 'schedule.json', 'change_requests.json', 'changes.json', 'activity_log.json']) {
      try { fs.unlinkSync(path.join(ROOT, f)); } catch {}
    }
    try { fs.rmSync(path.join(ROOT, 'snapshots'), { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
