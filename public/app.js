'use strict';

let scheduleData = null;
let seasonData = null;
let activeDivision = null;
let activeView = 'games';
let activeTopView = null;  // 'fields' | 'city' | null
let lastGames    = null;
let currentPage = 'schedule';
let seasonSlots = null;
let editingGameId = null;

// ── Top-level page switching ──────────────────────────────────────────────────
document.querySelectorAll('.top-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentPage = btn.dataset.page;
    document.querySelectorAll('.top-nav-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('page-schedule').classList.toggle('hidden', currentPage !== 'schedule');
    document.getElementById('page-teams').classList.toggle('hidden', currentPage !== 'teams');
    document.getElementById('page-editor').classList.toggle('hidden', currentPage !== 'editor');
    document.getElementById('page-changes').classList.toggle('hidden', currentPage !== 'changes');
    document.getElementById('page-fields').classList.toggle('hidden', currentPage !== 'fields');
    if (currentPage === 'teams') renderTeamsPage();
    if (currentPage === 'editor') renderSeasonEditor();
    if (currentPage === 'changes') renderChangesPage();
    if (currentPage === 'fields') renderFieldsPage();
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [sched, seas] = await Promise.all([
      fetchJSON('api/schedule'),
      fetchJSON('api/season'),
    ]);
    seasonData = seas;
    renderSeasonBar(seas);
    applySchedule(sched);
  } catch (e) {
    console.error('Init error:', e);
  }
  updateChangesBadge();
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Season info bar ───────────────────────────────────────────────────────────
function renderSeasonBar(seas) {
  if (!seas || !seas.divisions) return;
  const confirmedTeams = (seas.teams || []).filter(t => t.confirmed !== false);
  const perDiv = {};
  confirmedTeams.forEach(t => { perDiv[t.division_id] = (perDiv[t.division_id] || 0) + 1; });
  const start = seas.season?.start || '';
  const end   = seas.season?.end   || '';
  document.getElementById('season-bar-text').textContent =
    `${seas.divisions.length} divisions · ${confirmedTeams.length} teams` +
    (start ? ` · ${formatDate(start)} – ${formatDate(end)}` : '');
  document.getElementById('season-bar-divisions').innerHTML =
    seas.divisions.map(d =>
      `<span class="div-pill"><strong>${d.name || d.label || d.id}</strong> ${perDiv[d.id] || 0} teams</span>`
    ).join('');
  show('season-bar');
}

// ── Import schedule CSV ───────────────────────────────────────────────────────
document.getElementById('btn-import-csv').addEventListener('click', () => {
  document.getElementById('schedule-csv-input').click();
});

document.getElementById('schedule-csv-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  const text = await file.text();
  const btn = document.getElementById('btn-import-csv');
  btn.disabled = true;
  btn.textContent = 'Importing…';

  try {
    const res = await fetch('api/import-schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(data.error || 'Import failed.', 'error');
      return;
    }

    // Reload the schedule
    const sched = await fetchJSON('api/schedule');
    applySchedule(sched);

    let msg = `Schedule imported: ${data.total_games} games loaded.`;
    if (data.warnings && data.warnings.length) {
      msg += ` ${data.warnings.length} warning(s) — some team/field names could not be matched to IDs (games still imported).`;
      data.warnings.forEach(w => console.warn('Import warning:', w));
    }
    showBanner(msg, data.warnings?.length ? 'warn' : 'success');
  } catch (err) {
    showBanner('Import error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '↑ Import CSV';
  }
});

// ── Upload season.json ────────────────────────────────────────────────────────
document.getElementById('btn-upload').addEventListener('click', () => {
  document.getElementById('season-file-input').click();
});

document.getElementById('season-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    showBanner('Could not parse file — make sure it is valid JSON.', 'error');
    return;
  }

  const btn = document.getElementById('btn-upload');
  btn.disabled = true;
  btn.textContent = 'Uploading…';

  try {
    const res = await fetch('api/upload-season', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    const data = await res.json();
    if (!res.ok) { showBanner(data.error || 'Upload failed.', 'error'); return; }

    seasonData = parsed;
    renderSeasonBar(parsed);
    scheduleData = null;
    hide('tabs-container');
    hide('conflict-section');

    const s = data.summary;
    showBanner(
      `season.json uploaded: ${s.divisions} divisions, ${s.teams} teams. Click Run Scheduler to generate.`,
      'success'
    );
  } catch (err) {
    showBanner('Upload error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '\u2191 Upload season.json';
  }
});

// ── Run scheduler ─────────────────────────────────────────────────────────────
document.getElementById('btn-run').addEventListener('click', async () => {
  const btn = document.getElementById('btn-run');
  btn.disabled = true;
  show('loading');
  hide('conflict-section');
  hide('success-banner');

  try {
    const res = await fetch('api/run', { method: 'POST' });
    if (!res.ok) { showBanner((await res.json()).error || 'Scheduler error.', 'error'); return; }
    const data = await res.json();
    seasonData = await fetchJSON('api/season');
    applySchedule(data);
  } catch (e) {
    showBanner(e.message, 'error');
  } finally {
    btn.disabled = false;
    hide('loading');
  }
});

// ── Apply schedule ────────────────────────────────────────────────────────────
function applySchedule(data) {
  scheduleData = data;
  renderConflicts(data.failures || []);

  if (!(data.games || []).length && !(data.failures || []).length) {
    hide('tabs-container');
    hide('success-banner');
    return;
  }

  if (data.games?.length) {
    showBanner(
      `Schedule generated: ${data.total_games} games across ${countDivisions(data.games)} division(s).` +
      (data.failures?.length ? ` ${data.failures.length} division(s) failed.` : ''),
      'success'
    );
  }

  buildTabs(data.games || []);
  show('tabs-container');
}

function countDivisions(games) { return new Set(games.map(g => g.division_id)).size; }

// ── Conflicts ─────────────────────────────────────────────────────────────────
function renderConflicts(failures) {
  if (!failures.length) { hide('conflict-section'); return; }
  show('conflict-section');
  document.getElementById('conflict-list').innerHTML = failures.map(f => `
    <div class="conflict-card">
      <strong>${esc(f.division_name || f.division_id)}</strong>
      ${f.blocking_matchup ? `<br>Blocked: <em>${esc(f.blocking_matchup)}</em>` : ''}
      <br>${esc(f.reason || '')}
    </div>
  `).join('');
}

// ── View bar ──────────────────────────────────────────────────────────────────
// ── Top-level view buttons (Fields / City) ────────────────────────────────────
document.querySelectorAll('.admin-top-view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.topview;
    if (activeTopView === mode) {
      // toggle off — go back to division mode
      activeTopView = null;
      document.querySelectorAll('.admin-top-view-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('admin-div-view-bar').classList.remove('hidden');
      document.getElementById('admin-cross-div-bar').classList.add('hidden');
      buildTabs(lastGames);
    } else {
      activeTopView = mode;
      document.querySelectorAll('.admin-top-view-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('admin-div-view-bar').classList.add('hidden');
      document.getElementById('admin-cross-div-bar').classList.add('hidden');
      const crossBar = document.getElementById('admin-cross-div-bar');
      crossBar.classList.remove('hidden');
      document.getElementById('fields-controls').classList.toggle('hidden', mode !== 'fields');
      document.getElementById('city-controls').classList.toggle('hidden', mode !== 'city');
      if (mode === 'fields') populateAdminFieldSelect();
      if (mode === 'city')   populateAdminCitySelect();
    }
  });
});

// ── Per-division view bar ─────────────────────────────────────────────────────
document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeView = btn.dataset.view;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('games-controls').classList.toggle('hidden', activeView !== 'games');
    document.getElementById('cal-team-select').closest('.cal-controls').classList.toggle('hidden', activeView !== 'calendar');
    renderCurrentView();
  });
});

function renderCurrentView() {
  const effectiveView = activeTopView || activeView;
  ['games','teams','matrix','stats','calendar','fields','city'].forEach(v =>
    document.getElementById('view-' + v).classList.toggle('hidden', v !== effectiveView)
  );
  if (activeTopView === 'fields') { renderAdminFieldsView(); return; }
  if (activeTopView === 'city')   { renderAdminCityView();   return; }
  if (!scheduleData || !activeDivision) return;
  const divGames = (scheduleData.games || []).filter(g => g.division_id === activeDivision);
  const divTeams = getDivTeams(activeDivision);

  if (activeView === 'games')    renderGames(divGames);
  if (activeView === 'teams')    renderTeamsView(divGames, divTeams);
  if (activeView === 'matrix')   renderMatrixView(divGames, divTeams);
  if (activeView === 'stats')    renderStatsView(divGames, divTeams);
  if (activeView === 'calendar') renderCalendarView(divGames, divTeams);
}

function populateAdminFieldSelect() {
  const sel = document.getElementById('admin-field-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">All fields</option>';
  const games = scheduleData?.games || [];
  const names = [...new Set(games.map(g => g.field_name).filter(Boolean))].sort();
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderAdminFieldsView() {
  if (!scheduleData) return;
  const wrapper = document.getElementById('admin-fields-wrapper');
  const filterField = document.getElementById('admin-field-select').value;
  const divNames = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));
  const fieldIndex = Object.fromEntries((seasonData?.fields || []).map(f => [f.id, f]));

  const allGames = [...(scheduleData.games || [])]
    .filter(g => !filterField || g.field_name === filterField)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  if (!allGames.length) { wrapper.innerHTML = '<p class="no-games">No games found.</p>'; return; }

  const uniqueDates  = new Set(allGames.map(g => g.date));
  const uniqueFields = new Set(allGames.map(g => g.field_name));
  const showFieldCol = !filterField;

  const byDate = new Map();
  for (const g of allGames) { if (!byDate.has(g.date)) byDate.set(g.date, []); byDate.get(g.date).push(g); }

  const utilHtml = `<p class="field-utilization"><strong>${allGames.length}</strong> games across <strong>${uniqueDates.size}</strong> dates at <strong>${uniqueFields.size}</strong> field${uniqueFields.size !== 1 ? 's' : ''} <button onclick="adminExportFieldCSV('${filterField || ''}')" style="margin-left:8px;font-size:11px;padding:2px 8px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;cursor:pointer;color:#475569">↓ CSV</button></p>`;

  const groups = [...byDate.entries()].map(([date, dateGames]) => {
    const isSat = dateGames[0].day === 'Saturday';
    const dayClass = isSat ? 'fday-sat' : 'fday-wd';
    const rows = dateGames.map(g => {
      const fieldObj = fieldIndex[g.field_id];
      const mapLink = fieldObj?.coordinates
        ? ` <a href="https://www.google.com/maps?q=${fieldObj.coordinates}&t=k" target="_blank" rel="noopener" class="map-link">Map</a>`
        : '';
      return `<tr>
        <td>${formatTime12h(g.time)}</td>
        ${showFieldCol ? `<td>${esc(g.field_name)}<div style="font-size:10px;color:#94a3b8">${esc(g.field_address || '')}${mapLink}</div></td>` : ''}
        <td><span class="field-div-badge">${esc(divNames[g.division_id] || g.division_id)}</span></td>
        <td class="team-cell home">${esc(g.home_team_name)}</td>
        <td style="color:#94a3b8;font-size:11px">vs</td>
        <td class="team-cell away">${esc(g.away_team_name)}</td>
        <td style="color:#94a3b8;font-size:11px;white-space:nowrap">#${g.game_id}</td>
      </tr>`;
    }).join('');
    return `<div class="field-date-group">
      <div class="field-date-header">
        <span><span class="${dayClass}">${dateGames[0].day}</span> ${formatDate(date)} — Week ${dateGames[0].week}</span>
        <span class="field-date-count">${dateGames.length} game${dateGames.length !== 1 ? 's' : ''}</span>
      </div>
      <table class="field-games-table">
        <thead><tr><th>Time</th>${showFieldCol ? '<th>Field</th>' : ''}<th>Division</th><th>Home</th><th></th><th>Away</th><th>#</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  wrapper.innerHTML = utilHtml + groups;
}

function adminExportFieldCSV(fieldName) {
  const games = [...(scheduleData?.games || [])]
    .filter(g => !fieldName || g.field_name === fieldName)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  const divNames = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));
  const rows = [['Date','Day','Time','Division','Home Team','Away Team','Field','Address']];
  for (const g of games) {
    rows.push([formatDate(g.date), g.day, formatTime12h(g.time), divNames[g.division_id] || g.division_id,
      g.home_team_name, g.away_team_name, g.field_name, g.field_address || '']);
  }
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `field-schedule${fieldName ? '-' + fieldName.replace(/[^a-z0-9]/gi,'-').toLowerCase() : ''}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

// ── ADMIN CITY VIEW ───────────────────────────────────────────────────────────
function adminClubName(clubId) {
  const labels = (seasonData?.teams || []).filter(t => t.club_id === clubId).map(t => t.label || '');
  if (!labels.length) return clubId;
  if (labels.length === 1) return labels[0].replace(/\s+\d+$/, '').replace(/\s+-\s+\w+$/, '').trim();
  let prefix = labels[0];
  for (const l of labels.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < l.length && prefix[i] === l[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.replace(/[\s\-]+$/, '').trim() || clubId;
}

function populateAdminCitySelect() {
  const sel = document.getElementById('admin-city-select');
  const prev = sel.value;
  const clubIds = [...new Set((seasonData?.teams || []).map(t => t.club_id).filter(Boolean))]
    .sort((a, b) => adminClubName(a).localeCompare(adminClubName(b)));
  sel.innerHTML = '<option value="">All cities</option>';
  clubIds.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = adminClubName(id);
    sel.appendChild(opt);
  });
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  else if (clubIds.length) sel.value = clubIds[0];
}

function renderAdminCityView() {
  if (!scheduleData) return;
  const wrapper = document.getElementById('admin-city-wrapper');
  const clubId  = document.getElementById('admin-city-select').value;
  const teams = seasonData?.teams || [];
  const clubTeamIds = clubId ? new Set(teams.filter(t => t.club_id === clubId).map(t => t.id)) : null;
  const divNames = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));
  const fieldIndex = Object.fromEntries((seasonData?.fields || []).map(f => [f.id, f]));
  const name = clubId ? adminClubName(clubId) : 'All cities';

  const games = [...(scheduleData.games || [])]
    .filter(g => !clubTeamIds || clubTeamIds.has(g.home_team_id) || clubTeamIds.has(g.away_team_id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  if (!games.length) { wrapper.innerHTML = `<p class="no-games">No games found.</p>`; return; }

  const byDate = new Map();
  for (const g of games) { if (!byDate.has(g.date)) byDate.set(g.date, []); byDate.get(g.date).push(g); }

  const utilHtml = `<p class="field-utilization"><strong>${esc(name)}</strong> — <strong>${games.length}</strong> game${games.length !== 1 ? 's' : ''} across <strong>${byDate.size}</strong> date${byDate.size !== 1 ? 's' : ''} <button onclick="adminExportCityCSV('${clubId}')" style="margin-left:8px;font-size:11px;padding:2px 8px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;cursor:pointer;color:#475569">↓ CSV</button></p>`;

  const groups = [...byDate.entries()].map(([date, dateGames]) => {
    const isSat = dateGames[0].day === 'Saturday';
    const dayClass = isSat ? 'fday-sat' : 'fday-wd';
    const rows = dateGames.map(g => {
      const haLabel = clubTeamIds
        ? (clubTeamIds.has(g.home_team_id) ? '<span style="color:#16a34a;font-weight:700">Home</span>' : '<span style="color:#dc2626;font-weight:700">Away</span>')
        : '';
      const fieldObj = fieldIndex[g.field_id];
      const mapLink = fieldObj?.coordinates
        ? ` <a href="https://www.google.com/maps?q=${fieldObj.coordinates}&t=k" target="_blank" rel="noopener" class="map-link">Map</a>`
        : '';
      return `<tr>
        <td>${formatTime12h(g.time)}</td>
        ${clubTeamIds ? `<td>${haLabel}</td>` : ''}
        <td><span class="field-div-badge">${esc(divNames[g.division_id] || g.division_id)}</span></td>
        <td class="team-cell home">${esc(g.home_team_name)}</td>
        <td style="color:#94a3b8;font-size:11px">vs</td>
        <td class="team-cell away">${esc(g.away_team_name)}</td>
        <td style="font-size:11px;color:#64748b">${esc(g.field_name)}<div style="font-size:10px;color:#94a3b8">${esc(g.field_address || '')}${mapLink}</div></td>
        <td style="color:#94a3b8;font-size:11px;white-space:nowrap">#${g.game_id}</td>
      </tr>`;
    }).join('');
    return `<div class="field-date-group">
      <div class="field-date-header">
        <span><span class="${dayClass}">${dateGames[0].day}</span> ${formatDate(date)} — Week ${dateGames[0].week}</span>
        <span class="field-date-count">${dateGames.length} game${dateGames.length !== 1 ? 's' : ''}</span>
      </div>
      <table class="field-games-table">
        <thead><tr><th>Time</th>${clubTeamIds ? '<th>H/A</th>' : ''}<th>Division</th><th>Home</th><th></th><th>Away</th><th>Field</th><th>#</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  wrapper.innerHTML = utilHtml + groups;
}

function adminExportCityCSV(clubId) {
  const teams = seasonData?.teams || [];
  const clubTeamIds = clubId ? new Set(teams.filter(t => t.club_id === clubId).map(t => t.id)) : null;
  const divNames = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));
  const games = [...(scheduleData?.games || [])]
    .filter(g => !clubTeamIds || clubTeamIds.has(g.home_team_id) || clubTeamIds.has(g.away_team_id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  const rows = [['Date','Day','Time','Home/Away','Division','Home Team','Away Team','Field','Address','Game #']];
  for (const g of games) {
    const isHome = clubTeamIds ? clubTeamIds.has(g.home_team_id) : null;
    rows.push([formatDate(g.date), g.day, formatTime12h(g.time), isHome === null ? '' : isHome ? 'Home' : 'Away',
      divNames[g.division_id] || g.division_id, g.home_team_name, g.away_team_name,
      g.field_name, g.field_address || '', '#' + g.game_id]);
  }
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  const filename = clubId ? `${adminClubName(clubId).replace(/[^a-z0-9]/gi,'-').toLowerCase()}-schedule.csv` : 'all-cities-schedule.csv';
  a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
}

document.getElementById('admin-field-select').addEventListener('change', () => {
  if (activeTopView === 'fields') renderAdminFieldsView();
});
document.getElementById('admin-city-select').addEventListener('change', () => {
  if (activeTopView === 'city') renderAdminCityView();
});
document.getElementById('admin-field-export-btn').addEventListener('click', () => {
  adminExportFieldCSV(document.getElementById('admin-field-select').value);
});
document.getElementById('admin-city-export-btn').addEventListener('click', () => {
  adminExportCityCSV(document.getElementById('admin-city-select').value);
});

function getDivTeams(divId) {
  if (!seasonData) return [];
  return (seasonData.teams || [])
    .filter(t => t.division_id === divId && t.confirmed !== false)
    .sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
}

function teamLabel(t) { return t.name || t.label || t.team_name || `Team ${t.id}`; }

// ── Tabs ──────────────────────────────────────────────────────────────────────
function clearAdminNavTabs() {
  document.getElementById('division-tabs').querySelectorAll('.admin-nav-tab').forEach(el => el.remove());
}

function buildTabs(games) {
  lastGames = games;
  const divisionOrder = (seasonData?.divisions || []).map(d => d.id);
  const divisionNames = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));
  const presentDivs = divisionOrder.filter(id => games.some(g => g.division_id === id));
  const extraDivs = [...new Set(games.map(g => g.division_id))].filter(id => !divisionOrder.includes(id));
  const divisions = [...presentDivs, ...extraDivs];

  clearAdminNavTabs();
  const tabNav = document.getElementById('division-tabs');
  const sep = tabNav.querySelector('.admin-tabs-sep');
  divisions.forEach(divId => {
    const tab = document.createElement('button');
    tab.className = 'tab-btn admin-nav-tab';
    tab.textContent = divisionNames[divId] || divId;
    tab.dataset.divId = divId;
    tab.addEventListener('click', () => selectDivision(divId, games));
    tabNav.insertBefore(tab, sep);
  });

  if (divisions.length) {
    selectDivision(
      activeDivision && divisions.includes(activeDivision) ? activeDivision : divisions[0],
      games
    );
  }
}


function selectDivision(divId, games) {
  activeDivision = divId;
  activeTopView = null;
  document.querySelectorAll('.admin-nav-tab[data-div-id]').forEach(b =>
    b.classList.toggle('active', b.dataset.divId === divId)
  );
  document.querySelectorAll('.admin-top-view-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('admin-div-view-bar').classList.remove('hidden');
  document.getElementById('admin-cross-div-bar').classList.add('hidden');
  const divGames = (games || lastGames || []).filter(g => g.division_id === divId);
  populateTeamFilter(divGames);
  populateCalTeamSelect(divId);
  renderCurrentView();
}

// ── Team filter (Games view) ──────────────────────────────────────────────────
function populateTeamFilter(divGames) {
  const teams = new Map();
  divGames.forEach(g => {
    teams.set(g.home_team_id, g.home_team_name);
    teams.set(g.away_team_id, g.away_team_name);
  });
  const sorted = [...teams.entries()].sort((a, b) => (a[1] || '').localeCompare(b[1] || ''));
  const sel = document.getElementById('team-filter');
  sel.innerHTML = '<option value="">All teams</option>';
  sorted.forEach(([id, name]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    sel.appendChild(opt);
  });
}

document.getElementById('team-filter').addEventListener('change', () => {
  if (!scheduleData || activeView !== 'games') return;
  const divGames = (scheduleData.games || []).filter(g => g.division_id === activeDivision);
  renderGames(divGames);
});

// ── GAMES VIEW ────────────────────────────────────────────────────────────────
function renderGames(divGames) {
  const teamId = parseInt(document.getElementById('team-filter').value) || null;
  const filtered = teamId
    ? divGames.filter(g => g.home_team_id === teamId || g.away_team_id === teamId)
    : divGames;
  const sorted = [...filtered].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  document.getElementById('game-count-label').textContent =
    `${sorted.length} game${sorted.length !== 1 ? 's' : ''}`;

  const tbody = document.getElementById('schedule-body');
  const noMsg = document.getElementById('no-games-msg');

  if (!sorted.length) { tbody.innerHTML = ''; noMsg.classList.remove('hidden'); return; }
  noMsg.classList.add('hidden');

  tbody.innerHTML = sorted.map(g => `
    <tr class="game-row${g.is_rematch ? ' rematch-row' : ''}" data-game-id="${g.game_id}">
      <td class="center game-id-cell">#${g.game_id}</td>
      <td class="center">W${g.week}</td>
      <td>${formatDate(g.date)}</td>
      <td>${g.day}</td>
      <td>${formatTime12h(g.time)}</td>
      <td class="team-cell home">${esc(g.home_team_name)}</td>
      <td class="team-cell away">${esc(g.away_team_name)}</td>
      <td>${esc(g.field_name)}</td>
      <td class="address">${esc(g.field_address)}</td>
    </tr>
  `).join('');
}

// ── Game row click → edit modal ───────────────────────────────────────────────
document.getElementById('schedule-body').addEventListener('click', (e) => {
  const row = e.target.closest('tr.game-row');
  if (!row) return;
  const gameId = parseInt(row.dataset.gameId, 10);
  if (!isNaN(gameId)) openEditModal(gameId);
});

// ── TEAMS VIEW ────────────────────────────────────────────────────────────────
function renderTeamsView(divGames, divTeams) {
  const sorted = [...divGames].sort((a, b) => a.date.localeCompare(b.date));

  const cards = divTeams.map(team => {
    const id = team.id;
    const name = teamLabel(team);
    const myGames = sorted.filter(g => g.home_team_id === id || g.away_team_id === id);
    const homeCount = myGames.filter(g => g.home_team_id === id).length;
    const awayCount = myGames.filter(g => g.away_team_id === id).length;

    const rows = myGames.map(g => {
      const isHome = g.home_team_id === id;
      const opponent = isHome ? g.away_team_name : g.home_team_name;
      const haBadge = isHome
        ? `<span class="ha-badge home">H</span>`
        : `<span class="ha-badge away">A</span>`;
      return `<tr>
        <td class="game-id-cell">#${g.game_id}</td>
        <td>W${g.week}</td>
        <td>${formatDate(g.date)}</td>
        <td>${g.day.slice(0,3)}</td>
        <td>${formatTime12h(g.time)}</td>
        <td>${haBadge}</td>
        <td class="opp-name">${esc(opponent)}</td>
        <td class="field-small">${esc(g.field_name)}</td>
      </tr>`;
    }).join('');

    return `<div class="team-card">
      <div class="team-card-header">
        <span class="team-card-name">${esc(name)}</span>
        <span class="team-card-meta">${myGames.length} games · ${homeCount}H ${awayCount}A</span>
      </div>
      <table class="team-card-table">
        <thead><tr><th>#</th><th>Wk</th><th>Date</th><th>Day</th><th>Time</th><th></th><th>Opponent</th><th>Field</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  document.getElementById('teams-grid').innerHTML =
    cards || '<p class="no-games">No team data available.</p>';
}

// ── MATRIX VIEW ───────────────────────────────────────────────────────────────
function renderMatrixView(divGames, divTeams) {
  if (!divTeams.length) {
    document.getElementById('matrix-wrapper').innerHTML =
      '<p class="no-games">No teams found in season.json for this division.</p>';
    return;
  }

  const pairKey = (a, b) => `${Math.min(a,b)}_${Math.max(a,b)}`;
  const counts = {};
  const homeAway = {};
  divGames.forEach(g => {
    const k = pairKey(g.home_team_id, g.away_team_id);
    counts[k] = (counts[k] || 0) + 1;
    const hk = `${g.home_team_id}_${g.away_team_id}`;
    homeAway[hk] = (homeAway[hk] || 0) + 1;
  });

  const maxCount = Math.max(1, ...Object.values(counts));

  const header = `<tr>
    <th class="matrix-corner"></th>
    ${divTeams.map(t => `<th class="matrix-col-head" title="${esc(teamLabel(t))}">${esc(teamLabel(t))}</th>`).join('')}
  </tr>`;

  const rows = divTeams.map(rowTeam => {
    const cells = divTeams.map(colTeam => {
      if (rowTeam.id === colTeam.id) return `<td class="matrix-self">—</td>`;
      const k = pairKey(rowTeam.id, colTeam.id);
      const total = counts[k] || 0;
      const asHome = homeAway[`${rowTeam.id}_${colTeam.id}`] || 0;
      const asAway = homeAway[`${colTeam.id}_${rowTeam.id}`] || 0;
      if (!total) return `<td class="matrix-zero">·</td>`;
      const intensity = Math.round((total / maxCount) * 4);
      return `<td class="matrix-cell matrix-i${intensity}" title="${total} game(s): ${asHome}H ${asAway}A">
        <span class="matrix-count">${total}</span>
        <span class="matrix-ha">${asHome}H${asAway}A</span>
      </td>`;
    }).join('');
    return `<tr>
      <th class="matrix-row-head" title="${esc(teamLabel(rowTeam))}">${esc(teamLabel(rowTeam))}</th>
      ${cells}
    </tr>`;
  }).join('');

  document.getElementById('matrix-wrapper').innerHTML = `
    <p class="matrix-meta">${divGames.length} total games · ${Object.keys(counts).length} unique matchups · cell = games played (H home / A away from row team's perspective)</p>
    <div class="matrix-scroll">
      <table class="matrix-table"><thead>${header}</thead><tbody>${rows}</tbody></table>
    </div>`;
}

// ── STATS VIEW ────────────────────────────────────────────────────────────────
function renderStatsView(divGames, divTeams) {
  if (!divTeams.length) {
    document.getElementById('stats-wrapper').innerHTML = '<p class="no-games">No teams found.</p>';
    return;
  }

  const weeks = [...new Set(divGames.map(g => g.week))].sort((a, b) => a - b);

  const header = `<tr>
    <th>Team</th>
    <th class="center">Total</th>
    <th class="center">Home</th>
    <th class="center">Away</th>
    <th class="center">Wkday</th>
    <th class="center">Sat</th>
    ${weeks.map(w => `<th class="center">W${w}</th>`).join('')}
  </tr>`;

  const rows = divTeams.map(team => {
    const id = team.id;
    const myGames = divGames.filter(g => g.home_team_id === id || g.away_team_id === id);
    const home = myGames.filter(g => g.home_team_id === id).length;
    const away = myGames.filter(g => g.away_team_id === id).length;
    const wd  = myGames.filter(g => g.day !== 'Saturday').length;
    const sat = myGames.filter(g => g.day === 'Saturday').length;
    const perWeek = {};
    myGames.forEach(g => { perWeek[g.week] = (perWeek[g.week] || 0) + 1; });
    const imbalanced = Math.abs(home - away) > 1;

    return `<tr>
      <td class="stats-team-name">${esc(teamLabel(team))}</td>
      <td class="center stat-total">${myGames.length}</td>
      <td class="center ${imbalanced ? 'stat-warn' : ''}">${home}</td>
      <td class="center ${imbalanced ? 'stat-warn' : ''}">${away}</td>
      <td class="center">${wd}</td>
      <td class="center">${sat}</td>
      ${weeks.map(w => {
        const n = perWeek[w] || 0;
        return `<td class="center ${n > 2 ? 'stat-warn' : n === 0 ? 'stat-zero' : ''}">${n || '·'}</td>`;
      }).join('')}
    </tr>`;
  }).join('');

  const weekTotals = weeks.map(w => divGames.filter(g => g.week === w).length);

  document.getElementById('stats-wrapper').innerHTML = `
    <div class="stats-scroll">
      <table class="stats-table">
        <thead>${header}</thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td><strong>Total</strong></td>
          <td class="center stat-total"><strong>${divGames.length}</strong></td>
          <td colspan="4"></td>
          ${weekTotals.map(n => `<td class="center"><strong>${n}</strong></td>`).join('')}
        </tr></tfoot>
      </table>
    </div>
    <p class="stats-note">Orange = home/away imbalance &gt;1. · = no game that week.</p>`;
}

// ── Teams Roster Page (global, all divisions) ─────────────────────────────────
function renderTeamsPage() {
  const container = document.getElementById('teams-roster');
  if (!seasonData || !seasonData.divisions) {
    container.innerHTML = '<p class="no-games">No season data loaded.</p>';
    return;
  }

  const fieldMap = {};
  (seasonData.fields || []).forEach(f => { fieldMap[f.id] = fieldDisplayName(f); });

  const html = seasonData.divisions.map(div => {
    const divTeams = (seasonData.teams || []).filter(t => t.division_id === div.id);
    if (!divTeams.length) return '';

    const rows = divTeams.map(t => {
      const fieldName = fieldMap[t.home_field_id] || t.home_field_id || '—';
      const confirmed = t.confirmed !== false;
      const statusBadge = confirmed
        ? '<span class="confirmed-badge">Confirmed</span>'
        : '<span class="unconfirmed-badge">Unconfirmed</span>';
      const blackouts = (t.blackout_dates || []).join(', ') || '—';
      return `<tr class="${confirmed ? '' : 'unconfirmed-row'}">
        <td class="teams-table-name">${esc(teamLabel(t))}</td>
        <td>${esc(t.coach || '—')}</td>
        <td>${esc(t.phone || '—')}</td>
        <td>${esc(t.email || '—')}</td>
        <td>${esc(fieldName)}</td>
        <td>${statusBadge}</td>
        <td class="blackout-cell">${esc(blackouts)}</td>
      </tr>`;
    }).join('');

    const divLabel = div.name || div.label || div.id;
    return `<div class="teams-division-section">
      <div class="teams-division-header">${esc(divLabel)} <span class="teams-div-count">${divTeams.length} team${divTeams.length !== 1 ? 's' : ''}</span></div>
      <table class="teams-table">
        <thead><tr>
          <th>Team</th><th>Coach</th><th>Phone</th><th>Email</th><th>Home Field</th><th>Status</th><th>Blackout Dates</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  container.innerHTML = html || '<p class="no-games">No teams found.</p>';
}

// ── Game Edit Modal ───────────────────────────────────────────────────────────
async function openEditModal(gameId) {
  if (!scheduleData || !seasonData) return;
  const game = scheduleData.games.find(g => g.game_id === gameId);
  if (!game) return;

  editingGameId = gameId;

  // Fetch slots once
  if (!seasonSlots) {
    try {
      seasonSlots = await fetchJSON('api/season/slots');
    } catch (e) {
      showBanner('Could not load season slots: ' + e.message, 'error');
      return;
    }
  }

  const divName = (() => {
    const d = (seasonData.divisions || []).find(d => d.id === game.division_id);
    return d ? (d.name || d.label || d.id) : game.division_id;
  })();
  document.getElementById('modal-title').textContent = `Edit Game #${game.game_id} — ${divName}`;

  // Populate date select (grouped by week)
  const dateSelect = document.getElementById('edit-date');
  dateSelect.innerHTML = '';
  for (const wk of seasonSlots) {
    const grp = document.createElement('optgroup');
    grp.label = `Week ${wk.week}`;
    for (const slot of wk.dates) {
      const opt = document.createElement('option');
      opt.value = slot.date;
      opt.textContent = `${slot.day} ${formatDate(slot.date)}`;
      if (slot.date === game.date) opt.selected = true;
      grp.appendChild(opt);
    }
    dateSelect.appendChild(grp);
  }

  // Time
  document.getElementById('edit-time').value = game.time || '';

  // All fields in directory (no division filter needed)
  const fields = [...(seasonData.fields || [])].sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
  const fieldSelect = document.getElementById('edit-field');
  fieldSelect.innerHTML = '';
  for (const f of fields) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = fieldDisplayName(f);
    if (f.id === game.field_id) opt.selected = true;
    fieldSelect.appendChild(opt);
  }

  // Teams in division (confirmed only)
  const divTeams = (seasonData.teams || []).filter(t => t.division_id === game.division_id && t.confirmed !== false);
  const homeSelect = document.getElementById('edit-home');
  const awaySelect = document.getElementById('edit-away');
  homeSelect.innerHTML = '';
  awaySelect.innerHTML = '';
  for (const t of divTeams) {
    const label = teamLabel(t);
    const optH = document.createElement('option');
    optH.value = t.id;
    optH.textContent = label;
    if (t.id === game.home_team_id) optH.selected = true;
    homeSelect.appendChild(optH);

    const optA = document.createElement('option');
    optA.value = t.id;
    optA.textContent = label;
    if (t.id === game.away_team_id) optA.selected = true;
    awaySelect.appendChild(optA);
  }

  // Reset violations state
  const violDiv = document.getElementById('edit-violations');
  violDiv.classList.add('hidden');
  violDiv.innerHTML = '';
  document.getElementById('edit-force').classList.add('hidden');

  document.getElementById('game-edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('game-edit-modal').classList.add('hidden');
  document.getElementById('edit-violations').classList.add('hidden');
  document.getElementById('edit-violations').innerHTML = '';
  document.getElementById('edit-force').classList.add('hidden');
  // Reset notify panel
  document.getElementById('notify-panel').classList.add('hidden');
  document.getElementById('notify-email-btn').classList.add('hidden');
  document.getElementById('notify-done-btn').classList.add('hidden');
  document.getElementById('edit-cancel').classList.remove('hidden');
  document.getElementById('edit-save').classList.remove('hidden');
  document.getElementById('modal-body-fields').classList.remove('hidden');
  editingGameId = null;
}

async function saveGame(force) {
  if (editingGameId === null) return;

  const date = document.getElementById('edit-date').value;
  const time = document.getElementById('edit-time').value.trim();
  const field_id = document.getElementById('edit-field').value;
  const home_team_id_raw = document.getElementById('edit-home').value;
  const away_team_id_raw = document.getElementById('edit-away').value;

  // Try parsing as int, fall back to string
  const home_team_id = isNaN(parseInt(home_team_id_raw, 10)) ? home_team_id_raw : parseInt(home_team_id_raw, 10);
  const away_team_id = isNaN(parseInt(away_team_id_raw, 10)) ? away_team_id_raw : parseInt(away_team_id_raw, 10);
  const field_id_parsed = isNaN(parseInt(field_id, 10)) ? field_id : parseInt(field_id, 10);

  if (home_team_id === away_team_id) {
    showViolations(['Home team and away team cannot be the same.']);
    return;
  }

  try {
    const res = await fetch(`api/game/${editingGameId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, time, field_id: field_id_parsed, home_team_id, away_team_id, force: !!force }),
    });
    const data = await res.json();

    if (res.status === 409) {
      showViolations(data.violations || ['Unknown conflict.']);
      return;
    }

    if (!res.ok) {
      showBanner(data.error || 'Save failed.', 'error');
      return;
    }

    // Update in-memory game
    const idx = scheduleData.games.findIndex(g => g.game_id === editingGameId);
    if (idx !== -1) scheduleData.games[idx] = data.game;
    scheduleData.generated_at = data.generated_at || scheduleData.generated_at;

    // Re-render current view in background
    renderCurrentView();

    // Show notification panel
    if (data.change) {
      showNotifyPanel(data.change);
    } else {
      closeEditModal();
      showBanner('Game updated successfully.', 'success');
    }

    // Badge the Changes nav
    updateChangesBadge();
  } catch (err) {
    showBanner('Save error: ' + err.message, 'error');
  }
}

function showViolations(violations) {
  const div = document.getElementById('edit-violations');
  div.innerHTML = '<strong>Constraint violations:</strong><ul>' +
    violations.map(v => `<li>${esc(v)}</li>`).join('') +
    '</ul>';
  div.classList.remove('hidden');
  document.getElementById('edit-force').classList.remove('hidden');
}

// Modal event listeners
document.getElementById('modal-close').addEventListener('click', closeEditModal);
document.getElementById('edit-cancel').addEventListener('click', closeEditModal);
document.getElementById('edit-save').addEventListener('click', () => saveGame(false));
document.getElementById('edit-force').addEventListener('click', () => saveGame(true));
document.getElementById('game-edit-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('game-edit-modal')) closeEditModal();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(d) {
  const [y, m, day] = d.split('-');
  return `${parseInt(m)}/${parseInt(day)}/${y}`;
}

function formatTime12h(t) {
  if (!t) return t;
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

function showBanner(msg, type) {
  const banner = document.getElementById('success-banner');
  banner.className = 'success-banner' + (type === 'error' ? ' error' : type === 'warn' ? ' warn' : '');
  document.getElementById('success-text').textContent = msg;
  banner.classList.remove('hidden');
}

// ── CALENDAR VIEW ─────────────────────────────────────────────────────────────
function populateCalTeamSelect(divId) {
  const teams = getDivTeams(divId);
  const sel = document.getElementById('cal-team-select');
  const prev = sel.value;
  sel.innerHTML = '';
  teams.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = teamLabel(t);
    sel.appendChild(opt);
  });
  // Restore previous selection if still valid
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

document.getElementById('cal-team-select').addEventListener('change', () => {
  if (activeView === 'calendar' && scheduleData && activeDivision) {
    const divGames = (scheduleData.games || []).filter(g => g.division_id === activeDivision);
    renderCalendarView(divGames, getDivTeams(activeDivision));
  }
});

function renderCalendarView(divGames, divTeams) {
  const wrapper = document.getElementById('calendar-wrapper');
  if (!divTeams.length) { wrapper.innerHTML = '<p class="no-games">No teams found.</p>'; return; }

  const rawVal = document.getElementById('cal-team-select').value;
  const teamId = isNaN(parseInt(rawVal, 10)) ? rawVal : parseInt(rawVal, 10);
  const team   = divTeams.find(t => t.id === teamId) || divTeams[0];
  if (!team) { wrapper.innerHTML = '<p class="no-games">Select a team.</p>'; return; }

  const myGames = divGames.filter(g => g.home_team_id === team.id || g.away_team_id === team.id);
  const byDate  = {};
  myGames.forEach(g => { (byDate[g.date] = byDate[g.date] || []).push(g); });

  // Build blackout set: team-level + global
  const blackouts = new Set(team.blackout_dates || []);
  const globalBo  = seasonData?.season?.blackout_dates || [];
  for (const w of (seasonData?.season?.blackout_weekends || [])) {
    (w.dates || []).forEach(d => blackouts.add(d));
    if (w.saturday) blackouts.add(w.saturday);
    if (w.sunday)   blackouts.add(w.sunday);
  }
  globalBo.forEach(d => blackouts.add(d));

  const months = [
    { year: 2026, month: 4, label: 'April 2026' },
    { year: 2026, month: 5, label: 'May 2026' },
    { year: 2026, month: 6, label: 'June 2026' },
  ];

  const legend = `<div class="cal-legend">
    <span class="cal-legend-item"><span class="cal-legend-swatch cal-swatch-game"></span> Game scheduled</span>
    <span class="cal-legend-item"><span class="cal-legend-swatch cal-swatch-blackout"></span> Blacked out</span>
    <span class="cal-legend-item"><span class="cal-legend-swatch cal-swatch-rematch"></span> Rematch</span>
    <span class="cal-legend-item"><span class="cal-legend-swatch cal-swatch-global"></span> League-wide blackout</span>
  </div>`;

  wrapper.innerHTML = legend + months.map(m =>
    renderCalMonth(m.year, m.month, m.label, byDate, team.id, blackouts)
  ).join('');
}

function renderCalMonth(year, month, label, byDate, teamId, blackouts) {
  const firstDow    = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const DAY_HEADS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // Global blackouts (league-wide) vs team blackouts — distinguish for styling
  const globalBoDates = new Set();
  for (const w of (seasonData?.season?.blackout_weekends || [])) {
    (w.dates || []).forEach(d => globalBoDates.add(d));
    if (w.saturday) globalBoDates.add(w.saturday);
    if (w.sunday)   globalBoDates.add(w.sunday);
  }
  (seasonData?.season?.blackout_dates || []).forEach(d => globalBoDates.add(d));

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<td class="cal-empty"></td>');

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr  = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const games    = byDate[dateStr] || [];
    const isGlobal = globalBoDates.has(dateStr);
    const isBlackout = blackouts.has(dateStr);

    const gameHtml = games.map(g => {
      const isHome  = g.home_team_id === teamId;
      const opp     = esc(isHome ? g.away_team_name : g.home_team_name);
      const haLabel = isHome
        ? '<span class="cal-ha-label home">Home</span>'
        : '<span class="cal-ha-label away">Away</span>';
      return `<div class="cal-game${g.is_rematch ? ' cal-rematch' : ''}">
        ${haLabel}
        <span class="cal-opp">${opp}</span>
        <span class="cal-meta">${formatTime12h(g.time)} · #${g.game_id}</span>
      </div>`;
    }).join('');

    let cls = 'cal-day';
    if (games.length)  cls += ' cal-has-game';
    if (isGlobal)      cls += ' cal-global-blackout';
    else if (isBlackout) cls += ' cal-blackout';

    const title = isGlobal ? ' title="League-wide blackout"' : isBlackout ? ' title="Team blackout"' : '';

    cells.push(`<td class="${cls}"${title}>
      <span class="cal-day-num">${d}</span>${gameHtml}
    </td>`);
  }

  const remaining = (7 - (cells.length % 7)) % 7;
  for (let i = 0; i < remaining; i++) cells.push('<td class="cal-empty"></td>');

  const rows = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(`<tr>${cells.slice(i, i + 7).join('')}</tr>`);
  }

  return `<div class="cal-month">
    <div class="cal-month-label">${label}</div>
    <table class="cal-table">
      <thead><tr>${DAY_HEADS.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  </div>`;
}

// ── Season Editor Page ────────────────────────────────────────────────────────
let editorOpenTeamId = null;

function renderSeasonEditor() {
  const container = document.getElementById('season-editor-content');
  if (!seasonData || !seasonData.divisions) {
    container.innerHTML = '<p class="no-games" style="padding:24px">No season data loaded. Upload a season.json first.</p>';
    return;
  }

  const fieldOptions = [...(seasonData.fields || [])]
    .sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)))
    .map(f => `<option value="${esc(f.id)}">${esc(fieldDisplayName(f))}</option>`)
    .join('');

  const html = seasonData.divisions.map(div => {
    const divTeams = (seasonData.teams || []).filter(t => t.division_id === div.id);
    if (!divTeams.length) return '';
    const divLabel = div.name || div.label || div.id;
    const divTarget = div.target_games || (seasonData.season?.target_games) || 8;

    const rows = divTeams.map(t => buildTeamEditorRow(t, fieldOptions)).join('');

    return `<div class="editor-division-section">
      <div class="editor-division-header">
        ${esc(divLabel)} <span class="teams-div-count">${divTeams.length} team${divTeams.length !== 1 ? 's' : ''}</span>
        <span class="div-target-wrap">
          Target games: <input class="div-target-input" type="number" min="1" max="20" value="${divTarget}" data-div-id="${esc(div.id)}" title="Target games per team for this division">
          <span class="div-target-hint">per team</span>
        </span>
      </div>
      ${rows}
    </div>`;
  }).join('');

  container.innerHTML = html || '<p class="no-games" style="padding:24px">No teams found.</p>';

  // Re-open any previously open form after re-render
  if (editorOpenTeamId !== null) {
    const form = document.getElementById(`editor-form-${editorOpenTeamId}`);
    if (form) form.classList.remove('hidden');
  }
}

function buildTeamEditorRow(team, fieldOptions) {
  const id = team.id;
  const name = teamLabel(team);
  const fieldObj  = (seasonData.fields || []).find(f => f.id === team.home_field_id);
  const fieldName = fieldObj ? fieldDisplayName(fieldObj) : (team.home_field_id || '—');
  const confirmedBadge = team.confirmed !== false
    ? '<span class="confirmed-badge">Confirmed</span>'
    : '<span class="unconfirmed-badge">Unconfirmed</span>';
  const blackoutStr = (team.blackout_dates || []).join('\n');

  return `
  <div class="editor-team" id="editor-team-${id}">
    <div class="editor-team-row" onclick="toggleTeamForm(${JSON.stringify(id)})">
      <span class="editor-team-name">${esc(name)}</span>
      <span class="editor-team-coach">${esc(team.coach || '—')}</span>
      <span class="editor-team-field">${esc(fieldName)}</span>
      ${confirmedBadge}
      <span class="editor-chevron">›</span>
    </div>
    <div class="editor-team-form hidden" id="editor-form-${id}">
      <div class="editor-form-grid">
        <label class="editor-label">Team Name
          <input type="text" id="ef-label-${id}" value="${esc(team.label || team.name || '')}">
        </label>
        <label class="editor-label">Coach
          <input type="text" id="ef-coach-${id}" value="${esc(team.coach || '')}">
        </label>
        <label class="editor-label">Phone
          <input type="text" id="ef-phone-${id}" value="${esc(team.phone || '')}">
        </label>
        <label class="editor-label">Email
          <input type="text" id="ef-email-${id}" value="${esc(team.email || '')}">
        </label>
        <label class="editor-label">Home Field
          <select id="ef-field-${id}">
            ${fieldOptions}
          </select>
        </label>
      </div>
      <div class="editor-form-bottom">
        <label class="editor-label editor-label-wide">Blackout Dates <span class="editor-hint">one per line, YYYY-MM-DD</span>
          <textarea id="ef-blackouts-${id}" rows="4" spellcheck="false">${esc(blackoutStr)}</textarea>
        </label>
        <div class="editor-form-right">
          <label class="editor-checkbox-label">
            <input type="checkbox" id="ef-confirmed-${id}" ${team.confirmed !== false ? 'checked' : ''}>
            Confirmed
          </label>
          <div class="editor-form-actions">
            <button class="btn btn-secondary" onclick="toggleTeamForm(${JSON.stringify(id)})">Cancel</button>
            <button class="btn btn-primary" onclick="saveTeamForm(${JSON.stringify(id)})">Save</button>
          </div>
          <div id="ef-status-${id}" class="editor-status"></div>
        </div>
      </div>
    </div>
  </div>`;
}

function toggleTeamForm(teamId) {
  if (editorOpenTeamId !== null && editorOpenTeamId !== teamId) {
    // Close currently open form
    const prev = document.getElementById(`editor-form-${editorOpenTeamId}`);
    if (prev) prev.classList.add('hidden');
    const prevRow = document.getElementById(`editor-team-${editorOpenTeamId}`)?.querySelector('.editor-team-row');
    if (prevRow) prevRow.classList.remove('open');
  }

  const form = document.getElementById(`editor-form-${teamId}`);
  const row  = document.getElementById(`editor-team-${teamId}`)?.querySelector('.editor-team-row');
  if (!form) return;

  const isOpen = !form.classList.contains('hidden');
  form.classList.toggle('hidden', isOpen);
  row?.classList.toggle('open', !isOpen);
  editorOpenTeamId = isOpen ? null : teamId;

  if (!isOpen) {
    // Set select values after inserting into DOM
    const team = (seasonData.teams || []).find(t => t.id === teamId);
    if (team) {
      const fieldSel = document.getElementById(`ef-field-${teamId}`);
      if (fieldSel) fieldSel.value = team.home_field_id || '';
    }
  }
}

async function saveTeamForm(teamId) {
  const statusEl = document.getElementById(`ef-status-${teamId}`);
  statusEl.textContent = '';
  statusEl.className = 'editor-status';

  const label      = document.getElementById(`ef-label-${teamId}`)?.value.trim();
  const coach      = document.getElementById(`ef-coach-${teamId}`)?.value.trim();
  const phone      = document.getElementById(`ef-phone-${teamId}`)?.value.trim();
  const email      = document.getElementById(`ef-email-${teamId}`)?.value.trim();
  const home_field_id = document.getElementById(`ef-field-${teamId}`)?.value;
  const confirmed  = document.getElementById(`ef-confirmed-${teamId}`)?.checked;
  const blackoutRaw = document.getElementById(`ef-blackouts-${teamId}`)?.value || '';
  const blackout_dates = blackoutRaw.split('\n').map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));

  try {
    const res = await fetch(`api/team/${teamId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, coach, phone, email, home_field_id, confirmed, blackout_dates }),
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.error || 'Save failed.';
      statusEl.className = 'editor-status error';
      return;
    }

    // Update in-memory seasonData
    const idx = seasonData.teams.findIndex(t => t.id === teamId);
    if (idx !== -1) seasonData.teams[idx] = data.team;

    statusEl.textContent = '✓ Saved';
    statusEl.className = 'editor-status saved';

    // Refresh the team row summary
    const teamEl = document.getElementById(`editor-team-${teamId}`);
    if (teamEl) {
      const allFieldOptions = [...(seasonData.fields || [])]
        .sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)))
        .map(f => `<option value="${esc(f.id)}">${esc(f.name || f.id)} (${esc(f.id)})</option>`)
        .join('');
      teamEl.outerHTML = buildTeamEditorRow(data.team, allFieldOptions);
      // Re-open the form after replace
      editorOpenTeamId = null;
      toggleTeamForm(teamId);
      const newStatus = document.getElementById(`ef-status-${teamId}`);
      if (newStatus) { newStatus.textContent = '✓ Saved'; newStatus.className = 'editor-status saved'; }
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.className = 'editor-status error';
  }
}

// Division target_games inline editor
document.getElementById('season-editor-content').addEventListener('change', async (e) => {
  const input = e.target.closest('.div-target-input');
  if (!input) return;
  const divId = input.dataset.divId;
  const value = parseInt(input.value, 10);
  if (!divId || isNaN(value) || value < 1) return;

  try {
    const res = await fetch(`api/division/${encodeURIComponent(divId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_games: value }),
    });
    const data = await res.json();
    if (!res.ok) { showBanner(data.error || 'Failed to save division target.', 'error'); return; }
    // Update in-memory
    const div = (seasonData.divisions || []).find(d => d.id === divId);
    if (div) div.target_games = value;
    showBanner(`Target games updated for ${divId}: ${value} per team.`, 'success');
  } catch (err) {
    showBanner('Error saving division: ' + err.message, 'error');
  }
});

// ── Notify panel (shown in modal after save) ──────────────────────────────────
function showNotifyPanel(change) {
  // Hide edit fields + violations
  document.getElementById('modal-body-fields').classList.add('hidden');
  document.getElementById('edit-violations').classList.add('hidden');
  document.getElementById('edit-cancel').classList.add('hidden');
  document.getElementById('edit-save').classList.add('hidden');
  document.getElementById('edit-force').classList.add('hidden');

  // Build saved banner
  const changesDesc = change.changed_fields.length
    ? change.changed_fields.map(c => fieldLabel(c.field)).join(', ') + ' updated'
    : 'No fields changed';
  document.getElementById('notify-saved-banner').innerHTML =
    `&#10003; Game #${change.game_id} saved — ${esc(changesDesc)}`;

  // Build changes list
  document.getElementById('notify-changes-list').innerHTML = change.changed_fields.map(c => `
    <div class="notify-change-row">
      <span class="notify-change-field">${fieldLabel(c.field)}</span>
      <span class="notify-change-from">${esc(formatFieldValue(c.field, c.from))}</span>
      <span class="notify-change-arrow">→</span>
      <span class="notify-change-to">${esc(formatFieldValue(c.field, c.to))}</span>
    </div>`).join('') || '<span style="font-size:12px;color:#94a3b8">No fields were changed.</span>';

  // Build team cards
  const cards = [
    { role: 'Home Team', t: change.home_team },
    { role: 'Away Team', t: change.away_team },
  ].map(({ role, t }) => {
    if (!t) return `<div class="notify-team-card"><div class="notify-team-role">${role}</div><div class="notify-no-contact">No contact info</div></div>`;
    return `<div class="notify-team-card">
      <div class="notify-team-role">${role}</div>
      <div class="notify-team-name">${esc(t.name)}</div>
      <div class="notify-team-contact">
        ${t.coach ? `<span>&#128100; ${esc(t.coach)}</span>` : ''}
        ${t.email ? `<span>&#9993; <a href="mailto:${esc(t.email)}">${esc(t.email)}</a></span>` : '<span style="color:#94a3b8">No email on file</span>'}
        ${t.phone ? `<span>&#128222; ${esc(t.phone)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  document.getElementById('notify-team-cards').innerHTML = cards;

  // Wire up send button
  const emails = [change.home_team?.email, change.away_team?.email].filter(Boolean);
  const emailBtn = document.getElementById('notify-email-btn');
  if (emails.length) {
    emailBtn.onclick = async (e) => {
      e.preventDefault();
      emailBtn.textContent = 'Sending…';
      emailBtn.style.pointerEvents = 'none';
      try {
        const r = await fetch('api/notify-change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ change_id: change.id }) });
        const d = await r.json();
        if (d.ok) { emailBtn.textContent = '✓ Sent'; emailBtn.style.background = '#16a34a'; }
        else { emailBtn.textContent = '✗ Failed — ' + (d.error || 'error'); emailBtn.style.pointerEvents = ''; }
      } catch { emailBtn.textContent = '✗ Network error'; emailBtn.style.pointerEvents = ''; }
    };
    emailBtn.classList.remove('hidden');
  }

  document.getElementById('notify-panel').classList.remove('hidden');
  document.getElementById('notify-done-btn').classList.remove('hidden');
}

function fieldLabel(field) {
  return { date: 'Date', time: 'Time', field: 'Field', home_team: 'Home Team', away_team: 'Away Team' }[field] || field;
}
function formatFieldValue(field, val) {
  if (!val) return '—';
  if (field === 'date') return formatDate(val);
  if (field === 'time') return formatTime12h(val);
  return val;
}

document.getElementById('notify-done-btn').addEventListener('click', () => {
  closeEditModal();
  showBanner('Game updated.', 'success');
});

// ── Changes page ──────────────────────────────────────────────────────────────
async function renderChangesPage() {
  const container = document.getElementById('changes-content');
  container.innerHTML = '<p style="padding:24px;color:#94a3b8">Loading…</p>';
  let changes;
  try {
    changes = await fetchJSON('api/changes');
  } catch (e) {
    container.innerHTML = `<p class="changes-empty">Error loading changes: ${esc(e.message)}</p>`;
    return;
  }
  if (!changes.length) {
    container.innerHTML = '<p class="changes-empty">No changes recorded yet. Edit a game to start tracking.</p>';
    return;
  }
  // Most recent first
  changes = [...changes].reverse();
  container.innerHTML = changes.map(c => {
    const ts = new Date(c.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const forcedBadge = c.forced ? '<span class="change-forced-badge">Overridden</span>' : '';
    const pills = (c.changed_fields || []).map(f =>
      `<span class="change-field-pill"><strong>${fieldLabel(f.field)}:</strong> <span class="pill-from">${esc(formatFieldValue(f.field, f.from))}</span> → <span class="pill-to">${esc(formatFieldValue(f.field, f.to))}</span></span>`
    ).join('') || '<span class="change-field-pill" style="color:#94a3b8">No fields changed</span>';

    const teamCard = (t, role) => {
      if (!t) return '';
      const emailLink = t.email ? `<a href="mailto:${esc(t.email)}">${esc(t.email)}</a>` : 'no email';
      return `<div class="change-team-info"><strong>${esc(t.name)}</strong> (${role}) · ${esc(t.coach || '—')} · ${emailLink}${t.phone ? ' · ' + esc(t.phone) : ''}</div>`;
    };

    const emails = [c.home_team?.email, c.away_team?.email].filter(Boolean);

    return `<div class="change-entry">
      <div class="change-entry-header">
        <span class="change-ts">${ts}</span>
        <span class="change-game-badge">Game #${c.game_id}</span>
        <span class="change-div-badge">${esc(c.division_name || c.division_id)}</span>
        ${forcedBadge}
      </div>
      <div class="change-fields">${pills}</div>
      <div class="change-teams">${teamCard(c.home_team, 'H')}${teamCard(c.away_team, 'A')}</div>
      ${emails.length ? `<div class="change-entry-actions"><button class="change-resend" data-change-id="${c.id}">&#9993; Notify Coaches</button></div>` : ''}
    </div>`;
  }).join('');
}

// Delegate click on change log notify buttons
document.getElementById('changes-content').addEventListener('click', async (e) => {
  const btn = e.target.closest('.change-resend[data-change-id]');
  if (!btn) return;
  const changeId = parseInt(btn.dataset.changeId, 10);
  btn.textContent = 'Sending…';
  btn.disabled = true;
  try {
    const r = await fetch('api/notify-change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ change_id: changeId }) });
    const d = await r.json();
    if (d.ok) { btn.textContent = '✓ Sent'; btn.style.color = '#16a34a'; btn.style.borderColor = '#16a34a'; }
    else { btn.textContent = '✗ ' + (d.error || 'Failed'); btn.disabled = false; }
  } catch { btn.textContent = '✗ Network error'; btn.disabled = false; }
});

function updateChangesBadge() {
  fetchJSON('api/changes').then(changes => {
    const btn = document.getElementById('nav-changes');
    if (btn && changes.length) btn.textContent = `📋 Changes (${changes.length})`;
  }).catch(() => {});
}

document.getElementById('btn-clear-changes').addEventListener('click', async () => {
  if (!confirm('Clear the entire change log?')) return;
  await fetch('api/changes', { method: 'DELETE' });
  document.getElementById('nav-changes').textContent = '📋 Changes';
  renderChangesPage();
});

// ── FIELDS PAGE ───────────────────────────────────────────────────────────────
let editingFieldId = null;

function fieldDisplayName(f) {
  return f.sub_field ? `${f.name} – ${f.sub_field}` : f.name;
}

function fieldMapLink(f, label) {
  if (!f?.coordinates) return '';
  const url = `https://www.google.com/maps?q=${f.coordinates}&t=k`;
  return `<a href="${url}" target="_blank" rel="noopener" class="map-link">${label || '📍 Map'}</a>`;
}

function renderFieldsPage() {
  const fields = [...(seasonData?.fields || [])].sort((a, b) => fieldDisplayName(a).localeCompare(fieldDisplayName(b)));
  const teams  = seasonData?.teams  || [];
  const list = document.getElementById('fields-list');

  const usageCount = {};
  teams.forEach(t => { if (t.home_field_id) usageCount[t.home_field_id] = (usageCount[t.home_field_id] || 0) + 1; });

  if (!fields.length) {
    list.innerHTML = '<p style="color:#94a3b8;padding:24px">No fields defined. Add one above.</p>';
    return;
  }

  list.innerHTML = `<table class="fields-table">
    <thead><tr>
      <th>Field</th><th>Address</th><th>Notes</th><th>Map</th><th>Used By</th><th></th>
    </tr></thead>
    <tbody>
    ${fields.map(f => {
      const usage = usageCount[f.id] || 0;
      return `<tr>
        <td>
          <strong>${esc(f.name)}</strong>
          ${f.sub_field ? `<span class="field-subfield-badge">${esc(f.sub_field)}</span>` : ''}
        </td>
        <td>${esc(f.address || '—')}</td>
        <td style="font-size:12px;color:#94a3b8">${esc(f.notes || '—')}</td>
        <td>${fieldMapLink(f, '📍 View') || '<span style="color:#cbd5e1">—</span>'}</td>
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
  const field = (seasonData?.fields || []).find(f => String(f.id) === fieldId);
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
    // Refresh seasonData fields
    seasonData = await fetchJSON('api/season');
    document.getElementById('field-editor-form').classList.add('hidden');
    renderFieldsPage();
  } catch (e) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
});

async function deleteField(fieldId, fieldName) {
  if (!confirm(`Delete field "${fieldName}"? This cannot be undone.`)) return;
  try {
    const res  = await fetch(`api/season/fields/${fieldId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) { alert(data.error || 'Delete failed.'); return; }
    seasonData = await fetchJSON('api/season');
    renderFieldsPage();
  } catch (e) { alert('Network error. Try again.'); }
}

init();
