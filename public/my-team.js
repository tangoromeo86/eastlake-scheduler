'use strict';

let session = null;
let seasonData = null;
let myTeam = null;
let scheduleData = null;
let seasonSlots = null;

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fieldDisplayName(f) {
  return f.sub_field ? `${f.name} – ${f.sub_field}` : f.name;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function init() {
  try { session = await fetchJSON('api/auth/me'); } catch { session = null; }
  if (!session || session.role !== 'coach') {
    window.location = 'login';
    return;
  }
  try { seasonSlots = await fetchJSON('api/season/slots'); } catch { seasonSlots = []; }
  try { seasonData = await fetchJSON('api/season'); }
  catch (e) {
    document.getElementById('my-team-page').innerHTML = `<p style="color:#dc2626">Could not load team data: ${esc(e.message)}</p>`;
    return;
  }

  myTeam = (seasonData.teams || []).find(t => String(t.id) === String(session.team_id));
  if (!myTeam) {
    document.getElementById('my-team-page').innerHTML = '<p style="color:#dc2626">No team found for your account. Contact your director.</p>';
    return;
  }

  document.getElementById('team-title').textContent = myTeam.label || 'My Team';
  document.getElementById('mte-label').value = myTeam.label || '';
  document.getElementById('mte-coach').value = myTeam.coach || '';
  document.getElementById('mte-email').value = myTeam.email || '';
  document.getElementById('mte-phone').value = myTeam.phone || '';
  document.getElementById('mte-target').value = myTeam.target_games || '';
  document.getElementById('mte-earliest').value = myTeam.earliest_date || '';
  populateFieldSelect();
  renderAvailabilityGrid('mte-availability', myTeam.availability, seasonSlots, myTeam.earliest_date);
  renderRestrictionsEditor('mte-restrictions', myTeam, seasonData.teams, seasonData.programs, myTeam.restrictions);
  renderMyAvailabilityCalendar();

  // Info this once-per-season and rarely revisited — collapsed once it's
  // actually filled in, so the page opens on what's used every week (games)
  // instead of a wall of settings. Team Info still opens itself if it's
  // genuinely incomplete, since that's the one thing worth prompting for.
  document.getElementById('mte-info-details').open = !myTeam.label;
  document.getElementById('mte-info-summary').innerHTML = myTeam.label
    ? `Team Info <span class="field-form-hint">— ${esc(myTeam.label)}${myTeam.coach ? ` · Coach ${esc(myTeam.coach)}` : ''}</span>`
    : 'Team Info';

  try { scheduleData = await fetchJSON('api/schedule'); } catch { scheduleData = { games: [] }; }
  renderGamesList();

  openChangeRequestFromUrl();
  initMyTeamVerifyBanner();
}

// The public schedule's "Request Change" button used to redirect here blind —
// no game, no context. It now carries game_id through the URL; this opens
// that specific game's form directly.
function openChangeRequestFromUrl() {
  const gameId = parseInt(new URLSearchParams(window.location.search).get('game_id'), 10);
  if (!gameId) return;
  if (!myGames().some(g => g.game_id === gameId)) return;
  openChangeRequest(gameId);
}

// ── Games list + change requests ─────────────────────────────────────────────

function myGames() {
  return (scheduleData?.games || []).filter(g => g.home_team_id === myTeam.id || g.away_team_id === myTeam.id)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function opponentTeam(game) {
  const oppId = game.home_team_id === myTeam.id ? game.away_team_id : game.home_team_id;
  return (seasonData?.teams || []).find(t => String(t.id) === String(oppId));
}

// Compact inline summary for the games list. Full history lives in ui.js.
function liveStatusHtml(active) {
  if (!active) return '';
  const overdue = active.response_due_at && new Date(active.response_due_at) < new Date();
  const bits = [];
  if (active.round) bits.push(`Round ${active.round}`);
  if (active.proposed_by && active.proposal) bits.push(`${esc(active.proposed_by)} proposed ${esc(active.proposal.date)} ${esc(active.proposal.time)}`);
  if (active.awaiting) bits.push(`waiting on <strong>${esc(active.awaiting)}</strong>`);
  if (active.response_due_at) bits.push(`${overdue ? 'was due' : 'due'} ${esc(uiDue(active.response_due_at))}`);
  const flags = [];
  if (active.escalated?.director) flags.push('director notified');
  if (active.escalated?.admin) flags.push('admin notified');
  if (active.escalated?.stalemate) flags.push('stalemate');
  return `<div style="margin-top:4px;font-size:12px;color:${overdue ? '#991b1b' : '#92400e'}">
    ${bits.join(' · ')}${flags.length ? ` <em>(${flags.join(', ')})</em>` : ''}</div>`;
}

// Computes everything both the table row and the mobile card need for one
// game, once, so the two render paths can't quietly drift apart from
// each other.
function myGameRowCtx(g) {
  const isHome = g.home_team_id === myTeam.id;
  const mySide = isHome ? 'home' : 'away';
  const opp = opponentTeam(g);
  const status = g.status || 'scheduled';
  const confirmations = g.confirmations || {};
  const iConfirmed = !!confirmations[mySide];
  const oppName = esc(opp ? (opp.label || opp.name) : '—');
  return {
    g, isHome, opp, status,
    // Ted: "a home game is 'vs ___', an away game is '@ ___'" — replaces a
    // separate Home/Away label, since this already says which it is. Already
    // escaped here since it's assembled with markup below, not raw text.
    matchupLabel: `${isHome ? 'vs' : '@'} ${oppName}`,
    statusBadge: gameStatusBadge(status, confirmations, mySide),
    canRequest: status !== 'negotiating',
    // TODO: once tested, gate this to the day before the game through 2
    // weeks after it — for now it's shown on every eligible game per Ted.
    canRainout: status !== 'negotiating' && status !== 'cancelled',
    // TODO: once tested, only show this once the game's kickoff has passed
    // — for now it's shown on every eligible game per Ted, same as rainout.
    canScore: status !== 'cancelled',
    // Scheduled/Pending-and-not-yet-my-turn both mean "I haven't confirmed
    // this game as-is yet" — Confirmed and Negotiating never show the button.
    canConfirm: (status === 'scheduled' || status === 'pending') && !iConfirmed,
  };
}

function myGameActionButtons(ctx) {
  const g = ctx.g;
  return [
    ctx.canConfirm ? `<button class="btn btn-primary btn-sm" onclick="confirmGame(${g.game_id})">Confirm</button>` : '',
    ctx.canRequest ? `<button class="btn btn-secondary btn-sm" onclick="openChangeRequest(${g.game_id})">Request Change</button>` : '',
    ctx.canRainout ? `<button class="btn btn-secondary btn-sm" onclick="openRainout(${g.game_id})">Rain Out</button>` : '',
    ctx.canScore ? `<button class="btn btn-secondary btn-sm" onclick="openScore(${g.game_id})">${g.result ? 'Edit Score' : 'Report Score'}</button>` : '',
    `<button class="btn btn-secondary btn-sm" onclick="showGameHistory(${g.game_id})">History</button>`,
  ].join('');
}

function renderGamesList() {
  const games = myGames();
  const list = document.getElementById('games-list');
  if (!games.length) {
    list.innerHTML = '<p class="empty-note">No games scheduled yet.</p>';
    return;
  }
  const rows = games.map(myGameRowCtx);
  const forcedBadge = (g) => g.forced ? ` <span class="pill pill-wait" title="${escAttr(g.warning || 'Placed as a last resort.')}">Forced</span>` : '';

  const table = `<div class="mg-table-wrap table-wrap"><table class="fields-table">
    <thead><tr><th>#</th><th>Date</th><th>Opponent</th><th>Status</th><th>Score</th><th></th></tr></thead>
    <tbody>
    ${rows.map(ctx => `<tr>
        <td>#${ctx.g.game_id}</td>
        <td>${esc(ctx.g.day)} ${formatDateUS(ctx.g.date)} ${esc(ctx.g.time)}</td>
        <td>${ctx.matchupLabel}</td>
        <td>${ctx.statusBadge}${forcedBadge(ctx.g)}</td>
        <td>${resultBadge(ctx.g)}</td>
        <td><div class="row-actions">${myGameActionButtons(ctx)}</div></td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;

  const cards = `<div class="mg-cards">
    ${rows.map(ctx => `<div class="mg-card">
        <div class="mg-card-top">
          <span>#${ctx.g.game_id} &middot; ${esc(ctx.g.day)} ${formatDateUS(ctx.g.date)} ${esc(ctx.g.time)}</span>
        </div>
        <div class="mg-card-matchup">${ctx.matchupLabel}</div>
        <div class="mg-card-badges">${ctx.statusBadge} ${resultBadge(ctx.g)}${forcedBadge(ctx.g)}</div>
        <div class="mg-card-actions">${myGameActionButtons(ctx)}</div>
      </div>`).join('')}
  </div>`;

  list.innerHTML = table + cards;
}

// Every write action below hits a requireVerified route — gating here means
// the failure is an immediate, clear toast on the click, not a modal that
// opens fine and then silently fails (or worse, misreports itself as "no
// time works" — see openChangeRequestModal in ui.js) once you try to submit.
function requireVerifiedToEdit() {
  if (session?.verified) return true;
  toast('Verify your email first — send the link or enter the code in the banner above.', 'bad');
  document.getElementById('verify-banner')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}

// Confirm the game as scheduled/agreed — the first lifecycle step, distinct
// from and unrelated to requesting a change. POSTs directly rather than
// opening a form, since there's nothing to fill in.
async function confirmGame(gameId) {
  if (!requireVerifiedToEdit()) return;
  try {
    const res = await fetch(`api/games/${gameId}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await res.json();
    if (!data.ok) { toast(data.error || 'Could not confirm.', 'bad'); return; }
    scheduleData = await fetchJSON('api/schedule');
    renderGamesList();
    toast(data.status === 'confirmed' ? 'Confirmed — both sides have signed off.' : 'Confirmed. Waiting on the other coach.');
  } catch { toast('Network error. Try again.', 'bad'); }
}

function openChangeRequest(gameId) {
  if (!requireVerifiedToEdit()) return;
  const game = myGames().find(g => g.game_id === gameId);
  if (!game) return;
  openChangeRequestModal({
    game, teamId: myTeam.id, otherTeam: opponentTeam(game), fields: seasonData?.fields || [],
    noPhoneText: '(no phone on file — contact your director)',
    refresh: async () => { scheduleData = await fetchJSON('api/schedule'); renderGamesList(); },
  });
}

function openRainout(gameId) {
  if (!requireVerifiedToEdit()) return;
  const game = myGames().find(g => g.game_id === gameId);
  if (!game) return;
  openChangeRequestModal({
    game, teamId: myTeam.id, otherTeam: opponentTeam(game), fields: seasonData?.fields || [],
    noPhoneText: '(no phone on file — contact your director)',
    refresh: async () => { scheduleData = await fetchJSON('api/schedule'); renderGamesList(); },
    mode: 'rainout',
  });
}

function openScore(gameId) {
  if (!requireVerifiedToEdit()) return;
  const game = myGames().find(g => g.game_id === gameId);
  if (!game) return;
  openScoreModal({
    game, teamId: myTeam.id,
    refresh: async () => { scheduleData = await fetchJSON('api/schedule'); renderGamesList(); },
  });
}

function populateFieldSelect() {
  const sel = document.getElementById('mte-field');
  // Fields owned by this team's program; if the team has no program_id (legacy/admin-uploaded), show all fields.
  const fields = (seasonData?.fields || []).filter(f => !myTeam.program_id || f.program_id === myTeam.program_id);
  fields.sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
  sel.innerHTML = '<option value="">— None yet —</option>' +
    fields.map(f => `<option value="${String(f.id)}">${esc(fieldDisplayName(f))}</option>`).join('');
  sel.value = String(myTeam.home_field_id || '');
}

function renderMyAvailabilityCalendar() {
  renderAvailabilityCalendar('mte-avail-cal', seasonData?.season, (dateStr) => {
    const isSaturday = uiDayName(dateStr) === 'Saturday';
    return resolveTeamAvailabilityStatus(myTeam.availability, dateStr, isSaturday);
  }, 'team');
}

// Re-filter the per-date list live as the coach adjusts the first-available-
// day field, before saving — otherwise it only updates on the next full
// render (page load or after Save), so a coach setting it for the first time
// would still see the misleadingly-full date list right up until they save.
// readAvailabilityGrid captures whatever's already been toggled so re-
// rendering doesn't discard in-progress changes.
document.getElementById('mte-earliest').addEventListener('change', (e) => {
  const current = readAvailabilityGrid('mte-availability');
  renderAvailabilityGrid('mte-availability', current, seasonSlots, e.target.value);
});

document.getElementById('mte-save').addEventListener('click', async () => {
  const errEl = document.getElementById('mte-error');
  const okEl  = document.getElementById('mte-success');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');
  const body = {
    label:         document.getElementById('mte-label').value.trim(),
    coach:         document.getElementById('mte-coach').value.trim(),
    email:         document.getElementById('mte-email').value.trim(),
    phone:         document.getElementById('mte-phone').value.trim(),
    home_field_id: document.getElementById('mte-field').value || null,
    target_games:  document.getElementById('mte-target').value || undefined,
    earliest_date: document.getElementById('mte-earliest').value || undefined,
    availability:  readAvailabilityGrid('mte-availability'),
    restrictions:  readRestrictionsEditor('mte-restrictions'),
  };
  clearFieldErrors('mte-form');
  if (!validateForm([
    { id: 'mte-label',  label: 'Team name',       required: true },
    { id: 'mte-coach',  label: 'Coach name',      required: false },
    { id: 'mte-email',  label: 'Coach email',     required: true,  type: 'email' },
    { id: 'mte-phone',  label: 'Coach phone',     required: false, type: 'phone' },
    { id: 'mte-target', label: 'Games this season', required: false, type: 'int', min: 1, max: 20 },
  ])) return;
  try {
    const res  = await fetch(`api/teams/${myTeam.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) {
      if (!applyServerError(data)) { errEl.textContent = data.error || 'Save failed.'; errEl.classList.remove('hidden'); }
      return;
    }
    myTeam = data.team;
    document.getElementById('team-title').textContent = myTeam.label || 'My Team';
    renderAvailabilityGrid('mte-availability', myTeam.availability, seasonSlots, myTeam.earliest_date);
    renderRestrictionsEditor('mte-restrictions', myTeam, seasonData.teams, seasonData.programs, myTeam.restrictions);
    renderMyAvailabilityCalendar();
    if (data.email_change_pending) {
      okEl.textContent = data.email_change_sent
        ? `Saved. Check ${data.pending_email} for a link to confirm your new email — until then, your old email stays on file.`
        : `Saved, but the confirmation email couldn't be sent. Your email hasn't changed yet — try again shortly.`;
    } else {
      okEl.textContent = 'Saved.';
    }
    okEl.classList.remove('hidden');
  } catch (e) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
});

// ── Verify-email banner ──────────────────────────────────────────────────────

function initMyTeamVerifyBanner() {
  initVerifyBanner(session, 'Verify your email to save changes to your team.', '/my-team');
}

init();
