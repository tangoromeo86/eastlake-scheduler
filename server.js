'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Resend } = require('resend');
const { scheduleAll, validateGameEdit, SEASON_WEEKS, dayName, teamName } = require('./lib/scheduler');

const app = express();
const PORT = process.env.PORT || 3010;
const BASE_PATH = process.env.BASE_PATH || '';

const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
const SEASON_FILE   = path.join(__dirname, 'season.json');
const CHANGES_FILE  = path.join(__dirname, 'changes.json');

// ── Auth config (set via environment — never hardcode secrets here) ───────────
const ADMIN_EMAIL    = (process.env.ADMIN_EMAIL    || '').toLowerCase().trim();
const ADMIN_PASSWORD =  process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_SECRET =  process.env.SESSION_SECRET || 'eastlake-dev-secret';
const SESSION_COOKIE = 'el_sess';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

// ── Email config ──────────────────────────────────────────────────────────────
const RESEND_API_KEY  = process.env.RESEND_API_KEY  || '';
const EMAIL_FROM      = process.env.EMAIL_FROM      || 'schedule@tedriolo.com';
const EMAIL_REPLY_TO  = process.env.EMAIL_REPLY_TO  || '';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

async function sendEmail({ to, subject, text }) {
  if (!resend) return { ok: false, reason: 'No RESEND_API_KEY configured' };
  const toArr = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!toArr.length) return { ok: false, reason: 'No recipients' };
  try {
    const payload = { from: EMAIL_FROM, to: toArr, subject, text };
    if (EMAIL_REPLY_TO) payload.reply_to = EMAIL_REPLY_TO;
    await resend.emails.send(payload);
    return { ok: true };
  } catch (err) {
    console.error('Email send error:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ── Cookie & session helpers ──────────────────────────────────────────────────
function getCookie(req, name) {
  return (req.headers.cookie || '').split(';')
    .map(c => c.trim()).find(c => c.startsWith(name + '='))
    ?.slice(name.length + 1) || null;
}

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return data + '.' + sig;
}

function parseSession(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const data = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

function getSession(req) {
  return parseSession(getCookie(req, SESSION_COOKIE));
}

function setSession(res, payload) {
  const token = signSession({ ...payload, exp: Date.now() + SESSION_MAX_AGE * 1000 });
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE}; SameSite=Lax`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}

function requireAuth(req, res, next) {
  if (getSession(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect(BASE_PATH + '/login');
}

function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (s?.role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admin access required' });
  res.redirect(BASE_PATH + '/login');
}

// Look up a coach or director by email in season.json
function findByEmail(email) {
  try {
    const data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    const team = (data.teams || []).find(t => (t.email || '').toLowerCase().trim() === email);
    if (team) return { role: 'coach', name: team.coach || team.label || 'Coach', team_id: team.id, phone: team.phone || '' };
    const dir = (data.directors || []).find(d => (d.email || '').toLowerCase().trim() === email);
    if (dir) return { role: 'coach', name: dir.name || 'Director', phone: dir.phone || '' };
  } catch {}
  return null;
}

// ── Login page HTML ───────────────────────────────────────────────────────────
function loginPage(next) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sign In — Eastlake League Scheduler</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f0f4f8; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
    .brand { font-size: 13px; color: #94a3b8; margin-bottom: 20px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    .card { background: #fff; border-radius: 16px; padding: 36px 32px; width: 100%; max-width: 380px; box-shadow: 0 4px 28px rgba(0,0,0,.10); }
    h1 { font-size: 1.2rem; font-weight: 700; color: #1a1a2e; margin-bottom: 6px; }
    .sub { font-size: 13px; color: #64748b; margin-bottom: 26px; line-height: 1.5; }
    label { display: block; font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 6px; }
    input { width: 100%; padding: 12px 14px; border: 1.5px solid #cbd5e1; border-radius: 8px; font-size: 16px; margin-bottom: 14px; transition: border-color .15s; }
    input:focus { outline: none; border-color: #2d6cf0; box-shadow: 0 0 0 3px rgba(45,108,240,.12); }
    .btn { width: 100%; padding: 13px; background: #2d6cf0; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background .15s; }
    .btn:hover:not(:disabled) { background: #1d5ce0; }
    .btn:disabled { background: #94a3b8; cursor: default; }
    .error { color: #dc2626; font-size: 13px; margin-bottom: 14px; display: none; padding: 10px 12px; background: #fef2f2; border-radius: 6px; border: 1px solid #fecaca; }
    .error.show { display: block; }
    .pw-section { display: none; }
    .pw-section.show { display: block; }
    .back-btn { background: none; border: none; color: #64748b; font-size: 13px; cursor: pointer; padding: 0; margin-bottom: 18px; display: inline-flex; align-items: center; gap: 4px; }
    .back-btn:hover { color: #1a1a2e; }
    .email-chip { font-size: 14px; color: #1a1a2e; font-weight: 500; background: #f1f5f9; border-radius: 8px; padding: 10px 14px; margin-bottom: 20px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="brand">Eastlake League Scheduler</div>
  <div class="card">
    <h1 id="card-title">Welcome back</h1>
    <p class="sub" id="card-sub">Enter your email address to access the schedule.</p>
    <div id="error" class="error"></div>

    <div id="email-section">
      <label for="email-input">Email address</label>
      <input type="email" id="email-input" autocomplete="email" autofocus placeholder="yourname@example.com">
      <button class="btn" id="continue-btn">Continue</button>
    </div>

    <div id="pw-section" class="pw-section">
      <button class="back-btn" id="back-btn">← Change email</button>
      <div class="email-chip" id="email-chip"></div>
      <label for="pw-input">Password</label>
      <input type="password" id="pw-input" autocomplete="current-password" placeholder="Enter your password">
      <button class="btn" id="signin-btn">Sign In</button>
    </div>
  </div>

  <script>
    const NEXT = ${JSON.stringify(next || '')};
    // Derive base path from current URL (works under any nginx prefix)
    function pageBase() {
      const p = window.location.pathname;
      return p.substring(0, p.lastIndexOf('/') + 1);
    }

    const emailInput   = document.getElementById('email-input');
    const pwInput      = document.getElementById('pw-input');
    const emailSection = document.getElementById('email-section');
    const pwSection    = document.getElementById('pw-section');
    const continueBtn  = document.getElementById('continue-btn');
    const signinBtn    = document.getElementById('signin-btn');
    const errorEl      = document.getElementById('error');

    function showError(msg) { errorEl.textContent = msg; errorEl.classList.add('show'); }
    function clearError()   { errorEl.classList.remove('show'); }

    async function checkEmail() {
      const email = emailInput.value.trim();
      if (!email) { showError('Please enter your email address.'); return; }
      clearError();
      continueBtn.disabled = true;
      continueBtn.textContent = 'Checking…';
      try {
        const res  = await fetch('api/auth/check-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        const data = await res.json();
        if (!data.found) {
          showError('Email not recognized. Please check and try again.');
          continueBtn.disabled = false;
          continueBtn.textContent = 'Continue';
          return;
        }
        if (data.isAdmin) {
          document.getElementById('email-chip').textContent = email;
          emailSection.style.display = 'none';
          pwSection.classList.add('show');
          document.getElementById('card-title').textContent = 'Admin sign in';
          document.getElementById('card-sub').textContent = 'Enter your password to continue.';
          pwInput.focus();
        } else {
          continueBtn.textContent = 'Signing in…';
          const lr   = await fetch('api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
          const ld   = await lr.json();
          if (ld.ok) { window.location = pageBase(); }
          else { showError(ld.error || 'Login failed. Try again.'); continueBtn.disabled = false; continueBtn.textContent = 'Continue'; }
        }
      } catch { showError('Something went wrong. Please try again.'); continueBtn.disabled = false; continueBtn.textContent = 'Continue'; }
    }

    async function signIn() {
      const email = emailInput.value.trim();
      const pw    = pwInput.value;
      if (!pw) { showError('Please enter your password.'); return; }
      clearError();
      signinBtn.disabled = true;
      signinBtn.textContent = 'Signing in…';
      try {
        const res  = await fetch('api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw, next: NEXT }) });
        const data = await res.json();
        if (data.ok) { window.location = NEXT === 'admin' ? pageBase() + 'admin' : pageBase(); }
        else { showError(data.error || 'Incorrect password.'); signinBtn.disabled = false; signinBtn.textContent = 'Sign In'; pwInput.focus(); pwInput.select(); }
      } catch { showError('Something went wrong. Please try again.'); signinBtn.disabled = false; signinBtn.textContent = 'Sign In'; }
    }

    continueBtn.addEventListener('click', checkEmail);
    emailInput.addEventListener('keydown', e => { if (e.key === 'Enter') checkEmail(); });
    signinBtn.addEventListener('click', signIn);
    pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') signIn(); });
    document.getElementById('back-btn').addEventListener('click', () => {
      pwSection.classList.remove('show');
      emailSection.style.display = '';
      document.getElementById('card-title').textContent = 'Welcome back';
      document.getElementById('card-sub').textContent = 'Enter your email address to access the schedule.';
      clearError();
      pwInput.value = '';
      continueBtn.disabled = false;
      continueBtn.textContent = 'Continue';
      emailInput.focus();
    });
  </script>
</body>
</html>`;
}

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'viewer.html')));

app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/', (req, res) => res.redirect((BASE_PATH || '') + '/admin'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/login', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(loginPage(req.query.next || ''));
});

app.get('/logout', (req, res) => {
  clearSession(res);
  res.redirect(BASE_PATH + '/');
});

// ── Auth API (all public — return limited info) ───────────────────────────────

// Step 1: check if email is in the system
app.post('/api/auth/check-email', (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (ADMIN_EMAIL && email === ADMIN_EMAIL) return res.json({ found: true, isAdmin: true });
  const match = findByEmail(email);
  if (match) return res.json({ found: true, isAdmin: false });
  res.json({ found: false });
});

// Step 2: log in (admin needs password, coaches just need email)
app.post('/api/auth/login', (req, res) => {
  const email    = (req.body.email    || '').toLowerCase().trim();
  const password =  req.body.password || '';
  const next     =  req.body.next     || req.query.next || '';
  if (!email) return res.status(400).json({ error: 'Email required' });

  if (ADMIN_EMAIL && email === ADMIN_EMAIL) {
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect password' });
    setSession(res, { email, role: 'admin', name: 'Admin' });
    return res.json({ ok: true, redirect: BASE_PATH + (next === 'admin' ? '/admin' : '/') });
  }

  const match = findByEmail(email);
  if (!match) return res.status(401).json({ error: 'Email not recognized' });
  setSession(res, { email, role: match.role, name: match.name, phone: match.phone || '', team_id: match.team_id || null });
  return res.json({ ok: true, redirect: BASE_PATH + '/' });
});

// Return current session info (null if not logged in)
app.get('/api/auth/me', (req, res) => {
  const s = getSession(req);
  if (!s) return res.json(null);
  res.json({
    email:      s.email,
    name:       s.name,
    role:       s.role,
    phone:      s.phone || '',
    team_id:    s.team_id || null,
    request_to: ADMIN_EMAIL,  // only exposed to authenticated users
  });
});

// ── Public data APIs ──────────────────────────────────────────────────────────

app.get('/api/public/schedule', (req, res) => {
  if (!fs.existsSync(SCHEDULE_FILE)) return res.json({ games: [], failures: [], generated_at: null, total_games: 0 });
  try { res.json(JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Strip all contact info for public viewers
app.get('/api/public/season', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    res.json({
      ...data,
      directors: undefined,
      teams: (data.teams || []).map(({ coach, phone, email, ...rest }) => rest),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Authenticated data APIs (coaches + admin) ─────────────────────────────────

app.get('/api/schedule', requireAuth, (req, res) => {
  if (!fs.existsSync(SCHEDULE_FILE)) return res.json({ games: [], failures: [], generated_at: null, total_games: 0 });
  try { res.json(JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/season', requireAuth, (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/season/slots', requireAuth, (req, res) => {
  const result = SEASON_WEEKS.map(wk => {
    const dates = [];
    for (const d of wk.weekdays) dates.push({ date: d, type: 'weekday', day: dayName(d) });
    if (wk.saturday) dates.push({ date: wk.saturday, type: 'saturday', day: 'Saturday' });
    return { week: wk.week, dates };
  });
  res.json(result);
});

function adjacentDateStr(dateStr, delta) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

app.get('/api/game/:id/suggest-dates', requireAdmin, (req, res) => {
  const gameId = parseInt(req.params.id, 10);

  let schedData, seasonData;
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read schedule.json: ${err.message}` }); }
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  const game = schedData.games.find(g => g.game_id === gameId);
  if (!game) return res.status(404).json({ error: `Game ${gameId} not found` });

  // Allow caller to pass updated team IDs (in case editor changed them before clicking)
  const rawHomeId = req.query.home_team_id;
  const rawAwayId = req.query.away_team_id;
  const home_team_id = rawHomeId ? (isNaN(parseInt(rawHomeId, 10)) ? rawHomeId : parseInt(rawHomeId, 10)) : game.home_team_id;
  const away_team_id = rawAwayId ? (isNaN(parseInt(rawAwayId, 10)) ? rawAwayId : parseInt(rawAwayId, 10)) : game.away_team_id;

  const teams = seasonData.teams || [];
  const homeTeam = teams.find(t => t.id === home_team_id);
  const awayTeam = teams.find(t => t.id === away_team_id);

  // Global blackouts
  const season = seasonData.season || {};
  const globalBlackouts = new Set(season.blackout_dates || []);
  for (const weekend of (season.blackout_weekends || [])) {
    if (weekend.saturday) globalBlackouts.add(weekend.saturday);
    if (weekend.sunday)   globalBlackouts.add(weekend.sunday);
    if (Array.isArray(weekend.dates)) for (const d of weekend.dates) globalBlackouts.add(d);
  }

  // Team-level blackouts
  const homeBlackouts = new Set(homeTeam?.blackout_dates || []);
  const awayBlackouts = new Set(awayTeam?.blackout_dates || []);

  // Dates each team already has a game (excluding the game being edited)
  const otherGames = schedData.games.filter(g => g.game_id !== gameId);
  const homeDates = new Set(otherGames
    .filter(g => g.home_team_id === home_team_id || g.away_team_id === home_team_id)
    .map(g => g.date));
  const awayDates = new Set(otherGames
    .filter(g => g.home_team_id === away_team_id || g.away_team_id === away_team_id)
    .map(g => g.date));

  // Home team's home field for schedule preview
  const homeFieldId = homeTeam?.home_field_id ?? null;
  const fields = seasonData.fields || [];
  const homeFieldObj = homeFieldId ? fields.find(f => f.id === homeFieldId) : null;
  const homeFieldName = homeFieldObj
    ? (homeFieldObj.sub_field ? `${homeFieldObj.name} – ${homeFieldObj.sub_field}` : homeFieldObj.name)
    : null;

  const suggestions = [];
  for (const wk of SEASON_WEEKS) {
    const slots = wk.weekdays.map(d => ({ date: d, day: dayName(d), type: 'weekday' }));
    if (wk.saturday) slots.push({ date: wk.saturday, day: 'Saturday', type: 'saturday' });

    for (const { date, day, type } of slots) {
      if (globalBlackouts.has(date)) continue;
      if (homeBlackouts.has(date)) continue;
      if (awayBlackouts.has(date)) continue;
      if (homeDates.has(date)) continue;
      if (awayDates.has(date)) continue;

      const prevDay = adjacentDateStr(date, -1);
      const nextDay = adjacentDateStr(date, +1);
      if (homeDates.has(prevDay) || homeDates.has(nextDay)) continue;
      if (awayDates.has(prevDay) || awayDates.has(nextDay)) continue;

      // Collect other games at the home field on this date
      const fieldGames = homeFieldId
        ? otherGames
            .filter(g => g.field_id === homeFieldId && g.date === date)
            .map(g => ({ game_id: g.game_id, time: g.time || '', home: g.home_team_name, away: g.away_team_name }))
            .sort((a, b) => a.time.localeCompare(b.time))
        : [];

      suggestions.push({ date, day, week: wk.week, type, field_games: fieldGames });
    }
  }

  res.json({ suggestions, home_field_name: homeFieldName });
});

app.get('/api/export/csv', requireAuth, (req, res) => {
  if (!fs.existsSync(SCHEDULE_FILE)) return res.status(404).json({ error: 'No schedule generated yet' });
  let data;
  try { data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read schedule.json: ${err.message}` }); }

  const seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  const divisionMap = {};
  for (const d of (seasonData.divisions || [])) divisionMap[d.id] = d.name;

  const rows = [['Game #', 'Division', 'Week', 'Date', 'Day', 'Time', 'Home Team', 'Away Team', 'Field', 'Address', 'Rematch']];
  const sorted = [...(data.games || [])].sort((a, b) => a.date.localeCompare(b.date) || a.division_id.localeCompare(b.division_id));
  for (const g of sorted) {
    rows.push([g.game_id, divisionMap[g.division_id] || g.division_id, g.week, g.date, g.day, g.time,
      g.home_team_name, g.away_team_name, g.field_name, g.field_address, g.is_rematch ? 'Yes' : 'No']);
  }
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="schedule.csv"');
  res.send(csv);
});

// ── Admin-only APIs ───────────────────────────────────────────────────────────

app.get('/api/season/download', requireAdmin, (req, res) => {
  if (!fs.existsSync(SEASON_FILE)) return res.status(404).json({ error: 'season.json not found' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="season.json"');
  res.sendFile(SEASON_FILE);
});

app.get('/api/changes', requireAdmin, (req, res) => {
  if (!fs.existsSync(CHANGES_FILE)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/changes', requireAdmin, (req, res) => {
  try { fs.writeFileSync(CHANGES_FILE, '[]'); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/run', requireAdmin, (req, res) => {
  let seasonData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  let result;
  try { result = scheduleAll(seasonData); }
  catch (err) { return res.status(500).json({ error: `Scheduler error: ${err.message}` }); }

  for (const g of result.games) delete g._fieldKey;
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(result, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not write schedule.json: ${err.message}` }); }
  res.json(result);
});

app.post('/api/upload-season', requireAdmin, (req, res) => {
  const data = req.body;
  const missing = ['season', 'clubs', 'divisions', 'fields', 'teams'].filter(k => !data[k]);
  if (missing.length) return res.status(400).json({ error: `Missing required keys: ${missing.join(', ')}` });
  if (!Array.isArray(data.divisions) || data.divisions.length === 0) return res.status(400).json({ error: 'divisions must be a non-empty array' });
  if (!Array.isArray(data.teams) || data.teams.length === 0) return res.status(400).json({ error: 'teams must be a non-empty array' });

  const divisionIds = new Set(data.divisions.map(d => d.id));
  const badTeams = data.teams.filter(t => t.division_id && !divisionIds.has(t.division_id));
  if (badTeams.length) return res.status(400).json({
    error: `${badTeams.length} team(s) reference unknown division IDs: ` + [...new Set(badTeams.map(t => t.division_id))].join(', '),
  });

  if (fs.existsSync(SEASON_FILE)) {
    const backup = SEASON_FILE.replace('.json', `.backup-${Date.now()}.json`);
    fs.copyFileSync(SEASON_FILE, backup);
  }
  if (fs.existsSync(SCHEDULE_FILE)) fs.unlinkSync(SCHEDULE_FILE);

  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not save season.json: ${err.message}` }); }

  const confirmedTeams = data.teams.filter(t => t.confirmed !== false);
  const perDivision = {};
  confirmedTeams.forEach(t => { perDivision[t.division_id] = (perDivision[t.division_id] || 0) + 1; });

  res.json({
    ok: true,
    summary: {
      divisions: data.divisions.length,
      teams: confirmedTeams.length,
      per_division: data.divisions.map(d => ({ id: d.id, name: d.name, teams: perDivision[d.id] || 0 })),
      season_start: data.season?.start,
      season_end: data.season?.end,
      target_games: data.season?.target_games,
    },
  });
});

app.put('/api/game/:id', requireAdmin, (req, res) => {
  const gameId = parseInt(req.params.id, 10);
  const { date, time, field_id, home_team_id, away_team_id, force } = req.body;

  let schedData;
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read schedule.json: ${err.message}` }); }

  let seasonData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  const gameIdx = schedData.games.findIndex(g => g.game_id === gameId);
  if (gameIdx === -1) return res.status(404).json({ error: `Game ${gameId} not found` });

  const existingGame = schedData.games[gameIdx];
  const beforeSnap = {
    date: existingGame.date, day: existingGame.day, time: existingGame.time,
    field_id: existingGame.field_id, field_name: existingGame.field_name,
    home_team_id: existingGame.home_team_id, home_team_name: existingGame.home_team_name,
    away_team_id: existingGame.away_team_id, away_team_name: existingGame.away_team_name,
    week: existingGame.week,
  };

  const editedGame = { id: gameId, date, time, field_id, home_team_id, away_team_id, division_id: existingGame.division_id, week: existingGame.week };
  const seasonForValidation = { ...seasonData.season, _teams: seasonData.teams || [] };
  const violations = validateGameEdit(editedGame, schedData.games, seasonForValidation);
  if (violations.length && !force) return res.status(409).json({ violations });

  let newWeek = existingGame.week;
  for (const wk of SEASON_WEEKS) {
    if (wk.weekdays.includes(date) || wk.saturday === date) { newWeek = wk.week; break; }
  }

  const fieldObj = (seasonData.fields || []).find(f => f.id === field_id);
  const homeTeam = (seasonData.teams || []).find(t => t.id === home_team_id);
  const awayTeam = (seasonData.teams || []).find(t => t.id === away_team_id);

  const resolvedFieldName    = fieldObj ? (fieldObj.sub_field ? `${fieldObj.name} – ${fieldObj.sub_field}` : (fieldObj.name || field_id)) : field_id;
  const resolvedFieldAddress = fieldObj ? (fieldObj.address || '') : '';

  const updatedGame = {
    ...existingGame,
    date, day: dayName(date), time, field_id,
    field_name:    resolvedFieldName,
    field_address: resolvedFieldAddress,
    home_team_id,  home_team_name: homeTeam ? teamName(homeTeam) : String(home_team_id),
    away_team_id,  away_team_name: awayTeam ? teamName(awayTeam) : String(away_team_id),
    week: newWeek,
  };

  schedData.games[gameIdx] = updatedGame;
  schedData.total_games = schedData.games.length;
  schedData.generated_at = new Date().toISOString();

  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedData, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not write schedule.json: ${err.message}` }); }

  const changedFields = [];
  if (beforeSnap.date !== updatedGame.date)          changedFields.push({ field: 'date',      from: beforeSnap.date,           to: updatedGame.date });
  if (beforeSnap.time !== updatedGame.time)          changedFields.push({ field: 'time',      from: beforeSnap.time,           to: updatedGame.time });
  if (beforeSnap.field_id !== updatedGame.field_id)  changedFields.push({ field: 'field',     from: beforeSnap.field_name,     to: updatedGame.field_name });
  if (beforeSnap.home_team_id !== updatedGame.home_team_id) changedFields.push({ field: 'home_team', from: beforeSnap.home_team_name, to: updatedGame.home_team_name });
  if (beforeSnap.away_team_id !== updatedGame.away_team_id) changedFields.push({ field: 'away_team', from: beforeSnap.away_team_name, to: updatedGame.away_team_name });

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
  try { if (fs.existsSync(CHANGES_FILE)) allChanges = JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); } catch {}
  allChanges.push(changeRecord);
  try { fs.writeFileSync(CHANGES_FILE, JSON.stringify(allChanges, null, 2)); } catch {}

  res.json({ ok: true, game: updatedGame, violations, change: changeRecord });
});

app.delete('/api/game/:id', requireAdmin, (req, res) => {
  const gameId = parseInt(req.params.id, 10);

  let schedData, seasonData;
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read schedule.json: ${err.message}` }); }
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  const gameIdx = schedData.games.findIndex(g => g.game_id === gameId);
  if (gameIdx === -1) return res.status(404).json({ error: `Game ${gameId} not found` });

  const game = schedData.games[gameIdx];
  const homeTeam = (seasonData.teams || []).find(t => t.id === game.home_team_id);
  const awayTeam = (seasonData.teams || []).find(t => t.id === game.away_team_id);

  function teamContact(t) {
    if (!t) return null;
    return { id: t.id, name: teamName(t), coach: t.coach || '', email: t.email || '', phone: t.phone || '' };
  }

  const changeRecord = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    type: 'deletion',
    game_id: gameId,
    division_id: game.division_id,
    division_name: (() => {
      const d = (seasonData.divisions || []).find(d => d.id === game.division_id);
      return d ? (d.name || d.label || d.id) : game.division_id;
    })(),
    before: { ...game },
    after: null,
    changed_fields: [],
    home_team: teamContact(homeTeam),
    away_team: teamContact(awayTeam),
    forced: false,
  };

  schedData.games.splice(gameIdx, 1);
  schedData.total_games = schedData.games.length;
  schedData.generated_at = new Date().toISOString();

  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedData, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not write schedule.json: ${err.message}` }); }

  let allChanges = [];
  try { if (fs.existsSync(CHANGES_FILE)) allChanges = JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); } catch {}
  allChanges.push(changeRecord);
  try { fs.writeFileSync(CHANGES_FILE, JSON.stringify(allChanges, null, 2)); } catch {}

  res.json({ ok: true, change: changeRecord });
});

app.post('/api/notify-deletion', requireAdmin, async (req, res) => {
  const { change_id } = req.body;
  let changes = [];
  try { changes = JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); } catch {}
  const change = changes.find(c => c.id === change_id);
  if (!change) return res.status(404).json({ error: 'Change not found' });

  const emails = [change.home_team?.email, change.away_team?.email].filter(Boolean);
  if (!emails.length) return res.status(400).json({ error: 'No email on file for either team' });

  const divName = change.division_name || change.division_id;
  const game = change.before || {};
  const lines = [
    'Hi coaches,', '',
    'The following game has been removed from the schedule:', '',
    `Game #${change.game_id} — ${divName}`,
    `${change.home_team?.name || 'Home'} (H) vs ${change.away_team?.name || 'Away'} (A)`, '',
    'Game details:',
    `  Date: ${game.day || ''} ${game.date || ''}`,
    `  Time: ${game.time || ''}`,
    `  Field: ${game.field_name || ''}`,
    '', 'Please update your calendars accordingly.', '', '— Eastlake League Admin',
  ];
  const result = await sendEmail({ to: emails, subject: `Game Cancelled: Game #${change.game_id} — ${divName}`, text: lines.join('\n') });
  if (!result.ok) return res.status(500).json({ error: result.reason });
  res.json({ ok: true, sent_to: emails });
});

app.patch('/api/team/:id', requireAdmin, (req, res) => {
  const rawId = req.params.id;
  const teamId = isNaN(parseInt(rawId, 10)) ? rawId : parseInt(rawId, 10);

  let seasonData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  const teamIdx = seasonData.teams.findIndex(t => t.id === teamId);
  if (teamIdx === -1) return res.status(404).json({ error: `Team ${teamId} not found` });

  const team = { ...seasonData.teams[teamIdx] };
  const allowed = ['label', 'name', 'coach', 'phone', 'email', 'home_field_id', 'confirmed', 'blackout_dates'];
  for (const field of allowed) {
    if (!(field in req.body)) continue;
    team[field] = req.body[field];
  }
  delete team.home_field_saturday_id;
  seasonData.teams[teamIdx] = team;

  const backup = SEASON_FILE.replace('.json', `.backup-${Date.now()}.json`);
  fs.copyFileSync(SEASON_FILE, backup);
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(seasonData, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not write season.json: ${err.message}` }); }
  res.json({ ok: true, team });
});

app.patch('/api/division/:id', requireAdmin, (req, res) => {
  const divId = req.params.id;
  let seasonData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  const divIdx = seasonData.divisions.findIndex(d => d.id === divId);
  if (divIdx === -1) return res.status(404).json({ error: `Division ${divId} not found` });

  const div = { ...seasonData.divisions[divIdx] };
  const allowed = ['target_games'];
  for (const field of allowed) { if (field in req.body) div[field] = req.body[field]; }
  seasonData.divisions[divIdx] = div;

  const backup = SEASON_FILE.replace('.json', `.backup-${Date.now()}.json`);
  fs.copyFileSync(SEASON_FILE, backup);
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(seasonData, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not write season.json: ${err.message}` }); }
  res.json({ ok: true, division: div });
});

// ── Change request email (coach-initiated) ────────────────────────────────────

app.post('/api/change-request', requireAuth, (req, res) => {
  const s = getSession(req);
  const { game_id, reason, details, preferred_date, preferred_time, preferred_field } = req.body;
  if (!game_id || !reason) return res.status(400).json({ error: 'game_id and reason required' });

  const subject = `Change Request: Game #${game_id} — from ${s.name}`;
  const lines = [
    `A coach has submitted a schedule change request.`,
    ``,
    `From: ${s.name} (${s.email})`,
    `Game #: ${game_id}`,
    `Reason: ${reason}`,
  ];
  if (details)          lines.push(`Details: ${details}`);
  if (preferred_date)   lines.push(`Preferred date: ${preferred_date}`);
  if (preferred_time)   lines.push(`Preferred time: ${preferred_time}`);
  if (preferred_field)  lines.push(`Preferred field: ${preferred_field}`);
  lines.push('', '— Eastlake Scheduler');

  sendEmail({ to: EMAIL_REPLY_TO || ADMIN_EMAIL, subject, text: lines.join('\n') });
  res.json({ ok: true });
});

// ── Missing coach info submission ─────────────────────────────────────────────

app.post('/api/missing-info', requireAuth, (req, res) => {
  const s = getSession(req);
  const { team_name, division_name, coach, email, phone } = req.body;
  if (!team_name) return res.status(400).json({ error: 'team_name required' });
  if (!coach && !email && !phone) return res.status(400).json({ error: 'At least one field required' });

  const subject = `Missing Coach Info: ${team_name}`;
  const lines = [
    `A user has submitted missing coach information.`,
    ``,
    `Team: ${team_name}`,
    ...(division_name ? [`Division: ${division_name}`] : []),
  ];
  if (coach) lines.push(`Coach: ${coach}`);
  if (email) lines.push(`Email: ${email}`);
  if (phone) lines.push(`Phone: ${phone}`);
  lines.push('', `Submitted by: ${s.name} (${s.email})`, '', '— Eastlake Scheduler');

  sendEmail({ to: EMAIL_REPLY_TO || ADMIN_EMAIL, subject, text: lines.join('\n') });
  res.json({ ok: true });
});

// Manually notify coaches of an existing change log entry
app.post('/api/notify-change', requireAdmin, async (req, res) => {
  const { change_id } = req.body;
  let changes = [];
  try { changes = JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); } catch {}
  const change = changes.find(c => c.id === change_id);
  if (!change) return res.status(404).json({ error: 'Change not found' });

  const emails = [change.home_team?.email, change.away_team?.email].filter(Boolean);
  if (!emails.length) return res.status(400).json({ error: 'No email on file for either team' });

  const divName = change.division_name || change.division_id;
  const after   = change.after || {};
  const lines   = [
    'Hi coaches,', '',
    'Your game has been updated by the league admin:', '',
    `Game #${change.game_id} — ${divName}`,
    `${change.home_team?.name || 'Home'} (H) vs ${change.away_team?.name || 'Away'} (A)`, '',
    'Changes made:',
    ...(change.changed_fields || []).map(f => `  ${f.field}: ${f.from} → ${f.to}`),
    '', 'Current game info:',
    `  Date: ${after.day || ''} ${after.date || ''}`,
    `  Time: ${after.time || ''}`,
    `  Field: ${after.field_name || ''}`,
    '', 'Please update your calendars accordingly.', '', '— Eastlake League Admin',
  ];
  const result = await sendEmail({ to: emails, subject: `Schedule Update: Game #${change.game_id} — ${divName}`, text: lines.join('\n') });
  if (!result.ok) return res.status(500).json({ error: result.reason });
  res.json({ ok: true, sent_to: emails });
});

// ── Field CRUD (admin) ────────────────────────────────────────────────────────

app.post('/api/season/fields', requireAdmin, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const { name, sub_field, address, notes, coordinates } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Venue name is required' });
  const f = { id: 'field-' + Date.now(), name: name.trim(), address: (address || '').trim() };
  if (sub_field?.trim()) f.sub_field = sub_field.trim();
  if (notes?.trim()) f.notes = notes.trim();
  if (coordinates?.trim()) f.coordinates = coordinates.replace(/\s/g, '');
  data.fields = [...(data.fields || []), f];
  const backup = SEASON_FILE.replace('.json', `.backup-${Date.now()}.json`);
  fs.copyFileSync(SEASON_FILE, backup);
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true, field: f });
});

app.put('/api/season/fields/:id', requireAdmin, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const idx = (data.fields || []).findIndex(f => String(f.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Field not found' });
  const { name, sub_field, address, notes, coordinates } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Venue name is required' });
  const updated = { ...data.fields[idx], name: name.trim(), address: (address || '').trim() };
  if (sub_field?.trim()) updated.sub_field = sub_field.trim(); else delete updated.sub_field;
  if (notes?.trim()) updated.notes = notes.trim(); else delete updated.notes;
  if (coordinates?.trim()) updated.coordinates = coordinates.replace(/\s/g, ''); else delete updated.coordinates;
  delete updated.weekend_venue; delete updated.weekend_address;
  data.fields[idx] = updated;
  const backup = SEASON_FILE.replace('.json', `.backup-${Date.now()}.json`);
  fs.copyFileSync(SEASON_FILE, backup);
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }

  // Re-resolve field names in schedule.json for all games using this field
  if (fs.existsSync(SCHEDULE_FILE)) {
    try {
      const sched = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
      let changed = false;
      for (const g of sched.games || []) {
        if (String(g.field_id) === req.params.id) {
          g.field_name    = updated.sub_field ? `${updated.name} – ${updated.sub_field}` : (updated.name || g.field_id);
          g.field_address = updated.address || '';
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(sched, null, 2));
    } catch {} // schedule update is best-effort; don't fail the field save
  }

  res.json({ ok: true, field: updated });
});

app.delete('/api/season/fields/:id', requireAdmin, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const before = (data.fields || []).length;
  data.fields = (data.fields || []).filter(f => String(f.id) !== req.params.id);
  if (data.fields.length === before) return res.status(404).json({ error: 'Field not found' });
  const backup = SEASON_FILE.replace('.json', `.backup-${Date.now()}.json`);
  fs.copyFileSync(SEASON_FILE, backup);
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true });
});

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        let val = ''; i++;
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

app.post('/api/import-schedule', requireAdmin, express.text({ type: '*/*', limit: '10mb' }), (req, res) => {
  const csv = req.body;
  if (!csv || !csv.trim()) return res.status(400).json({ error: 'No CSV data received.' });

  const rows = parseCSV(csv);
  if (rows.length < 2) return res.status(400).json({ error: 'CSV appears empty or has no data rows.' });

  const headers = rows[0].map(h => h.trim().toLowerCase());
  const col = name => headers.indexOf(name);
  const C = {
    gameId:   col('game #'), division: col('division'), week: col('week'),
    date:     col('date'),   day:      col('day'),       time: col('time'),
    home:     col('home team'), away: col('away team'), field: col('field'),
    address:  col('address'), rematch: col('rematch'),
  };

  if (C.date < 0 || C.home < 0 || C.away < 0) {
    return res.status(400).json({ error: 'CSV is missing required columns (Date, Home Team, Away Team).' });
  }

  let seasonData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch { return res.status(500).json({ error: 'Could not read season.json.' }); }

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
    if (f.name)          fieldByName[f.name.toLowerCase()] = f;
    if (f.weekend_venue) fieldByName[f.weekend_venue.toLowerCase()] = f;
  }

  const games = [];
  const warnings = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const date = C.date >= 0 ? r[C.date]?.trim() : '';
    if (!date) continue;

    const divRaw = C.division >= 0 ? r[C.division]?.trim() : '';
    const div    = divByName[divRaw.toLowerCase()];
    const divId  = div ? div.id : divRaw;
    const homeRaw  = C.home  >= 0 ? r[C.home]?.trim()  : '';
    const awayRaw  = C.away  >= 0 ? r[C.away]?.trim()  : '';
    const fieldRaw = C.field >= 0 ? r[C.field]?.trim() : '';

    const divTeams = teamsByDiv[divId] || [];
    const findTeam = name => {
      const nl = name.toLowerCase();
      return divTeams.find(t => (t.label || '').toLowerCase() === nl || (t.name || '').toLowerCase() === nl || (t.team_name || '').toLowerCase() === nl);
    };

    const homeTeam = findTeam(homeRaw);
    const awayTeam = findTeam(awayRaw);
    const field    = fieldByName[fieldRaw.toLowerCase()];

    if (!homeTeam) warnings.push(`Row ${i + 1}: Home team "${homeRaw}" not matched in division "${divId}".`);
    if (!awayTeam) warnings.push(`Row ${i + 1}: Away team "${awayRaw}" not matched in division "${divId}".`);
    if (!field)    warnings.push(`Row ${i + 1}: Field "${fieldRaw}" not matched.`);

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

  if (fs.existsSync(SCHEDULE_FILE)) {
    const backup = SCHEDULE_FILE.replace('.json', `.backup-${Date.now()}.json`);
    try { fs.copyFileSync(SCHEDULE_FILE, backup); } catch {}
  }

  const result = { success: true, games, total_games: games.length, generated_at: new Date().toISOString(), source: 'csv_import', warnings: [], failures: [] };
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(result, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not save schedule: ${err.message}` }); }

  res.json({ ok: true, total_games: games.length, warnings });
});

app.listen(PORT, () => {
  console.log(`Eastlake League Scheduler running at http://localhost:${PORT}`);
});
