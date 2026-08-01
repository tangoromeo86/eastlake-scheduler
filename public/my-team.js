'use strict';

let session = null;
let seasonData = null;
let myTeam = null;
let scheduleData = null;
let crGameId = null;

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fieldDisplayName(f) {
  return f.sub_field ? `${f.name} – ${f.sub_field}` : f.name;
}

// ── Availability grid (shared shape with public/director.js) ────────────────
const AVAIL_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday'];
const AVAIL_SAT_BLOCKS = [['before11', 'Before 11am'], ['mid', '11am–2pm'], ['after2', '2pm–5pm']];
const AVAIL_STATUS_OPTIONS = [
  ['both', 'Available for both'],
  ['host', 'Available to host'],
  ['travel', 'Available to travel'],
  ['none', 'Not available'],
];

function renderAvailabilityGrid(containerId, availability) {
  const a = availability || {};
  const weekday = a.weekday || {};
  const saturday = a.saturday || {};
  const statusOpts = (current) => AVAIL_STATUS_OPTIONS
    .map(([v, l]) => `<option value="${v}" ${v === (current || 'both') ? 'selected' : ''}>${l}</option>`).join('');

  const weekdayRows = AVAIL_WEEKDAYS.map(day => {
    const entry = weekday[day] || {};
    return `<tr>
      <td>${day}</td>
      <td><select class="avail-status" data-kind="weekday" data-key="${day}">${statusOpts(entry.status)}</select></td>
      <td><input type="text" class="avail-time" data-key="${day}" placeholder="e.g. 18:30" value="${esc(entry.time || '')}" style="width:90px"></td>
    </tr>`;
  }).join('');

  const satRows = AVAIL_SAT_BLOCKS.map(([key, label]) => `<tr>
      <td>Sat: ${label}</td>
      <td><select class="avail-status" data-kind="saturday" data-key="${key}">${statusOpts(saturday[key])}</select></td>
      <td></td>
    </tr>`).join('');

  document.getElementById(containerId).innerHTML = `<table class="fields-table">
    <thead><tr><th>Day</th><th>Status</th><th>Start Time (optional)</th></tr></thead>
    <tbody>${weekdayRows}${satRows}</tbody>
  </table>`;
}

function readAvailabilityGrid(containerId) {
  const container = document.getElementById(containerId);
  const weekday = {};
  const saturday = {};
  container.querySelectorAll('select.avail-status[data-kind="weekday"]').forEach(sel => {
    const day = sel.dataset.key;
    const timeInput = container.querySelector(`input.avail-time[data-key="${day}"]`);
    weekday[day] = { status: sel.value, time: (timeInput?.value || '').trim() || null };
  });
  container.querySelectorAll('select.avail-status[data-kind="saturday"]').forEach(sel => {
    saturday[sel.dataset.key] = sel.value;
  });
  return { weekday, saturday };
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
  populateFieldSelect();
  renderAvailabilityGrid('mte-availability', myTeam.availability);

  try { scheduleData = await fetchJSON('api/schedule'); } catch { scheduleData = { games: [] }; }
  renderGamesList();

  initVerifyBanner();
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
  box.innerHTML = '<p style="color:#94a3b8;padding:8px">Finding times that work for both teams…</p>';
  submitBtn.disabled = true;
  try {
    const params = new URLSearchParams({ game_id: gameId });
    if (typeof crTeamId !== 'undefined' && crTeamId) params.set('team_id', crTeamId);
    const data = await fetchJSON('api/change-requests/options?' + params.toString());
    if (!data.slots.length) {
      box.innerHTML = '<p style="color:#dc2626;padding:8px">No other time fits both teams\'  availability right now. Ask your director for help — they can adjust availability or free up a field.</p>';
      return;
    }
    box.innerHTML = data.slots.map((s, i) => `
      <label class="cr-slot" style="display:block;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin:6px 0;cursor:pointer;font-size:14px">
        <input type="radio" name="cr-slot" value="${i}" style="margin-right:10px">${esc(crSlotLabel(s))}
      </label>`).join('');
    box.querySelectorAll('input[name="cr-slot"]').forEach(r => {
      r.addEventListener('change', () => {
        crSelectedSlot = data.slots[parseInt(r.value, 10)];
        submitBtn.disabled = false;
      });
    });
  } catch (e) {
    box.innerHTML = '<p style="color:#dc2626;padding:8px">Could not load available times. Try again.</p>';
  }
}

function renderGamesList() {
  const games = myGames();
  const list = document.getElementById('games-list');
  if (!games.length) {
    list.innerHTML = '<p style="color:#94a3b8;padding:24px">No games scheduled yet.</p>';
    return;
  }
  list.innerHTML = `<table class="fields-table">
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
        <td>${canRequest ? `<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="openChangeRequest(${g.game_id})">Request Change</button>` : ''}</td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>`;
}

function populateCrFieldSelects() {
  const fields = [...(seasonData?.fields || [])].sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
  const opts = '<option value="">— No preference —</option>' + fields.map(f => `<option value="${String(f.id)}">${esc(fieldDisplayName(f))}</option>`).join('');
  document.getElementById('cr-field').innerHTML = opts;
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
    slot: crSelectedSlot,
  };
  try {
    const res = await fetch('api/change-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) { errEl.textContent = data.error || 'Could not submit request.'; errEl.classList.remove('hidden'); return; }
    document.getElementById('cr-form').classList.add('hidden');
    alert('Check your email to confirm this request before it goes to the other coach.');
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
    availability:  readAvailabilityGrid('mte-availability'),
  };
  if (!body.label) { errEl.textContent = 'Team name is required.'; errEl.classList.remove('hidden'); return; }
  try {
    const res  = await fetch(`api/teams/${myTeam.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) { errEl.textContent = data.error || 'Save failed.'; errEl.classList.remove('hidden'); return; }
    myTeam = data.team;
    document.getElementById('team-title').textContent = myTeam.label || 'My Team';
    renderAvailabilityGrid('mte-availability', myTeam.availability);
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

function initVerifyBanner() {
  if (!session || session.verified) return;
  const banner = document.createElement('div');
  banner.id = 'verify-banner';
  banner.style.cssText = 'background:#fef3c7;border-bottom:1px solid #f59e0b;color:#92400e;padding:10px 16px;font-size:13px;display:flex;align-items:center;gap:10px;justify-content:center';
  banner.innerHTML = `<span>Verify your email to save changes to your team.</span>
    <button id="verify-banner-btn" class="btn btn-secondary" style="padding:4px 10px;font-size:12px">Send verification link</button>`;
  document.body.prepend(banner);

  document.getElementById('verify-banner-btn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Sending…';
    try {
      const res = await fetch('api/auth/request-verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ next: '/my-team' }),
      });
      const data = await res.json();
      e.target.textContent = data.ok ? 'Check your email!' : (data.error || 'Failed — try again');
    } catch { e.target.textContent = 'Network error — try again'; e.target.disabled = false; }
  });
}

init();
