'use strict';

let session = null;
let seasonData = null;
let editingTeamId = null;
let editingFieldId = null;

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

async function init() {
  try { session = await fetchJSON('api/auth/me'); } catch { session = null; }
  if (!session || (session.role !== 'director' && session.role !== 'admin')) {
    window.location = 'login';
    return;
  }
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
  initVerifyBanner();
}

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
    list.innerHTML = '<p style="color:#94a3b8;padding:24px">No teams yet. Add one above.</p>';
    return;
  }

  list.innerHTML = `<table class="fields-table">
    <thead><tr><th>Team</th><th>Division</th><th>Coach</th><th>Email</th><th>Phone</th><th>Home Field</th><th></th></tr></thead>
    <tbody>
    ${teams.map(t => `<tr>
        <td><strong>${esc(teamLabel(t))}</strong></td>
        <td>${esc(divName(t.division_id))}</td>
        <td>${esc(t.coach || '—')}</td>
        <td>${esc(t.email || '—')}</td>
        <td>${esc(t.phone || '—')}</td>
        <td>${esc(fieldName(t.home_field_id))}</td>
        <td><div class="field-row-actions">
          <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="openTeamEdit('${String(t.id)}')">Edit</button>
          <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;color:#dc2626" onclick="deleteTeam('${String(t.id)}','${esc(teamLabel(t))}')">Delete</button>
        </div></td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function openTeamAdd() {
  if (!(seasonData?.divisions || []).length) { alert('No divisions exist yet — ask the admin to set them up first.'); return; }
  editingTeamId = null;
  document.getElementById('team-form-title').textContent = 'Add Team';
  document.getElementById('tfe-label').value = '';
  document.getElementById('tfe-coach').value = '';
  document.getElementById('tfe-email').value = '';
  document.getElementById('tfe-phone').value = '';
  populateDivisionSelect();
  populateFieldSelect();
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
  populateDivisionSelect();
  populateFieldSelect();
  document.getElementById('tfe-division').value = String(team.division_id || '');
  document.getElementById('tfe-field').value = String(team.home_field_id || '');
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
  };
  if (!body.label) { errEl.textContent = 'Team name is required.'; errEl.classList.remove('hidden'); return; }
  const url    = editingTeamId ? `api/teams/${editingTeamId}` : 'api/teams';
  const method = editingTeamId ? 'PUT' : 'POST';
  try {
    const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) { errEl.textContent = data.error || 'Save failed.'; errEl.classList.remove('hidden'); return; }
    seasonData = await fetchJSON('api/season');
    document.getElementById('team-editor-form').classList.add('hidden');
    renderTeamsList();
  } catch (e) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
});

async function deleteTeam(teamId, teamName) {
  if (!confirm(`Delete team "${teamName}"? This cannot be undone.`)) return;
  try {
    const res  = await fetch(`api/teams/${teamId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) { alert(data.error || 'Delete failed.'); return; }
    seasonData = await fetchJSON('api/season');
    renderTeamsList();
    populateFieldSelect();
  } catch (e) { alert('Network error. Try again.'); }
}

// ── Fields ────────────────────────────────────────────────────────────────────

function renderFieldsList() {
  const fields = [...myProgramFields()].sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
  const teams = seasonData?.teams || [];
  const list = document.getElementById('fields-list');

  const usageCount = {};
  teams.forEach(t => { if (t.home_field_id) usageCount[t.home_field_id] = (usageCount[t.home_field_id] || 0) + 1; });

  if (!fields.length) {
    list.innerHTML = '<p style="color:#94a3b8;padding:24px">No fields defined. Add one above.</p>';
    return;
  }

  list.innerHTML = `<table class="fields-table">
    <thead><tr><th>Field</th><th>Address</th><th>Used By</th><th></th></tr></thead>
    <tbody>
    ${fields.map(f => {
      const usage = usageCount[f.id] || 0;
      return `<tr>
        <td><strong>${esc(f.name)}</strong>${f.sub_field ? `<span class="field-subfield-badge">${esc(f.sub_field)}</span>` : ''}</td>
        <td>${esc(f.address || '—')}</td>
        <td>${usage ? `<span class="field-used-badge">${usage} team${usage !== 1 ? 's' : ''}</span>` : '<span style="color:#cbd5e1">—</span>'}</td>
        <td><div class="field-row-actions">
          <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="openFieldEdit('${String(f.id)}')">Edit</button>
          <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;color:#dc2626" onclick="deleteField('${String(f.id)}','${esc(fieldDisplayName(f))}')">Delete</button>
        </div></td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>`;
}

function openFieldAdd() {
  editingFieldId = null;
  document.getElementById('field-form-title').textContent = 'Add Field';
  document.getElementById('ffe-name').value = '';
  document.getElementById('ffe-subfield').value = '';
  document.getElementById('ffe-address').value = '';
  document.getElementById('ffe-notes').value = '';
  document.getElementById('ffe-coords').value = '';
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
  };
  if (!body.name) { errEl.textContent = 'Venue name is required.'; errEl.classList.remove('hidden'); return; }
  const url    = editingFieldId ? `api/season/fields/${editingFieldId}` : 'api/season/fields';
  const method = editingFieldId ? 'PUT' : 'POST';
  try {
    const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) { errEl.textContent = data.error || 'Save failed.'; errEl.classList.remove('hidden'); return; }
    seasonData = await fetchJSON('api/season');
    document.getElementById('field-editor-form').classList.add('hidden');
    renderFieldsList();
    populateFieldSelect();
  } catch (e) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
});

async function deleteField(fieldId, fieldName) {
  if (!confirm(`Delete field "${fieldName}"? This cannot be undone.`)) return;
  try {
    const res  = await fetch(`api/season/fields/${fieldId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) { alert(data.error || 'Delete failed.'); return; }
    seasonData = await fetchJSON('api/season');
    renderFieldsList();
    populateFieldSelect();
  } catch (e) { alert('Network error. Try again.'); }
}

// ── Verify-email banner ──────────────────────────────────────────────────────

function initVerifyBanner() {
  if (!session || session.verified) return;
  const banner = document.createElement('div');
  banner.id = 'verify-banner';
  banner.style.cssText = 'background:#fef3c7;border-bottom:1px solid #f59e0b;color:#92400e;padding:10px 16px;font-size:13px;display:flex;align-items:center;gap:10px;justify-content:center';
  banner.innerHTML = `<span>Verify your email to add or edit teams and fields.</span>
    <button id="verify-banner-btn" class="btn btn-secondary" style="padding:4px 10px;font-size:12px">Send verification link</button>`;
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
