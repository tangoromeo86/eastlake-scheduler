'use strict';

let session = null;
let seasonData = null;
let editingTeamId = null;
let editingFieldId = null;
let scheduleData = null;
let crTeamId = null;
let seasonSlots = null;

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
  await Promise.all(games
    .filter(g => (g.status || 'scheduled') === 'pending')
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

  openChangeRequestFromUrl();
  initDirectorVerifyBanner();
}

// The public schedule's "Request Change" button used to redirect here blind —
// no game, no context, just the top of the page. It now carries game_id (and
// team_id, since a director can manage several teams) through the URL; this
// opens that specific game's form directly instead of leaving the director to
// scroll and re-find it themselves.
function openChangeRequestFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const gameId = parseInt(params.get('game_id'), 10);
  if (!gameId) return;
  const teamId = params.get('team_id');
  const game = myProgramGames().find(g => g.game_id === gameId);
  if (!game) return;
  const resolvedTeamId = teamId || [game.home_team_id, game.away_team_id]
    .find(id => myProgramTeams().some(t => String(t.id) === String(id)));
  if (!resolvedTeamId) return;
  openChangeRequest(gameId, String(resolvedTeamId));
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

function renderGamesList() {
  const games = myProgramGames();
  const list = document.getElementById('games-list');
  if (!games.length) {
    list.innerHTML = '<p class="empty-note">No games scheduled yet.</p>';
    return;
  }
  list.innerHTML = `<div class="table-wrap"><table class="fields-table">
    <thead><tr><th>Date</th><th>Home</th><th>Away</th><th>Status</th><th>Score</th><th></th></tr></thead>
    <tbody>
    ${games.map(g => {
      const status = g.status || 'scheduled';
      // Whichever of our program's teams is involved is who we'd act on behalf of.
      const myTeamId = [g.home_team_id, g.away_team_id].find(id => myProgramTeams().some(t => String(t.id) === String(id)));
      const mySide = String(myTeamId) === String(g.home_team_id) ? 'home' : 'away';
      const confirmations = g.confirmations || {};
      const statusBadge = gameStatusBadge(status, confirmations, mySide);
      const canRequest = status !== 'negotiating';
      // TODO: once tested, gate this to the day before the game through 2
      // weeks after it — for now it's shown on every eligible game per Ted.
      const canRainout = status !== 'negotiating' && status !== 'cancelled';
      // TODO: once tested, only show this once the game's kickoff has passed
      // — for now it's shown on every eligible game per Ted, same as rainout.
      const canScore = status !== 'cancelled';
      // A director can confirm on a coach's behalf — Ted: "either nudge them
      // offline, or confirm them on the coach's behalf."
      const canConfirm = (status === 'scheduled' || status === 'pending') && !confirmations[mySide];
      return `<tr>
        <td>${esc(g.day)} ${esc(g.date)} ${esc(g.time)}</td>
        <td>${esc(g.home_team_name)}</td>
        <td>${esc(g.away_team_name)}</td>
        <td>${statusBadge}${liveStatusHtml(activeByGame[g.game_id])}</td>
        <td>${resultBadge(g)}</td>
        <td><div class="row-actions">
          ${canConfirm ? `<button class="btn btn-primary btn-sm" onclick="confirmGame(${g.game_id},'${String(myTeamId)}')">Confirm</button>` : ''}
          ${canRequest ? `<button class="btn btn-secondary btn-sm" onclick="openChangeRequest(${g.game_id},'${String(myTeamId)}')">Request Change</button>` : ''}
          ${canRainout ? `<button class="btn btn-secondary btn-sm" onclick="openRainout(${g.game_id},'${String(myTeamId)}')">Rain Out</button>` : ''}
          ${canScore ? `<button class="btn btn-secondary btn-sm" onclick="openScore(${g.game_id},'${String(myTeamId)}')">${g.result ? 'Edit Score' : 'Report Score'}</button>` : ''}
          <button class="btn btn-secondary btn-sm" onclick="showGameHistory(${g.game_id})">History</button>
        </div></td>
      </tr>`;
    }).join('')}
    </tbody>
  </table></div>`;
}

// Confirm on behalf of whichever of the director's own teams is in this game.
async function confirmGame(gameId, teamId) {
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

function openScore(gameId, teamId) {
  const game = (scheduleData?.games || []).find(g => g.game_id === gameId);
  if (!game) return;
  openScoreModal({
    game, teamId,
    refresh: async () => { scheduleData = await fetchJSON('api/schedule'); renderGamesList(); },
  });
}

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
  document.getElementById('dcal-target-label').textContent = mode === 'field' ? 'Field:' : 'Team:';
  if (mode === 'field') {
    const fields = [...myProgramFields()].sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
    sel.innerHTML = fields.map(f => `<option value="${String(f.id)}">${esc(fieldDisplayName(f))}</option>`).join('');
  } else {
    const teams = [...myProgramTeams()].sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
    sel.innerHTML = teams.map(t => `<option value="${String(t.id)}">${esc(teamLabel(t))}</option>`).join('');
  }
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
          <button class="btn btn-secondary btn-sm danger-text" onclick="deleteTeam('${String(t.id)}','${esc(teamLabel(t))}')">Delete</button>
        </div></td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;
}

// Opening any editor when unverified means a director can fill in the whole
// form and lose it all at Save, since requireVerified only rejects the write —
// it never stops the form from being filled in first. Gating here instead
// means the only thing that gets interrupted is a click, not typed-in work.
function requireVerifiedToEdit() {
  if (session?.verified) return true;
  toast('Verify your email first — send the link or enter the code in the banner above.', 'bad');
  document.getElementById('verify-banner')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}

function openTeamAdd() {
  if (!requireVerifiedToEdit()) return;
  if (!(seasonData?.divisions || []).length) { toast('No divisions exist yet — ask the admin to set them up first.', 'bad'); return; }
  editingTeamId = null;
  document.getElementById('team-form-title').textContent = 'Add Team';
  document.getElementById('tfe-label').value = '';
  document.getElementById('tfe-coach').value = '';
  document.getElementById('tfe-email').value = '';
  document.getElementById('tfe-phone').value = '';
  document.getElementById('tfe-target').value = '';
  document.getElementById('tfe-earliest').value = '';
  populateDivisionSelect();
  populateFieldSelect();
  renderAvailabilityGrid('tfe-availability', null, seasonSlots);
  // Collapsed by default on Add — setting availability is the coach's job,
  // later. A director who genuinely needs to set it now can still open this.
  document.getElementById('tfe-availability-details').open = false;
  document.getElementById('tfe-error').classList.add('hidden');
  document.getElementById('team-editor-form').classList.remove('hidden');
  document.getElementById('tfe-label').focus();
}

function openTeamEdit(teamId) {
  if (!requireVerifiedToEdit()) return;
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
  populateDivisionSelect();
  populateFieldSelect();
  document.getElementById('tfe-division').value = String(team.division_id || '');
  document.getElementById('tfe-field').value = String(team.home_field_id || '');
  renderAvailabilityGrid('tfe-availability', team.availability, seasonSlots);
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

document.getElementById('tfe-save').addEventListener('click', async () => {
  const errEl = document.getElementById('tfe-error');
  errEl.classList.add('hidden');
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
          <button class="btn btn-secondary btn-sm danger-text" onclick="deleteField('${String(f.id)}','${esc(fieldDisplayName(f))}')">Delete</button>
        </div></td>
      </tr>`;
    }).join('')}
    </tbody>
  </table></div>`;
}

function openFieldAdd() {
  if (!requireVerifiedToEdit()) return;
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
  if (!requireVerifiedToEdit()) return;
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
