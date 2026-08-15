'use strict';

let session = null;
let seasonData = null;
let editingTeamId = null;
let editingFieldId = null;
let scheduleData = null;
let crTeamId = null;
let seasonSlots = null;
let tfeJerseyTouched = false;

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function teamLabel(t) { return t.label || t.name || t.team_name || `Team ${t.id}`; }

function fieldDisplayName(f) {
  return f.sub_field ? `${f.name} – ${f.sub_field}` : f.name;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Live negotiation state for the program's games, keyed by game_id, so a
// director can see what's happening without waiting for an escalation email.
let activeByGame = {};

async function loadActiveNegotiations(games) {
  activeByGame = {};
  // Not filtered by game.status — a field change deliberately never flips a
  // game's status (Ted: the other team "just shows up and plays," nothing
  // is blocked on it), so unlike a reschedule there's no status value that
  // would tell us to bother checking. Just skip games already in the past.
  const today = new Date(new Date().toDateString());
  await Promise.all(games
    .filter(g => g.status !== 'cancelled' && new Date(g.date + 'T00:00:00') >= today)
    .map(async g => {
      try {
        const h = await fetchJSON(`api/games/${g.game_id}/history`);
        if (h.active) activeByGame[g.game_id] = h.active;
      } catch {}
    }));
}

async function init() {
  try { session = await fetchJSON('api/auth/me'); } catch { session = null; }
  if (!session || (session.role !== 'director' && session.role !== 'admin')) {
    window.location = 'login';
    return;
  }
  try { seasonSlots = await fetchJSON('api/season/slots'); } catch { seasonSlots = []; }
  try { seasonData = await fetchJSON('api/season'); }
  catch (e) {
    document.getElementById('director-page').innerHTML = `<p style="color:#dc2626">Could not load season data: ${esc(e.message)}</p>`;
    return;
  }

  const program = (seasonData.programs || []).find(p => String(p.id) === String(session.program_id));
  document.getElementById('program-title').textContent = program ? `${program.name} — My Program` : 'My Program';
  if (!program && session.role !== 'admin') {
    document.getElementById('director-page').innerHTML = '<p style="color:#dc2626">No program is assigned to your account. Contact the league admin.</p>';
    return;
  }

  populateDivisionSelect();
  populateFieldSelect();
  renderTeamsList();
  renderFieldsList();
  populateAvailCalTargets();

  try { scheduleData = await fetchJSON('api/schedule'); } catch { scheduleData = { games: [] }; }
  renderGamesList();
  await loadActiveNegotiations(myProgramGames());
  renderGamesList();

  highlightGameFromUrl();
  initDirectorVerifyBanner();
}

// The public schedule's game-row button sends directors here with the
// specific game in the URL. Ted: that button used to jump straight into the
// Request Change form, which made it look like requesting a change was the
// only thing you could do about a game — scroll to and highlight the row
// instead, so every available action (Confirm, Request Change, Change Field,
// Rain Out, Report Score, Edit...) is visible at once and the director picks
// the right one.
function highlightGameFromUrl() {
  const gameId = parseInt(new URLSearchParams(window.location.search).get('game_id'), 10);
  if (!gameId) return;
  if (!myProgramGames().some(g => g.game_id === gameId)) return;
  const el = document.getElementById(`mg-row-${gameId}`) || document.getElementById(`mg-card-${gameId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('mg-highlight');
}

// ── Games list + change requests ─────────────────────────────────────────────

function myProgramGames() {
  const teamIds = new Set(myProgramTeams().map(t => String(t.id)));
  return (scheduleData?.games || []).filter(g => teamIds.has(String(g.home_team_id)) || teamIds.has(String(g.away_team_id)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function teamById(id) {
  return (seasonData?.teams || []).find(t => String(t.id) === String(id));
}


// Compact inline summary for the games list. Full history lives in ui.js.
function liveStatusHtml(active) {
  if (!active) return '';
  const overdue = active.response_due_at && new Date(active.response_due_at) < new Date();
  const bits = [];
  if (active.is_field_change) {
    const f = (seasonData?.fields || []).find(x => String(x.id) === String(active.proposal?.field_id));
    bits.push(`${esc(active.proposed_by)} moved this to ${esc(f ? fieldDisplayName(f) : 'a new field')}`);
  } else {
    if (active.round) bits.push(`Round ${active.round}`);
    if (active.proposed_by && active.proposal) bits.push(`${esc(active.proposed_by)} proposed ${esc(active.proposal.date)} ${esc(active.proposal.time)}`);
  }
  if (active.awaiting) bits.push(`${active.is_field_change ? 'awaiting acknowledgment from' : 'waiting on'} <strong>${esc(active.awaiting)}</strong>`);
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
function dirGameRowCtx(g) {
  const status = g.status || 'scheduled';
  // Whichever of our program's teams is involved is who we'd act on behalf of.
  const myTeamId = [g.home_team_id, g.away_team_id].find(id => myProgramTeams().some(t => String(t.id) === String(id)));
  const mySide = String(myTeamId) === String(g.home_team_id) ? 'home' : 'away';
  const confirmations = g.confirmations || {};
  const active = activeByGame[g.game_id] || null;
  const hasActiveRequest = active?.status === 'awaiting_response' || active?.status === 'awaiting_requester_confirm';
  return {
    g, myTeamId, status, active,
    statusBadge: gameStatusBadge(status, confirmations, mySide),
    canRequest: status !== 'negotiating',
    // Only the home team reschedules a rainout — they're the ones who have
    // to find and rebook a makeup slot at one of their own fields, mirroring
    // my-team.js. TODO: once tested, gate this to the day before the game
    // through 2 weeks after it — for now it's shown on every eligible game
    // per Ted.
    canRainout: mySide === 'home' && status !== 'negotiating' && status !== 'cancelled',
    // TODO: once tested, only show this once the game's kickoff has passed
    // — for now it's shown on every eligible game per Ted, same as rainout.
    canScore: status !== 'cancelled',
    // A director can confirm on a coach's behalf — Ted: "either nudge them
    // offline, or confirm them on the coach's behalf."
    canConfirm: (status === 'scheduled' || status === 'pending') && !confirmations[mySide],
    // Manual edit (with the force-past-the-rules authority coaches don't
    // get) — same "nothing left to touch" exclusion as Rain Out/Report Score.
    canEdit: status !== 'cancelled',
    // Only the home team's own field is ever in play, mirroring my-team.js.
    canChangeField: mySide === 'home' && status !== 'cancelled' && !hasActiveRequest,
    canAcknowledgeField: !!active && active.is_field_change && active.status === 'awaiting_response' && String(active.awaiting_team_id) === String(myTeamId),
    canChangeJersey: status !== 'cancelled',
    myJerseyColor: (mySide === 'home' ? g.home_jersey_color : g.away_jersey_color) || teamById(myTeamId)?.jersey_color,
    myJerseyLabel: (mySide === 'home' ? g.home_jersey_label : g.away_jersey_label) || teamById(myTeamId)?.jersey_label,
    oppJerseyColor: mySide === 'home' ? g.away_jersey_color : g.home_jersey_color,
    oppJerseyLabel: mySide === 'home' ? g.away_jersey_label : g.home_jersey_label,
  };
}

// Table view shows Home/Away as separate columns rather than "mine/theirs",
// so only the column matching this director's own team in that game gets a
// click-to-edit link; the other side's tag (if any) is just informational.
function dirJerseyCellHtml(ctx, side) {
  const isMine = String(side === 'home' ? ctx.g.home_team_id : ctx.g.away_team_id) === String(ctx.myTeamId);
  const color = side === 'home' ? ctx.g.home_jersey_color : ctx.g.away_jersey_color;
  const label = side === 'home' ? ctx.g.home_jersey_label : ctx.g.away_jersey_label;
  if (isMine && ctx.canChangeJersey) {
    const tag = jerseyTagHtml(color, label) || '<span class="jersey-tag" style="color:#94a3b8">+ Jersey</span>';
    return `<a href="javascript:void(0)" onclick="openJerseyChange(${ctx.g.game_id},'${ctx.myTeamId}')" style="text-decoration:none">${tag}</a>`;
  }
  return jerseyTagHtml(color, label);
}

function dirGameActionButtons(ctx) {
  const g = ctx.g, tid = String(ctx.myTeamId);
  return [
    ctx.canConfirm ? `<button class="btn btn-primary btn-sm" onclick="confirmGame(${g.game_id},'${tid}')">Confirm</button>` : '',
    ctx.canAcknowledgeField ? `<button class="btn btn-primary btn-sm" onclick="acknowledgeFieldChange(${g.game_id})">Acknowledge Field</button>` : '',
    ctx.canRequest ? `<button class="btn btn-secondary btn-sm" onclick="openChangeRequest(${g.game_id},'${tid}')">Request Change</button>` : '',
    ctx.canChangeField ? `<button class="btn btn-secondary btn-sm" onclick="openFieldChange(${g.game_id},'${tid}')">Change Field</button>` : '',
    ctx.canRainout ? `<button class="btn btn-secondary btn-sm" onclick="openRainout(${g.game_id},'${tid}')">Rain Out</button>` : '',
    ctx.canScore ? `<button class="btn btn-secondary btn-sm" onclick="openScore(${g.game_id},'${tid}')">${g.result ? 'Edit Score' : 'Report Score'}</button>` : '',
    ctx.canEdit ? `<button class="btn btn-secondary btn-sm" onclick="openGameEdit(${g.game_id})">Edit</button>` : '',
    `<button class="btn btn-secondary btn-sm" onclick="showGameHistory(${g.game_id})">History</button>`,
  ].join('');
}

function renderGamesList() {
  const games = myProgramGames();
  const list = document.getElementById('games-list');
  if (!games.length) {
    list.innerHTML = '<p class="empty-note">No games scheduled yet.</p>';
    return;
  }
  const rows = games.map(dirGameRowCtx);

  const forcedBadge = (g) => g.forced ? ` <span class="pill pill-wait" title="${escAttr(g.warning || 'Placed as a last resort.')}">Forced</span>` : '';

  const table = `<div class="mg-table-wrap table-wrap"><table class="fields-table">
    <thead><tr><th>#</th><th>Date</th><th>Home</th><th>Away</th><th>Status</th><th>Score</th><th></th></tr></thead>
    <tbody>
    ${rows.map(ctx => `<tr id="mg-row-${ctx.g.game_id}">
        <td>#${ctx.g.game_id}</td>
        <td>${esc(ctx.g.day)} ${formatDateUS(ctx.g.date)} ${esc(ctx.g.time)}</td>
        <td>${esc(ctx.g.home_team_name)}${dirJerseyCellHtml(ctx, 'home')}</td>
        <td>${esc(ctx.g.away_team_name)}${dirJerseyCellHtml(ctx, 'away')}</td>
        <td>${ctx.statusBadge}${liveStatusHtml(activeByGame[ctx.g.game_id])}${forcedBadge(ctx.g)}</td>
        <td>${resultBadge(ctx.g)}</td>
        <td><div class="row-actions">${dirGameActionButtons(ctx)}</div></td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;

  const cards = `<div class="mg-cards">
    ${rows.map(ctx => `<div class="mg-card" id="mg-card-${ctx.g.game_id}">
        <div class="mg-card-top">
          <span>#${ctx.g.game_id} &middot; ${esc(ctx.g.day)} ${formatDateUS(ctx.g.date)} ${esc(ctx.g.time)}</span>
        </div>
        <div class="mg-card-matchup">${esc(ctx.g.home_team_name)} <span class="mg-ha">vs</span> ${esc(ctx.g.away_team_name)}${jerseyRowHtml(ctx, ctx.canChangeJersey ? `openJerseyChange(${ctx.g.game_id},'${ctx.myTeamId}')` : null)}</div>
        <div class="mg-card-badges">${ctx.statusBadge}${liveStatusHtml(activeByGame[ctx.g.game_id])} ${resultBadge(ctx.g)}${forcedBadge(ctx.g)}</div>
        <div class="mg-card-actions">${dirGameActionButtons(ctx)}</div>
      </div>`).join('')}
  </div>`;

  list.innerHTML = table + cards;
}

// Confirm on behalf of whichever of the director's own teams is in this game.
async function confirmGame(gameId, teamId) {
  if (!requireVerifiedToEdit('confirm this game')) return;
  try {
    const res = await fetch(`api/games/${gameId}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ team_id: teamId }),
    });
    const data = await res.json();
    if (!data.ok) { toast(data.error || 'Could not confirm.', 'bad'); return; }
    scheduleData = await fetchJSON('api/schedule');
    renderGamesList();
    toast(data.status === 'confirmed' ? 'Confirmed — both sides have signed off.' : 'Confirmed on their behalf. Waiting on the other coach.');
  } catch { toast('Network error. Try again.', 'bad'); }
}

function openChangeRequest(gameId, teamId) {
  if (!requireVerifiedToEdit('open a change request for this game')) return;
  const game = (scheduleData?.games || []).find(g => g.game_id === gameId);
  if (!game) return;
  crTeamId = teamId;
  const otherId = String(game.home_team_id) === teamId ? game.away_team_id : game.home_team_id;
  openChangeRequestModal({
    game, teamId, otherTeam: teamById(otherId), fields: seasonData?.fields || [],
    refresh: async () => { scheduleData = await fetchJSON('api/schedule'); renderGamesList(); },
  });
}

function openRainout(gameId, teamId) {
  if (!requireVerifiedToEdit('report a rainout for this game')) return;
  const game = (scheduleData?.games || []).find(g => g.game_id === gameId);
  if (!game) return;
  crTeamId = teamId;
  const otherId = String(game.home_team_id) === teamId ? game.away_team_id : game.home_team_id;
  openChangeRequestModal({
    game, teamId, otherTeam: teamById(otherId), fields: seasonData?.fields || [],
    refresh: async () => { scheduleData = await fetchJSON('api/schedule'); renderGamesList(); },
    mode: 'rainout',
  });
}

function openFieldChange(gameId, teamId) {
  if (!requireVerifiedToEdit("change this game's field")) return;
  const game = (scheduleData?.games || []).find(g => g.game_id === gameId);
  if (!game) return;
  crTeamId = teamId;
  const otherId = String(game.home_team_id) === teamId ? game.away_team_id : game.home_team_id;
  const myTeam = teamById(teamId);
  openChangeRequestModal({
    game, teamId, otherTeam: teamById(otherId), fields: seasonData?.fields || [],
    refresh: async () => {
      scheduleData = await fetchJSON('api/schedule');
      await loadActiveNegotiations(myProgramGames());
      renderGamesList();
    },
    mode: 'field', programId: myTeam?.program_id,
  });
}

async function acknowledgeFieldChange(gameId) {
  if (!requireVerifiedToEdit('acknowledge this field change')) return;
  const active = activeByGame[gameId];
  if (!active) return;
  try {
    const res = await fetch(`api/change-requests/${active.change_request_id}/acknowledge`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) { toast(data.error || 'Could not acknowledge.', 'bad'); return; }
    await loadActiveNegotiations(myProgramGames());
    renderGamesList();
    toast('Acknowledged.');
  } catch { toast('Network error. Try again.', 'bad'); }
}

function openJerseyChange(gameId, teamId) {
  if (!requireVerifiedToEdit('set the jersey color for this game')) return;
  const game = (scheduleData?.games || []).find(g => g.game_id === gameId);
  if (!game) return;
  openJerseyModal({
    game, teamId, myTeam: teamById(teamId),
    refresh: async () => { scheduleData = await fetchJSON('api/schedule'); renderGamesList(); },
  });
}

function openScore(gameId, teamId) {
  if (!requireVerifiedToEdit('report the score for this game')) return;
  const game = (scheduleData?.games || []).find(g => g.game_id === gameId);
  if (!game) return;
  openScoreModal({
    game, teamId,
    refresh: async () => { scheduleData = await fetchJSON('api/schedule'); renderGamesList(); },
  });
}

// ── Manual game editor (director's own force authority) ─────────────────────
// Mirrors the shape of admin's Add/Edit Game panel, trimmed to just what
// this needs (no delete/rainout/score/notify-email — those already exist as
// their own actions). The scoping to "at least one of my program's teams"
// is enforced server-side; this UI doesn't try to duplicate that check, it
// just surfaces whatever the server says.
let dgeGameId = null;   // null while adding, the game id while editing
let dgeAdding = false;

function closeGameEditModal() {
  document.getElementById('dge-modal').classList.add('hidden');
  document.getElementById('dge-violations').classList.add('hidden');
  document.getElementById('dge-violations').innerHTML = '';
  document.getElementById('dge-force').classList.add('hidden');
  document.getElementById('dge-suggest-panel').classList.add('hidden');
  dgeGameId = null;
  dgeAdding = false;
}

function dgePopulateDivisionsAndTeams(selectedDivId) {
  const divSelect = document.getElementById('dge-division');
  divSelect.innerHTML = '';
  for (const d of (seasonData?.divisions || [])) {
    const opt = document.createElement('option');
    opt.value = d.id; opt.textContent = d.name || d.label || d.id;
    if (d.id === selectedDivId) opt.selected = true;
    divSelect.appendChild(opt);
  }
  dgePopulateTeams(divSelect.value);
}

function dgePopulateTeams(divId) {
  const divTeams = (seasonData?.teams || [])
    .filter(t => t.division_id === divId && t.confirmed !== false)
    .sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
  const homeSelect = document.getElementById('dge-home');
  const awaySelect = document.getElementById('dge-away');
  homeSelect.innerHTML = ''; awaySelect.innerHTML = '';
  for (const t of divTeams) {
    const label = teamLabel(t);
    const optH = document.createElement('option'); optH.value = t.id; optH.textContent = label;
    homeSelect.appendChild(optH);
    const optA = document.createElement('option'); optA.value = t.id; optA.textContent = label;
    awaySelect.appendChild(optA);
  }
}

function dgePopulateDates(selectedDate) {
  const dateSelect = document.getElementById('dge-date');
  dateSelect.innerHTML = '';
  for (const wk of (seasonSlots || [])) {
    const grp = document.createElement('optgroup');
    grp.label = `Week ${wk.week}`;
    for (const slot of wk.dates) {
      const opt = document.createElement('option');
      opt.value = slot.date;
      opt.textContent = `${slot.day} ${formatDateUS(slot.date)}`;
      if (slot.date === selectedDate) opt.selected = true;
      grp.appendChild(opt);
    }
    dateSelect.appendChild(grp);
  }
}

function dgePopulateFields(selectedFieldId) {
  const fields = [...(seasonData?.fields || [])].sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
  const fieldSelect = document.getElementById('dge-field');
  fieldSelect.innerHTML = '';
  for (const f of fields) {
    const opt = document.createElement('option');
    opt.value = f.id; opt.textContent = fieldDisplayName(f);
    if (f.id === selectedFieldId) opt.selected = true;
    fieldSelect.appendChild(opt);
  }
}

function openGameAdd() {
  if (!requireVerifiedToEdit('add a new game')) return;
  if (!seasonSlots || !seasonData) return;
  dgeAdding = true; dgeGameId = null;

  document.getElementById('dge-division-row').classList.remove('hidden');
  dgePopulateDivisionsAndTeams((seasonData.divisions || [])[0]?.id);
  dgePopulateDates(null);
  document.getElementById('dge-time').value = '';
  dgePopulateFields(null);
  document.getElementById('dge-suggest-btn').classList.add('hidden');

  document.getElementById('dge-title').textContent = 'Add Game';
  document.getElementById('dge-save').textContent = 'Add Game';
  document.getElementById('dge-violations').classList.add('hidden');
  document.getElementById('dge-violations').innerHTML = '';
  document.getElementById('dge-force').classList.add('hidden');
  document.getElementById('dge-approval-notice').classList.add('hidden');
  document.getElementById('dge-reason-row').classList.add('hidden');
  document.getElementById('dge-reason').value = '';
  document.getElementById('dge-modal').classList.remove('hidden');
}

function openGameEdit(gameId) {
  if (!requireVerifiedToEdit('edit this game')) return;
  const game = (scheduleData?.games || []).find(g => g.game_id === gameId);
  if (!game || !seasonSlots) return;
  dgeAdding = false; dgeGameId = gameId;

  document.getElementById('dge-division-row').classList.add('hidden');
  dgePopulateTeams(game.division_id);
  document.getElementById('dge-home').value = String(game.home_team_id);
  document.getElementById('dge-away').value = String(game.away_team_id);
  dgePopulateDates(game.date);
  document.getElementById('dge-time').value = game.time || '';
  dgePopulateFields(game.field_id);
  document.getElementById('dge-suggest-btn').classList.remove('hidden');

  // Editing an existing game is no longer a direct apply for a director —
  // it goes to admin for approval (see the modal comment in director.html).
  // Admin's own game-edit modal in app.js is a completely separate code
  // path and is unaffected by any of this.
  const isAdmin = session?.role === 'admin';
  document.getElementById('dge-title').textContent = `Edit Game #${game.game_id}`;
  document.getElementById('dge-save').textContent = isAdmin ? 'Save Changes' : 'Send to Admin for Approval';
  document.getElementById('dge-violations').classList.add('hidden');
  document.getElementById('dge-violations').innerHTML = '';
  document.getElementById('dge-force').classList.add('hidden');
  document.getElementById('dge-approval-notice').classList.toggle('hidden', isAdmin);
  document.getElementById('dge-reason-row').classList.toggle('hidden', isAdmin);
  document.getElementById('dge-reason').value = '';
  document.getElementById('dge-modal').classList.remove('hidden');
}

function dgeShowViolations(violations) {
  const div = document.getElementById('dge-violations');
  div.innerHTML = '<strong>Constraint violations:</strong><ul>' +
    violations.map(v => `<li>${esc(v)}</li>`).join('') + '</ul>';
  div.classList.remove('hidden');
  document.getElementById('dge-force').classList.remove('hidden');
}

async function dgeSuggestDates() {
  if (dgeAdding || dgeGameId === null) return;
  const panel = document.getElementById('dge-suggest-panel');
  panel.classList.remove('hidden');
  panel.innerHTML = '<p class="muted">Finding dates that work for both teams…</p>';
  try {
    const home = document.getElementById('dge-home').value;
    const away = document.getElementById('dge-away').value;
    const params = new URLSearchParams({ home_team_id: home, away_team_id: away });
    const data = await fetchJSON(`api/game/${dgeGameId}/suggest-dates?${params}`);
    const slots = data.suggestions || [];
    if (!slots.length) { panel.innerHTML = '<p class="danger-text">No open date/time works for both teams right now.</p>'; return; }
    panel.innerHTML = `<div class="suggest-panel-header"><strong>${slots.length} option(s)</strong>${data.home_field_name ? ` <span>at ${esc(data.home_field_name)}</span>` : ''}</div>` +
      slots.slice(0, 12).map(s => `<button type="button" class="btn btn-secondary btn-sm" data-date="${s.date}" data-time="${s.time}" style="margin:3px">${s.day} ${formatDateUS(s.date)} ${s.time}</button>`).join('');
    panel.querySelectorAll('button[data-date]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('dge-date').value = btn.dataset.date;
        document.getElementById('dge-time').value = btn.dataset.time;
      });
    });
  } catch (e) { panel.innerHTML = `<p class="danger-text">Could not load suggestions: ${esc(e.message)}</p>`; }
}

async function dgeSave(force) {
  const date = document.getElementById('dge-date').value;
  const time = document.getElementById('dge-time').value.trim();
  const field_id_raw = document.getElementById('dge-field').value;
  const home_raw = document.getElementById('dge-home').value;
  const away_raw = document.getElementById('dge-away').value;
  const field_id = isNaN(parseInt(field_id_raw, 10)) ? field_id_raw : parseInt(field_id_raw, 10);
  const home_team_id = isNaN(parseInt(home_raw, 10)) ? home_raw : parseInt(home_raw, 10);
  const away_team_id = isNaN(parseInt(away_raw, 10)) ? away_raw : parseInt(away_raw, 10);

  if (home_team_id === away_team_id) { dgeShowViolations(['Home team and away team cannot be the same.']); return; }

  // A director editing an existing game goes through admin approval instead
  // of applying directly — admin editing (either from this same page, or
  // adding a brand-new game either role) is unaffected.
  const needsApproval = !dgeAdding && session?.role !== 'admin';
  let reason = '';
  if (needsApproval) {
    reason = document.getElementById('dge-reason').value.trim();
    if (!reason) { dgeShowViolations(['Explain why this needs a direct edit — it\'s sent to admin along with the change.']); return; }
  }

  try {
    let res, data;
    if (dgeAdding) {
      const division_id = document.getElementById('dge-division').value;
      res = await fetch('api/game', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ division_id, date, time, field_id, home_team_id, away_team_id, force: !!force }),
      });
    } else if (needsApproval) {
      res = await fetch(`api/game/${dgeGameId}/override-request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, time, field_id, home_team_id, away_team_id, force: !!force, reason }),
      });
    } else {
      res = await fetch(`api/game/${dgeGameId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, time, field_id, home_team_id, away_team_id, force: !!force }),
      });
    }
    data = await res.json();
    if (res.status === 409) { dgeShowViolations(data.violations || ['Unknown conflict.']); return; }
    if (!res.ok) { toast(data.error || 'Save failed.', 'bad'); return; }
    if (needsApproval) {
      closeGameEditModal();
      toast('Sent to admin for approval — the game stays as-is until they approve it.', 'good');
      return;
    }
    scheduleData = await fetchJSON('api/schedule');
    renderGamesList();
    closeGameEditModal();
    toast(force ? 'Saved — rules were forced through.' : 'Game saved.', 'good');
  } catch (e) { toast('Network error. Try again.', 'bad'); }
}

document.getElementById('btn-add-game').addEventListener('click', openGameAdd);
document.getElementById('dge-close').addEventListener('click', closeGameEditModal);
document.getElementById('dge-cancel').addEventListener('click', closeGameEditModal);
document.getElementById('dge-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeGameEditModal(); });
document.getElementById('dge-save').addEventListener('click', () => dgeSave(false));
document.getElementById('dge-force').addEventListener('click', () => dgeSave(true));
document.getElementById('dge-suggest-btn').addEventListener('click', dgeSuggestDates);
document.getElementById('dge-division').addEventListener('change', e => { if (dgeAdding) dgePopulateTeams(e.target.value); });

function myProgramFields() {
  return (seasonData?.fields || []).filter(f => f.program_id === session.program_id);
}
function myProgramTeams() {
  return (seasonData?.teams || []).filter(t => t.program_id === session.program_id);
}

// ── Availability calendar ────────────────────────────────────────────────────

function populateAvailCalTargets() {
  const mode = document.getElementById('dcal-mode').value;
  const sel = document.getElementById('dcal-target');
  // Rebuilding a <select>'s options resets the browser's selection to
  // whichever is now first, unless we explicitly restore it — this function
  // gets called after ANY team/field save on the whole page (not just ones
  // made from this tab), so without this a director watching one team's
  // calendar would silently get bounced to a different team the moment they
  // saved an edit, making the edit look like it "didn't show up" when it
  // actually saved fine (Ted, 2026-08-07 bug report).
  const prevSelection = sel.value;
  document.getElementById('dcal-target-label').textContent = mode === 'field' ? 'Field:' : 'Team:';
  if (mode === 'field') {
    const fields = [...myProgramFields()].sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
    sel.innerHTML = fields.map(f => `<option value="${String(f.id)}">${esc(fieldDisplayName(f))}</option>`).join('');
  } else {
    const teams = [...myProgramTeams()].sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
    sel.innerHTML = teams.map(t => `<option value="${String(t.id)}">${esc(teamLabel(t))}</option>`).join('');
  }
  if (prevSelection && [...sel.options].some(o => o.value === prevSelection)) sel.value = prevSelection;
  renderDirectorAvailCalendar();
}

function renderDirectorAvailCalendar() {
  const mode = document.getElementById('dcal-mode').value;
  const targetId = document.getElementById('dcal-target').value;
  const wrapper = document.getElementById('director-avail-cal');
  if (!targetId) { wrapper.innerHTML = `<p class="empty-state">No ${mode === 'field' ? 'fields' : 'teams'} yet.</p>`; return; }
  if (mode === 'field') {
    const field = myProgramFields().find(f => String(f.id) === targetId);
    renderAvailabilityCalendar('director-avail-cal', seasonData?.season, (dateStr) =>
      resolveFieldAvailabilityStatus(field?.availability, dateStr, uiDayName(dateStr) === 'Saturday'), 'field');
  } else {
    const team = myProgramTeams().find(t => String(t.id) === targetId);
    renderAvailabilityCalendar('director-avail-cal', seasonData?.season, (dateStr) =>
      resolveTeamAvailabilityStatus(team?.availability, dateStr, uiDayName(dateStr) === 'Saturday'), 'team');
  }
}

document.getElementById('dcal-mode').addEventListener('change', populateAvailCalTargets);
document.getElementById('dcal-target').addEventListener('change', renderDirectorAvailCalendar);

// ── Teams ─────────────────────────────────────────────────────────────────────

function populateDivisionSelect() {
  const sel = document.getElementById('tfe-division');
  const divisions = [...(seasonData?.divisions || [])].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  sel.innerHTML = divisions.map(d => `<option value="${String(d.id)}">${esc(d.name || d.label || d.id)}</option>`).join('');
}

function populateFieldSelect() {
  const sel = document.getElementById('tfe-field');
  const fields = [...myProgramFields()].sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
  sel.innerHTML = '<option value="">— None yet —</option>' +
    fields.map(f => `<option value="${String(f.id)}">${esc(fieldDisplayName(f))}</option>`).join('');
}

function renderTeamsList() {
  const teams = [...myProgramTeams()].sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
  const divName = id => (seasonData?.divisions || []).find(d => String(d.id) === String(id))?.name || id;
  const fieldName = id => { const f = (seasonData?.fields || []).find(x => String(x.id) === String(id)); return f ? fieldDisplayName(f) : '—'; };
  const list = document.getElementById('teams-list');

  if (!teams.length) {
    list.innerHTML = '<p class="empty-note">No teams yet. Add one above.</p>';
    return;
  }

  // A team with no email has no coach who can sign in, set availability, or be
  // reached about a change — it is registered but inert. Worth saying plainly.
  const noEmail = teams.filter(t => !(t.email || '').trim());
  const noField = teams.filter(t => !t.home_field_id);
  const noAvail = teams.filter(t => !t.availability || !Object.keys(t.availability).length);
  const gaps = [];
  if (noEmail.length) gaps.push(`${noEmail.length} without a coach email — that coach can't sign in or be contacted about changes`);
  if (noField.length) gaps.push(`${noField.length} without a home field`);
  if (noAvail.length) gaps.push(`${noAvail.length} with no availability set — they'll be scheduled on the default pattern`);
  const banner = gaps.length
    ? `<div class="notice notice-warn section-gap"><strong>Before the schedule runs:</strong><ul style="margin:6px 0 0 18px">${
        gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>`
    : `<div class="notice notice-good section-gap">All ${teams.length} teams have a coach, a home field and availability set.</div>`;

  list.innerHTML = banner + `<div class="table-wrap"><table class="fields-table">
    <thead><tr><th>Team</th><th>Division</th><th>Coach</th><th>Email</th><th>Phone</th><th>Home Field</th><th></th></tr></thead>
    <tbody>
    ${teams.map(t => `<tr>
        <td><strong>${esc(teamLabel(t))}</strong></td>
        <td>${esc(divName(t.division_id))}</td>
        <td>${esc(t.coach || '—')}</td>
        <td>${t.email ? esc(t.email) : '<span class="pill pill-wait">no email</span>'}</td>
        <td>${esc(t.phone || '—')}</td>
        <td>${t.home_field_id ? esc(fieldName(t.home_field_id)) : '<span class="pill pill-wait">not set</span>'}</td>
        <td><div class="row-actions">
          <button class="btn btn-secondary btn-sm" onclick="openTeamEdit('${String(t.id)}')">Edit</button>
          <button class="btn btn-secondary btn-sm danger-text" onclick="deleteTeam(${escAttr(t.id)},${escAttr(teamLabel(t))})">Delete</button>
        </div></td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;
}

// Demo deployments mirror dev's live data for visitors to look around, but a
// director/coach account there must never actually change anything — the
// server enforces this independently (any mutating request from that role
// is a no-op there too), this is just the friendly, no-round-trip path that
// tells the visitor what the button would have done. Admin is exempt: that's
// how Ted himself manages the data demo is mirroring.
function demoBlocked(what) {
  if (!session?.demoMode || session.role === 'admin') return false;
  toast(`This is a demo — clicking here would ${what}, but nothing is actually changed.`);
  return true;
}

// Opening any editor when unverified means a director can fill in the whole
// form and lose it all at Save, since requireVerified only rejects the write —
// it never stops the form from being filled in first. Gating here instead
// means the only thing that gets interrupted is a click, not typed-in work.
function requireVerifiedToEdit(what) {
  if (demoBlocked(what)) return false;
  if (session?.verified) return true;
  toast('Verify your email first — send the link or enter the code in the banner above.', 'bad');
  document.getElementById('verify-banner')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}

function openTeamAdd() {
  if (!requireVerifiedToEdit('add a new team')) return;
  if (!(seasonData?.divisions || []).length) { toast('No divisions exist yet — ask the admin to set them up first.', 'bad'); return; }
  editingTeamId = null;
  document.getElementById('team-form-title').textContent = 'Add Team';
  document.getElementById('tfe-label').value = '';
  document.getElementById('tfe-coach').value = '';
  document.getElementById('tfe-email').value = '';
  document.getElementById('tfe-phone').value = '';
  document.getElementById('tfe-target').value = '';
  document.getElementById('tfe-earliest').value = '';
  document.getElementById('tfe-jersey-color').value = '#1a2e6e';
  document.getElementById('tfe-jersey-label').value = '';
  tfeJerseyTouched = false;
  populateDivisionSelect();
  populateFieldSelect();
  renderAvailabilityGrid('tfe-availability', null, seasonSlots, '');
  // Collapsed by default on Add — setting availability is the coach's job,
  // later. A director who genuinely needs to set it now can still open this.
  document.getElementById('tfe-availability-details').open = false;
  document.getElementById('tfe-error').classList.add('hidden');
  document.getElementById('team-editor-form').classList.remove('hidden');
  document.getElementById('tfe-label').focus();
}

function openTeamEdit(teamId) {
  if (!requireVerifiedToEdit('edit this team')) return;
  const team = myProgramTeams().find(t => String(t.id) === teamId);
  if (!team) return;
  editingTeamId = teamId;
  document.getElementById('team-form-title').textContent = 'Edit Team';
  document.getElementById('tfe-label').value = team.label || '';
  document.getElementById('tfe-coach').value = team.coach || '';
  document.getElementById('tfe-email').value = team.email || '';
  document.getElementById('tfe-phone').value = team.phone || '';
  document.getElementById('tfe-target').value = team.target_games || '';
  document.getElementById('tfe-earliest').value = team.earliest_date || '';
  document.getElementById('tfe-jersey-color').value = team.jersey_color || '#1a2e6e';
  document.getElementById('tfe-jersey-label').value = team.jersey_label || '';
  tfeJerseyTouched = false;
  populateDivisionSelect();
  populateFieldSelect();
  document.getElementById('tfe-division').value = String(team.division_id || '');
  document.getElementById('tfe-field').value = String(team.home_field_id || '');
  renderAvailabilityGrid('tfe-availability', team.availability, seasonSlots, team.earliest_date);
  // Open on Edit — this is the director deliberately going looking for it.
  document.getElementById('tfe-availability-details').open = true;
  document.getElementById('tfe-error').classList.add('hidden');
  document.getElementById('team-editor-form').classList.remove('hidden');
  document.getElementById('tfe-label').focus();
}

document.getElementById('btn-add-team').addEventListener('click', openTeamAdd);
document.getElementById('tfe-cancel').addEventListener('click', () => {
  document.getElementById('team-editor-form').classList.add('hidden');
});

// Re-filter the per-date list live as the first-available-day field changes
// (shared by both Add and Edit) — otherwise it only updates on the next full
// render, so a director setting it for a brand-new team wouldn't see it take
// effect until after saving. readAvailabilityGrid captures whatever's
// already been toggled so re-rendering doesn't discard in-progress changes.
document.getElementById('tfe-earliest').addEventListener('change', (e) => {
  const current = readAvailabilityGrid('tfe-availability');
  renderAvailabilityGrid('tfe-availability', current, seasonSlots, e.target.value);
});

document.getElementById('tfe-jersey-color').addEventListener('input', () => { tfeJerseyTouched = true; });

document.getElementById('tfe-save').addEventListener('click', async () => {
  const errEl = document.getElementById('tfe-error');
  errEl.classList.add('hidden');
  const editingTeam = editingTeamId ? myProgramTeams().find(t => String(t.id) === editingTeamId) : null;
  const body = {
    label:         document.getElementById('tfe-label').value.trim(),
    coach:         document.getElementById('tfe-coach').value.trim(),
    email:         document.getElementById('tfe-email').value.trim(),
    phone:         document.getElementById('tfe-phone').value.trim(),
    division_id:   document.getElementById('tfe-division').value,
    home_field_id: document.getElementById('tfe-field').value || null,
    target_games:  document.getElementById('tfe-target').value || undefined,
    earliest_date: document.getElementById('tfe-earliest').value || undefined,
    availability:  readAvailabilityGrid('tfe-availability'),
    // Same "can't tell untouched from genuinely black" issue as my-team.js's
    // color picker — only send it once this team already had a color on
    // file, or this session actually opened the picker.
    jersey_color: (editingTeam?.jersey_color || tfeJerseyTouched) ? document.getElementById('tfe-jersey-color').value : undefined,
    jersey_label: document.getElementById('tfe-jersey-label').value.trim(),
    // No restrictions field — Teams to Avoid is admin-only now; even if this
    // were sent, PUT /api/teams/:id ignores it from a non-admin caller.
  };
  clearFieldErrors('team-editor-form');
  if (!validateForm([
    { id: 'tfe-label',  label: 'Team name',        required: true },
    { id: 'tfe-coach',  label: 'Coach name',       required: false },
    { id: 'tfe-email',  label: 'Coach email',      required: false, type: 'email' },
    { id: 'tfe-phone',  label: 'Coach phone',      required: false, type: 'phone' },
    { id: 'tfe-target', label: 'Games this season', required: false, type: 'int', min: 1, max: 20 },
  ])) return;
  const url    = editingTeamId ? `api/teams/${editingTeamId}` : 'api/teams';
  const method = editingTeamId ? 'PUT' : 'POST';
  try {
    const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) {
      if (!applyServerError(data)) { errEl.textContent = data.error || 'Save failed.'; errEl.classList.remove('hidden'); }
      return;
    }
    seasonData = await fetchJSON('api/season');
    document.getElementById('team-editor-form').classList.add('hidden');
    renderTeamsList();
    populateAvailCalTargets();
    if (data.email_change_pending) {
      toast(data.email_change_sent
        ? `Saved. Email unchanged until ${data.pending_email} clicks the confirmation link.`
        : `Saved, but the confirmation email failed to send — the email is unchanged.`,
        data.email_change_sent ? 'good' : 'bad');
    }
  } catch (e) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
});

async function deleteTeam(teamId, teamName) {
  if (demoBlocked('delete this team')) return;
  try {
    if (!await deleteWithBlockers(`api/teams/${teamId}`, teamName, 'delete')) return;
    seasonData = await fetchJSON('api/season');
    renderTeamsList();
    populateAvailCalTargets();
    populateFieldSelect();
  } catch (e) { toast('Network error. Try again.', 'bad'); }
}

// ── Fields ────────────────────────────────────────────────────────────────────

function renderFieldsList() {
  const fields = [...myProgramFields()].sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
  const teams = seasonData?.teams || [];
  const list = document.getElementById('fields-list');

  const usageCount = {};
  teams.forEach(t => { if (t.home_field_id) usageCount[t.home_field_id] = (usageCount[t.home_field_id] || 0) + 1; });

  if (!fields.length) {
    list.innerHTML = '<p class="empty-note">No fields defined. Add one above.</p>';
    return;
  }

  list.innerHTML = `<div class="table-wrap"><table class="fields-table">
    <thead><tr><th>Field</th><th>Address</th><th>Used By</th><th>Availability</th><th></th></tr></thead>
    <tbody>
    ${fields.map(f => {
      const usage = usageCount[f.id] || 0;
      const avail = fieldAvailabilitySummary(f);
      return `<tr>
        <td><strong>${esc(f.name)}</strong>${f.sub_field ? `<span class="field-subfield-badge">${esc(f.sub_field)}</span>` : ''}</td>
        <td>${esc(f.address || '—')}</td>
        <td>${usage ? `<span class="field-used-badge">${usage} team${usage !== 1 ? 's' : ''}</span>` : '<span style="color:#cbd5e1">—</span>'}</td>
        <td><span class="pill ${avail.restricted ? 'pill-wait' : 'pill-good'}">${esc(avail.text)}</span></td>
        <td><div class="row-actions">
          <button class="btn btn-secondary btn-sm" onclick="openFieldEdit('${String(f.id)}')">Edit</button>
          <button class="btn btn-secondary btn-sm danger-text" onclick="deleteField(${escAttr(f.id)},${escAttr(fieldDisplayName(f))})">Delete</button>
        </div></td>
      </tr>`;
    }).join('')}
    </tbody>
  </table></div>`;
}

function openFieldAdd() {
  if (!requireVerifiedToEdit('add a new field')) return;
  editingFieldId = null;
  document.getElementById('field-form-title').textContent = 'Add Field';
  document.getElementById('ffe-name').value = '';
  document.getElementById('ffe-subfield').value = '';
  document.getElementById('ffe-address').value = '';
  document.getElementById('ffe-notes').value = '';
  document.getElementById('ffe-coords').value = '';
  resetFieldGeocodeUI();
  renderFieldAvailabilityGrid('ffe-availability', null, seasonSlots);
  document.getElementById('ffe-error').classList.add('hidden');
  document.getElementById('field-editor-form').classList.remove('hidden');
  document.getElementById('ffe-name').focus();
}

function openFieldEdit(fieldId) {
  if (!requireVerifiedToEdit('edit this field')) return;
  const field = myProgramFields().find(f => String(f.id) === fieldId);
  if (!field) return;
  editingFieldId = fieldId;
  document.getElementById('field-form-title').textContent = 'Edit Field';
  document.getElementById('ffe-name').value = field.name || '';
  document.getElementById('ffe-subfield').value = field.sub_field || '';
  document.getElementById('ffe-address').value = field.address || '';
  document.getElementById('ffe-notes').value = field.notes || '';
  document.getElementById('ffe-coords').value = field.coordinates ? field.coordinates.replace(',', ', ') : '';
  resetFieldGeocodeUI();
  renderFieldAvailabilityGrid('ffe-availability', field.availability, seasonSlots);
  document.getElementById('ffe-error').classList.add('hidden');
  document.getElementById('field-editor-form').classList.remove('hidden');
  document.getElementById('ffe-name').focus();
}

document.getElementById('btn-add-field').addEventListener('click', openFieldAdd);
document.getElementById('ffe-cancel').addEventListener('click', () => {
  document.getElementById('field-editor-form').classList.add('hidden');
});

document.getElementById('ffe-save').addEventListener('click', async () => {
  const errEl = document.getElementById('ffe-error');
  errEl.classList.add('hidden');
  const body = {
    name:        document.getElementById('ffe-name').value.trim(),
    sub_field:   document.getElementById('ffe-subfield').value.trim(),
    address:     document.getElementById('ffe-address').value.trim(),
    notes:       document.getElementById('ffe-notes').value.trim(),
    coordinates: document.getElementById('ffe-coords').value.trim(),
    availability: readFieldAvailabilityGrid('ffe-availability'),
  };
  clearFieldErrors('field-editor-form');
  if (!validateForm([
    { id: 'ffe-name',   label: 'Venue name',  required: true },
    { id: 'ffe-coords', label: 'Coordinates', required: false, type: 'coords' },
  ])) return;
  const url    = editingFieldId ? `api/season/fields/${editingFieldId}` : 'api/season/fields';
  const method = editingFieldId ? 'PUT' : 'POST';
  try {
    const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) {
      if (!applyServerError(data)) { errEl.textContent = data.error || 'Save failed.'; errEl.classList.remove('hidden'); }
      return;
    }
    seasonData = await fetchJSON('api/season');
    document.getElementById('field-editor-form').classList.add('hidden');
    renderFieldsList();
    populateAvailCalTargets();
    populateFieldSelect();
  } catch (e) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
});

async function deleteField(fieldId, fieldName) {
  if (demoBlocked('delete this field')) return;
  try {
    if (!await deleteWithBlockers(`api/season/fields/${fieldId}`, fieldName, 'delete')) return;
    seasonData = await fetchJSON('api/season');
    renderFieldsList();
    populateAvailCalTargets();
    populateFieldSelect();
  } catch (e) { toast('Network error. Try again.', 'bad'); }
}

// ── Verify-email banner ──────────────────────────────────────────────────────

function initDirectorVerifyBanner() {
  initVerifyBanner(session, 'Verify your email to add or edit teams and fields.', '/director');
}

init();
