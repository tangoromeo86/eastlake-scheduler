'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { scheduleAll, validateGameEdit, SEASON_WEEKS, dayName, teamName } = require('./lib/scheduler');

const app = express();
const PORT = process.env.PORT || 3010;
const BASE_PATH = process.env.BASE_PATH || '';

const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
const SEASON_FILE   = path.join(__dirname, 'season.json');
const CHANGES_FILE  = path.join(__dirname, 'changes.json');

// Public viewer — no auth required
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// Admin tool — auth required
app.get('/admin', (req, res) => {
  if (!isAuthed(req)) return res.redirect(BASE_PATH + '/login?next=admin');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin/', (req, res) => {
  res.redirect((BASE_PATH || '') + '/admin');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Simple password auth ──────────────────────────────────────────────────────
const APP_PASSWORD = process.env.APP_PASSWORD || 'eastlake2026';
const AUTH_COOKIE  = 'el_auth';

function getCookie(req, name) {
  return (req.headers.cookie || '').split(';')
    .map(c => c.trim()).find(c => c.startsWith(name + '='))
    ?.slice(name.length + 1) || null;
}

function isAuthed(req) {
  return getCookie(req, AUTH_COOKIE) === APP_PASSWORD;
}

app.get('/login', (req, res) => {
  const error = req.url.includes('error=1');
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Eastlake Scheduler — Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f4f6f8; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; padding: 40px 36px; width: 340px; box-shadow: 0 4px 24px rgba(0,0,0,.10); }
    h1 { font-size: 1.1rem; font-weight: 700; color: #1a1a2e; margin-bottom: 6px; }
    p  { font-size: 13px; color: #64748b; margin-bottom: 24px; }
    label { display: block; font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 6px; }
    input { width: 100%; padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
    button { width: 100%; padding: 10px; background: #2d6cf0; color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .err { color: #dc2626; font-size: 13px; margin-bottom: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Eastlake League Scheduler</h1>
    <p>Enter the password to continue.</p>
    ${error ? '<p class="err">Incorrect password. Try again.</p>' : ''}
    <form method="POST" action="${BASE_PATH}/login${req.query.next ? '?next=' + req.query.next : ''}">
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" autofocus autocomplete="current-password">
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    const maxAge = 7 * 24 * 60 * 60; // 7 days in seconds
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${APP_PASSWORD}; HttpOnly; Path=/; Max-Age=${maxAge}`);
    const next = req.query.next === 'admin' ? '/admin' : '/';
    return res.redirect(BASE_PATH + next);
  }
  res.redirect(BASE_PATH + '/login?error=1');
});

// GET /api/public/schedule — no auth, same data as /api/schedule
app.get('/api/public/schedule', (req, res) => {
  if (!fs.existsSync(SCHEDULE_FILE)) {
    return res.json({ games: [], failures: [], generated_at: null, total_games: 0 });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/public/season — no auth, strips coach/phone/email from teams
app.get('/api/public/season', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    const stripped = {
      ...data,
      teams: (data.teams || []).map(t => {
        const { coach, phone, email, ...rest } = t;
        return rest;
      }),
    };
    res.json(stripped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auth guard — protects all routes except /login and /api/public/
app.use((req, res, next) => {
  if (req.path === '/login') return next();
  if (req.path.startsWith('/api/public/')) return next();
  if (isAuthed(req)) return next();
  res.redirect(BASE_PATH + '/login');
});

// POST /api/run — run the scheduler and save results
app.post('/api/run', (req, res) => {
  let seasonData;
  try {
    seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: `Could not read season.json: ${err.message}` });
  }

  let result;
  try {
    result = scheduleAll(seasonData);
  } catch (err) {
    return res.status(500).json({ error: `Scheduler error: ${err.message}` });
  }

  // Strip internal tracking fields before saving
  for (const g of result.games) delete g._fieldKey;

  // Always save even if partial (so we can show what worked)
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(result, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `Could not write schedule.json: ${err.message}` });
  }

  res.json(result);
});

// GET /api/schedule — return current schedule.json
app.get('/api/schedule', (req, res) => {
  if (!fs.existsSync(SCHEDULE_FILE)) {
    return res.json({ games: [], failures: [], generated_at: null, total_games: 0 });
  }
  try {
    const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: `Could not read schedule.json: ${err.message}` });
  }
});

// GET /api/season — return season data (teams, divisions, etc.)
app.get('/api/season', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: `Could not read season.json: ${err.message}` });
  }
});

// GET /api/season/download — download the raw season.json file
app.get('/api/season/download', (req, res) => {
  if (!fs.existsSync(SEASON_FILE)) {
    return res.status(404).json({ error: 'season.json not found' });
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="season.json"');
  res.sendFile(SEASON_FILE);
});

// POST /api/upload-season — validate and replace season.json
app.post('/api/upload-season', (req, res) => {
  const data = req.body;

  // Basic structure validation
  const missing = ['season', 'clubs', 'divisions', 'fields', 'teams'].filter(k => !data[k]);
  if (missing.length) {
    return res.status(400).json({ error: `Missing required keys: ${missing.join(', ')}` });
  }
  if (!Array.isArray(data.divisions) || data.divisions.length === 0) {
    return res.status(400).json({ error: 'divisions must be a non-empty array' });
  }
  if (!Array.isArray(data.teams) || data.teams.length === 0) {
    return res.status(400).json({ error: 'teams must be a non-empty array' });
  }

  // Check every team references a valid division
  const divisionIds = new Set(data.divisions.map(d => d.id));
  const badTeams = data.teams.filter(t => t.division_id && !divisionIds.has(t.division_id));
  if (badTeams.length) {
    return res.status(400).json({
      error: `${badTeams.length} team(s) reference unknown division IDs: ` +
        [...new Set(badTeams.map(t => t.division_id))].join(', '),
    });
  }

  // Back up the current file before overwriting
  if (fs.existsSync(SEASON_FILE)) {
    const backup = SEASON_FILE.replace('.json', `.backup-${Date.now()}.json`);
    fs.copyFileSync(SEASON_FILE, backup);
  }

  // Delete any existing generated schedule (it's stale now)
  if (fs.existsSync(SCHEDULE_FILE)) fs.unlinkSync(SCHEDULE_FILE);

  try {
    fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `Could not save season.json: ${err.message}` });
  }

  // Return a summary
  const confirmedTeams = data.teams.filter(t => t.confirmed !== false);
  const perDivision = {};
  confirmedTeams.forEach(t => {
    perDivision[t.division_id] = (perDivision[t.division_id] || 0) + 1;
  });

  res.json({
    ok: true,
    summary: {
      divisions: data.divisions.length,
      teams: confirmedTeams.length,
      per_division: data.divisions.map(d => ({
        id: d.id,
        name: d.name,
        teams: perDivision[d.id] || 0,
      })),
      season_start: data.season?.start,
      season_end: data.season?.end,
      target_games: data.season?.target_games,
    },
  });
});

// GET /api/export/csv — export schedule as CSV
app.get('/api/export/csv', (req, res) => {
  if (!fs.existsSync(SCHEDULE_FILE)) {
    return res.status(404).json({ error: 'No schedule generated yet' });
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: `Could not read schedule.json: ${err.message}` });
  }

  const seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  const divisionMap = {};
  for (const d of (seasonData.divisions || [])) divisionMap[d.id] = d.name;

  const rows = [['Game #', 'Division', 'Week', 'Date', 'Day', 'Time', 'Home Team', 'Away Team', 'Field', 'Address', 'Rematch']];

  const sorted = [...(data.games || [])].sort((a, b) =>
    a.date.localeCompare(b.date) || a.division_id.localeCompare(b.division_id)
  );

  for (const g of sorted) {
    rows.push([
      g.game_id,
      divisionMap[g.division_id] || g.division_id,
      g.week,
      g.date,
      g.day,
      g.time,
      g.home_team_name,
      g.away_team_name,
      g.field_name,
      g.field_address,
      g.is_rematch ? 'Yes' : 'No',
    ]);
  }

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="schedule.csv"');
  res.send(csv);
});

// GET /api/season/slots — return SEASON_WEEKS as enriched date list
app.get('/api/season/slots', (req, res) => {
  const result = SEASON_WEEKS.map(wk => {
    const dates = [];
    for (const d of wk.weekdays) {
      dates.push({ date: d, type: 'weekday', day: dayName(d) });
    }
    if (wk.saturday) {
      dates.push({ date: wk.saturday, type: 'saturday', day: 'Saturday' });
    }
    return { week: wk.week, dates };
  });
  res.json(result);
});

// PUT /api/game/:id — edit a game
app.put('/api/game/:id', (req, res) => {
  const gameId = parseInt(req.params.id, 10);
  const { date, time, field_id, home_team_id, away_team_id, force } = req.body;

  let schedData;
  try {
    schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: `Could not read schedule.json: ${err.message}` });
  }

  let seasonData;
  try {
    seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: `Could not read season.json: ${err.message}` });
  }

  const gameIdx = schedData.games.findIndex(g => g.game_id === gameId);
  if (gameIdx === -1) {
    return res.status(404).json({ error: `Game ${gameId} not found` });
  }

  const existingGame = schedData.games[gameIdx];

  // Snapshot before state for change log
  const beforeSnap = {
    date: existingGame.date, day: existingGame.day, time: existingGame.time,
    field_id: existingGame.field_id, field_name: existingGame.field_name,
    home_team_id: existingGame.home_team_id, home_team_name: existingGame.home_team_name,
    away_team_id: existingGame.away_team_id, away_team_name: existingGame.away_team_name,
    week: existingGame.week,
  };

  // Build edit candidate
  const editedGame = {
    id: gameId,
    date,
    time,
    field_id,
    home_team_id,
    away_team_id,
    division_id: existingGame.division_id,
    week: existingGame.week, // used for context; recalculated below
  };

  // Attach teams to season object for validateGameEdit lookup
  const seasonForValidation = { ...seasonData.season, _teams: seasonData.teams || [] };

  const violations = validateGameEdit(editedGame, schedData.games, seasonForValidation);

  if (violations.length && !force) {
    return res.status(409).json({ violations });
  }

  // Determine week from SEASON_WEEKS
  let newWeek = existingGame.week;
  for (const wk of SEASON_WEEKS) {
    if (wk.weekdays.includes(date) || wk.saturday === date) {
      newWeek = wk.week;
      break;
    }
  }

  // Resolve field name/address
  const fieldObj = (seasonData.fields || []).find(f => f.id === field_id);
  const fieldName = fieldObj ? (fieldObj.name || field_id) : field_id;
  const fieldAddress = fieldObj ? (fieldObj.address || '') : '';

  // Resolve team names
  const homeTeam = (seasonData.teams || []).find(t => t.id === home_team_id);
  const awayTeam = (seasonData.teams || []).find(t => t.id === away_team_id);
  const homeTeamName = homeTeam ? teamName(homeTeam) : String(home_team_id);
  const awayTeamName = awayTeam ? teamName(awayTeam) : String(away_team_id);

  // Update the game in place
  const updatedGame = {
    ...existingGame,
    date,
    day: dayName(date),
    time,
    field_id,
    field_name: fieldName,
    field_address: fieldAddress,
    home_team_id,
    home_team_name: homeTeamName,
    away_team_id,
    away_team_name: awayTeamName,
    week: newWeek,
  };

  schedData.games[gameIdx] = updatedGame;
  schedData.total_games = schedData.games.length;
  schedData.generated_at = new Date().toISOString();

  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedData, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `Could not write schedule.json: ${err.message}` });
  }

  // ── Build and append change record ──────────────────────────────────────
  const changedFields = [];
  if (beforeSnap.date !== updatedGame.date)
    changedFields.push({ field: 'date', from: beforeSnap.date, to: updatedGame.date });
  if (beforeSnap.time !== updatedGame.time)
    changedFields.push({ field: 'time', from: beforeSnap.time, to: updatedGame.time });
  if (beforeSnap.field_id !== updatedGame.field_id)
    changedFields.push({ field: 'field', from: beforeSnap.field_name, to: updatedGame.field_name });
  if (beforeSnap.home_team_id !== updatedGame.home_team_id)
    changedFields.push({ field: 'home_team', from: beforeSnap.home_team_name, to: updatedGame.home_team_name });
  if (beforeSnap.away_team_id !== updatedGame.away_team_id)
    changedFields.push({ field: 'away_team', from: beforeSnap.away_team_name, to: updatedGame.away_team_name });

  function teamContact(t) {
    if (!t) return null;
    return { id: t.id, name: teamName(t), coach: t.coach || '', email: t.email || '', phone: t.phone || '' };
  }

  const changeRecord = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    game_id: gameId,
    division_id: existingGame.division_id,
    division_name: (() => {
      const d = (seasonData.divisions || []).find(d => d.id === existingGame.division_id);
      return d ? (d.name || d.label || d.id) : existingGame.division_id;
    })(),
    before: beforeSnap,
    after: { ...updatedGame },
    changed_fields: changedFields,
    home_team: teamContact(homeTeam),
    away_team: teamContact(awayTeam),
    forced: !!force,
  };

  let allChanges = [];
  try {
    if (fs.existsSync(CHANGES_FILE)) allChanges = JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8'));
  } catch {}
  allChanges.push(changeRecord);
  try { fs.writeFileSync(CHANGES_FILE, JSON.stringify(allChanges, null, 2)); } catch {}

  res.json({ ok: true, game: updatedGame, violations, change: changeRecord });
});

// PATCH /api/team/:id — update editable fields on a team
app.patch('/api/team/:id', (req, res) => {
  const rawId = req.params.id;
  // Team IDs may be int or string
  const teamId = isNaN(parseInt(rawId, 10)) ? rawId : parseInt(rawId, 10);

  let seasonData;
  try {
    seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: `Could not read season.json: ${err.message}` });
  }

  const teamIdx = seasonData.teams.findIndex(t => t.id === teamId);
  if (teamIdx === -1) {
    return res.status(404).json({ error: `Team ${teamId} not found` });
  }

  const team = { ...seasonData.teams[teamIdx] };
  const allowed = ['label', 'name', 'coach', 'phone', 'email', 'home_field_id', 'home_field_saturday_id', 'confirmed', 'blackout_dates'];

  for (const field of allowed) {
    if (!(field in req.body)) continue;
    const val = req.body[field];
    if (field === 'home_field_saturday_id' && (val === '' || val === null)) {
      delete team.home_field_saturday_id;
    } else {
      team[field] = val;
    }
  }

  seasonData.teams[teamIdx] = team;

  // Back up before writing
  const backup = SEASON_FILE.replace('.json', `.backup-${Date.now()}.json`);
  fs.copyFileSync(SEASON_FILE, backup);

  try {
    fs.writeFileSync(SEASON_FILE, JSON.stringify(seasonData, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `Could not write season.json: ${err.message}` });
  }

  res.json({ ok: true, team });
});

// PATCH /api/division/:id — update editable fields on a division
app.patch('/api/division/:id', (req, res) => {
  const divId = req.params.id;

  let seasonData;
  try {
    seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: `Could not read season.json: ${err.message}` });
  }

  const divIdx = seasonData.divisions.findIndex(d => d.id === divId);
  if (divIdx === -1) return res.status(404).json({ error: `Division ${divId} not found` });

  const allowed = ['target_games'];
  const div = { ...seasonData.divisions[divIdx] };
  for (const field of allowed) {
    if (field in req.body) div[field] = req.body[field];
  }
  seasonData.divisions[divIdx] = div;

  const backup = SEASON_FILE.replace('.json', `.backup-${Date.now()}.json`);
  fs.copyFileSync(SEASON_FILE, backup);
  try {
    fs.writeFileSync(SEASON_FILE, JSON.stringify(seasonData, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `Could not write season.json: ${err.message}` });
  }

  res.json({ ok: true, division: div });
});

// GET /api/changes — return full change log
app.get('/api/changes', (req, res) => {
  if (!fs.existsSync(CHANGES_FILE)) return res.json([]);
  try {
    res.json(JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/changes — clear the change log
app.delete('/api/changes', (req, res) => {
  try {
    fs.writeFileSync(CHANGES_FILE, '[]');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CSV parser (handles quoted fields) ───────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        let val = '';
        i++;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
          else if (line[i] === '"') { i++; break; }
          else { val += line[i++]; }
        }
        row.push(val);
        if (line[i] === ',') i++;
      } else {
        let val = '';
        while (i < line.length && line[i] !== ',') val += line[i++];
        if (line[i] === ',') i++;
        row.push(val);
      }
    }
    rows.push(row);
  }
  return rows;
}

// POST /api/import-schedule — restore a schedule from a previously exported CSV
app.post('/api/import-schedule', express.text({ type: '*/*', limit: '10mb' }), (req, res) => {
  const csv = req.body;
  if (!csv || !csv.trim()) return res.status(400).json({ error: 'No CSV data received.' });

  const rows = parseCSV(csv);
  if (rows.length < 2) return res.status(400).json({ error: 'CSV appears empty or has no data rows.' });

  // Map header names to column indexes
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const col = name => headers.indexOf(name);
  const C = {
    gameId:   col('game #'),
    division: col('division'),
    week:     col('week'),
    date:     col('date'),
    day:      col('day'),
    time:     col('time'),
    home:     col('home team'),
    away:     col('away team'),
    field:    col('field'),
    address:  col('address'),
    rematch:  col('rematch'),
  };

  if (C.date < 0 || C.home < 0 || C.away < 0) {
    return res.status(400).json({ error: 'CSV is missing required columns (Date, Home Team, Away Team). Make sure this is a schedule exported by this tool.' });
  }

  // Load season for ID lookups
  let seasonData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (e) { return res.status(500).json({ error: 'Could not read season.json.' }); }

  // Build lookup maps
  const divByName = {};
  for (const d of (seasonData.divisions || [])) {
    const key = (d.name || d.label || d.id).toLowerCase();
    divByName[key] = d;
    divByName[d.id.toLowerCase()] = d;
  }

  const teamsByDiv = {};
  for (const t of (seasonData.teams || [])) {
    if (!teamsByDiv[t.division_id]) teamsByDiv[t.division_id] = [];
    teamsByDiv[t.division_id].push(t);
  }

  const fieldByName = {};
  for (const f of (seasonData.fields || [])) {
    if (f.name)           fieldByName[f.name.toLowerCase()] = f;
    if (f.weekend_venue)  fieldByName[f.weekend_venue.toLowerCase()] = f;
  }

  const games = [];
  const warnings = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const date = C.date >= 0 ? r[C.date]?.trim() : '';
    if (!date) continue; // skip blank rows

    const divRaw = C.division >= 0 ? r[C.division]?.trim() : '';
    const div    = divByName[divRaw.toLowerCase()];
    const divId  = div ? div.id : divRaw;

    const homeRaw = C.home >= 0 ? r[C.home]?.trim() : '';
    const awayRaw = C.away >= 0 ? r[C.away]?.trim() : '';
    const fieldRaw = C.field >= 0 ? r[C.field]?.trim() : '';

    const divTeams = teamsByDiv[divId] || [];
    const findTeam = name => {
      const nl = name.toLowerCase();
      return divTeams.find(t =>
        (t.label || '').toLowerCase() === nl ||
        (t.name || '').toLowerCase() === nl ||
        (t.team_name || '').toLowerCase() === nl
      );
    };

    const homeTeam = findTeam(homeRaw);
    const awayTeam = findTeam(awayRaw);
    const field    = fieldByName[fieldRaw.toLowerCase()];

    if (!homeTeam) warnings.push(`Row ${i + 1}: Home team "${homeRaw}" not matched in division "${divId}" — ID left as name.`);
    if (!awayTeam) warnings.push(`Row ${i + 1}: Away team "${awayRaw}" not matched in division "${divId}" — ID left as name.`);
    if (!field)    warnings.push(`Row ${i + 1}: Field "${fieldRaw}" not matched — field_id left as name.`);

    games.push({
      game_id:        C.gameId >= 0 ? (parseInt(r[C.gameId], 10) || i) : i,
      division_id:    divId,
      week:           C.week >= 0 ? (parseInt(r[C.week], 10) || 0) : 0,
      date,
      day:            C.day >= 0 ? r[C.day]?.trim() : '',
      time:           C.time >= 0 ? r[C.time]?.trim() : '',
      home_team_id:   homeTeam ? homeTeam.id : homeRaw,
      home_team_name: homeRaw,
      away_team_id:   awayTeam ? awayTeam.id : awayRaw,
      away_team_name: awayRaw,
      field_id:       field ? field.id : fieldRaw,
      field_name:     fieldRaw,
      field_address:  C.address >= 0 ? r[C.address]?.trim() : (field?.address || ''),
      is_rematch:     C.rematch >= 0 ? r[C.rematch]?.trim().toLowerCase() === 'yes' : false,
    });
  }

  if (!games.length) return res.status(400).json({ error: 'No valid game rows found in CSV.' });

  // Backup current schedule before overwriting
  if (fs.existsSync(SCHEDULE_FILE)) {
    const backup = SCHEDULE_FILE.replace('.json', `.backup-${Date.now()}.json`);
    try { fs.copyFileSync(SCHEDULE_FILE, backup); } catch {}
  }

  const result = {
    success: true,
    games,
    total_games: games.length,
    generated_at: new Date().toISOString(),
    source: 'csv_import',
    warnings: [],
    failures: [],
  };

  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(result, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `Could not save schedule: ${err.message}` });
  }

  res.json({ ok: true, total_games: games.length, warnings });
});

app.listen(PORT, () => {
  console.log(`Eastlake League Scheduler running at http://localhost:${PORT}`);
});
