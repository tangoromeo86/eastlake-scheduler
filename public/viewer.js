'use strict';

let scheduleData = null;
let seasonData   = null;
let session      = null;
let activeDivision = null;
let activeView   = 'games';
let activeTopView = null;  // 'fields' | 'program' | null (null = division mode)
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
  initVerifyBanner(session, 'Verify your email to make schedule changes.', location.pathname);
  renderSeasonBar(seasonData);

  if ((scheduleData.games || []).length) {
    buildDivTabs(scheduleData.games);
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
      `<button class="help-trigger" id="help-btn" title="Help">?</button>` +
      `<span class="header-name">${esc(session.name)}</span>` +
      (session.role === 'admin' ? '<a href="admin" class="header-link">Admin ›</a>' : '') +
      (session.role === 'director' ? '<a href="director" class="header-link">Manage My Program ›</a>' : '') +
      (session.role === 'coach' ? '<a href="my-team" class="header-link">Edit My Team ›</a>' : '') +
      `<a href="guide.html" class="header-link">Guide</a>` +
      `<a href="logout" class="header-link">Sign out</a>`;
    document.getElementById('help-btn').addEventListener('click', openHelp);

    // Auto-show help on first login
    const key = 'el_help_seen_v1';
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, '1');
      setTimeout(openHelp, 400);
    }
  } else {
    el.innerHTML = `<a href="guide.html" class="header-link">Guide</a>`
                 + `<a href="login" class="header-link">Sign in</a>`;
  }
  // Matrix and Stats are admin-only views
  const isAdmin = session && session.role === 'admin';
  ['matrix','stats'].forEach(v => {
    const btn = document.querySelector(`.vbar-btn[data-view="${v}"]`);
    if (btn) btn.classList.toggle('hidden', !isAdmin);
  });
}

function openHelp() {
  document.getElementById('help-modal').classList.remove('hidden');
}

document.getElementById('help-close').addEventListener('click', () => {
  document.getElementById('help-modal').classList.add('hidden');
});

document.getElementById('help-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

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
  const sep = nav.querySelector('.div-tabs-sep');
  // remove old div tabs only, keep sep + top-view-btns
  nav.querySelectorAll('.div-tab').forEach(el => el.remove());
  divs.forEach(divId => {
    const btn = document.createElement('button');
    btn.className = 'div-tab';
    btn.textContent = names[divId] || divId;
    btn.dataset.divId = divId;
    btn.addEventListener('click', () => selectDivision(divId));
    nav.insertBefore(btn, sep);
  });
  if (divs.length) selectDivision(divs[0]);
}

function selectDivision(divId) {
  activeDivision = divId;
  activeTopView = null;
  document.querySelectorAll('.div-tab').forEach(b => b.classList.toggle('active', b.dataset.divId === divId));
  document.querySelectorAll('.top-view-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('vbar').classList.remove('hidden');
  document.getElementById('cross-div-bar').classList.add('hidden');
  populateTeamFilter();
  populateCalTeamSelect();
  renderCurrentView();
}

// ── Top-level view buttons (Fields / Program) ────────────────────────────────────
document.querySelectorAll('.top-view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.topview;
    if (activeTopView === mode) {
      // toggle off — back to division mode
      activeTopView = null;
      document.querySelectorAll('.top-view-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('vbar').classList.remove('hidden');
      document.getElementById('cross-div-bar').classList.add('hidden');
      renderCurrentView();
    } else {
      activeTopView = mode;
      document.querySelectorAll('.top-view-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('vbar').classList.add('hidden');
      syncCrossDivBar();
      renderCurrentView();
    }
  });
});

function syncCrossDivBar() {
  const bar = document.getElementById('cross-div-bar');
  const fs  = document.getElementById('field-select');
  const feb = document.getElementById('field-export-btn');
  const cys = document.getElementById('program-select');
  const cyb = document.getElementById('program-export-btn');
  if (activeTopView === 'fields') {
    bar.classList.remove('hidden');
    fs.classList.remove('hidden');  feb.classList.remove('hidden');
    cys.classList.add('hidden');    cyb.classList.add('hidden');
    populateFieldSelect();
  } else if (activeTopView === 'program') {
    bar.classList.remove('hidden');
    fs.classList.add('hidden');     feb.classList.add('hidden');
    cys.classList.remove('hidden'); cyb.classList.remove('hidden');
    populateProgramSelect();
  } else {
    bar.classList.add('hidden');
  }
}

// ── Per-division view bar ─────────────────────────────────────────────────────
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
  tf.classList.add('hidden');  gc.classList.add('hidden');  teb.classList.add('hidden');
  cs.classList.add('hidden');
  if (activeView === 'games') {
    tf.classList.remove('hidden'); gc.classList.remove('hidden');
    teb.classList.toggle('hidden', !tf.value);
  } else if (activeView === 'calendar') {
    cs.classList.remove('hidden');
  }
}

function renderCurrentView() {
  const effectiveView = activeTopView || activeView;
  ['games','teams','matrix','standings','stats','calendar','fields','program'].forEach(v => {
    document.getElementById('view-' + v).classList.toggle('hidden', v !== effectiveView);
  });
  if (!scheduleData) return;
  if (activeTopView === 'fields') { renderFieldsView(); return; }
  if (activeTopView === 'program')   { renderProgramView();   return; }
  if (!activeDivision) return;
  const divGames = (scheduleData.games || []).filter(g => g.division_id === activeDivision);
  const divTeams = getDivTeams(activeDivision);
  if (activeView === 'games')     renderGames(divGames);
  if (activeView === 'teams')     renderTeamsView(divGames, divTeams);
  if (activeView === 'matrix')    renderMatrixView(divGames, divTeams);
  if (activeView === 'standings') renderStandingsView(divGames, divTeams);
  if (activeView === 'stats')     renderStatsView(divGames, divTeams);
  if (activeView === 'calendar')  renderCalendarView(divGames, divTeams);
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


document.getElementById('field-select').addEventListener('change', () => { if (activeTopView === 'fields') renderFieldsView(); });
document.getElementById('program-select').addEventListener('change', () => { if (activeTopView === 'program') renderProgramView(); });
document.getElementById('field-export-btn').addEventListener('click', () => {
  exportFieldCSV(document.getElementById('field-select').value || 'all-fields');
});
document.getElementById('program-export-btn').addEventListener('click', () => {
  exportProgramCSV(document.getElementById('program-select').value);
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

  // Patch table header to include a request-change column — only for coaches
  // and directors, who might actually see a button in some row; admin never
  // does (this button isn't an admin action), so no point in a trailing empty column.
  const wantsReqTh = session?.role === 'coach' || session?.role === 'director';
  const thead = document.querySelector('#view-games .games-table-wrap thead tr');
  if (thead) {
    const hasReqTh = thead.querySelector('.req-th');
    if (wantsReqTh && !hasReqTh) {
      const th = document.createElement('th');
      th.className = 'req-th';
      thead.appendChild(th);
    } else if (!wantsReqTh && hasReqTh) {
      hasReqTh.remove();
    }
  }

  // Table (desktop)
  document.getElementById('games-tbody').innerHTML = sorted.map(g => {
    const ctx = myRequestChangeContext(g);
    return `
    <tr class="${g.is_rematch ? 'g-rematch' : ''}">
      <td class="g-id">#${g.game_id}</td>
      <td>W${g.week}</td>
      <td>${formatDate(g.date)}</td>
      <td>${g.day.slice(0,3)}</td>
      <td>${formatTime12h(g.time)}</td>
      <td class="g-home">${esc(g.home_team_name)}</td>
      <td class="g-away">${esc(g.away_team_name)} ${gameStatusBadge(g.status || 'scheduled', g.confirmations)}</td>
      <td>${esc(g.field_name)}</td>
      <td class="g-addr">${esc(g.field_address)}${fieldMapLink(g.field_id)}</td>
      ${ctx ? `<td><button class="req-btn" data-gid="${g.game_id}" data-tid="${esc(ctx.team_id)}">Request Change</button></td>` : (wantsReqTh ? '<td></td>' : '')}
    </tr>`;
  }).join('');

  // Cards (mobile)
  document.getElementById('games-cards').innerHTML = sorted.map(g => {
    const ctx = myRequestChangeContext(g);
    return `
    <div class="game-card${g.is_rematch ? ' rematch' : ''}">
      <div class="game-card-top">
        <span>W${g.week} · ${g.day.slice(0,3)} ${formatDate(g.date)} · ${formatTime12h(g.time)}</span>
        ${g.is_rematch ? '<span class="rematch-badge">Rematch</span>' : ''}
        ${gameStatusBadge(g.status || 'scheduled', g.confirmations)}
      </div>
      <div class="game-card-matchup">
        <span class="home">${esc(g.home_team_name)}</span>
        <span class="vs">vs</span>
        <span class="away">${esc(g.away_team_name)}</span>
      </div>
      <div class="game-card-field">📍 ${esc(g.field_name)}${g.field_address ? ' — ' + esc(g.field_address) : ''}${fieldMapLink(g.field_id)}</div>
      ${ctx ? `<div class="game-card-req"><button class="req-btn" data-gid="${g.game_id}" data-tid="${esc(ctx.team_id)}">Request Change</button></div>` : ''}
    </div>`;
  }).join('');

  // Attach request change button listeners
  if (session) {
    document.querySelectorAll('.req-btn[data-gid]').forEach(btn => {
      btn.addEventListener('click', () => {
        // The change flow lives on the coach/director pages, where the server
        // computes which times actually work for both teams. Carry the game
        // (and, for a director managing several teams, which of their teams
        // is involved) through so the destination page can open that specific
        // game's form instead of landing blind at the top of the page.
        const dest = session?.role === 'director' ? 'director' : 'my-team';
        const params = new URLSearchParams({ game_id: btn.dataset.gid });
        if (btn.dataset.tid) params.set('team_id', btn.dataset.tid);
        window.location = `${dest}?${params.toString()}`;
      });
    });
  }
}

// Whether the viewer can request a change on this game, and — for a director,
// who may manage several teams — which of their teams to act as. Returns null
// (no button rendered) for admin and for any game that doesn't involve the
// viewer at all, rather than showing the same button on every game in the
// league regardless of relevance.
function myRequestChangeContext(g) {
  if (!session) return null;
  if (session.role === 'coach') {
    if (String(g.home_team_id) === String(session.team_id) || String(g.away_team_id) === String(session.team_id)) {
      return { team_id: session.team_id };
    }
    return null;
  }
  if (session.role === 'director') {
    const teams = seasonData?.teams || [];
    const homeTeam = teams.find(t => String(t.id) === String(g.home_team_id));
    const awayTeam = teams.find(t => String(t.id) === String(g.away_team_id));
    const mine = [homeTeam, awayTeam].find(t => t && String(t.program_id) === String(session.program_id));
    return mine ? { team_id: mine.id } : null;
  }
  return null; // admin — this button isn't an admin action
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
    if (session) {
      const parts = [];
      if (team.coach) parts.push(`<span style="font-weight:600">${esc(team.coach)}</span>`);
      if (team.email) parts.push(`<a href="mailto:${esc(team.email)}" style="color:#2d6cf0">${esc(team.email)}</a>`);
      if (team.phone) parts.push(`<a href="tel:${esc(team.phone)}" style="color:#64748b">${esc(team.phone)}</a>`);
      if (!team.coach || !team.email || !team.phone) {
        parts.push(`<button class="missing-info-link" data-tid="${team.id}" style="background:none;border:none;padding:0;cursor:pointer;color:#ea580c;font-size:11px;font-weight:600;text-decoration:underline">Missing info</button>`);
      }
      const sep = '<span style="color:#cbd5e1;margin:0 2px">·</span>';
      contactHtml = `<div style="padding:8px 14px;font-size:12px;background:#f0f9ff;border-bottom:1px solid #e2e8f0;display:flex;flex-wrap:wrap;gap:10px;align-items:center">${parts.join(sep)}</div>`;
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
  if (session) {
    document.querySelectorAll('.missing-info-link[data-tid]').forEach(btn => {
      btn.addEventListener('click', () => openMissingInfo(parseInt(btn.dataset.tid, 10)));
    });
  }
}

// ── MATRIX VIEW ───────────────────────────────────────────────────────────────
function renderMatrixView(divGames, divTeams) {
  if (!divTeams.length) { document.getElementById('matrix-wrapper').innerHTML = '<p class="empty-state">No teams found.</p>'; return; }
  const pairKey = (a, b) => [String(a), String(b)].sort().join('_');
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

// ── STANDINGS VIEW ────────────────────────────────────────────────────────────
// Purely derived from each game's result (see server.js's score-reporting
// endpoint) — no separate standings storage. A game with no result yet just
// doesn't count toward anyone's record. Standard 3/1/0 soccer scoring;
// cancelled/rained-out games (their makeup carries the eventual result) never
// count even if one happened to have a result left on it from before.
function computeStandings(divGames, divTeams) {
  const rows = new Map(divTeams.map(t => [t.id, { team: t, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 }]));
  divGames.forEach(g => {
    if (!g.result || g.status === 'cancelled') return;
    const home = rows.get(g.home_team_id), away = rows.get(g.away_team_id);
    if (!home || !away) return;
    const hs = g.result.home_score, as = g.result.away_score;
    home.played++; away.played++;
    home.gf += hs; home.ga += as;
    away.gf += as; away.ga += hs;
    if (hs > as) { home.w++; away.l++; }
    else if (hs < as) { away.w++; home.l++; }
    else { home.d++; away.d++; }
  });
  return [...rows.values()]
    .map(r => ({ ...r, gd: r.gf - r.ga, pts: r.w * 3 + r.d }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || teamLabel(a.team).localeCompare(teamLabel(b.team)));
}

function renderStandingsView(divGames, divTeams) {
  const wrapper = document.getElementById('standings-wrapper');
  if (!divTeams.length) { wrapper.innerHTML = '<p class="empty-state">No teams found.</p>'; return; }
  const rows = computeStandings(divGames, divTeams);
  if (!rows.some(r => r.played > 0)) {
    wrapper.innerHTML = '<p class="empty-state">No results reported yet this season.</p>';
    return;
  }
  const header = '<tr><th>Team</th><th>GP</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr>';
  const body = rows.map(r => `<tr>
    <td>${esc(teamLabel(r.team))}</td>
    <td style="text-align:center">${r.played}</td>
    <td style="text-align:center">${r.w}</td>
    <td style="text-align:center">${r.d}</td>
    <td style="text-align:center">${r.l}</td>
    <td style="text-align:center">${r.gf}</td>
    <td style="text-align:center">${r.ga}</td>
    <td style="text-align:center">${r.gd > 0 ? '+' + r.gd : r.gd}</td>
    <td style="text-align:center;font-weight:700">${r.pts}</td>
  </tr>`).join('');
  wrapper.innerHTML = `
    <div class="stats-scroll"><table class="stats-table"><thead>${header}</thead><tbody>${body}</tbody></table></div>
    <p style="font-size:11px;color:#94a3b8;margin-top:8px">3 pts win &middot; 1 pt draw &middot; ties broken by goal difference, then goals for.</p>`;
}

// ── CALENDAR VIEW ─────────────────────────────────────────────────────────────
function populateCalTeamSelect() {
  const teams = getDivTeams(activeDivision);
  const sel = document.getElementById('cal-team-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="all">All teams</option>';
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

// calendarMonthsFor is defined once, shared, in ui.js (issue #13).
function renderCalendarView(divGames, divTeams) {
  const wrapper = document.getElementById('calendar-wrapper');
  if (!divTeams.length) { wrapper.innerHTML = '<p class="empty-state">No teams found.</p>'; return; }
  const rawVal = document.getElementById('cal-team-select').value;
  const months = calendarMonthsFor(seasonData?.season, divGames);

  if (rawVal === 'all') {
    const byDate = {};
    divGames.forEach(g => { (byDate[g.date] = byDate[g.date] || []).push(g); });
    const globalBo = new Set(seasonData?.season?.blackout_dates || []);
    for (const w of (seasonData?.season?.blackout_weekends || [])) {
      (w.dates || []).forEach(d => globalBo.add(d));
      if (w.saturday) globalBo.add(w.saturday);
    }
    const legend = `<div class="cal-legend">
      <span class="cal-legend-item"><span class="cal-legend-swatch cal-swatch-game"></span> Game</span>
      <span class="cal-legend-item"><span class="cal-legend-swatch cal-swatch-rematch"></span> Rematch</span>
    </div>`;
    wrapper.innerHTML = legend + months.map(m => renderCalMonthAll(m.year, m.month, m.label, byDate, globalBo)).join('');
    return;
  }

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

function renderCalMonthAll(year, month, label, byDate, blackouts) {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const DAY_HEADS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<td class="cal-empty"></td>');
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = year + '-' + String(month).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    const games = (byDate[dateStr] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
    const isBlackout = blackouts.has(dateStr);
    const gameHtml = games.map(g =>
      `<div class="cal-game${g.is_rematch ? ' cal-rematch' : ''}">
        <span class="cal-opp">${esc(g.home_team_name)} vs ${esc(g.away_team_name)}</span>
        <span class="cal-meta">${formatTime12h(g.time)} · ${esc(g.field_name)}</span>
      </div>`
    ).join('');
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

// ── PROGRAM VIEW ─────────────────────────────────────────────────────────────────
function programName(programId) {
  // Derive display name from common prefix of all team labels for this program
  const labels = (seasonData?.teams || []).filter(t => t.program_id === programId).map(t => t.label || '');
  if (!labels.length) return programId;
  if (labels.length === 1) return labels[0].replace(/\s+\d+$/, '').replace(/\s+-\s+\w+$/, '').trim();
  let prefix = labels[0];
  for (const l of labels.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < l.length && prefix[i] === l[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.replace(/[\s\-]+$/, '').trim() || programId;
}

function populateProgramSelect() {
  const sel = document.getElementById('program-select');
  const prev = sel.value;
  const teams = seasonData?.teams || [];
  const programIds = [...new Set(teams.map(t => t.program_id).filter(Boolean))].sort((a, b) => programName(a).localeCompare(programName(b)));
  sel.innerHTML = '<option value="">All programs</option>';
  programIds.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = programName(id);
    sel.appendChild(opt);
  });
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  else if (programIds.length) sel.value = programIds[0];
}

function renderProgramView() {
  const wrapper = document.getElementById('program-wrapper');
  const programId  = document.getElementById('program-select').value;
  const teams   = seasonData?.teams || [];
  const programTeamIds = programId ? new Set(teams.filter(t => t.program_id === programId).map(t => t.id)) : null;
  const divNames = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));
  const name = programId ? programName(programId) : 'All programs';

  const games = [...(scheduleData?.games || [])]
    .filter(g => !programTeamIds || programTeamIds.has(g.home_team_id) || programTeamIds.has(g.away_team_id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  if (!games.length) { wrapper.innerHTML = `<p class="empty-state">No games found.</p>`; return; }

  const byDate = new Map();
  for (const g of games) { if (!byDate.has(g.date)) byDate.set(g.date, []); byDate.get(g.date).push(g); }

  const summary = `<p class="field-utilization"><strong>${name}</strong> — <strong>${games.length}</strong> game${games.length !== 1 ? 's' : ''} across <strong>${byDate.size}</strong> date${byDate.size !== 1 ? 's' : ''} <button onclick="exportProgramCSV('${programId}')" style="margin-left:8px;font-size:11px;padding:2px 8px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;cursor:pointer;color:#475569">↓ CSV</button></p>`;

  const groups = [...byDate.entries()].map(([date, dateGames]) => {
    const isSat = dateGames[0].day === 'Saturday';
    const dayClass = isSat ? 'fday-sat' : 'fday-wd';
    const rows = dateGames.map(g => {
      const haLabel = programTeamIds
        ? (programTeamIds.has(g.home_team_id) ? '<span style="color:#16a34a;font-weight:700">Home</span>' : '<span style="color:#dc2626;font-weight:700">Away</span>')
        : '';
      return `<tr>
        <td>${formatTime12h(g.time)}</td>
        ${programTeamIds ? `<td>${haLabel}</td>` : ''}
        <td><span class="field-div-badge">${esc(divNames[g.division_id] || g.division_id)}</span></td>
        <td class="g-home">${esc(g.home_team_name)}</td>
        <td style="color:#94a3b8;font-size:11px">vs</td>
        <td class="g-away">${esc(g.away_team_name)}</td>
        <td style="font-size:11px;color:#64748b">${esc(g.field_name)}</td>
        <td style="color:#94a3b8;font-size:11px;white-space:nowrap">#${g.game_id}</td>
      </tr>`;
    }).join('');
    return `<div class="field-date-group">
      <div class="field-date-header">
        <span><span class="${dayClass}">${dateGames[0].day}</span> ${formatDate(date)} — Week ${dateGames[0].week}</span>
        <span class="field-date-count">${dateGames.length} game${dateGames.length !== 1 ? 's' : ''}</span>
      </div>
      <table class="field-games-table">
        <thead><tr><th>Time</th>${programTeamIds ? '<th>H/A</th>' : ''}<th>Division</th><th>Home</th><th></th><th>Away</th><th>Field</th><th>#</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  wrapper.innerHTML = summary + groups;
}

function exportProgramCSV(programId) {
  const teams = seasonData?.teams || [];
  const programTeamIds = programId ? new Set(teams.filter(t => t.program_id === programId).map(t => t.id)) : null;
  const divNames = Object.fromEntries((seasonData?.divisions || []).map(d => [d.id, d.name || d.label || d.id]));
  const games = [...(scheduleData?.games || [])]
    .filter(g => !programTeamIds || programTeamIds.has(g.home_team_id) || programTeamIds.has(g.away_team_id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  const rows = [['Date','Day','Time','Home/Away','Division','Home Team','Away Team','Field','Address','Game #']];
  for (const g of games) {
    const isHome = programTeamIds ? programTeamIds.has(g.home_team_id) : null;
    rows.push([formatDate(g.date), g.day, formatTime12h(g.time), isHome === null ? '' : isHome ? 'Home' : 'Away',
      divNames[g.division_id] || g.division_id, g.home_team_name, g.away_team_name,
      g.field_name, g.field_address || '', '#' + g.game_id]);
  }
  const filename = programId ? `${programName(programId).replace(/[^a-z0-9]/gi,'-').toLowerCase()}-schedule.csv` : 'all-programs-schedule.csv';
  downloadCSV(filename, rows);
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
        ${showFieldCol ? `<td>${esc(g.field_name)}<div style="font-size:10px;color:#94a3b8">${esc(g.field_address)}${fieldMapLink(g.field_id)}</div></td>` : ''}
        <td><span class="field-div-badge">${esc(divNames[g.division_id] || g.division_id)}</span></td>
        <td class="g-home">${esc(g.home_team_name)}</td>
        <td style="color:#94a3b8;font-size:11px">vs</td>
        <td class="g-away">${esc(g.away_team_name)}</td>
        <td style="color:#94a3b8;font-size:11px;white-space:nowrap">#${g.game_id}</td>
      </tr>`).join('');
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

// ── Missing coach info modal ──────────────────────────────────────────────────
let miTeam = null;

function openMissingInfo(teamId) {
  miTeam = (seasonData?.teams || []).find(t => t.id === teamId);
  if (!miTeam || !session) return;
  document.getElementById('missing-info-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderMissingInfoForm();
}

function closeMissingInfoModal() {
  document.getElementById('missing-info-modal').classList.add('hidden');
  document.body.style.overflow = '';
  miTeam = null;
}

document.getElementById('mi-close-btn').addEventListener('click', closeMissingInfoModal);
document.getElementById('missing-info-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeMissingInfoModal();
});

function renderMissingInfoForm(sent) {
  const body = document.getElementById('mi-body');
  if (sent) {
    body.innerHTML = `
      <p style="color:#16a34a;font-weight:600;font-size:15px;margin-bottom:8px">✓ Submitted!</p>
      <p style="font-size:13px;color:#64748b">Thanks — the league admin will update the roster.</p>
      <div class="modal-actions" style="margin-top:20px">
        <button class="modal-btn modal-btn-secondary" onclick="closeMissingInfoModal()">Close</button>
      </div>`;
    return;
  }
  body.innerHTML = `
    <div class="modal-game-summary" style="margin-bottom:16px">
      <div class="matchup">${esc(teamLabel(miTeam))}</div>
      <div class="meta">Fill in any missing contact info below and hit Submit.</div>
    </div>
    <div class="modal-field">
      <label>Coach name${miTeam.coach ? '' : ' <span style="color:#ea580c">*</span>'}</label>
      <input type="text" id="mi-coach" value="${esc(miTeam.coach || '')}" placeholder="First Last">
    </div>
    <div class="modal-field">
      <label>Email${miTeam.email ? '' : ' <span style="color:#ea580c">*</span>'}</label>
      <input type="email" inputmode="email" autocomplete="email" spellcheck="false" id="mi-email" value="${esc(miTeam.email || '')}" placeholder="coach@example.com">
    </div>
    <div class="modal-field">
      <label>Phone${miTeam.phone ? '' : ' <span style="color:#ea580c">*</span>'}</label>
      <input type="tel" inputmode="tel" autocomplete="tel" id="mi-phone" value="${esc(miTeam.phone || '')}" placeholder="(555) 555-5555">
    </div>
    <div id="mi-error" style="color:#dc2626;font-size:12px;margin-bottom:10px;display:none"></div>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeMissingInfoModal()">Cancel</button>
      <button class="modal-btn modal-btn-primary" id="mi-submit-btn" onclick="submitMissingInfo()">Submit</button>
    </div>`;
}

async function submitMissingInfo() {
  const coach = document.getElementById('mi-coach')?.value.trim();
  const email = document.getElementById('mi-email')?.value.trim();
  const phone = document.getElementById('mi-phone')?.value.trim();
  const errEl = document.getElementById('mi-error');
  const btn   = document.getElementById('mi-submit-btn');

  if (!coach && !email && !phone) {
    errEl.textContent = 'Please fill in at least one field.';
    errEl.style.display = '';
    return;
  }
  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const r = await fetch('api/missing-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: miTeam.id,
        team_name: teamLabel(miTeam),
        division_name: (seasonData?.divisions || []).find(d => d.id === miTeam.division_id)?.name || miTeam.division_id || '',
        coach, email, phone,
      }),
    });
    const d = await r.json();
    if (d.ok) {
      renderMissingInfoForm(true);
    } else {
      btn.disabled = false;
      btn.textContent = 'Submit';
      errEl.textContent = 'Failed to send: ' + (d.error || 'unknown error');
      errEl.style.display = '';
    }
  } catch {
    btn.disabled = false;
    btn.textContent = 'Submit';
    errEl.textContent = 'Network error — please try again.';
    errEl.style.display = '';
  }
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

function fieldMapLink(fieldId) {
  const f = (seasonData?.fields || []).find(f => f.id === fieldId);
  if (!f?.coordinates) return '';
  const url = `https://www.google.com/maps?q=${f.coordinates}&t=k`;
  return ` <a href="${url}" target="_blank" rel="noopener" class="map-link">Map</a>`;
}

init();
