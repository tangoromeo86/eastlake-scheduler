'use strict';

let scheduleData = null;
let seasonData = null;
let activeDivision = null;
let activeView = 'games';
let seasonSlots = null;

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [sched, seas] = await Promise.all([
      fetchJSON('api/public/schedule'),
      fetchJSON('api/public/season'),
    ]);
    seasonData = seas;
    scheduleData = sched;

    renderSeasonBar(seas);

    if ((sched.games || []).length) {
      buildDivTabs(sched.games);
      populateFieldSelect();
      document.getElementById('div-tabs-outer').classList.remove('hidden');
      document.getElementById('vbar').classList.remove('hidden');
    } else {
      document.getElementById('loading-state').textContent = 'No schedule has been generated yet. Check back later.';
      document.getElementById('loading-state').classList.remove('hidden');
      return;
    }
  } catch (e) {
    document.getElementById('loading-state').textContent = 'Could not load schedule: ' + e.message;
    return;
  }
  document.getElementById('loading-state').classList.add('hidden');
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ── Season bar ────────────────────────────────────────────────────────────────
function renderSeasonBar(seas) {
  if (!seas || !seas.season) return;
  const s = seas.season;
  const teams = (seas.teams || []).filter(t => t.confirmed !== false);
  const parts = [];
  if (s.start) parts.push(formatDate(s.start) + ' – ' + formatDate(s.end || s.start));
  parts.push((seas.divisions || []).length + ' divisions');
  parts.push(teams.length + ' teams');
  const bar = document.getElementById('season-bar');
  bar.innerHTML = parts.map(p => `<span>${esc(p)}</span>`).join('<span style="color:#334155">·</span>');
  bar.classList.remove('hidden');
}

// ── Division tabs ─────────────────────────────────────────────────────────────
function buildDivTabs(games) {
  const order = (seasonData?.divisions || []).map(d => d.id);
  const names = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));
  const present = order.filter(id => games.some(g => g.division_id === id));
  const extra = [...new Set(games.map(g => g.division_id))].filter(id => !order.includes(id));
  const divs = [...present, ...extra];

  const nav = document.getElementById('division-tabs');
  nav.innerHTML = '';
  divs.forEach(divId => {
    const btn = document.createElement('button');
    btn.className = 'div-tab';
    btn.textContent = names[divId] || divId;
    btn.dataset.divId = divId;
    btn.addEventListener('click', () => selectDivision(divId));
    nav.appendChild(btn);
  });
  if (divs.length) selectDivision(divs[0]);
}

function selectDivision(divId) {
  activeDivision = divId;
  document.querySelectorAll('.div-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.divId === divId)
  );
  populateTeamFilter();
  populateCalTeamSelect();
  renderCurrentView();
}

// ── View bar ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.vbar-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeView = btn.dataset.view;
    document.querySelectorAll('.vbar-btn').forEach(b => b.classList.toggle('active', b === btn));
    syncFilterVisibility();
    renderCurrentView();
  });
});

function syncFilterVisibility() {
  const tf = document.getElementById('team-filter');
  const gc = document.getElementById('game-count-badge');
  const cs = document.getElementById('cal-team-select');
  const fs = document.getElementById('field-select');
  if (activeView === 'games') {
    tf.classList.remove('hidden');
    gc.classList.remove('hidden');
    cs.classList.add('hidden');
    fs.classList.add('hidden');
  } else if (activeView === 'calendar') {
    tf.classList.add('hidden');
    gc.classList.add('hidden');
    cs.classList.remove('hidden');
    fs.classList.add('hidden');
  } else if (activeView === 'fields') {
    tf.classList.add('hidden');
    gc.classList.add('hidden');
    cs.classList.add('hidden');
    fs.classList.remove('hidden');
  } else {
    tf.classList.add('hidden');
    gc.classList.add('hidden');
    cs.classList.add('hidden');
    fs.classList.add('hidden');
  }
}

function renderCurrentView() {
  ['games','teams','matrix','stats','calendar','fields'].forEach(v => {
    document.getElementById('view-' + v).classList.toggle('hidden', v !== activeView);
  });
  if (!scheduleData) return;
  if (activeView === 'fields') { renderFieldsView(); return; }
  if (!activeDivision) return;
  const divGames = (scheduleData.games || []).filter(g => g.division_id === activeDivision);
  const divTeams = getDivTeams(activeDivision);
  if (activeView === 'games')    renderGames(divGames);
  if (activeView === 'teams')    renderTeamsView(divGames, divTeams);
  if (activeView === 'matrix')   renderMatrixView(divGames, divTeams);
  if (activeView === 'stats')    renderStatsView(divGames, divTeams);
  if (activeView === 'calendar') renderCalendarView(divGames, divTeams);
}

function getDivTeams(divId) {
  if (!seasonData) return [];
  return (seasonData.teams || [])
    .filter(t => t.division_id === divId && t.confirmed !== false)
    .sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
}

function teamLabel(t) { return t.name || t.label || t.team_name || 'Team ' + t.id; }

// ── Team filter ───────────────────────────────────────────────────────────────
function populateTeamFilter() {
  const divGames = (scheduleData?.games || []).filter(g => g.division_id === activeDivision);
  const teams = new Map();
  divGames.forEach(g => {
    teams.set(g.home_team_id, g.home_team_name);
    teams.set(g.away_team_id, g.away_team_name);
  });
  const sorted = [...teams.entries()].sort((a, b) => (a[1]||'').localeCompare(b[1]||''));
  const sel = document.getElementById('team-filter');
  sel.innerHTML = '<option value="">All teams</option>';
  sorted.forEach(([id, name]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  syncFilterVisibility();
}

document.getElementById('team-filter').addEventListener('change', () => {
  if (!scheduleData || activeView !== 'games') return;
  const divGames = (scheduleData.games || []).filter(g => g.division_id === activeDivision);
  renderGames(divGames);
});

// ── GAMES VIEW ────────────────────────────────────────────────────────────────
function renderGames(divGames) {
  const rawVal = document.getElementById('team-filter').value;
  const teamId = rawVal ? (isNaN(parseInt(rawVal,10)) ? rawVal : parseInt(rawVal,10)) : null;
  const filtered = teamId
    ? divGames.filter(g => g.home_team_id === teamId || g.away_team_id === teamId)
    : divGames;
  const sorted = [...filtered].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  const badge = document.getElementById('game-count-badge');
  badge.textContent = sorted.length + ' game' + (sorted.length !== 1 ? 's' : '');

  const noMsg = document.getElementById('no-games-msg');
  if (!sorted.length) {
    document.getElementById('games-tbody').innerHTML = '';
    document.getElementById('games-cards').innerHTML = '';
    noMsg.classList.remove('hidden');
    return;
  }
  noMsg.classList.add('hidden');

  // Table (desktop)
  document.getElementById('games-tbody').innerHTML = sorted.map(g => `
    <tr class="${g.is_rematch ? 'g-rematch' : ''}">
      <td class="g-id">#${g.game_id}</td>
      <td>W${g.week}</td>
      <td>${formatDate(g.date)}</td>
      <td>${g.day.slice(0,3)}</td>
      <td>${formatTime12h(g.time)}</td>
      <td class="g-home">${esc(g.home_team_name)}</td>
      <td class="g-away">${esc(g.away_team_name)}</td>
      <td>${esc(g.field_name)}</td>
      <td class="g-addr">${esc(g.field_address)}</td>
    </tr>
  `).join('');

  // Cards (mobile)
  document.getElementById('games-cards').innerHTML = sorted.map(g => `
    <div class="game-card${g.is_rematch ? ' rematch' : ''}">
      <div class="game-card-top">
        <span>W${g.week} · ${g.day.slice(0,3)} ${formatDate(g.date)} · ${formatTime12h(g.time)}</span>
        ${g.is_rematch ? '<span class="rematch-badge">Rematch</span>' : ''}
      </div>
      <div class="game-card-matchup">
        <span class="home">${esc(g.home_team_name)}</span>
        <span class="vs">vs</span>
        <span class="away">${esc(g.away_team_name)}</span>
      </div>
      <div class="game-card-field">📍 ${esc(g.field_name)}${g.field_address ? ' — ' + esc(g.field_address) : ''}</div>
    </div>
  `).join('');
}

// ── TEAMS VIEW ────────────────────────────────────────────────────────────────
function renderTeamsView(divGames, divTeams) {
  const sorted = [...divGames].sort((a, b) => a.date.localeCompare(b.date));
  const cards = divTeams.map(team => {
    const myGames = sorted.filter(g => g.home_team_id === team.id || g.away_team_id === team.id);
    const homeCount = myGames.filter(g => g.home_team_id === team.id).length;
    const awayCount = myGames.filter(g => g.away_team_id === team.id).length;
    const rows = myGames.map(g => {
      const isHome = g.home_team_id === team.id;
      const opp = isHome ? g.away_team_name : g.home_team_name;
      const ha = isHome ? '<span class="ha-home">H</span>' : '<span class="ha-away">A</span>';
      return `<tr>
        <td>W${g.week}</td>
        <td>${formatDate(g.date)}</td>
        <td>${g.day.slice(0,3)}</td>
        <td>${formatTime12h(g.time)}</td>
        <td>${ha}</td>
        <td>${esc(opp)}</td>
        <td style="color:#94a3b8;font-size:11px">${esc(g.field_name)}</td>
      </tr>`;
    }).join('');
    return `<div class="tcard">
      <div class="tcard-header">
        <span class="tcard-name">${esc(teamLabel(team))}</span>
        <span class="tcard-meta">${myGames.length} games · ${homeCount}H ${awayCount}A</span>
      </div>
      <table>
        <thead><tr><th>Wk</th><th>Date</th><th>Day</th><th>Time</th><th></th><th>Opponent</th><th>Field</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');
  document.getElementById('teams-grid').innerHTML = cards || '<p class="empty-state">No team data available.</p>';
}

// ── MATRIX VIEW ───────────────────────────────────────────────────────────────
function renderMatrixView(divGames, divTeams) {
  if (!divTeams.length) {
    document.getElementById('matrix-wrapper').innerHTML = '<p class="empty-state">No teams found.</p>';
    return;
  }
  const pairKey = (a, b) => Math.min(a,b) + '_' + Math.max(a,b);
  const counts = {};
  const homeAway = {};
  divGames.forEach(g => {
    const k = pairKey(g.home_team_id, g.away_team_id);
    counts[k] = (counts[k] || 0) + 1;
    const hk = g.home_team_id + '_' + g.away_team_id;
    homeAway[hk] = (homeAway[hk] || 0) + 1;
  });
  const maxCount = Math.max(1, ...Object.values(counts));
  const header = '<tr><th class="matrix-corner"></th>' +
    divTeams.map(t => `<th class="matrix-col-head" title="${esc(teamLabel(t))}">${esc(teamLabel(t))}</th>`).join('') +
    '</tr>';
  const rows = divTeams.map(row => {
    const cells = divTeams.map(col => {
      if (row.id === col.id) return '<td class="matrix-self">—</td>';
      const k = pairKey(row.id, col.id);
      const total = counts[k] || 0;
      if (!total) return '<td class="matrix-zero">·</td>';
      const asHome = homeAway[row.id + '_' + col.id] || 0;
      const asAway = homeAway[col.id + '_' + row.id] || 0;
      const intensity = Math.round((total / maxCount) * 4);
      return `<td class="matrix-cell matrix-i${intensity}" title="${total} game(s): ${asHome}H ${asAway}A">
        <span class="matrix-count">${total}</span>
        <span class="matrix-ha">${asHome}H${asAway}A</span>
      </td>`;
    }).join('');
    return '<tr><th class="matrix-row-head" title="' + esc(teamLabel(row)) + '">' + esc(teamLabel(row)) + '</th>' + cells + '</tr>';
  }).join('');
  document.getElementById('matrix-wrapper').innerHTML = `
    <p class="matrix-meta">${divGames.length} total games · ${Object.keys(counts).length} unique matchups</p>
    <div class="matrix-scroll"><table class="matrix-table"><thead>${header}</thead><tbody>${rows}</tbody></table></div>`;
}

// ── STATS VIEW ────────────────────────────────────────────────────────────────
function renderStatsView(divGames, divTeams) {
  if (!divTeams.length) {
    document.getElementById('stats-wrapper').innerHTML = '<p class="empty-state">No teams found.</p>';
    return;
  }
  const weeks = [...new Set(divGames.map(g => g.week))].sort((a, b) => a - b);
  const header = '<tr><th>Team</th><th>Total</th><th>Home</th><th>Away</th><th>Wkday</th><th>Sat</th>' +
    weeks.map(w => `<th>W${w}</th>`).join('') + '</tr>';
  const rows = divTeams.map(team => {
    const myGames = divGames.filter(g => g.home_team_id === team.id || g.away_team_id === team.id);
    const home = myGames.filter(g => g.home_team_id === team.id).length;
    const away = myGames.filter(g => g.away_team_id === team.id).length;
    const wd = myGames.filter(g => g.day !== 'Saturday').length;
    const sat = myGames.filter(g => g.day === 'Saturday').length;
    const perWeek = {};
    myGames.forEach(g => { perWeek[g.week] = (perWeek[g.week] || 0) + 1; });
    const imb = Math.abs(home - away) > 1;
    return `<tr>
      <td>${esc(teamLabel(team))}</td>
      <td class="stat-total" style="text-align:center">${myGames.length}</td>
      <td style="text-align:center" class="${imb ? 'stat-warn' : ''}">${home}</td>
      <td style="text-align:center" class="${imb ? 'stat-warn' : ''}">${away}</td>
      <td style="text-align:center">${wd}</td>
      <td style="text-align:center">${sat}</td>
      ${weeks.map(w => {
        const n = perWeek[w] || 0;
        return `<td style="text-align:center" class="${n > 2 ? 'stat-warn' : n === 0 ? 'stat-zero' : ''}">${n || '·'}</td>`;
      }).join('')}
    </tr>`;
  }).join('');
  document.getElementById('stats-wrapper').innerHTML = `
    <div class="stats-scroll"><table class="stats-table"><thead>${header}</thead><tbody>${rows}</tbody></table></div>
    <p style="font-size:11px;color:#94a3b8;margin-top:8px">Orange = home/away imbalance &gt;1</p>`;
}

// ── CALENDAR VIEW ─────────────────────────────────────────────────────────────
function populateCalTeamSelect() {
  const teams = getDivTeams(activeDivision);
  const sel = document.getElementById('cal-team-select');
  const prev = sel.value;
  sel.innerHTML = '';
  teams.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = teamLabel(t);
    sel.appendChild(opt);
  });
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
  if (!divTeams.length) { wrapper.innerHTML = '<p class="empty-state">No teams found.</p>'; return; }
  const rawVal = document.getElementById('cal-team-select').value;
  const teamId = isNaN(parseInt(rawVal,10)) ? rawVal : parseInt(rawVal,10);
  const team = divTeams.find(t => t.id === teamId) || divTeams[0];
  if (!team) { wrapper.innerHTML = '<p class="empty-state">Select a team.</p>'; return; }
  const myGames = divGames.filter(g => g.home_team_id === team.id || g.away_team_id === team.id);
  const byDate = {};
  myGames.forEach(g => { (byDate[g.date] = byDate[g.date] || []).push(g); });
  const blackouts = new Set(team.blackout_dates || []);
  const globalBo = seasonData?.season?.blackout_dates || [];
  for (const w of (seasonData?.season?.blackout_weekends || [])) {
    (w.dates || []).forEach(d => blackouts.add(d));
    if (w.saturday) blackouts.add(w.saturday);
  }
  globalBo.forEach(d => blackouts.add(d));
  const months = [
    { year: 2026, month: 4, label: 'April 2026' },
    { year: 2026, month: 5, label: 'May 2026' },
    { year: 2026, month: 6, label: 'June 2026' },
  ];
  const legend = `<div class="cal-legend">
    <span class="cal-legend-item"><span class="cal-legend-swatch cal-swatch-game"></span> Game</span>
    <span class="cal-legend-item"><span class="cal-legend-swatch cal-swatch-rematch"></span> Rematch</span>
    <span class="cal-legend-item"><span class="cal-legend-swatch cal-swatch-blackout"></span> Blackout</span>
  </div>`;
  wrapper.innerHTML = legend + months.map(m => renderCalMonth(m.year, m.month, m.label, byDate, team.id, blackouts)).join('');
}

function renderCalMonth(year, month, label, byDate, teamId, blackouts) {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const DAY_HEADS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<td class="cal-empty"></td>');
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = year + '-' + String(month).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    const games = byDate[dateStr] || [];
    const isBlackout = blackouts.has(dateStr);
    const gameHtml = games.map(g => {
      const isHome = g.home_team_id === teamId;
      const opp = esc(isHome ? g.away_team_name : g.home_team_name);
      const ha = isHome ? '<span class="cal-ha-label home">H</span>' : '<span class="cal-ha-label away">A</span>';
      return `<div class="cal-game${g.is_rematch ? ' cal-rematch' : ''}">${ha}<span class="cal-opp">${opp}</span><span class="cal-meta">${formatTime12h(g.time)}</span></div>`;
    }).join('');
    let cls = 'cal-day';
    if (games.length) cls += ' has-game';
    if (isBlackout && !games.length) cls += ' is-blackout';
    cells.push(`<td class="${cls}"><span class="cal-day-num">${d}</span>${gameHtml}</td>`);
  }
  const remaining = (7 - (cells.length % 7)) % 7;
  for (let i = 0; i < remaining; i++) cells.push('<td class="cal-empty"></td>');
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push('<tr>' + cells.slice(i, i+7).join('') + '</tr>');
  return `<div class="cal-month"><div class="cal-month-label">${label}</div>
    <table class="cal-table">
      <thead><tr>${DAY_HEADS.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>`;
}

// ── FIELDS VIEW ───────────────────────────────────────────────────────────────
function populateFieldSelect() {
  const allGames = scheduleData?.games || [];
  // Collect unique field names preserving first-seen order by name sort
  const fieldMap = new Map(); // field_name → { field_id, field_name, field_address }
  for (const g of allGames) {
    if (!fieldMap.has(g.field_name)) {
      fieldMap.set(g.field_name, { field_id: g.field_id, field_name: g.field_name, field_address: g.field_address });
    }
  }
  const sorted = [...fieldMap.values()].sort((a, b) => a.field_name.localeCompare(b.field_name));

  const sel = document.getElementById('field-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">All fields</option>';
  sorted.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.field_name;
    opt.textContent = f.field_name;
    sel.appendChild(opt);
  });
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

document.getElementById('field-select').addEventListener('change', () => {
  if (activeView === 'fields') renderFieldsView();
});

function renderFieldsView() {
  const wrapper = document.getElementById('fields-wrapper');
  const allGames = [...(scheduleData?.games || [])].sort((a, b) =>
    a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
  );
  const filterField = document.getElementById('field-select').value;
  const games = filterField ? allGames.filter(g => g.field_name === filterField) : allGames;

  if (!games.length) { wrapper.innerHTML = '<p class="empty-state">No games found.</p>'; return; }

  // Utilization summary
  const uniqueDates = new Set(games.map(g => g.date));
  const uniqueFields = new Set(games.map(g => g.field_name));
  const utilHtml = `<p class="field-utilization">
    <strong>${games.length}</strong> games across
    <strong>${uniqueDates.size}</strong> dates at
    <strong>${uniqueFields.size}</strong> field${uniqueFields.size !== 1 ? 's' : ''}
  </p>`;

  // Group by date
  const byDate = new Map();
  for (const g of games) {
    if (!byDate.has(g.date)) byDate.set(g.date, []);
    byDate.get(g.date).push(g);
  }

  // Div name lookup
  const divNames = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));

  const showFieldCol = !filterField; // only show field column in "all fields" view

  const groups = [...byDate.entries()].map(([date, dateGames]) => {
    const isSat = dateGames[0].day === 'Saturday';
    const dayClass = isSat ? 'fday-sat' : 'fday-wd';
    const rows = dateGames.map(g => `
      <tr>
        <td>${formatTime12h(g.time)}</td>
        ${showFieldCol ? `<td>${esc(g.field_name)}<div style="font-size:10px;color:#94a3b8">${esc(g.field_address)}</div></td>` : ''}
        <td><span class="field-div-badge">${esc(divNames[g.division_id] || g.division_id)}</span></td>
        <td class="g-home">${esc(g.home_team_name)}</td>
        <td style="color:#94a3b8;font-size:11px">vs</td>
        <td class="g-away">${esc(g.away_team_name)}</td>
      </tr>`).join('');
    return `<div class="field-date-group">
      <div class="field-date-header">
        <span><span class="${dayClass}">${dateGames[0].day}</span> ${formatDate(date)} — Week ${dateGames[0].week}</span>
        <span class="field-date-count">${dateGames.length} game${dateGames.length !== 1 ? 's' : ''}</span>
      </div>
      <table class="field-games-table">
        <thead><tr>
          <th>Time</th>
          ${showFieldCol ? '<th>Field</th>' : ''}
          <th>Division</th><th>Home</th><th></th><th>Away</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  wrapper.innerHTML = utilHtml + groups;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(d) {
  const [y, m, day] = d.split('-');
  return parseInt(m) + '/' + parseInt(day) + '/' + y;
}
function formatTime12h(t) {
  if (!t) return t;
  const [h, m] = t.split(':').map(Number);
  return (h % 12 || 12) + ':' + String(m).padStart(2,'0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

init();
