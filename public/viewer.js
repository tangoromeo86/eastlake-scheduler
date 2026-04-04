'use strict';

let scheduleData = null;
let seasonData   = null;
let session      = null;
let activeDivision = null;
let activeView   = 'games';
let seasonSlots  = null;
let gamesById    = {};   // game_id → game object, for change request lookup

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  // Check auth state first
  try { session = await fetchJSON('api/auth/me'); } catch {}

  // Use authenticated endpoints when logged in (includes contact info)
  try {
    const [sched, seas] = await Promise.all([
      fetchJSON(session ? 'api/schedule' : 'api/public/schedule'),
      fetchJSON(session ? 'api/season'   : 'api/public/season'),
    ]);
    seasonData   = seas;
    scheduleData = sched;
  } catch (e) {
    document.getElementById('loading-state').textContent = 'Could not load schedule: ' + e.message;
    return;
  }

  // Index games by ID for quick lookup
  (scheduleData.games || []).forEach(g => { gamesById[g.game_id] = g; });

  updateHeader();
  renderSeasonBar(seasonData);

  if ((scheduleData.games || []).length) {
    buildDivTabs(scheduleData.games);
    populateFieldSelect();
    document.getElementById('div-tabs-outer').classList.remove('hidden');
    document.getElementById('vbar').classList.remove('hidden');
  } else {
    const ls = document.getElementById('loading-state');
    ls.textContent = 'No schedule has been generated yet. Check back later.';
    ls.classList.remove('hidden');
    return;
  }
  document.getElementById('loading-state').classList.add('hidden');
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (res.status === 401 || res.status === 403) {
    session = null;
    return fetchJSON(url.replace(/^api\//, 'api/public/'));
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ── Header ────────────────────────────────────────────────────────────────────
function updateHeader() {
  const el = document.getElementById('header-right');
  if (!el) return;
  if (session) {
    el.innerHTML =
      `<span class="header-name">${esc(session.name)}</span>` +
      (session.role === 'admin' ? '<a href="admin" class="header-link">Admin ›</a>' : '') +
      `<a href="logout" class="header-link">Sign out</a>`;
  } else {
    el.innerHTML = `<a href="login" class="header-link">Sign in</a>`;
  }
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
  if (session) parts.push('Signed in as ' + session.name);
  const bar = document.getElementById('season-bar');
  bar.innerHTML = parts.map(p => `<span>${esc(p)}</span>`).join('<span style="color:#334155">·</span>');
  bar.classList.remove('hidden');
}

// ── Division tabs ─────────────────────────────────────────────────────────────
function buildDivTabs(games) {
  const order = (seasonData?.divisions || []).map(d => d.id);
  const names = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));
  const present = order.filter(id => games.some(g => g.division_id === id));
  const extra   = [...new Set(games.map(g => g.division_id))].filter(id => !order.includes(id));
  const divs    = [...present, ...extra];

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
  document.querySelectorAll('.div-tab').forEach(b => b.classList.toggle('active', b.dataset.divId === divId));
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
  const tf  = document.getElementById('team-filter');
  const gc  = document.getElementById('game-count-badge');
  const teb = document.getElementById('team-export-btn');
  const cs  = document.getElementById('cal-team-select');
  const fs  = document.getElementById('field-select');
  const feb = document.getElementById('field-export-btn');
  if (activeView === 'games') {
    tf.classList.remove('hidden');  gc.classList.remove('hidden');
    cs.classList.add('hidden');     fs.classList.add('hidden');     feb.classList.add('hidden');
    // team export only visible when a specific team is selected
    teb.classList.toggle('hidden', !tf.value);
  } else if (activeView === 'calendar') {
    tf.classList.add('hidden');     gc.classList.add('hidden');     teb.classList.add('hidden');
    cs.classList.remove('hidden');  fs.classList.add('hidden');     feb.classList.add('hidden');
  } else if (activeView === 'fields') {
    tf.classList.add('hidden');     gc.classList.add('hidden');     teb.classList.add('hidden');
    cs.classList.add('hidden');     fs.classList.remove('hidden');  feb.classList.remove('hidden');
  } else {
    tf.classList.add('hidden');     gc.classList.add('hidden');     teb.classList.add('hidden');
    cs.classList.add('hidden');     fs.classList.add('hidden');     feb.classList.add('hidden');
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
  divGames.forEach(g => { teams.set(g.home_team_id, g.home_team_name); teams.set(g.away_team_id, g.away_team_name); });
  const sorted = [...teams.entries()].sort((a, b) => (a[1]||'').localeCompare(b[1]||''));
  const sel = document.getElementById('team-filter');
  sel.innerHTML = '<option value="">All teams</option>';
  sorted.forEach(([id, name]) => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = name;
    sel.appendChild(opt);
  });
  syncFilterVisibility();
}

document.getElementById('team-filter').addEventListener('change', () => {
  if (!scheduleData || activeView !== 'games') return;
  renderGames((scheduleData.games || []).filter(g => g.division_id === activeDivision));
  syncFilterVisibility();
});

document.getElementById('team-export-btn').addEventListener('click', () => {
  const sel = document.getElementById('team-filter');
  const rawVal = sel.value;
  if (!rawVal) return;
  const teamId = isNaN(parseInt(rawVal, 10)) ? rawVal : parseInt(rawVal, 10);
  const teamName = sel.options[sel.selectedIndex]?.text || 'team';
  exportTeamCSV(teamId, teamName);
});

document.getElementById('field-export-btn').addEventListener('click', () => {
  const sel = document.getElementById('field-select');
  const fieldName = sel.value || 'all-fields';
  exportFieldCSV(fieldName);
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

  const reqTh = session ? '<th></th>' : '';
  // Patch table header to include request column if not already
  const thead = document.querySelector('#view-games .games-table-wrap thead tr');
  if (thead) {
    const hasReqTh = thead.querySelector('.req-th');
    if (session && !hasReqTh) {
      const th = document.createElement('th');
      th.className = 'req-th';
      thead.appendChild(th);
    } else if (!session && hasReqTh) {
      hasReqTh.remove();
    }
  }

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
      ${session ? `<td><button class="req-btn" data-gid="${g.game_id}">Request Change</button></td>` : ''}
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
      ${session ? `<div class="game-card-req"><button class="req-btn" data-gid="${g.game_id}">Request Change</button></div>` : ''}
    </div>
  `).join('');

  // Attach request change button listeners
  if (session) {
    document.querySelectorAll('.req-btn[data-gid]').forEach(btn => {
      btn.addEventListener('click', () => openChangeRequest(parseInt(btn.dataset.gid, 10)));
    });
  }
}

// ── TEAMS VIEW ────────────────────────────────────────────────────────────────
function renderTeamsView(divGames, divTeams) {
  const sorted = [...divGames].sort((a, b) => a.date.localeCompare(b.date));
  const cards = divTeams.map(team => {
    const myGames = sorted.filter(g => g.home_team_id === team.id || g.away_team_id === team.id);
    const homeCount = myGames.filter(g => g.home_team_id === team.id).length;
    const awayCount = myGames.filter(g => g.away_team_id === team.id).length;

    const gameRows = myGames.map(g => {
      const isHome = g.home_team_id === team.id;
      const opp    = esc(isHome ? g.away_team_name : g.home_team_name);
      const ha     = isHome ? '<span class="ha-home">H</span>' : '<span class="ha-away">A</span>';
      const dt     = `${g.day.slice(0,3)} ${formatDate(g.date)} · ${formatTime12h(g.time)}`;
      return `<div class="tgame">
        <div class="tgame-main">${ha}<span class="tgame-opp">${opp}</span><span class="tgame-dt">${dt}</span></div>
        <div class="tgame-field">📍 ${esc(g.field_name)}</div>
      </div>`;
    }).join('');

    // Contact info — only shown when authenticated
    let contactHtml = '';
    if (session && (team.coach || team.email || team.phone)) {
      const parts = [];
      if (team.coach) parts.push(`<span style="font-weight:600">${esc(team.coach)}</span>`);
      if (team.email) parts.push(`<a href="mailto:${esc(team.email)}" style="color:#2d6cf0">${esc(team.email)}</a>`);
      if (team.phone) parts.push(`<a href="tel:${esc(team.phone)}" style="color:#64748b">${esc(team.phone)}</a>`);
      contactHtml = `<div style="padding:8px 14px;font-size:12px;background:#f0f9ff;border-bottom:1px solid #e2e8f0;display:flex;flex-wrap:wrap;gap:10px;align-items:center">${parts.join('<span style="color:#cbd5e1;margin:0 2px">·</span>')}</div>`;
    }

    return `<div class="tcard">
      <div class="tcard-header">
        <span class="tcard-name">${esc(teamLabel(team))}</span>
        <span class="tcard-meta">${myGames.length} games · ${homeCount}H ${awayCount}A</span>
      </div>
      ${contactHtml}
      ${gameRows || '<div class="tgame" style="color:#94a3b8;font-size:12px">No games scheduled</div>'}
    </div>`;
  }).join('');
  document.getElementById('teams-grid').innerHTML = cards || '<p class="empty-state">No team data available.</p>';
}

// ── MATRIX VIEW ───────────────────────────────────────────────────────────────
function renderMatrixView(divGames, divTeams) {
  if (!divTeams.length) { document.getElementById('matrix-wrapper').innerHTML = '<p class="empty-state">No teams found.</p>'; return; }
  const pairKey = (a, b) => Math.min(a,b) + '_' + Math.max(a,b);
  const counts = {}; const homeAway = {};
  divGames.forEach(g => {
    const k = pairKey(g.home_team_id, g.away_team_id);
    counts[k] = (counts[k] || 0) + 1;
    const hk = g.home_team_id + '_' + g.away_team_id;
    homeAway[hk] = (homeAway[hk] || 0) + 1;
  });
  const maxCount = Math.max(1, ...Object.values(counts));
  const header = '<tr><th class="matrix-corner"></th>' +
    divTeams.map(t => `<th class="matrix-col-head" title="${esc(teamLabel(t))}">${esc(teamLabel(t))}</th>`).join('') + '</tr>';
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
        <span class="matrix-count">${total}</span><span class="matrix-ha">${asHome}H${asAway}A</span></td>`;
    }).join('');
    return '<tr><th class="matrix-row-head" title="' + esc(teamLabel(row)) + '">' + esc(teamLabel(row)) + '</th>' + cells + '</tr>';
  }).join('');
  document.getElementById('matrix-wrapper').innerHTML = `
    <p class="matrix-meta">${divGames.length} total games · ${Object.keys(counts).length} unique matchups</p>
    <div class="matrix-scroll"><table class="matrix-table"><thead>${header}</thead><tbody>${rows}</tbody></table></div>`;
}

// ── STATS VIEW ────────────────────────────────────────────────────────────────
function renderStatsView(divGames, divTeams) {
  if (!divTeams.length) { document.getElementById('stats-wrapper').innerHTML = '<p class="empty-state">No teams found.</p>'; return; }
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
    opt.value = t.id; opt.textContent = teamLabel(t);
    sel.appendChild(opt);
  });
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

document.getElementById('cal-team-select').addEventListener('change', () => {
  if (activeView === 'calendar' && scheduleData && activeDivision) {
    renderCalendarView((scheduleData.games || []).filter(g => g.division_id === activeDivision), getDivTeams(activeDivision));
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
  const fieldMap = new Map();
  for (const g of allGames) {
    if (!fieldMap.has(g.field_name)) fieldMap.set(g.field_name, { field_id: g.field_id, field_name: g.field_name, field_address: g.field_address });
  }
  const sorted = [...fieldMap.values()].sort((a, b) => a.field_name.localeCompare(b.field_name));
  const sel = document.getElementById('field-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">All fields</option>';
  sorted.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.field_name; opt.textContent = f.field_name;
    sel.appendChild(opt);
  });
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

document.getElementById('field-select').addEventListener('change', () => { if (activeView === 'fields') renderFieldsView(); });

function renderFieldsView() {
  const wrapper = document.getElementById('fields-wrapper');
  const allGames = [...(scheduleData?.games || [])].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  const filterField = document.getElementById('field-select').value;
  const games = filterField ? allGames.filter(g => g.field_name === filterField) : allGames;
  if (!games.length) { wrapper.innerHTML = '<p class="empty-state">No games found.</p>'; return; }

  const uniqueDates  = new Set(games.map(g => g.date));
  const uniqueFields = new Set(games.map(g => g.field_name));
  const utilHtml = `<p class="field-utilization"><strong>${games.length}</strong> games across <strong>${uniqueDates.size}</strong> dates at <strong>${uniqueFields.size}</strong> field${uniqueFields.size !== 1 ? 's' : ''}</p>`;

  const byDate = new Map();
  for (const g of games) { if (!byDate.has(g.date)) byDate.set(g.date, []); byDate.get(g.date).push(g); }

  const divNames = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));
  const showFieldCol = !filterField;

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
        <thead><tr><th>Time</th>${showFieldCol ? '<th>Field</th>' : ''}<th>Division</th><th>Home</th><th></th><th>Away</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  wrapper.innerHTML = utilHtml + groups;
}

// ── CHANGE REQUEST MODAL ──────────────────────────────────────────────────────
const ISSUE_OPTS = [
  { value: 'date',  icon: '📅', label: "We can't play on this date" },
  { value: 'time',  icon: '🕐', label: 'We need a different time' },
  { value: 'field', icon: '📍', label: 'There\'s a field or location problem' },
  { value: 'other', icon: '💬', label: 'Something else' },
];

let crState = null;  // change request state

function openChangeRequest(gameId) {
  const game = gamesById[gameId];
  if (!game || !session) return;

  crState = {
    game,
    step: 1,
    issue: null,
    details: {},
    notes: '',
    name:  session.name  || '',
    email: session.email || '',
    phone: session.phone || '',
  };

  document.getElementById('change-request-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderModalStep();
}

function closeModal() {
  document.getElementById('change-request-modal').classList.add('hidden');
  document.body.style.overflow = '';
  crState = null;
}

document.getElementById('modal-close-btn').addEventListener('click', closeModal);
document.getElementById('change-request-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

function setModalStep(n) {
  crState.step = n;
  document.getElementById('modal-step-label').textContent = `Step ${n} of 6`;
  renderModalStep();
}

function renderModalStep() {
  const body = document.getElementById('modal-body');
  switch (crState.step) {
    case 1: body.innerHTML = renderStep1(); break;
    case 2: body.innerHTML = renderStep2(); wireStep2(); break;
    case 3: body.innerHTML = renderStep3(); break;
    case 4: body.innerHTML = renderStep4(); break;
    case 5: body.innerHTML = renderStep5(); break;
    case 6: body.innerHTML = renderStep6(); break;
  }
  // Scroll modal to top on step change
  const card = document.querySelector('.modal-card');
  if (card) card.scrollTop = 0;
}

function gameSummaryHtml(game) {
  const divName = (seasonData?.divisions || []).find(d => d.id === game.division_id)?.name || game.division_id;
  return `<div class="modal-game-summary">
    <div class="matchup">${esc(game.home_team_name)} vs ${esc(game.away_team_name)}</div>
    <div class="meta">${divName} · Week ${game.week} · ${game.day} ${formatDate(game.date)} · ${formatTime12h(game.time)}</div>
    <div class="meta" style="margin-top:2px">📍 ${esc(game.field_name)}</div>
  </div>`;
}

// Step 1 — Game context
function renderStep1() {
  return gameSummaryHtml(crState.game) + `
    <p style="font-size:13px;color:#64748b;margin-bottom:20px">We'll guide you through describing your request, then open your email app with a pre-written message ready to send.</p>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-primary" onclick="setModalStep(2)">Continue →</button>
    </div>`;
}

// Step 2 — Issue type
function renderStep2() {
  return `<p class="modal-q">What's the problem with this game?</p>
    <div class="modal-opts" id="issue-opts">
      ${ISSUE_OPTS.map(o => `
        <label class="modal-opt${crState.issue === o.value ? ' selected' : ''}">
          <input type="radio" name="issue" value="${o.value}" ${crState.issue === o.value ? 'checked' : ''}>
          <span class="modal-opt-icon">${o.icon}</span>
          <span>${o.label}</span>
        </label>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="setModalStep(1)">← Back</button>
      <button class="modal-btn modal-btn-primary" id="step2-next">Continue →</button>
    </div>`;
}

function wireStep2() {
  document.querySelectorAll('#issue-opts .modal-opt').forEach(label => {
    label.addEventListener('click', () => {
      crState.issue = label.querySelector('input').value;
      document.querySelectorAll('#issue-opts .modal-opt').forEach(l => l.classList.remove('selected'));
      label.classList.add('selected');
    });
  });
  document.getElementById('step2-next').addEventListener('click', () => {
    if (!crState.issue) { alert('Please select an option.'); return; }
    setModalStep(3);
  });
}

// Step 3 — Specific details (varies by issue)
function renderStep3() {
  let fields = '';
  if (crState.issue === 'date') {
    fields = `
      <div class="modal-field">
        <label>What dates and times work for your team this season?</label>
        <textarea id="f-available" placeholder="e.g. Most weekday evenings work. Saturdays before May 15 are best.">${esc(crState.details.available || '')}</textarea>
        <div class="hint">Be as specific as you can — weeks, days, time ranges.</div>
      </div>
      <div class="modal-field">
        <label>Any dates you definitely cannot play?</label>
        <textarea id="f-avoid" placeholder="e.g. April 22, May 6, any Friday">${esc(crState.details.avoid || '')}</textarea>
      </div>`;
  } else if (crState.issue === 'time') {
    fields = `
      <div class="modal-field">
        <label>What time would work better?</label>
        <input type="text" id="f-preferred-time" placeholder="e.g. 6:00 PM, any time after 5:30 PM" value="${esc(crState.details.preferred_time || '')}">
      </div>
      <div class="modal-field">
        <label>Could the date also change if needed?</label>
        <div class="modal-yesno">
          <label><input type="radio" name="date-flex" value="yes" ${crState.details.date_flexible === 'yes' ? 'checked' : ''}> Yes, date is flexible</label>
          <label><input type="radio" name="date-flex" value="no"  ${crState.details.date_flexible === 'no'  ? 'checked' : ''}> No, only the time</label>
        </div>
      </div>`;
  } else if (crState.issue === 'field') {
    fields = `
      <div class="modal-field">
        <label>What's the issue with the field or location?</label>
        <textarea id="f-field-issue" placeholder="e.g. Field is unavailable, turf is under repair, parking issues…">${esc(crState.details.field_issue || '')}</textarea>
      </div>
      <div class="modal-field">
        <label>Can you suggest an alternative field? (optional)</label>
        <input type="text" id="f-alt-field" placeholder="e.g. Riverside Park Field 2" value="${esc(crState.details.alt_field || '')}">
      </div>`;
  } else {
    fields = `
      <div class="modal-field">
        <label>Please describe the issue</label>
        <textarea id="f-other" placeholder="Describe what needs to change and why…">${esc(crState.details.description || '')}</textarea>
      </div>`;
  }

  const issueLabel = ISSUE_OPTS.find(o => o.value === crState.issue)?.label || crState.issue;
  return `
    ${gameSummaryHtml(crState.game)}
    <p class="modal-q">Tell us more about: <em style="font-weight:400;color:#64748b">${esc(issueLabel)}</em></p>
    ${fields}
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="setModalStep(2)">← Back</button>
      <button class="modal-btn modal-btn-primary" onclick="saveStep3AndContinue()">Continue →</button>
    </div>`;
}

function saveStep3AndContinue() {
  if (crState.issue === 'date') {
    crState.details.available = document.getElementById('f-available')?.value.trim() || '';
    crState.details.avoid     = document.getElementById('f-avoid')?.value.trim() || '';
  } else if (crState.issue === 'time') {
    crState.details.preferred_time = document.getElementById('f-preferred-time')?.value.trim() || '';
    crState.details.date_flexible  = document.querySelector('input[name="date-flex"]:checked')?.value || '';
  } else if (crState.issue === 'field') {
    crState.details.field_issue = document.getElementById('f-field-issue')?.value.trim() || '';
    crState.details.alt_field   = document.getElementById('f-alt-field')?.value.trim() || '';
  } else {
    crState.details.description = document.getElementById('f-other')?.value.trim() || '';
  }
  setModalStep(4);
}

// Step 4 — Additional notes
function renderStep4() {
  return `
    <p class="modal-q">Anything else the admin should know? <span style="font-weight:400;color:#94a3b8">(optional)</span></p>
    <div class="modal-field">
      <textarea id="f-notes" placeholder="Any additional context, urgency, or constraints…">${esc(crState.notes)}</textarea>
    </div>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="setModalStep(3)">← Back</button>
      <button class="modal-btn modal-btn-primary" onclick="saveStep4AndContinue()">Continue →</button>
    </div>`;
}

function saveStep4AndContinue() {
  crState.notes = document.getElementById('f-notes')?.value.trim() || '';
  setModalStep(5);
}

// Step 5 — Contact info confirmation
function renderStep5() {
  return `
    <p class="modal-q">Confirm your contact info</p>
    <p style="font-size:13px;color:#64748b;margin-bottom:16px">This will be included in the email so the admin can follow up with you.</p>
    <div class="modal-field">
      <label>Your name</label>
      <input type="text" id="f-name" value="${esc(crState.name)}" placeholder="Your name">
    </div>
    <div class="modal-field">
      <label>Email</label>
      <input type="text" id="f-email" value="${esc(crState.email)}" readonly style="background:#f8fafc;color:#64748b">
    </div>
    <div class="modal-field">
      <label>Phone <span style="font-weight:400;color:#94a3b8">(optional)</span></label>
      <input type="text" id="f-phone" value="${esc(crState.phone)}" placeholder="Best number to reach you">
    </div>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="setModalStep(4)">← Back</button>
      <button class="modal-btn modal-btn-primary" onclick="saveStep5AndContinue()">Preview Email →</button>
    </div>`;
}

function saveStep5AndContinue() {
  crState.name  = document.getElementById('f-name')?.value.trim()  || crState.name;
  crState.phone = document.getElementById('f-phone')?.value.trim() || '';
  setModalStep(6);
}

// Step 6 — Review & send
function renderStep6() {
  const mailto = buildMailtoLink();
  const preview = buildEmailBody();
  return `
    <p class="modal-q">Review your request</p>
    <p style="font-size:13px;color:#64748b;margin-bottom:12px">Tap "Open Email App" to send this — your email app will open with the message ready to go.</p>
    <div class="modal-email-preview">${esc(preview)}</div>
    <a href="${esc(mailto)}" class="modal-send-btn">📧 Open Email App</a>
    <div class="modal-actions" style="margin-top:0">
      <button class="modal-btn modal-btn-secondary" onclick="setModalStep(5)">← Edit</button>
      <button class="modal-btn modal-btn-secondary" onclick="closeModal()">Done</button>
    </div>`;
}

function buildEmailBody() {
  const g = crState.game;
  const divName = (seasonData?.divisions || []).find(d => d.id === g.division_id)?.name || g.division_id;
  const issueLabel = ISSUE_OPTS.find(o => o.value === crState.issue)?.label || crState.issue;

  let detailLines = [];
  if (crState.issue === 'date') {
    if (crState.details.available) detailLines.push('Available dates/times: ' + crState.details.available);
    if (crState.details.avoid)     detailLines.push('Dates to avoid: ' + crState.details.avoid);
  } else if (crState.issue === 'time') {
    if (crState.details.preferred_time) detailLines.push('Preferred time: ' + crState.details.preferred_time);
    if (crState.details.date_flexible)  detailLines.push('Date flexible: ' + (crState.details.date_flexible === 'yes' ? 'Yes' : 'No, time only'));
  } else if (crState.issue === 'field') {
    if (crState.details.field_issue) detailLines.push('Field issue: ' + crState.details.field_issue);
    if (crState.details.alt_field)   detailLines.push('Alternative field: ' + crState.details.alt_field);
  } else {
    if (crState.details.description) detailLines.push(crState.details.description);
  }

  const lines = [
    'GAME DETAILS',
    `Game #${g.game_id} — ${divName}, Week ${g.week}`,
    `${g.day} ${formatDate(g.date)} at ${formatTime12h(g.time)}`,
    `${g.home_team_name} (Home) vs ${g.away_team_name} (Away)`,
    `Field: ${g.field_name}`,
    '',
    'CHANGE REQUEST',
    `Issue: ${issueLabel}`,
    ...detailLines,
    ...(crState.notes ? ['', 'Additional notes: ' + crState.notes] : []),
    '',
    'SUBMITTED BY',
    crState.name,
    crState.email,
    ...(crState.phone ? [crState.phone] : []),
  ];

  return lines.join('\n');
}

function buildMailtoLink() {
  const g = crState.game;
  const divName = (seasonData?.divisions || []).find(d => d.id === g.division_id)?.name || g.division_id;
  const to = session?.request_to || '';
  const subject = `Game Change Request — ${divName} W${g.week}: ${g.home_team_name} vs ${g.away_team_name} (${formatDate(g.date)})`;
  const body = buildEmailBody();
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ── CSV Exports ───────────────────────────────────────────────────────────────
function downloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportTeamCSV(teamId, teamName) {
  const allGames = scheduleData?.games || [];
  const myGames = allGames
    .filter(g => g.home_team_id === teamId || g.away_team_id === teamId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  const divNames = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));

  const rows = [['Week', 'Date', 'Day', 'Time', 'Home/Away', 'Opponent', 'Field', 'Address', 'Division']];
  for (const g of myGames) {
    const isHome = g.home_team_id === teamId;
    rows.push([
      'W' + g.week,
      formatDate(g.date),
      g.day,
      formatTime12h(g.time),
      isHome ? 'Home' : 'Away',
      isHome ? g.away_team_name : g.home_team_name,
      g.field_name,
      g.field_address || '',
      divNames[g.division_id] || g.division_id,
    ]);
  }
  const safeName = teamName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  downloadCSV(`${safeName}-schedule.csv`, rows);
}

function exportFieldCSV(fieldName) {
  const allGames = [...(scheduleData?.games || [])]
    .filter(g => !fieldName || fieldName === 'all-fields' || g.field_name === fieldName)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  const divNames = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));

  const rows = [['Date', 'Day', 'Time', 'Division', 'Home Team', 'Away Team', 'Field', 'Address']];
  for (const g of allGames) {
    rows.push([
      formatDate(g.date),
      g.day,
      formatTime12h(g.time),
      divNames[g.division_id] || g.division_id,
      g.home_team_name,
      g.away_team_name,
      g.field_name,
      g.field_address || '',
    ]);
  }
  const safeField = (fieldName === 'all-fields' ? 'all-fields' : fieldName).replace(/[^a-z0-9]/gi, '-').toLowerCase();
  downloadCSV(`field-schedule-${safeField}.csv`, rows);
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
