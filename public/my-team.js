'use strict';

let session = null;
let seasonData = null;
let myTeam = null;
let scheduleData = null;
let crGameId = null;
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
  populateFieldSelect();
  renderAvailabilityGrid('mte-availability', myTeam.availability, seasonSlots);

  try { scheduleData = await fetchJSON('api/schedule'); } catch { scheduleData = { games: [] }; }
  renderGamesList();

  initMyTeamVerifyBanner();
}

// ── Games list + change requests ─────────────────────────────────────────────

function myGames() {
  return (scheduleData?.games || []).filter(g => g.home_team_id === myTeam.id || g.away_team_id === myTeam.id)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function daysUntil(dateStr) {
  const ms = new Date(dateStr + 'T00:00:00') - new Date(new Date().toDateString());
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function opponentTeam(game) {
  const oppId = game.home_team_id === myTeam.id ? game.away_team_id : game.home_team_id;
  return (seasonData?.teams || []).find(t => String(t.id) === String(oppId));
}


// ── Change-request slot picker ───────────────────────────────────────────────
// Slots come from the server, which only offers times valid for BOTH teams, so
// a coach can never propose something the other team already ruled out.
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
    if (typeof crTeamId !== 'undefined' && crTeamId) params.set('team_id', crTeamId);
    const data = await fetchJSON('api/change-requests/options?' + params.toString());
    if (!data.slots.length) {
      box.innerHTML = '<p class="danger-text">No other time fits both teams\'  availability right now. Ask your director for help — they can adjust availability or free up a field.</p>';
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
  const games = myGames();
  const list = document.getElementById('games-list');
  if (!games.length) {
    list.innerHTML = '<p class="empty-note">No games scheduled yet.</p>';
    return;
  }
  list.innerHTML = `<div class="table-wrap"><table class="fields-table">
    <thead><tr><th>Date</th><th>Opponent</th><th>H/A</th><th>Status</th><th></th></tr></thead>
    <tbody>
    ${games.map(g => {
      const isHome = g.home_team_id === myTeam.id;
      const opp = opponentTeam(g);
      const status = g.status || 'scheduled';
      const statusBadge = status === 'pending' ? '<span class="unconfirmed-badge">Pending change</span>'
        : status === 'confirmed' ? '<span class="confirmed-badge">Confirmed change</span>'
        : status === 'finalized' ? '<span class="confirmed-badge">Finalized</span>' : '—';
      const canRequest = status !== 'finalized';
      return `<tr>
        <td>${esc(g.day)} ${esc(g.date)} ${esc(g.time)}</td>
        <td>${esc(opp ? (opp.label || opp.name) : '—')}</td>
        <td>${isHome ? 'Home' : 'Away'}</td>
        <td>${statusBadge}</td>
        <td><div class="row-actions">
          ${canRequest ? `<button class="btn btn-secondary btn-sm" onclick="openChangeRequest(${g.game_id})">Request Change</button>` : ''}
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
  // There is no #cr-field element — the normal-request flow's field choice was
  // dropped from the markup (each viable slot already carries its field), but
  // this line populating it was never removed, and threw on every click since
  // it's the first thing openChangeRequest() calls. Only #cr-mo-field (the
  // manual-override path) actually exists.
  document.getElementById('cr-mo-field').innerHTML = opts.replace('No preference', 'Keep current');
}

function openChangeRequest(gameId) {
  const game = myGames().find(g => g.game_id === gameId);
  if (!game) return;
  crGameId = gameId;
  const opp = opponentTeam(game);
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
    document.getElementById('cr-other-phone').textContent = opp?.phone || '(no phone on file — contact your director)';
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
    game_id: crGameId,
    reason: document.getElementById('cr-reason').value.trim(),
    slot: { date: crSelectedSlot.date, slot_key: crSelectedSlot.slot_key || null,
            time: document.getElementById('cr-time').value || crSelectedSlot.time },
  };
  try {
    const res = await fetch('api/change-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) { errEl.textContent = data.error || 'Could not submit request.'; errEl.classList.remove('hidden'); return; }
    document.getElementById('cr-form').classList.add('hidden');
    toast('Check your email to confirm this request before it reaches the other coach.', 'good');
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
    date, time,
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

function populateFieldSelect() {
  const sel = document.getElementById('mte-field');
  // Fields owned by this team's program; if the team has no program_id (legacy/admin-uploaded), show all fields.
  const fields = (seasonData?.fields || []).filter(f => !myTeam.program_id || f.program_id === myTeam.program_id);
  fields.sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
  sel.innerHTML = '<option value="">— None yet —</option>' +
    fields.map(f => `<option value="${String(f.id)}">${esc(fieldDisplayName(f))}</option>`).join('');
  sel.value = String(myTeam.home_field_id || '');
}

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
    availability:  readAvailabilityGrid('mte-availability'),
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
    renderAvailabilityGrid('mte-availability', myTeam.availability, seasonSlots);
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
