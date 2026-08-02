'use strict';

let session = null;
let seasonData = null;
let editingTeamId = null;
let editingFieldId = null;
let scheduleData = null;
let crGameId = null;
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

  try { scheduleData = await fetchJSON('api/schedule'); } catch { scheduleData = { games: [] }; }
  renderGamesList();
  await loadActiveNegotiations(myProgramGames());
  renderGamesList();

  initVerifyBanner();
}

// ── Games list + change requests ─────────────────────────────────────────────

function myProgramGames() {
  const teamIds = new Set(myProgramTeams().map(t => String(t.id)));
  return (scheduleData?.games || []).filter(g => teamIds.has(String(g.home_team_id)) || teamIds.has(String(g.away_team_id)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function daysUntil(dateStr) {
  const ms = new Date(dateStr + 'T00:00:00') - new Date(new Date().toDateString());
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function teamById(id) {
  return (seasonData?.teams || []).find(t => String(t.id) === String(id));
}


// ── Change-request slot picker ───────────────────────────────────────────────
// Slots come from the server, which only offers times valid for BOTH teams.
let crSelectedSlot = null;

function crSlotLabel(s) {
  const d = new Date(s.date + 'T12:00:00Z');
  const nice = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${nice} at ${s.time}`;
}

async function loadChangeSlots(gameId) {
  const box = document.getElementById('cr-slots');
  const submitBtn = document.getElementById('cr-submit');
  box.innerHTML = '<p class="muted">Finding times that work for both teams…</p>';
  submitBtn.disabled = true;
  try {
    const params = new URLSearchParams({ game_id: gameId });
    if (crTeamId) params.set('team_id', crTeamId);
    const data = await fetchJSON('api/change-requests/options?' + params.toString());
    if (!data.slots.length) {
      box.innerHTML = '<p class="danger-text">No other time fits both teams\' availability. You may need to adjust a team\'s availability or open up a field.</p>';
      return;
    }
    box.innerHTML = data.slots.map((s, i) => `
      <label class="cr-slot">
        <input type="radio" name="cr-slot" value="${i}">${esc(crSlotLabel(s))}
      </label>`).join('');
    box.querySelectorAll('input[name="cr-slot"]').forEach(r => {
      r.addEventListener('change', () => {
        crSelectedSlot = data.slots[parseInt(r.value, 10)];
        submitBtn.disabled = false;
        const sel = document.getElementById('cr-time');
        sel.innerHTML = (crSelectedSlot.allowed_times || [crSelectedSlot.time])
          .map(t => `<option value="${t}"${t === crSelectedSlot.time ? ' selected' : ''}>${t}</option>`).join('');
        document.getElementById('cr-time-row').style.display = '';
      });
    });
  } catch (e) {
    box.innerHTML = '<p class="danger-text">Could not load available times. Try again.</p>';
  }
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
    <thead><tr><th>Date</th><th>Home</th><th>Away</th><th>Status</th><th></th></tr></thead>
    <tbody>
    ${games.map(g => {
      const status = g.status || 'scheduled';
      const statusBadge = status === 'pending' ? '<span class="unconfirmed-badge">Pending change</span>'
        : status === 'confirmed' ? '<span class="confirmed-badge">Confirmed change</span>'
        : status === 'finalized' ? '<span class="confirmed-badge">Finalized</span>' : '—';
      // Whichever of our program's teams is involved is who we'd act on behalf of.
      const myTeamId = [g.home_team_id, g.away_team_id].find(id => myProgramTeams().some(t => String(t.id) === String(id)));
      const canRequest = status !== 'finalized';
      return `<tr>
        <td>${esc(g.day)} ${esc(g.date)} ${esc(g.time)}</td>
        <td>${esc(g.home_team_name)}</td>
        <td>${esc(g.away_team_name)}</td>
        <td>${statusBadge}${liveStatusHtml(activeByGame[g.game_id])}</td>
        <td><div class="row-actions">
          ${canRequest ? `<button class="btn btn-secondary btn-sm" onclick="openChangeRequest(${g.game_id},'${String(myTeamId)}')">Request Change</button>` : ''}
          <button class="btn btn-secondary btn-sm" onclick="showGameHistory(${g.game_id})">History</button>
        </div></td>
      </tr>`;
    }).join('')}
    </tbody>
  </table></div>`;
}

function populateCrFieldSelects() {
  const fields = [...(seasonData?.fields || [])].sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
  const opts = '<option value="">— No preference —</option>' + fields.map(f => `<option value="${String(f.id)}">${esc(fieldDisplayName(f))}</option>`).join('');
  document.getElementById('cr-field').innerHTML = opts;
  document.getElementById('cr-mo-field').innerHTML = opts.replace('No preference', 'Keep current');
}

function openChangeRequest(gameId, teamId) {
  const game = (scheduleData?.games || []).find(g => g.game_id === gameId);
  if (!game) return;
  crGameId = gameId;
  crTeamId = teamId;
  const otherId = String(game.home_team_id) === teamId ? game.away_team_id : game.home_team_id;
  const other = teamById(otherId);
  document.getElementById('cr-error').classList.add('hidden');
  populateCrFieldSelects();

  crSelectedSlot = null;
  const tr = document.getElementById('cr-time-row');
  if (tr) tr.style.display = 'none';
  const locked = daysUntil(game.date) < 7;
  document.getElementById('cr-form-title').textContent = locked ? 'Change Locked — Manual Override' : 'Request Change';
  document.getElementById('cr-normal-form').classList.toggle('hidden', locked);
  document.getElementById('cr-lockout-form').classList.toggle('hidden', !locked);
  if (locked) {
    document.getElementById('cr-other-phone').textContent = other?.phone || '(no phone on file)';
    document.getElementById('cr-mo-date').value = game.date;
    document.getElementById('cr-mo-time').value = game.time;
  } else {
    document.getElementById('cr-reason').value = '';
    loadChangeSlots(gameId);
  }
  document.getElementById('cr-form').classList.remove('hidden');
}

document.getElementById('cr-cancel').addEventListener('click', () => document.getElementById('cr-form').classList.add('hidden'));
document.getElementById('cr-mo-cancel').addEventListener('click', () => document.getElementById('cr-form').classList.add('hidden'));

document.getElementById('cr-submit').addEventListener('click', async () => {
  const errEl = document.getElementById('cr-error');
  errEl.classList.add('hidden');
  if (!crSelectedSlot) { errEl.textContent = 'Pick a proposed time first.'; errEl.classList.remove('hidden'); return; }
  const body = {
    game_id: crGameId, team_id: crTeamId,
    reason: document.getElementById('cr-reason').value.trim(),
    slot: { date: crSelectedSlot.date, slot_key: crSelectedSlot.slot_key || null,
            time: document.getElementById('cr-time').value || crSelectedSlot.time },
  };
  try {
    const res = await fetch('api/change-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) { errEl.textContent = data.error || 'Could not submit request.'; errEl.classList.remove('hidden'); return; }
    document.getElementById('cr-form').classList.add('hidden');
    toast("Check the coach's email to confirm this request before it reaches the other coach.", 'good');
  } catch (e) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
});

document.getElementById('cr-mo-submit').addEventListener('click', async () => {
  const errEl = document.getElementById('cr-error');
  errEl.classList.add('hidden');
  const who = document.getElementById('cr-mo-who').value.trim();
  const how = document.getElementById('cr-mo-how').value.trim();
  const date = document.getElementById('cr-mo-date').value;
  const time = document.getElementById('cr-mo-time').value.trim();
  if (!who || !how || !date || !time) { errEl.textContent = 'Date, time, who, and how are all required.'; errEl.classList.remove('hidden'); return; }
  const body = {
    team_id: crTeamId, date, time,
    field_id: document.getElementById('cr-mo-field').value || null,
    who_spoke_to: who, how_connected: how,
  };
  try {
    const res = await fetch(`api/change-requests/${crGameId}/manual-override`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) { errEl.textContent = data.error || 'Could not apply change.'; errEl.classList.remove('hidden'); return; }
    document.getElementById('cr-form').classList.add('hidden');
    scheduleData = await fetchJSON('api/schedule');
    renderGamesList();
  } catch (e) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
});

function myProgramFields() {
  return (seasonData?.fields || []).filter(f => f.program_id === session.program_id);
}
function myProgramTeams() {
  return (seasonData?.teams || []).filter(t => t.program_id === session.program_id);
}

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

function openTeamAdd() {
  if (!(seasonData?.divisions || []).length) { toast('No divisions exist yet — ask the admin to set them up first.', 'bad'); return; }
  editingTeamId = null;
  document.getElementById('team-form-title').textContent = 'Add Team';
  document.getElementById('tfe-label').value = '';
  document.getElementById('tfe-coach').value = '';
  document.getElementById('tfe-email').value = '';
  document.getElementById('tfe-phone').value = '';
  document.getElementById('tfe-target').value = '';
  populateDivisionSelect();
  populateFieldSelect();
  renderAvailabilityGrid('tfe-availability', null, seasonSlots);
  document.getElementById('tfe-error').classList.add('hidden');
  document.getElementById('team-editor-form').classList.remove('hidden');
  document.getElementById('tfe-label').focus();
}

function openTeamEdit(teamId) {
  const team = myProgramTeams().find(t => String(t.id) === teamId);
  if (!team) return;
  editingTeamId = teamId;
  document.getElementById('team-form-title').textContent = 'Edit Team';
  document.getElementById('tfe-label').value = team.label || '';
  document.getElementById('tfe-coach').value = team.coach || '';
  document.getElementById('tfe-email').value = team.email || '';
  document.getElementById('tfe-phone').value = team.phone || '';
  document.getElementById('tfe-target').value = team.target_games || '';
  populateDivisionSelect();
  populateFieldSelect();
  document.getElementById('tfe-division').value = String(team.division_id || '');
  document.getElementById('tfe-field').value = String(team.home_field_id || '');
  renderAvailabilityGrid('tfe-availability', team.availability, seasonSlots);
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
    <thead><tr><th>Field</th><th>Address</th><th>Used By</th><th></th></tr></thead>
    <tbody>
    ${fields.map(f => {
      const usage = usageCount[f.id] || 0;
      return `<tr>
        <td><strong>${esc(f.name)}</strong>${f.sub_field ? `<span class="field-subfield-badge">${esc(f.sub_field)}</span>` : ''}</td>
        <td>${esc(f.address || '—')}</td>
        <td>${usage ? `<span class="field-used-badge">${usage} team${usage !== 1 ? 's' : ''}</span>` : '<span style="color:#cbd5e1">—</span>'}</td>
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
  editingFieldId = null;
  document.getElementById('field-form-title').textContent = 'Add Field';
  document.getElementById('ffe-name').value = '';
  document.getElementById('ffe-subfield').value = '';
  document.getElementById('ffe-address').value = '';
  document.getElementById('ffe-notes').value = '';
  document.getElementById('ffe-coords').value = '';
  renderFieldAvailabilityGrid('ffe-availability', null, seasonSlots);
  document.getElementById('ffe-error').classList.add('hidden');
  document.getElementById('field-editor-form').classList.remove('hidden');
  document.getElementById('ffe-name').focus();
}

function openFieldEdit(fieldId) {
  const field = myProgramFields().find(f => String(f.id) === fieldId);
  if (!field) return;
  editingFieldId = fieldId;
  document.getElementById('field-form-title').textContent = 'Edit Field';
  document.getElementById('ffe-name').value = field.name || '';
  document.getElementById('ffe-subfield').value = field.sub_field || '';
  document.getElementById('ffe-address').value = field.address || '';
  document.getElementById('ffe-notes').value = field.notes || '';
  document.getElementById('ffe-coords').value = field.coordinates ? field.coordinates.replace(',', ', ') : '';
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
    populateFieldSelect();
  } catch (e) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
});

async function deleteField(fieldId, fieldName) {
  try {
    if (!await deleteWithBlockers(`api/season/fields/${fieldId}`, fieldName, 'delete')) return;
    seasonData = await fetchJSON('api/season');
    renderFieldsList();
    populateFieldSelect();
  } catch (e) { toast('Network error. Try again.', 'bad'); }
}

// ── Verify-email banner ──────────────────────────────────────────────────────

function initVerifyBanner() {
  if (!session || session.verified) return;
  const banner = document.createElement('div');
  banner.id = 'verify-banner';
  banner.style.cssText = 'background:#fef3c7;border-bottom:1px solid #f59e0b;color:#92400e;padding:10px 16px;font-size:13px;display:flex;align-items:center;gap:10px;justify-content:center';
  banner.innerHTML = `<span>Verify your email to add or edit teams and fields.</span>
    <button id="verify-banner-btn" class="btn btn-secondary btn-sm">Send verification link</button>`;
  document.body.prepend(banner);

  document.getElementById('verify-banner-btn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Sending…';
    try {
      const res = await fetch('api/auth/request-verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ next: '/director' }),
      });
      const data = await res.json();
      e.target.textContent = data.ok ? 'Check your email!' : (data.error || 'Failed — try again');
    } catch { e.target.textContent = 'Network error — try again'; e.target.disabled = false; }
  });
}

init();
