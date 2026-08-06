'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const V = require('./lib/validate');
const { Resend } = require('resend');
const { scheduleAll, validateGameEdit, dayName, teamName,
        resolveTeamAvailability, resolveFieldAvailability, nearestSaturdaySlot,
        SATURDAY_SLOTS, SATURDAY_SLOT_TIMES, WEEKDAY_TIME, TIME_BOUNDS, isValidGameTime, allowedTimes,
        buildSeasonWeeks, weekdayStartTimeForField, allowedWeekdayTimesForField,
        isExemptBackToBack, MAX_GAMES_PER_WEEK, DEFAULT_GAME_LENGTH_MINUTES, toMinutes } = require('./lib/scheduler');

const app = express();
// Deployed behind exactly one nginx hop. This MUST be the hop count (1), not
// `true`: nginx uses $proxy_add_x_forwarded_for, which APPENDS the real client
// IP to whatever X-Forwarded-For the client already sent. With `true`, Express
// trusts the whole chain and takes the left-most (client-supplied) entry, so
// anyone could spoof a fresh X-Forwarded-For per request and walk straight
// through the per-IP rate limits below — verified that this was exploitable
// before pinning it to 1. With 1, req.ip is the entry nginx itself appended,
// which a client cannot forge.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3010;
const BASE_PATH = process.env.BASE_PATH || '';

const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
const SEASON_FILE   = path.join(__dirname, 'season.json');
const CHANGES_FILE  = path.join(__dirname, 'changes.json');
const CHANGE_REQUESTS_FILE = path.join(__dirname, 'change_requests.json');

// ── Auth config (set via environment — never hardcode secrets here) ───────────
const ADMIN_EMAIL    = (process.env.ADMIN_EMAIL    || '').toLowerCase().trim();
const ADMIN_PASSWORD =  process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_SECRET =  process.env.SESSION_SECRET || 'eastlake-dev-secret';
// These two fallbacks are public (they're sitting right here in source) — if
// either env var is ever left unset, anyone could forge a valid signed admin
// session or just log in outright. Refuse to boot rather than silently run
// wide open; every real deploy (dev droplet, tests) already sets both.
if (process.env.ADMIN_PASSWORD === undefined || process.env.SESSION_SECRET === undefined) {
  console.error('FATAL: ADMIN_PASSWORD and SESSION_SECRET must both be set via environment — refusing to start with an insecure built-in fallback.');
  process.exit(1);
}
const SESSION_COOKIE = 'el_sess';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds
const IS_HTTPS = process.env.FORCE_HTTPS_COOKIE === '1' || process.env.NODE_ENV === 'production';

// ── Email config ──────────────────────────────────────────────────────────────
const RESEND_API_KEY  = process.env.RESEND_API_KEY  || '';
const EMAIL_FROM      = process.env.EMAIL_FROM      || 'schedule@tedriolo.com';
const EMAIL_REPLY_TO  = process.env.EMAIL_REPLY_TO  || '';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

async function sendEmail({ to, subject, text, html }) {
  if (!resend) return { ok: false, reason: 'No RESEND_API_KEY configured' };
  const toArr = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!toArr.length) return { ok: false, reason: 'No recipients' };
  try {
    const payload = { from: EMAIL_FROM, to: toArr, subject, text };
    if (html) payload.html = html;
    if (EMAIL_REPLY_TO) payload.reply_to = EMAIL_REPLY_TO;
    await resend.emails.send(payload);
    return { ok: true };
  } catch (err) {
    console.error('Email send error:', err.message);
    return { ok: false, reason: err.message };
  }
}

// Plain `===` on a secret leaks its comparison time byte-by-byte in theory —
// impractical to actually exploit over a network at this app's traffic, but
// crypto.timingSafeEqual costs nothing and removes the question entirely.
// Needs equal-length buffers, so a length mismatch is checked (and rejected)
// first rather than passed through to timingSafeEqual, which throws on it.
function secureEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Simple in-memory rate limiting for auth endpoints ─────────────────────────
// No external store — this runs as a single process, and a restart clearing
// counters is an acceptable tradeoff for a small league tool. Protects the
// admin password from brute force (login) and a coach/director's inbox from
// being mail-bombed by anyone who knows their email (request-verify) — both
// reachable without any prior authentication.
const rateLimitHits = new Map(); // key -> [timestamps]

function recentHits(key, windowMs) {
  const now = Date.now();
  const hits = (rateLimitHits.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length) rateLimitHits.set(key, hits); else rateLimitHits.delete(key);
  return hits;
}

// Checking and recording are deliberately separate so a limit can count only
// FAILED attempts. Counting successes too would let a busy legitimate user
// (or Ted signing in repeatedly) burn their own budget and lock themselves
// out, while doing nothing extra to slow an attacker down.
function overLimit(key, maxHits, windowMs) {
  return recentHits(key, windowMs).length >= maxHits;
}

function noteAttempt(key, windowMs) {
  const hits = recentHits(key, windowMs);
  hits.push(Date.now());
  rateLimitHits.set(key, hits);
  const now = Date.now();
  if (rateLimitHits.size > 5000) {
    for (const [k, v] of rateLimitHits) if (!v.length || now - v[v.length - 1] > 60 * 60 * 1000) rateLimitHits.delete(k);
  }
}

function rateLimited(key, maxHits, windowMs) {
  noteAttempt(key, windowMs);
  return recentHits(key, windowMs).length > maxHits;
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
  if (!secureEqual(sig, expected)) return null;
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
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE}; SameSite=Lax${IS_HTTPS ? '; Secure' : ''}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0${IS_HTTPS ? '; Secure' : ''}`);
}

// ── Magic-link verification tokens (in-memory, short-lived) ──────────────────
// One Map for both purposes, discriminated by `type`: logging in as your own
// verified session, or confirming a team's new email address.
const VERIFY_TOKEN_TTL_MS = 15 * 60 * 1000;
const verifyTokens = new Map(); // token -> { type, exp, ...payload }

// A 6-digit code is generated alongside the link and emailed in the same
// message. Ted: clicking a link navigates away from whatever page you were
// filling in; typing a code lets you verify without ever leaving it. Both
// redeem the same underlying entry — whichever gets used first invalidates
// the other, since it's the same one-time record either way.
function randomCode() {
  return String(crypto.randomInt(100000, 1000000)); // always 6 digits, no leading zero
}

function createVerifyToken(email) {
  const token = crypto.randomBytes(24).toString('base64url');
  const code = randomCode();
  verifyTokens.set(token, { type: 'login-verify', email, code, exp: Date.now() + VERIFY_TOKEN_TTL_MS });
  return { token, code };
}

function redeemVerifyToken(token, email) {
  const entry = verifyTokens.get(token);
  if (!entry || entry.type !== 'login-verify') return false;
  verifyTokens.delete(token); // one-time use
  if (entry.exp < Date.now()) return false;
  return entry.email === email;
}

// Codes aren't a Map key (they're short and meant to be typed, not looked up
// by), so this scans the small set of pending verifications for a match
// scoped to the requesting session's own email — a code from someone else's
// pending verification can never redeem yours.
function redeemVerifyCode(email, code) {
  const trimmed = String(code || '').trim();
  if (!trimmed) return false;
  for (const [token, entry] of verifyTokens) {
    if (entry.type === 'login-verify' && entry.email === email && entry.code === trimmed) {
      verifyTokens.delete(token); // one-time use, same record the link would have redeemed
      return entry.exp >= Date.now();
    }
  }
  return false;
}

function createEmailChangeToken(teamId, newEmail) {
  const token = crypto.randomBytes(24).toString('base64url');
  verifyTokens.set(token, { type: 'email-change', team_id: teamId, newEmail, exp: Date.now() + VERIFY_TOKEN_TTL_MS });
  return token;
}

// Returns { team_id, newEmail } on success, or null if the token is missing/expired/wrong type.
function redeemEmailChangeToken(token) {
  const entry = verifyTokens.get(token);
  if (!entry || entry.type !== 'email-change') return null;
  verifyTokens.delete(token); // one-time use
  if (entry.exp < Date.now()) return null;
  return { team_id: entry.team_id, newEmail: entry.newEmail };
}

// ── Game change requests (persisted — these links must stay valid for up to
// a week, so unlike the short-lived tokens above they live on the record
// itself in change_requests.json, not the in-memory Map, and survive restarts.
// ── Snapshots (real, restorable backups) ─────────────────────────────────────
// A snapshot captures season + schedule + change requests *together*, so a
// restore can never leave a schedule referencing teams that no longer exist.
// This replaces the old scattered `.backup-<ts>.json` files, which were written
// on nearly every edit and had no restore path at all.
const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const MAX_AUTO_SNAPSHOTS = 20;

function readJsonSafe(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}

function createSnapshot(label, kind = 'auto') {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const season = readJsonSafe(SEASON_FILE, null);
    const schedule = readJsonSafe(SCHEDULE_FILE, null);
    const changeRequests = readJsonSafe(CHANGE_REQUESTS_FILE, []);
    const id = `snap-${Date.now()}`;
    const snap = {
      id, label: label || 'Snapshot', kind,
      created_at: new Date().toISOString(),
      summary: {
        teams: season?.teams?.length || 0,
        games: schedule?.games?.length || 0,
        programs: season?.programs?.length || 0,
        open_requests: changeRequests.filter(c => String(c.status || '').startsWith('awaiting')).length,
      },
      season, schedule, change_requests: changeRequests,
    };
    fs.writeFileSync(path.join(SNAPSHOT_DIR, `${id}.json`), JSON.stringify(snap, null, 2));
    pruneAutoSnapshots();
    return snap;
  } catch (err) {
    console.error('Snapshot failed:', err.message);
    return null;
  }
}

// Manual snapshots are kept forever — Ted took those deliberately. Automatic
// ones are capped so the directory doesn't grow without bound.
function pruneAutoSnapshots() {
  try {
    const autos = listSnapshots().filter(s => s.kind === 'auto');
    for (const old of autos.slice(MAX_AUTO_SNAPSHOTS)) {
      fs.unlinkSync(path.join(SNAPSHOT_DIR, `${old.id}.json`));
    }
  } catch {}
}

// Newest first. Metadata only — the payload can be large.
function listSnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs.readdirSync(SNAPSHOT_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const d = readJsonSafe(path.join(SNAPSHOT_DIR, f), null);
      return d ? { id: d.id, label: d.label, kind: d.kind, created_at: d.created_at, summary: d.summary } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function readChangeRequests() {
  if (!fs.existsSync(CHANGE_REQUESTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CHANGE_REQUESTS_FILE, 'utf8')); }
  catch { return []; }
}
function writeChangeRequests(list) {
  fs.writeFileSync(CHANGE_REQUESTS_FILE, JSON.stringify(list, null, 2));
}
function newActionToken() {
  return crypto.randomBytes(24).toString('base64url');
}
function daysBetween(isoA, isoB) {
  return Math.floor((new Date(isoB) - new Date(isoA)) / (24 * 60 * 60 * 1000));
}
function crTeamContact(t) {
  if (!t) return null;
  return { id: t.id, name: teamName(t), coach: t.coach || '', email: t.email || '', phone: t.phone || '', program_id: t.program_id || null };
}

// A team's email doubles as its coach's login identity, so changing it never
// takes effect until the *new* address proves it's reachable. Shared by every
// route that can change a team email (coach self-edit, director edit, admin
// season editor) so the safeguard can't be sidestepped through a different door.
async function sendTeamEmailChangeConfirmation(req, team, newEmail) {
  const token = createEmailChangeToken(team.id, newEmail);
  const confirmUrl = `${req.protocol}://${req.get('host')}${BASE_PATH}/api/teams/${team.id}/confirm-email?token=${token}`;
  return sendEmail({
    to: newEmail,
    subject: `Confirm your new email — ${team.label || teamName(team)}`,
    text: `Click the link below to confirm this email address for ${team.label || teamName(team)}:\n\n${confirmUrl}\n\nThis link expires in 15 minutes and can only be used once. If you didn't request this change, you can ignore this email — nothing will happen until the link above is clicked.\n\n— Eastlake Scheduler`,
  });
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

function requireDirector(req, res, next) {
  const s = getSession(req);
  if (s?.role === 'admin' || s?.role === 'director') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Director access required' });
  res.redirect(BASE_PATH + '/login');
}

// Verified = proved ownership of the email via magic link (or admin password).
// Viewing only needs requireAuth; making a change needs requireVerified.
function requireVerified(req, res, next) {
  const s = getSession(req);
  if (s?.verified) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Please verify your email before making changes' });
  res.redirect(BASE_PATH + '/login');
}

// Look up a director or coach by email in season.json
function findByEmail(email) {
  try {
    const data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    const dir = (data.directors || []).find(d => (d.email || '').toLowerCase().trim() === email && d.active !== false);
    if (dir) return { role: 'director', name: dir.name || 'Director', phone: dir.phone || '', program_id: dir.program_id || null };
    const team = (data.teams || []).find(t => (t.email || '').toLowerCase().trim() === email);
    if (team) return { role: 'coach', name: team.coach || team.label || 'Coach', team_id: team.id, phone: team.phone || '' };
  } catch {}
  return null;
}


// ── Referential integrity ────────────────────────────────────────────────────
// Teams and fields used to delete unconditionally, leaving the schedule holding
// ids that no longer resolve — games rendering as blank teams, and stats
// silently wrong. These report what is blocking so the user can act on it.

function readScheduleSafe() {
  try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch { return null; }
}
function readChangeRequestsSafe() {
  try { return JSON.parse(fs.readFileSync(CHANGE_REQUESTS_FILE, 'utf8')); } catch { return []; }
}
function openRequestsFor(pred) {
  const list = readChangeRequestsSafe();
  const arr = Array.isArray(list) ? list : (list.requests || []);
  return arr.filter(r => !['approved', 'applied', 'cancelled', 'rejected'].includes(r.status) && pred(r));
}

// Returns an array of human-readable blockers ([] means safe to delete).
function teamDeleteBlockers(teamId, seasonData) {
  const blockers = [];
  const sched = readScheduleSafe();
  const games = (sched?.games || []).filter(g =>
    String(g.home_team_id) === String(teamId) || String(g.away_team_id) === String(teamId));
  if (games.length) blockers.push(`${games.length} scheduled game${games.length === 1 ? '' : 's'}`);
  const reqs = openRequestsFor(r => String(r.team_id) === String(teamId));
  if (reqs.length) blockers.push(`${reqs.length} open change request${reqs.length === 1 ? '' : 's'}`);
  return blockers;
}

function fieldDeleteBlockers(fieldId, seasonData) {
  const blockers = [];
  const sched = readScheduleSafe();
  const games = (sched?.games || []).filter(g => String(g.field_id) === String(fieldId));
  if (games.length) blockers.push(`${games.length} scheduled game${games.length === 1 ? '' : 's'}`);
  const homeTo = (seasonData.teams || []).filter(t => String(t.home_field_id) === String(fieldId));
  if (homeTo.length) blockers.push(`${homeTo.length} team${homeTo.length === 1 ? '' : 's'} using it as a home field`);
  return blockers;
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
  <p style="margin-top:16px;font-size:13px;color:#94a3b8">
    New here? <a href="guide.html" style="color:#2d6cf0;text-decoration:none">Read the guide</a>
  </p>

  <script>
    const NEXT = ${JSON.stringify(next || '')};

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
          const lr   = await fetch('api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, next: NEXT }) });
          const ld   = await lr.json();
          if (ld.ok) { window.location = ld.redirect; }
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
        if (data.ok) { window.location = data.redirect; }
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

// admin.html, director.html, and my-team.html are served from views/, not
// public/ — express.static below only serves the public/ directory, so none
// of these have a static path a role could guess/bypass their way into.
// requireAdmin/requireDirector/requireAuth below are the real gate; the
// separate directory means there's no static fallback that could ever bypass
// them (same reasoning as admin-guide.html, which started this pattern).
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));
app.get('/admin/', (req, res) => res.redirect((BASE_PATH || '') + '/admin'));

app.get('/director', requireDirector, (req, res) => res.sendFile(path.join(__dirname, 'views', 'director.html')));
app.get('/director/', (req, res) => res.redirect((BASE_PATH || '') + '/director'));

app.get('/guide', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guide.html')));

app.get('/admin-guide', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin-guide.html')));

app.get('/my-team', requireAuth, (req, res) => {
  const s = getSession(req);
  if (s.role !== 'coach') return res.redirect(BASE_PATH + '/');
  res.sendFile(path.join(__dirname, 'views', 'my-team.html'));
});

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

  // A generous per-IP ceiling, purely an abuse guard. Deliberately loose:
  // a coach/director login has no secret to guess (their email IS the
  // credential, by design), so throttling it buys almost nothing, while
  // whole schools and mobile carriers share one public IP — a tight limit
  // here would lock out real people during registration week.
  const LOGIN_WINDOW = 15 * 60 * 1000;
  if (overLimit(`login:${req.ip}`, 60, LOGIN_WINDOW)) {
    return res.status(429).json({ error: 'Too many login attempts from this connection. Try again in a few minutes.' });
  }
  noteAttempt(`login:${req.ip}`, LOGIN_WINDOW);

  if (ADMIN_EMAIL && email === ADMIN_EMAIL) {
    // The admin password is the one real secret in the system, so it gets a
    // tight budget — but only FAILURES count against it, so Ted signing in
    // normally can never lock himself out.
    if (overLimit(`admin-fail:${req.ip}`, 5, LOGIN_WINDOW)) {
      return res.status(429).json({ error: 'Too many failed password attempts. Try again in a few minutes.' });
    }
    if (!secureEqual(password, ADMIN_PASSWORD)) {
      noteAttempt(`admin-fail:${req.ip}`, LOGIN_WINDOW);
      return res.status(401).json({ error: 'Incorrect password' });
    }
    // Password already proves identity — no separate verify step needed.
    setSession(res, { email, role: 'admin', name: 'Admin', verified: true });
    return res.json({ ok: true, redirect: BASE_PATH + (next === 'admin' ? '/admin' : '/') });
  }

  const match = findByEmail(email);
  if (!match) return res.status(401).json({ error: 'Email not recognized' });
  // Email-only login grants view access. Making changes requires verifying via magic link.
  setSession(res, { email, role: match.role, name: match.name, phone: match.phone || '', team_id: match.team_id || null, program_id: match.program_id || null, verified: false });
  const defaultRedirect = match.role === 'director' ? '/director' : '/';
  return res.json({ ok: true, redirect: BASE_PATH + (next === 'director' ? '/director' : (next || defaultRedirect)) });
});

// Request a magic-link email to upgrade the current session to "verified" (can make changes)
app.post('/api/auth/request-verify', requireAuth, async (req, res) => {
  const s = getSession(req);
  if (s.verified) return res.json({ ok: true, alreadyVerified: true });
  if (rateLimited(`verify:${s.email}`, 5, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many verification emails requested for this address. Try again in a few minutes.' });
  }
  const { token, code } = createVerifyToken(s.email);
  const next = (req.body && req.body.next) || '';
  const verifyUrl = `${req.protocol}://${req.get('host')}${BASE_PATH}/api/auth/verify?token=${token}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
  const result = await sendEmail({
    to: s.email,
    subject: 'Verify your email — Eastlake League Scheduler',
    text: `Hi ${s.name},\n\nClick the link below to verify your email so you can make schedule changes:\n\n${verifyUrl}\n\n` +
      `Or, if you'd rather stay on the page you were on, enter this code there instead: ${code}\n\n` +
      `Either one expires in 15 minutes and can only be used once — using one cancels the other.\n\n— Eastlake Scheduler`,
  });
  if (!result.ok) return res.status(500).json({ error: 'Could not send verification email', reason: result.reason });
  res.json({ ok: true });
});

// Redeem a magic link — upgrades the current session to verified:true
app.get('/api/auth/verify', (req, res) => {
  const s = getSession(req);
  const token = req.query.token || '';
  if (!s) return res.redirect(BASE_PATH + '/login');
  if (!token || !redeemVerifyToken(token, s.email)) {
    return res.status(400).send('This verification link is invalid or has expired. Please request a new one.');
  }
  setSession(res, { ...s, verified: true });
  res.redirect(BASE_PATH + (req.query.next || '/'));
});

// Same upgrade as the link above, but redeemed without leaving the page —
// the whole reason this exists. Scoped to the caller's own session email, so
// a code only ever verifies the person it was actually sent to.
app.post('/api/auth/verify-code', requireAuth, (req, res) => {
  const s = getSession(req);
  if (s.verified) return res.json({ ok: true, alreadyVerified: true });
  const code = (req.body && req.body.code) || '';
  if (!redeemVerifyCode(s.email, code)) {
    return res.status(400).json({ error: 'That code is wrong or has expired. Request a new one and try again.' });
  }
  setSession(res, { ...s, verified: true });
  res.json({ ok: true });
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
    program_id: s.program_id || null,
    verified:   !!s.verified,
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
      // Same gap as /api/season had (public/viewer.js:135 reads season.end for
      // its date-range header) — missed the first time because it wasn't
      // caught by grepping for the literal pattern, only found once actually
      // looking at the live page.
      season: data.season ? { ...data.season, end: seasonEndDate(data.season) } : data.season,
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

// There is no stored season "end" date — only start + weeks — so several
// places (the admin season bar, the season-summary API response) used to read
// `season.end` and get `undefined`, rendering as "NaN/NaN/". Computed once
// here from buildSeasonWeeks (the same calendar every other date-dependent
// route already treats as authoritative) rather than duplicated per caller,
// so a future date-math tweak only has to happen in one place.
function seasonEndDate(season) {
  const weeks = buildSeasonWeeks(season);
  const last = weeks[weeks.length - 1];
  return last ? (last.saturday || last.weekdays?.[last.weekdays.length - 1] || null) : null;
}

app.get('/api/season', requireAuth, (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    if (data.season) data.season = { ...data.season, end: seasonEndDate(data.season) };
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/season/slots', requireAuth, (req, res) => {
  let seasonCfg = {};
  try { seasonCfg = (JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')).season) || {}; } catch {}
  const result = buildSeasonWeeks(seasonCfg).map(wk => {
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

// ── Viable-slot engine ───────────────────────────────────────────────────────
// Single source of truth for "when could this game actually be played?".
// Enforces exactly what the scheduler enforces — global/team blackouts, each
// team's existing games, no back-to-back days, both teams' weekly availability
// (including host/travel orientation), and the home field being open — so a
// coach or admin can never be offered a slot the scheduler itself would refuse.
//
// opts.minDaysOut  — skip anything closer than this many days (change requests
//                    use 7; the admin editor passes 0 since it can place freely).
function computeViableSlots(game, seasonData, schedData, opts = {}) {
  const { minDaysOut = 0, homeTeamId, awayTeamId } = opts;
  const teams = seasonData.teams || [];
  const fields = seasonData.fields || [];
  const season = seasonData.season || {};
  const gameLengthMinutes = (seasonData.divisions || []).find(d => d.id === game.division_id)?.game_length_minutes;
  const divisionLengths = new Map((seasonData.divisions || []).map(d => [d.id, d.game_length_minutes]));
  const gameLengthFor = g => divisionLengths.get(g.division_id) || DEFAULT_GAME_LENGTH_MINUTES;

  const home_team_id = homeTeamId !== undefined ? homeTeamId : game.home_team_id;
  const away_team_id = awayTeamId !== undefined ? awayTeamId : game.away_team_id;
  const homeTeam = teams.find(t => t.id === home_team_id);
  const awayTeam = teams.find(t => t.id === away_team_id);

  const globalBlackouts = new Set(season.blackout_dates || []);
  for (const weekend of (season.blackout_weekends || [])) {
    if (weekend.saturday) globalBlackouts.add(weekend.saturday);
    if (weekend.sunday)   globalBlackouts.add(weekend.sunday);
    if (Array.isArray(weekend.dates)) for (const d of weekend.dates) globalBlackouts.add(d);
  }

  const homeBlackouts = new Set(homeTeam?.blackout_dates || []);
  const awayBlackouts = new Set(awayTeam?.blackout_dates || []);

  // Cancelled games don't occupy their old slot — a rained-out game shouldn't
  // block anyone (including its own makeup) from reusing that date/field.
  const otherGames = schedData.games.filter(g => g.game_id !== game.game_id && g.status !== 'cancelled');
  const homeDates = new Set(otherGames
    .filter(g => g.home_team_id === home_team_id || g.away_team_id === home_team_id).map(g => g.date));
  const awayDates = new Set(otherGames
    .filter(g => g.home_team_id === away_team_id || g.away_team_id === away_team_id).map(g => g.date));
  // Per-week game counts, for the same MAX_GAMES_PER_WEEK cap the scheduler
  // itself enforces — a coach negotiating a change should never land on a
  // week that's already full, same as the initial auto-schedule never would.
  const weekCountsFor = teamId => {
    const counts = {};
    for (const g of otherGames) {
      if (g.home_team_id === teamId || g.away_team_id === teamId) counts[g.week] = (counts[g.week] || 0) + 1;
    }
    return counts;
  };
  const homeWeekCounts = weekCountsFor(home_team_id);
  const awayWeekCounts = weekCountsFor(away_team_id);

  const homeFieldId = homeTeam?.home_field_id ?? null;
  const homeFieldObj = homeFieldId ? fields.find(f => f.id === homeFieldId) : null;
  const homeFieldName = homeFieldObj
    ? (homeFieldObj.sub_field ? `${homeFieldObj.name} – ${homeFieldObj.sub_field}` : homeFieldObj.name)
    : null;

  const today = new Date().toISOString().slice(0, 10);

  const slotsOut = [];
  for (const wk of buildSeasonWeeks(season)) {
    // Saturdays expand into their three real slots, so a coach can pick which
    // part of the day rather than being handed a single division-fixed time.
    // A weekday's default kickoff is pulled earlier when the home field's
    // civil twilight would otherwise cut the game off mid-play (same
    // adjustment the scheduler itself applies) — the date is dropped
    // entirely if even the earliest allowed kickoff would run past dark.
    const daySlots = wk.weekdays
      .map(d => ({ date: d, day: dayName(d), type: 'weekday', slotKey: null,
                   time: weekdayStartTimeForField(WEEKDAY_TIME, gameLengthMinutes, homeFieldObj, d) }))
      .filter(s => s.time !== null);
    if (wk.saturday) {
      for (const k of SATURDAY_SLOTS) {
        daySlots.push({ date: wk.saturday, day: 'Saturday', type: 'saturday', slotKey: k, time: SATURDAY_SLOT_TIMES[k] });
      }
    }

    for (const { date, day, type, slotKey, time } of daySlots) {
      if (date <= today) continue;
      if (minDaysOut > 0 && daysBetween(new Date().toISOString(), date) < minDaysOut) continue;
      if (globalBlackouts.has(date)) continue;
      if (homeBlackouts.has(date) || awayBlackouts.has(date)) continue;
      // A team can't play twice in a day even across Saturday slots.
      if (homeDates.has(date) || awayDates.has(date)) continue;

      // Consecutive-day check — Friday->Saturday is exempt (Ted, 2026-08-04):
      // a Friday game no longer closes off the Saturday right after it.
      const prevDay = adjacentDateStr(date, -1);
      const nextDay = adjacentDateStr(date, +1);
      const prevExempt = isExemptBackToBack(date, prevDay);
      const nextExempt = isExemptBackToBack(date, nextDay);
      if ((homeDates.has(prevDay) && !prevExempt) || (homeDates.has(nextDay) && !nextExempt)) continue;
      if ((awayDates.has(prevDay) && !prevExempt) || (awayDates.has(nextDay) && !nextExempt)) continue;

      // Weekly cap — same MAX_GAMES_PER_WEEK the scheduler itself enforces.
      if ((homeWeekCounts[wk.week] || 0) >= MAX_GAMES_PER_WEEK) continue;
      if ((awayWeekCounts[wk.week] || 0) >= MAX_GAMES_PER_WEEK) continue;

      // Availability resolved against this concrete date, not the weekday pattern.
      if (homeTeam && awayTeam) {
        const homeStatus = resolveTeamAvailability(homeTeam, date, type, slotKey);
        const awayStatus = resolveTeamAvailability(awayTeam, date, type, slotKey);
        if (homeStatus === 'none' || homeStatus === 'travel') continue;
        if (awayStatus === 'none' || awayStatus === 'host') continue;
        if (homeFieldObj && !resolveFieldAvailability(homeFieldObj, date, type, slotKey)) continue;
      }

      // The home field can host other games that day now (different slots) —
      // but "different slot" has to mean real non-overlapping time ranges,
      // not just a different time *string*. Divisions can have different
      // game lengths and independently sunset-adjusted weekday kickoffs, so
      // two games can show different times and still physically overlap on
      // the same field (e.g. an 80-min game at 17:45 running to 19:05
      // against a 50-min game starting 18:00) — checked as real intervals so
      // that case is actually caught instead of quietly offering it.
      if (homeFieldId && otherGames.some(g =>
        g.field_id === homeFieldId && g.date === date && g.time &&
        timeRangesOverlap(time, gameLengthMinutes, g.time, gameLengthFor(g))
      )) continue;

      const fieldGames = homeFieldId
        ? otherGames.filter(g => g.field_id === homeFieldId && g.date === date)
            .map(g => ({ game_id: g.game_id, time: g.time || '', home: g.home_team_name, away: g.away_team_name }))
            .sort((a, b) => a.time.localeCompare(b.time))
        : [];

      slotsOut.push({ date, day, week: wk.week, type, slot_key: slotKey, time,
                      allowed_times: type === 'weekday'
                        ? allowedWeekdayTimesForField(gameLengthMinutes, homeFieldObj, date)
                        : allowedTimes(type),
                      field_id: homeFieldId, field_games: fieldGames });
    }
  }
  return { slots: slotsOut, home_field_name: homeFieldName };
}

app.get('/api/game/:id/suggest-dates', requireDirector, requireVerified, (req, res) => {
  const s = getSession(req);
  const gameId = parseInt(req.params.id, 10);

  let schedData, seasonData;
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read schedule.json: ${err.message}` }); }
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  const game = schedData.games.find(g => g.game_id === gameId);
  if (!game) return res.status(404).json({ error: `Game ${gameId} not found` });

  if (s.role === 'director') {
    const teams = seasonData.teams || [];
    const homeT = teams.find(t => t.id === game.home_team_id);
    const awayT = teams.find(t => t.id === game.away_team_id);
    const owns = (homeT && canManageProgram(s, homeT.program_id)) || (awayT && canManageProgram(s, awayT.program_id));
    if (!owns) return res.status(403).json({ error: 'You can only get suggestions for games involving one of your own program\'s teams' });
  }

  // The editor may have changed the teams before clicking Suggest.
  const rawHomeId = req.query.home_team_id;
  const rawAwayId = req.query.away_team_id;
  const opts = {};
  if (rawHomeId) opts.homeTeamId = isNaN(parseInt(rawHomeId, 10)) ? rawHomeId : parseInt(rawHomeId, 10);
  if (rawAwayId) opts.awayTeamId = isNaN(parseInt(rawAwayId, 10)) ? rawAwayId : parseInt(rawAwayId, 10);

  const { slots, home_field_name } = computeViableSlots(game, seasonData, schedData, opts);
  res.json({ suggestions: slots, home_field_name });
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
  createSnapshot('Before running scheduler', 'auto');
  let seasonData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  let result;
  try { result = scheduleAll(seasonData); }
  catch (err) { return res.status(500).json({ error: `Scheduler error: ${err.message}` }); }

  // Strip every scheduler-internal field (_fieldKey, _intervalStart,
  // _intervalEnd, and anything added later) rather than naming them one by
  // one — the previous enumerate-by-hand version silently started leaking
  // two new underscore fields into schedule.json the moment the field-
  // conflict check grew from a boolean to real time intervals.
  for (const g of result.games) {
    for (const k of Object.keys(g)) if (k.startsWith('_')) delete g[k];
  }
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(result, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not write schedule.json: ${err.message}` }); }
  res.json(result);
});

app.post('/api/upload-season', requireAdmin, (req, res) => {
  createSnapshot('Before uploading season.json', 'auto');
  const data = req.body;
  const missing = ['season', 'programs', 'divisions', 'fields', 'teams'].filter(k => !data[k]);
  if (missing.length) return res.status(400).json({ error: `Missing required keys: ${missing.join(', ')}` });
  if (!Array.isArray(data.divisions) || data.divisions.length === 0) return res.status(400).json({ error: 'divisions must be a non-empty array' });
  if (!Array.isArray(data.teams) || data.teams.length === 0) return res.status(400).json({ error: 'teams must be a non-empty array' });

  const divisionIds = new Set(data.divisions.map(d => d.id));
  const badTeams = data.teams.filter(t => t.division_id && !divisionIds.has(t.division_id));
  if (badTeams.length) return res.status(400).json({
    error: `${badTeams.length} team(s) reference unknown division IDs: ` + [...new Set(badTeams.map(t => t.division_id))].join(', '),
  });

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
      season_end: seasonEndDate(data.season),
      target_games: data.season?.target_games,
    },
  });
});

// Directors get the same manual create/edit/force authority as admin here —
// Ted was explicit that this is a director+admin thing, "but, crucially, not
// coaches" (coaches stay entirely on the negotiated Request Change/Rain Out
// path, which hard-enforces every rule with no force option). Scoped below
// to games touching at least one of the director's own program's teams.
app.post('/api/game', requireDirector, requireVerified, (req, res) => {
  const s = getSession(req);
  const { division_id, date, time, field_id, home_team_id, away_team_id, force } = req.body;
  if (!division_id || !date || !time || !field_id || home_team_id == null || away_team_id == null)
    return res.status(400).json({ error: 'division_id, date, time, field_id, home_team_id, and away_team_id are required' });

  let schedData, seasonData;
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read schedule.json: ${err.message}` }); }
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  const home_team_id_p = isNaN(parseInt(home_team_id, 10)) ? home_team_id : parseInt(home_team_id, 10);
  const away_team_id_p = isNaN(parseInt(away_team_id, 10)) ? away_team_id : parseInt(away_team_id, 10);
  const field_id_p = isNaN(parseInt(field_id, 10)) ? field_id : parseInt(field_id, 10);

  if (s.role === 'director') {
    const teams = seasonData.teams || [];
    const homeT = teams.find(t => t.id === home_team_id_p);
    const awayT = teams.find(t => t.id === away_team_id_p);
    const owns = (homeT && canManageProgram(s, homeT.program_id)) || (awayT && canManageProgram(s, awayT.program_id));
    if (!owns) return res.status(403).json({ error: 'You can only schedule games involving one of your own program\'s teams' });
  }

  const gameId = Math.max(0, ...schedData.games.map(g => g.game_id || 0)) + 1;

  const gameForValidation = { id: gameId, date, time, field_id: field_id_p, home_team_id: home_team_id_p, away_team_id: away_team_id_p, division_id, week: null };
  const seasonForValidation = { ...seasonData.season, _teams: seasonData.teams || [], _fields: seasonData.fields || [], _divisions: seasonData.divisions || [] };
  const violations = validateGameEdit(gameForValidation, schedData.games, seasonForValidation);
  if (violations.length && !force) return res.status(409).json({ violations });

  let newWeek = null;
  for (const wk of buildSeasonWeeks(seasonData.season)) {
    if (wk.weekdays.includes(date) || wk.saturday === date) { newWeek = wk.week; break; }
  }

  const fieldObj = (seasonData.fields || []).find(f => f.id === field_id_p || f.id === field_id);
  const homeTeam = (seasonData.teams || []).find(t => t.id === home_team_id_p);
  const awayTeam = (seasonData.teams || []).find(t => t.id === away_team_id_p);

  const resolvedFieldName    = fieldObj ? (fieldObj.sub_field ? `${fieldObj.name} – ${fieldObj.sub_field}` : (fieldObj.name || field_id)) : field_id;
  const resolvedFieldAddress = fieldObj ? (fieldObj.address || '') : '';

  const newGame = {
    game_id: gameId, status: 'scheduled', division_id, week: newWeek,
    date, day: dayName(date), time,
    field_id: field_id_p, field_name: resolvedFieldName, field_address: resolvedFieldAddress,
    home_team_id: home_team_id_p, home_team_name: homeTeam ? teamName(homeTeam) : String(home_team_id_p),
    away_team_id: away_team_id_p, away_team_name: awayTeam ? teamName(awayTeam) : String(away_team_id_p),
    is_rematch: false,
  };

  schedData.games.push(newGame);
  schedData.games.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
  schedData.total_games = schedData.games.length;
  schedData.generated_at = new Date().toISOString();

  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedData, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not write schedule.json: ${err.message}` }); }

  function teamContact(t) {
    if (!t) return null;
    return { id: t.id, name: teamName(t), coach: t.coach || '', email: t.email || '', phone: t.phone || '' };
  }

  const changeRecord = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    type: 'addition',
    game_id: gameId,
    division_id,
    division_name: (() => {
      const d = (seasonData.divisions || []).find(d => d.id === division_id);
      return d ? (d.name || d.label || d.id) : division_id;
    })(),
    before: null,
    after: { ...newGame },
    changed_fields: [],
    home_team: teamContact(homeTeam),
    away_team: teamContact(awayTeam),
    forced: !!force,
  };

  let allChanges = [];
  try { if (fs.existsSync(CHANGES_FILE)) allChanges = JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); } catch {}
  allChanges.push(changeRecord);
  try { fs.writeFileSync(CHANGES_FILE, JSON.stringify(allChanges, null, 2)); } catch {}

  res.json({ ok: true, game: newGame, violations, change: changeRecord });
});

app.put('/api/game/:id', requireDirector, requireVerified, (req, res) => {
  const s = getSession(req);
  const gameId = parseInt(req.params.id, 10);
  const { date, time, force } = req.body;
  // Coerce the same way POST /api/game does — ids come from the client as
  // whatever type its <select> produced, and a raw type mismatch here would
  // silently fail every downstream .find(t => t.id === ...) lookup instead
  // of erroring, since both branches already handle "no team object found".
  const rawHome = req.body.home_team_id, rawAway = req.body.away_team_id, rawField = req.body.field_id;
  const home_team_id = isNaN(parseInt(rawHome, 10)) ? rawHome : parseInt(rawHome, 10);
  const away_team_id = isNaN(parseInt(rawAway, 10)) ? rawAway : parseInt(rawAway, 10);
  const field_id = isNaN(parseInt(rawField, 10)) ? rawField : parseInt(rawField, 10);

  let schedData;
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read schedule.json: ${err.message}` }); }

  let seasonData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  const gameIdx = schedData.games.findIndex(g => g.game_id === gameId);
  if (gameIdx === -1) return res.status(404).json({ error: `Game ${gameId} not found` });

  const existingGame = schedData.games[gameIdx];

  if (s.role === 'director') {
    const teams = seasonData.teams || [];
    const homeT = teams.find(t => t.id === existingGame.home_team_id);
    const awayT = teams.find(t => t.id === existingGame.away_team_id);
    const owns = (homeT && canManageProgram(s, homeT.program_id)) || (awayT && canManageProgram(s, awayT.program_id));
    if (!owns) return res.status(403).json({ error: 'You can only edit games involving one of your own program\'s teams' });
  }

  const beforeSnap = {
    date: existingGame.date, day: existingGame.day, time: existingGame.time,
    field_id: existingGame.field_id, field_name: existingGame.field_name,
    home_team_id: existingGame.home_team_id, home_team_name: existingGame.home_team_name,
    away_team_id: existingGame.away_team_id, away_team_name: existingGame.away_team_name,
    week: existingGame.week,
  };

  const editedGame = { id: gameId, date, time, field_id, home_team_id, away_team_id, division_id: existingGame.division_id, week: existingGame.week };
  const seasonForValidation = { ...seasonData.season, _teams: seasonData.teams || [], _fields: seasonData.fields || [], _divisions: seasonData.divisions || [] };
  const violations = validateGameEdit(editedGame, schedData.games, seasonForValidation);
  if (violations.length && !force) return res.status(409).json({ violations });

  let newWeek = existingGame.week;
  for (const wk of buildSeasonWeeks(seasonData.season)) {
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

// Rain-out reschedule: cancels the original game in place (kept in
// schedule.json as history — status 'cancelled' — rather than deleted, so
// there's a record of what was originally on the calendar) and creates a
// new linked "makeup" game at the chosen date/time/field. The two records
// point at each other (rescheduled_to_game_id / rescheduled_from_game_id) so
// either can be traced from the other.
app.post('/api/game/:id/rainout', requireAdmin, (req, res) => {
  createSnapshot('Before rain-out reschedule', 'auto');
  const gameId = parseInt(req.params.id, 10);
  const { reason, date, time, field_id, force } = req.body;
  if (!date || !time) return res.status(400).json({ error: 'date and time are required' });

  let schedData, seasonData;
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read schedule.json: ${err.message}` }); }
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  const gameIdx = schedData.games.findIndex(g => g.game_id === gameId);
  if (gameIdx === -1) return res.status(404).json({ error: `Game ${gameId} not found` });

  const original = schedData.games[gameIdx];
  if (original.status === 'cancelled')
    return res.status(400).json({ error: `Game ${gameId} has already been rained out.` });

  const field_id_p = field_id != null ? (isNaN(parseInt(field_id, 10)) ? field_id : parseInt(field_id, 10)) : original.field_id;

  const editedGame = {
    id: gameId, date, time, field_id: field_id_p,
    home_team_id: original.home_team_id, away_team_id: original.away_team_id,
    division_id: original.division_id, week: original.week,
  };
  const seasonForValidation = { ...seasonData.season, _teams: seasonData.teams || [], _fields: seasonData.fields || [], _divisions: seasonData.divisions || [] };
  const violations = validateGameEdit(editedGame, schedData.games, seasonForValidation);
  if (violations.length && !force) return res.status(409).json({ violations });

  const homeTeam = (seasonData.teams || []).find(t => t.id === original.home_team_id);
  const awayTeam = (seasonData.teams || []).find(t => t.id === original.away_team_id);

  const { cancelledGame, makeupGame } = applyRainoutToGame(
    schedData, seasonData, gameIdx, { date, time, field_id: field_id_p, reason });

  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedData, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not write schedule.json: ${err.message}` }); }

  function teamContact(t) {
    if (!t) return null;
    return { id: t.id, name: teamName(t), coach: t.coach || '', email: t.email || '', phone: t.phone || '' };
  }

  const changeRecord = {
    id: Date.now(),
    timestamp: cancelledGame.cancelled_at,
    type: 'rainout',
    game_id: gameId,
    makeup_game_id: makeupGame.game_id,
    division_id: original.division_id,
    division_name: (() => {
      const d = (seasonData.divisions || []).find(d => d.id === original.division_id);
      return d ? (d.name || d.label || d.id) : original.division_id;
    })(),
    before: { date: original.date, day: original.day, time: original.time, field_name: original.field_name },
    after: { ...makeupGame },
    changed_fields: [],
    reason: cancelledGame.cancelled_reason,
    home_team: teamContact(homeTeam),
    away_team: teamContact(awayTeam),
    forced: !!force,
  };

  let allChanges = [];
  try { if (fs.existsSync(CHANGES_FILE)) allChanges = JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); } catch {}
  allChanges.push(changeRecord);
  try { fs.writeFileSync(CHANGES_FILE, JSON.stringify(allChanges, null, 2)); } catch {}

  res.json({ ok: true, cancelled_game: cancelledGame, makeup_game: makeupGame, violations, change: changeRecord });
});

app.post('/api/notify-rainout', requireAdmin, async (req, res) => {
  const { change_id } = req.body;
  let changes = [];
  try { changes = JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); } catch {}
  const change = changes.find(c => c.id === change_id);
  if (!change) return res.status(404).json({ error: 'Change not found' });

  const emails = [change.home_team?.email, change.away_team?.email].filter(Boolean);
  if (!emails.length) return res.status(400).json({ error: 'No email on file for either team' });

  const divName = change.division_name || change.division_id;
  const before = change.before || {};
  const after = change.after || {};
  const lines = [
    'Hi coaches,', '',
    `Game #${change.game_id} — ${divName} was rained out and has been rescheduled:`, '',
    `${change.home_team?.name || 'Home'} (H) vs ${change.away_team?.name || 'Away'} (A)`, '',
    `Reason: ${change.reason || 'Rain out'}`, '',
    `Original date: ${before.day || ''} ${before.date || ''} — cancelled`, '',
    'New makeup game:',
    `  Date: ${after.day || ''} ${after.date || ''}`,
    `  Time: ${after.time || ''}`,
    `  Field: ${after.field_name || ''}`,
    `  Address: ${after.field_address || ''}`,
    '', 'Please update your calendars accordingly.', '', '— Eastlake League Admin',
  ];
  const result = await sendEmail({ to: emails, subject: `Rained Out & Rescheduled: Game #${change.game_id} — ${divName}`, text: lines.join('\n') });
  if (!result.ok) return res.status(500).json({ error: result.reason });
  res.json({ ok: true, sent_to: emails });
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

app.post('/api/notify-addition', requireAdmin, async (req, res) => {
  const { change_id } = req.body;
  let changes = [];
  try { changes = JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); } catch {}
  const change = changes.find(c => c.id === change_id);
  if (!change) return res.status(404).json({ error: 'Change not found' });

  const emails = [change.home_team?.email, change.away_team?.email].filter(Boolean);
  if (!emails.length) return res.status(400).json({ error: 'No email on file for either team' });

  const divName = change.division_name || change.division_id;
  const game = change.after || {};
  const lines = [
    'Hi coaches,', '',
    'A new game has been added to the schedule:', '',
    `Game #${change.game_id} — ${divName}`,
    `${change.home_team?.name || 'Home'} (H) vs ${change.away_team?.name || 'Away'} (A)`, '',
    'Game details:',
    `  Date: ${game.day || ''} ${game.date || ''}`,
    `  Time: ${game.time || ''}`,
    `  Field: ${game.field_name || ''}`,
    `  Address: ${game.field_address || ''}`,
    '', 'Please add this game to your calendars.', '', '— Eastlake League Admin',
  ];
  const result = await sendEmail({ to: emails, subject: `New Game Added: Game #${change.game_id} — ${divName}`, text: lines.join('\n') });
  if (!result.ok) return res.status(500).json({ error: result.reason });
  res.json({ ok: true, sent_to: emails });
});

app.patch('/api/team/:id', requireAdmin, async (req, res) => {
  const rawId = req.params.id;
  const teamId = isNaN(parseInt(rawId, 10)) ? rawId : parseInt(rawId, 10);

  let seasonData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: `Could not read season.json: ${err.message}` }); }

  const teamIdx = seasonData.teams.findIndex(t => t.id === teamId);
  if (teamIdx === -1) return res.status(404).json({ error: `Team ${teamId} not found` });

  const existingEmail = seasonData.teams[teamIdx].email || '';
  const team = { ...seasonData.teams[teamIdx] };
  // `email` is deliberately absent — it goes through the confirm-at-new-address
  // flow below rather than being written directly, same as every other route.
  if ('earliest_date' in req.body) {
    const vEarliest = V.validateEarliestDate(req.body.earliest_date);
    if (!vEarliest.ok) return res.status(400).json({ error: vEarliest.error, field: 'earliest_date' });
  }
  const allowed = ['label', 'name', 'coach', 'phone', 'home_field_id', 'confirmed', 'blackout_dates', 'program_id', 'availability', 'target_games', 'earliest_date'];
  for (const field of allowed) {
    if (!(field in req.body)) continue;
    team[field] = req.body[field];
  }
  delete team.home_field_saturday_id;
  seasonData.teams[teamIdx] = team;

  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(seasonData, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not write season.json: ${err.message}` }); }

  const newEmail = ('email' in req.body ? (req.body.email || '') : '').toLowerCase().trim();
  if (newEmail && newEmail !== existingEmail) {
    const result = await sendTeamEmailChangeConfirmation(req, team, newEmail);
    return res.json({ ok: true, team, email_change_pending: true, email_change_sent: result.ok, pending_email: newEmail });
  }
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

  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(seasonData, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not write season.json: ${err.message}` }); }
  res.json({ ok: true, division: div });
});

// ── Change request email (coach-initiated) ────────────────────────────────────

// A coach may only request on their own game; a director/admin must say which
// of the game's two teams they're acting for (and it must be theirs to manage).
function resolveRequestingTeam(session, game, bodyTeamId, teams) {
  if (session.role === 'coach') {
    if (game.home_team_id !== session.team_id && game.away_team_id !== session.team_id) return null;
    return session.team_id;
  }
  if (bodyTeamId !== game.home_team_id && bodyTeamId !== game.away_team_id) return null;
  const team = teams.find(t => String(t.id) === String(bodyTeamId));
  if (!team) return null;
  if (!canManageProgram(session, team.program_id)) return null;
  return bodyTeamId;
}

// ── Game change requests ────────────────────────────────────────────────────

// How many days out a change request must be to use the negotiation flow at all
// (anything closer belongs to the manual-override path).
const CHANGE_REQUEST_MIN_DAYS = 7;
// Rounds of back-and-forth before both directors are looped in to break the tie.
const STALEMATE_ROUND_LIMIT = 3;

// The first ask arrives cold and gets the most time; once it's an active
// dialogue the window tightens, because both coaches are already engaged.
function responseDeadlineDays(round) {
  if ((round || 1) <= 1) return 3;
  if (round === 2) return 2;
  return 1;
}
// Admin is looped in a fixed two days after the director, so round 1 keeps the
// original day-3 / day-5 behaviour and later rounds accelerate along with it.
const ADMIN_ESCALATION_GRACE_DAYS = 2;

function addDaysIso(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}
// "Thu, Sep 10" — a date a coach can act on, not a raw timestamp.
function formatDeadline(iso) {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Loads schedule + season and resolves the caller's side of a game. Shared by
// every coach-facing change-request route so the permission logic lives once.
function loadGameContext(req, gameId) {
  let schedData, seasonData;
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch { return { error: 'Could not read schedule.json' }; }
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch { return { error: 'Could not read season.json' }; }
  const game = schedData.games.find(g => g.game_id === gameId);
  if (!game) return { error: 'Game not found', status: 404 };
  return { schedData, seasonData, game, teams: seasonData.teams || [] };
}

// Slots this coach could legitimately propose for their game.
app.get('/api/change-requests/options', requireVerified, (req, res) => {
  const s = getSession(req);
  const gameId = parseInt(req.query.game_id, 10);
  const ctx = loadGameContext(req, gameId);
  if (ctx.error) return res.status(ctx.status || 500).json({ error: ctx.error });

  const myTeamId = resolveRequestingTeam(s, ctx.game, req.query.team_id, ctx.teams);
  if (!myTeamId) return res.status(403).json({ error: 'You can only view options for your own game' });

  const { slots } = computeViableSlots(ctx.game, ctx.seasonData, ctx.schedData, { minDaysOut: CHANGE_REQUEST_MIN_DAYS });
  res.json({ ok: true, slots, current: { date: ctx.game.date, time: ctx.game.time, field_name: ctx.game.field_name } });
});

// Formats a proposal for display in emails and pages.
function describeSlot(slot, fields) {
  const f = (fields || []).find(x => String(x.id) === String(slot.field_id));
  const fname = f ? (f.sub_field ? `${f.name} – ${f.sub_field}` : f.name) : '';
  const d = new Date(slot.date + 'T12:00:00Z');
  const nice = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${nice} at ${slot.time}${fname ? ` — ${fname}` : ''}`;
}

// ── Change-request email formatting ─────────────────────────────────────────
// Ted: these emails were "super basic" — a naked link with no surrounding
// context, no field address, no team names beyond what fit on one line, and
// no way to reach the other coach without going back into the app. A coach
// reading this on their phone should be able to act on it without opening
// anything else. Kept alongside the plain-text body Resend also gets (some
// clients still render text-only, and it's a reasonable fallback).
function emailEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fieldLabel(fieldId, fields) {
  const f = (fields || []).find(x => String(x.id) === String(fieldId));
  return f ? (f.sub_field ? `${f.name} – ${f.sub_field}` : f.name) : '';
}

function fieldAddressOf(fieldId, fields) {
  return (fields || []).find(x => String(x.id) === String(fieldId))?.address || '';
}

function niceDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Wraps a body in the shared shell — logo line, card, footer. Inline styles
// throughout since email clients don't reliably load a <style> block.
function emailShell(bodyHtml) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px 16px;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
    <div style="max-width:520px;margin:0 auto">
      <div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#94a3b8;margin-bottom:14px">Eastlake League Scheduler</div>
      <div style="background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.06)">
        ${bodyHtml}
      </div>
      <div style="font-size:12px;color:#94a3b8;margin-top:16px;text-align:center">This is an automated message from the Eastlake League Scheduler.</div>
    </div>
  </body></html>`;
}

function emailHeading(text) {
  return `<h1 style="font-size:17px;font-weight:700;color:#1a1a2e;margin:0 0 12px">${emailEsc(text)}</h1>`;
}

function emailP(text) {
  return `<p style="font-size:14px;line-height:1.55;color:#334155;margin:0 0 14px">${text}</p>`;
}

// A proper button instead of a raw URL sitting in the middle of the text.
function emailButton(url, label, kind) {
  const bg = kind === 'secondary' ? '#fff' : '#2d6cf0';
  const fg = kind === 'secondary' ? '#334155' : '#fff';
  const border = kind === 'secondary' ? 'border:1.5px solid #cbd5e1;' : '';
  return `<a href="${url}" style="display:inline-block;padding:11px 20px;margin:4px 8px 4px 0;background:${bg};color:${fg};${border}border-radius:8px;font-size:14px;font-weight:600;text-decoration:none">${emailEsc(label)}</a>`;
}

// The recurring "here's the game" block — division/teams/current time & place.
// gameOrSlot accepts either a full game record or a {date,time,field_id} slot
// (the two shapes that show up at different points in the negotiation).
function emailGameCard({ homeLabel, awayLabel, date, time, fieldName, fieldAddress, caption }) {
  return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:0 0 14px">
    ${caption ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:#94a3b8;margin-bottom:6px">${emailEsc(caption)}</div>` : ''}
    <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:4px">${emailEsc(homeLabel)} vs ${emailEsc(awayLabel)}</div>
    <div style="font-size:13px;color:#475569;line-height:1.6">
      ${emailEsc(niceDate(date))} at ${emailEsc(time)}<br>
      ${emailEsc(fieldName || '')}${fieldAddress ? ` — ${emailEsc(fieldAddress)}` : ''}
    </div>
  </div>`;
}

// "Opposite coach" contact block — the whole point of a change-request email
// is often just to work something out directly, and the old version made you
// go back into the app to find a phone number for that.
function emailContactCard(team, label) {
  if (!team) return '';
  const bits = [];
  if (team.coach) bits.push(emailEsc(team.coach));
  if (team.phone) bits.push(`<a href="tel:${emailEsc(team.phone)}" style="color:#2d6cf0;text-decoration:none">${emailEsc(team.phone)}</a>`);
  if (team.email) bits.push(`<a href="mailto:${emailEsc(team.email)}" style="color:#2d6cf0;text-decoration:none">${emailEsc(team.email)}</a>`);
  if (!bits.length) return '';
  return `<div style="font-size:13px;color:#475569;margin:0 0 14px">
    <span style="font-weight:600;color:#1a1a2e">${emailEsc(label || (team.label || team.name))}</span><br>${bits.join(' · ')}
  </div>`;
}

// Every round gets fresh links, so a link from an earlier round can't be replayed.
function newRoundTokens() {
  return { approve: newActionToken(), counter: newActionToken(), cancel: newActionToken() };
}

// Hands the ball to the other coach: swaps turn, resets the response clock, and
// clears the per-round escalation flags (a new round is a genuinely fresh ask).
function advanceRound(cr, proposingTeamId, awaitingTeamId, proposal) {
  cr.history = cr.history || [];
  // Only record a proposal once it's actually been superseded — the initial
  // confirm (round 0 -> 1) isn't replacing anything.
  if (cr.proposal && (cr.round || 0) >= 1) {
    cr.history.push({ round: cr.round, proposing_team_id: cr.proposing_team_id, ...cr.proposal, at: new Date().toISOString() });
  }
  cr.round = (cr.round || 0) + 1;
  cr.proposing_team_id = proposingTeamId;
  cr.awaiting_team_id = awaitingTeamId;
  cr.proposal = proposal;
  cr.status = 'awaiting_response';
  cr.tokens = newRoundTokens();
  cr.round_started_at = new Date().toISOString();
  cr.response_due_at = addDaysIso(cr.round_started_at, responseDeadlineDays(cr.round));
  cr.director_notified_at = null;
  cr.admin_notified_at = null;
}

function directorsForTeams(seasonData, teamIds) {
  const teams = seasonData.teams || [];
  const programIds = teamIds
    .map(id => teams.find(t => String(t.id) === String(id))?.program_id)
    .filter(Boolean);
  return (seasonData.directors || [])
    .filter(d => d.active !== false && programIds.includes(d.program_id));
}

// Emails the coach whose turn it is with Approve / Suggest-another-time links.
// `game` is the game as it stands right now (still at its original date/time
// until someone actually agrees) — shown alongside the proposal so the coach
// sees both "what's currently on the books" and "what's being asked for"
// without having to go find the game in the app first.
async function notifyTurn(req, cr, seasonData, game) {
  const teams = seasonData.teams || [];
  const awaitingTeam = teams.find(t => String(t.id) === String(cr.awaiting_team_id));
  const proposingTeam = teams.find(t => String(t.id) === String(cr.proposing_team_id));
  if (!awaitingTeam?.email) return { ok: false, reason: 'no email for awaiting team' };
  const base = `${req.protocol}://${req.get('host')}${BASE_PATH}/api/change-requests/${cr.id}`;
  const isCounter = cr.round > 1;
  const proposerName = proposingTeam?.label || proposingTeam?.name || 'The other coach';
  const matchup = game ? `${game.home_team_name} vs ${game.away_team_name}` : `${proposerName} vs ${awaitingTeam.label || awaitingTeam.name || 'your team'}`;
  const subject = cr.is_rainout
    ? `${matchup}: rained out — ${isCounter ? 'new makeup time proposed' : 'makeup time proposed'} — your response needed`
    : `${matchup}: ${isCounter ? 'new time proposed' : 'change requested'} — your response needed`;
  const approveUrl = `${base}/approve?token=${cr.tokens.approve}`;
  const counterUrl = `${base}/counter?token=${cr.tokens.counter}`;

  const html = emailShell(`
    ${emailHeading(subject)}
    ${emailP(`${emailEsc(proposerName)} ${cr.is_rainout ? (isCounter ? 'has proposed a different makeup time' : 'reported this game as rained out and proposed a makeup time') : (isCounter ? 'has proposed a different time' : 'has requested a change')} for this game.`)}
    ${game ? emailGameCard({ homeLabel: game.home_team_name, awayLabel: game.away_team_name, date: game.date, time: game.time, fieldName: game.field_name, fieldAddress: game.field_address, caption: cr.is_rainout ? 'Rained out — was scheduled' : 'Currently scheduled' }) : ''}
    ${emailGameCard({ homeLabel: game?.home_team_name || 'Home', awayLabel: game?.away_team_name || 'Away', date: cr.proposal.date, time: cr.proposal.time, fieldName: fieldLabel(cr.proposal.field_id, seasonData.fields), fieldAddress: fieldAddressOf(cr.proposal.field_id, seasonData.fields), caption: cr.is_rainout ? 'Proposed makeup' : 'Proposed instead' })}
    ${cr.reason ? emailP(`<strong>Note from ${emailEsc(proposerName)}:</strong> ${emailEsc(cr.reason)}`) : ''}
    ${emailContactCard(proposingTeam, `${proposerName} (proposing)`)}
    <div style="margin:18px 0 4px">${emailButton(approveUrl, 'Works for us — approve it')}${emailButton(counterUrl, 'Suggest another time', 'secondary')}</div>
    ${emailP(`Please respond by ${emailEsc(formatDeadline(cr.response_due_at))}. If we don't hear from you by then, your director will be looped in to help move things along.`)}
  `);

  return sendEmail({
    to: awaitingTeam.email,
    subject,
    text: [
      `${proposerName} ${cr.is_rainout ? (isCounter ? 'has proposed a different makeup time' : 'reported this game as rained out and proposed a makeup time') : (isCounter ? 'has proposed a different time' : 'has requested a change')} for Game #${cr.game_id}.`,
      '',
      game ? `${cr.is_rainout ? 'Rained out — was' : 'Currently'}: ${describeSlot({ date: game.date, time: game.time, field_id: game.field_id }, seasonData.fields)}` : null,
      `Proposed: ${describeSlot(cr.proposal, seasonData.fields)}`,
      cr.reason ? `Reason: ${cr.reason}` : null,
      '',
      proposingTeam ? `${proposerName} — ${[proposingTeam.phone, proposingTeam.email].filter(Boolean).join(' · ')}` : null,
      '',
      `Works for us — approve it: ${approveUrl}`,
      `Doesn't work — suggest another time: ${counterUrl}`,
      '',
      `Please respond by ${formatDeadline(cr.response_due_at)}. If we don't hear from you by then, your director will be looped in to help move things along.`,
      '', '— Eastlake Scheduler',
    ].filter(l => l !== null).join('\n'),
    html,
  });
}

// When no slot works for both teams, the coaches can't resolve it themselves —
// hand it to the directors rather than dead-ending.
async function notifyNoOptions(req, cr, seasonData, context, game) {
  const dirs = directorsForTeams(seasonData, [cr.requesting_team_id || cr.initiating_team_id, cr.other_team_id]);
  const emails = dirs.map(d => d.email).filter(Boolean);
  if (!emails.length) return;
  const teams = seasonData.teams || [];
  const homeTeam = teams.find(t => String(t.id) === String(cr.initiating_team_id));
  const awayTeam = teams.find(t => String(t.id) === String(cr.other_team_id));
  const nameOf = id => teams.find(t => String(t.id) === String(id))?.label || id;
  const matchup = game ? `${game.home_team_name} vs ${game.away_team_name}` : `${nameOf(cr.initiating_team_id)} vs ${nameOf(cr.other_team_id)}`;
  const subject = `${matchup}: no time works — needs your help`;

  const html = emailShell(`
    ${emailHeading(subject)}
    ${emailP(emailEsc(context))}
    ${game ? emailGameCard({ homeLabel: game.home_team_name, awayLabel: game.away_team_name, date: game.date, time: game.time, fieldName: game.field_name, fieldAddress: game.field_address, caption: 'Currently scheduled' }) : emailP(`Game #${cr.game_id}: ${emailEsc(nameOf(cr.initiating_team_id))} vs ${emailEsc(nameOf(cr.other_team_id))}`)}
    ${emailContactCard(homeTeam)}
    ${emailContactCard(awayTeam)}
    ${emailP(`There is no date that satisfies both teams' stated availability, their fields' open hours, and the rest of the schedule. Usually this means one team's availability needs updating, or a field needs to open up.`)}
  `);

  await sendEmail({
    to: [...new Set(emails)],
    subject,
    text: [
      `${context}`,
      '',
      `Game #${cr.game_id}: ${nameOf(cr.initiating_team_id)} vs ${nameOf(cr.other_team_id)}`,
      game ? `Currently: ${describeSlot({ date: game.date, time: game.time, field_id: game.field_id }, seasonData.fields)}` : null,
      '',
      homeTeam ? `${nameOf(cr.initiating_team_id)} — ${[homeTeam.phone, homeTeam.email].filter(Boolean).join(' · ')}` : null,
      awayTeam ? `${nameOf(cr.other_team_id)} — ${[awayTeam.phone, awayTeam.email].filter(Boolean).join(' · ')}` : null,
      '',
      `There is no date that satisfies both teams' stated availability, their fields' open hours, and the rest of the schedule.`,
      `Usually this means one team's availability needs updating, or a field needs to open up.`,
      '', '— Eastlake Scheduler',
    ].filter(l => l !== null).join('\n'),
    html,
  });
}

// Resolves a client-picked slot against what's actually viable, allowing the
// coaches to shift the kickoff within the legal window. Returns
// { slot, time } or { error }. Never trusts the client's time.
function resolveProposedSlot(slots, wanted, schedData, gameId, seasonData) {
  if (!wanted || !wanted.date) return { error: 'Pick a proposed date' };
  const candidates = slots.filter(x => x.date === wanted.date &&
    (!wanted.slot_key || x.slot_key === wanted.slot_key));
  if (!candidates.length) return { error: 'That date is no longer available — please pick again', stale: true };
  // Prefer an exact slot-time match, else the first viable slot on that date.
  const slot = candidates.find(x => x.time === wanted.time) || candidates[0];

  const time = wanted.time || slot.time;
  if (!isValidGameTime(time, slot.type)) {
    const [lo, hi] = TIME_BOUNDS[slot.type === 'saturday' ? 'saturday' : 'weekday'];
    return { error: `Game time must be between ${lo} and ${hi}, on the half hour` };
  }
  // A shifted time could collide with another game already on that field.
  // Compared as real time ranges, not matching time strings: coaches shift
  // kickoffs freely within the legal window here, and two different-length
  // games (or two divisions) can overlap without their times ever matching.
  // Cancelled (rained-out) games are excluded, same as everywhere else —
  // otherwise a rainout's own vacated slot would block its makeup.
  const divisionLengths = new Map(((seasonData && seasonData.divisions) || []).map(d => [d.id, d.game_length_minutes]));
  const thisGame = (schedData.games || []).find(g => g.game_id === gameId);
  const thisLength = divisionLengths.get(thisGame && thisGame.division_id) || DEFAULT_GAME_LENGTH_MINUTES;
  const clash = (schedData.games || []).some(g =>
    g.game_id !== gameId && g.status !== 'cancelled' &&
    g.field_id === slot.field_id && g.date === slot.date && g.time &&
    timeRangesOverlap(time, thisLength, g.time, divisionLengths.get(g.division_id) || DEFAULT_GAME_LENGTH_MINUTES));
  if (clash) return { error: 'Another game is already booked on that field at that time' };

  return { slot, time };
}

app.post('/api/change-requests', requireVerified, async (req, res) => {
  const s = getSession(req);
  const { game_id, team_id, reason, details, slot, is_rainout } = req.body;
  if (!game_id) return res.status(400).json({ error: 'game_id is required' });

  const ctx = loadGameContext(req, game_id);
  if (ctx.error) return res.status(ctx.status || 500).json({ error: ctx.error });
  const { game, seasonData, schedData, teams } = ctx;

  const requestingTeamId = resolveRequestingTeam(s, game, team_id, teams);
  if (!requestingTeamId) return res.status(403).json({ error: 'You can only request a change on your own game' });
  const otherTeamId = requestingTeamId === game.home_team_id ? game.away_team_id : game.home_team_id;
  const requestingTeam = teams.find(t => String(t.id) === String(requestingTeamId));
  const otherTeam = teams.find(t => String(t.id) === String(otherTeamId));

  if (daysBetween(new Date().toISOString(), game.date) < CHANGE_REQUEST_MIN_DAYS) {
    return res.status(400).json({ error: `This game is within ${CHANGE_REQUEST_MIN_DAYS} days — use Manual Override instead`, lockout: true });
  }
  if (!requestingTeam?.email) return res.status(400).json({ error: 'No email on file for your team — contact your director' });
  if (!slot || !slot.date || !slot.time) return res.status(400).json({ error: 'Pick a proposed date and time' });

  // Never trust the client's slot: re-derive what's actually viable and match.
  const { slots } = computeViableSlots(game, seasonData, schedData, { minDaysOut: CHANGE_REQUEST_MIN_DAYS });
  if (!slots.length) {
    await notifyNoOptions(req,
      { game_id, initiating_team_id: requestingTeamId, other_team_id: otherTeamId },
      seasonData,
      `${requestingTeam.label || 'A coach'} tried to reschedule Game #${game_id}, but no workable slot exists.`,
      game);
    return res.status(400).json({ error: 'No date works for both teams right now. Your directors have been notified to help.', no_options: true });
  }
  const picked = resolveProposedSlot(slots, slot, schedData, game_id, seasonData);
  if (picked.error) return res.status(400).json({ error: picked.error, stale_slot: !!picked.stale });
  const chosen = { ...picked.slot, time: picked.time };

  const cr = {
    id: 'cr-' + Date.now(),
    game_id, division_id: game.division_id,
    initiating_team_id: requestingTeamId,
    requesting_team_id: requestingTeamId,   // kept for the manual-override record shape
    other_team_id: otherTeamId,
    reason: (reason || '').trim(), details: (details || '').trim(),
    is_rainout: !!is_rainout,
    proposing_team_id: requestingTeamId,
    awaiting_team_id: null,                 // set once the initiator confirms
    proposal: { date: chosen.date, time: chosen.time, field_id: chosen.field_id },
    round: 0,
    history: [],
    status: 'awaiting_requester_confirm',
    submitted_at: new Date().toISOString(), round_started_at: null, responded_at: null,
    director_notified_at: null, admin_notified_at: null, stalemate_notified_at: null,
    tokens: newRoundTokens(),
    manual_override: null,
  };
  const list = readChangeRequests();
  list.push(cr);
  writeChangeRequests(list);

  const base = `${req.protocol}://${req.get('host')}${BASE_PATH}/api/change-requests/${cr.id}`;
  const confirmSubject = cr.is_rainout
    ? `${game.home_team_name} vs ${game.away_team_name}: confirm the rain-out reschedule`
    : `${game.home_team_name} vs ${game.away_team_name}: confirm your change request`;
  const confirmUrl = `${base}/confirm?token=${cr.tokens.approve}`;
  const cancelUrl = `${base}/cancel?token=${cr.tokens.cancel}`;
  const confirmHtml = emailShell(`
    ${emailHeading(confirmSubject)}
    ${cr.is_rainout
      ? emailP(`Reporting this game as rained out and proposing a makeup below. Nothing reaches ${emailEsc(otherTeam?.label || otherTeam?.name || 'the other coach')} until you confirm.`)
      : emailP(`Did you mean to request a schedule change for this game? Nothing reaches ${emailEsc(otherTeam?.label || otherTeam?.name || 'the other coach')} until you confirm below.`)}
    ${emailGameCard({ homeLabel: game.home_team_name, awayLabel: game.away_team_name, date: game.date, time: game.time, fieldName: game.field_name, fieldAddress: game.field_address, caption: cr.is_rainout ? 'Rained out — was scheduled' : 'Currently scheduled' })}
    ${emailGameCard({ homeLabel: game.home_team_name, awayLabel: game.away_team_name, date: cr.proposal.date, time: cr.proposal.time, fieldName: fieldLabel(cr.proposal.field_id, seasonData.fields), fieldAddress: fieldAddressOf(cr.proposal.field_id, seasonData.fields), caption: cr.is_rainout ? 'Proposed makeup' : 'You proposed' })}
    ${cr.reason ? emailP(`<strong>Your note:</strong> ${emailEsc(cr.reason)}`) : ''}
    <div style="margin:18px 0 4px">${emailButton(confirmUrl, 'Yes, send it to the other coach')}${emailButton(cancelUrl, 'No, cancel', 'secondary')}</div>
    ${emailP('If you ignore this, nothing happens — the request never reaches the other coach.')}
  `);
  const result = await sendEmail({
    to: requestingTeam.email,
    subject: confirmSubject,
    text: [
      `Did you mean to request a schedule change for Game #${game_id}?`,
      '',
      `Currently: ${describeSlot({ date: game.date, time: game.time, field_id: game.field_id }, seasonData.fields)}`,
      `You proposed: ${describeSlot(cr.proposal, seasonData.fields)}`,
      cr.reason ? `Reason: ${cr.reason}` : null,
      '',
      `Yes, send it to the other coach: ${confirmUrl}`,
      `No, cancel: ${cancelUrl}`,
      '',
      'If you ignore this, nothing happens — the request never reaches the other coach.',
      '', '— Eastlake Scheduler',
    ].filter(l => l !== null).join('\n'),
    html: confirmHtml,
  });
  if (!result.ok) return res.status(500).json({ error: 'Could not send confirmation email', reason: result.reason });
  res.json({ ok: true, change_request: cr });
});

function crActionPage(title, message, extraHtml) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>body{font-family:system-ui,-apple-system,sans-serif;background:#f4f6f8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:12px;padding:32px;max-width:560px;width:100%;box-shadow:0 4px 20px rgba(0,0,0,.08)}
  h1{font-size:1.1rem;margin-bottom:10px;color:#1a1a2e}p{color:#475569;line-height:1.5;font-size:14px}
  .slot{display:block;width:100%;text-align:left;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin:8px 0;font-size:14px;cursor:pointer}
  .slot:hover{border-color:#2d6cf0;background:#f0f5ff}
  .slot input{margin-right:10px}
  .btn{margin-top:16px;width:100%;padding:12px;background:#2d6cf0;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
  .cur{background:#fef3c7;border-radius:8px;padding:10px 12px;font-size:13px;color:#92400e;margin-bottom:16px}</style></head>
  <body><div class="card"><h1>${title}</h1><p>${message}</p>${extraHtml || ''}</div></body></html>`;
}

// Not found / already redeemed / a link from a previous round.
function crAlreadyResolved(res) {
  res.status(200).send(crActionPage('Already resolved', 'This request has already been resolved, or a newer message has replaced this one. No action was taken.'));
}

// Looks up a request by id and validates the token for the expected step.
function findCrByToken(id, token, expectedStatus, tokenKey) {
  const list = readChangeRequests();
  const idx = list.findIndex(c => c.id === id);
  if (idx === -1) return null;
  const cr = list[idx];
  if (cr.status !== expectedStatus) return null;
  if (!token || cr.tokens?.[tokenKey] !== token) return null;
  return { list, idx, cr };
}

app.get('/api/change-requests/:id/confirm', async (req, res) => {
  const found = findCrByToken(req.params.id, req.query.token, 'awaiting_requester_confirm', 'approve');
  if (!found) return crAlreadyResolved(res);
  const { list, idx, cr } = found;

  let seasonData, schedData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); } catch { seasonData = { teams: [] }; }
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch { schedData = { games: [] }; }

  advanceRound(cr, cr.initiating_team_id, cr.other_team_id, cr.proposal);
  list[idx] = cr;
  writeChangeRequests(list);

  // The game keeps its agreed date — only the badge changes — so nobody turns up
  // at the wrong field while the coaches are still negotiating. "negotiating"
  // (was "pending") — renamed so it stops colliding with the dual-coach
  // confirm-the-schedule "Pending" status below, a different concept entirely.
  const gameIdx = schedData.games.findIndex(g => g.game_id === cr.game_id);
  if (gameIdx !== -1) {
    schedData.games[gameIdx].status = 'negotiating';
    try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedData, null, 2)); } catch {}
  }

  await notifyTurn(req, cr, seasonData, gameIdx !== -1 ? schedData.games[gameIdx] : null);
  res.send(crActionPage('Request sent',
    `Your proposal for Game #${cr.game_id} has gone to the other coach. The game stays at its current time until you both agree.`));
});

app.get('/api/change-requests/:id/cancel', (req, res) => {
  const found = findCrByToken(req.params.id, req.query.token, 'awaiting_requester_confirm', 'cancel');
  if (!found) return crAlreadyResolved(res);
  const { list, idx, cr } = found;
  cr.status = 'cancelled';
  list[idx] = cr;
  writeChangeRequests(list);
  res.send(crActionPage('Cancelled', `Your change request for Game #${cr.game_id} was cancelled. The schedule is unchanged.`));
});


// Inside-7-days changes skip the request/approve flow entirely — the two coaches
// already agreed by phone/text, this just records it and applies the change.
// Notifies the other coach and both teams' directors (not admin) — a director-owned
// accountability record, not admin oversight, per NOTES.md.
// Applies an agreed proposal to the real game. Mirrors PUT /api/game/:id's
// recompute (week / field name / day) but never hard-blocks on soft violations —
// the coaches have already agreed, so there is no "Save Anyway" step here.
function applyChangeRequestToGame(cr, schedData, seasonData) {
  const gameIdx = schedData.games.findIndex(g => g.game_id === cr.game_id);
  if (gameIdx === -1) return null;
  const existingGame = schedData.games[gameIdx];
  const p = cr.proposal || {};

  const date = p.date || existingGame.date;
  const time = p.time || existingGame.time;
  const field_id = p.field_id || existingGame.field_id;

  let newWeek = existingGame.week;
  for (const wk of buildSeasonWeeks(seasonData.season)) {
    if (wk.weekdays.includes(date) || wk.saturday === date) { newWeek = wk.week; break; }
  }

  const fieldObj = (seasonData.fields || []).find(f => f.id === field_id);
  const resolvedFieldName    = fieldObj ? (fieldObj.sub_field ? `${fieldObj.name} – ${fieldObj.sub_field}` : (fieldObj.name || field_id)) : field_id;
  const resolvedFieldAddress = fieldObj ? (fieldObj.address || '') : '';

  const updatedGame = {
    ...existingGame,
    date, day: dayName(date), time, field_id,
    field_name: resolvedFieldName, field_address: resolvedFieldAddress,
    week: newWeek,
    // Both coaches just agreed to this — that IS the dual confirmation, so it
    // lands straight at Confirmed rather than resetting to Scheduled/Pending
    // and making them confirm the very thing they just negotiated all over again.
    status: 'confirmed',
    confirmations: { home: true, away: true },
  };
  schedData.games[gameIdx] = updatedGame;
  schedData.total_games = schedData.games.length;
  schedData.generated_at = new Date().toISOString();
  return updatedGame;
}

// A rain-out is never just "move the game" — the original stays in the
// schedule as history (status 'cancelled') and a new linked "makeup" game
// is created at the chosen slot, so there's a permanent record of what was
// originally on the calendar and either record can trace to the other via
// rescheduled_to_game_id / rescheduled_from_game_id. Shared by the admin's
// direct rain-out action and the coach-negotiated one (applied once both
// coaches have agreed via the same change-request flow as any other
// reschedule) so the two paths can't quietly drift apart. Doesn't write the
// file — same convention as applyChangeRequestToGame — the caller decides
// when to persist.
function applyRainoutToGame(schedData, seasonData, gameIdx, { date, time, field_id, reason }) {
  const original = schedData.games[gameIdx];
  const field_id_p = field_id != null
    ? (isNaN(parseInt(field_id, 10)) ? field_id : parseInt(field_id, 10))
    : original.field_id;

  let newWeek = null;
  for (const wk of buildSeasonWeeks(seasonData.season)) {
    if (wk.weekdays.includes(date) || wk.saturday === date) { newWeek = wk.week; break; }
  }

  const fieldObj = (seasonData.fields || []).find(f => f.id === field_id_p);
  const resolvedFieldName    = fieldObj ? (fieldObj.sub_field ? `${fieldObj.name} – ${fieldObj.sub_field}` : (fieldObj.name || field_id_p)) : original.field_name;
  const resolvedFieldAddress = fieldObj ? (fieldObj.address || '') : original.field_address;

  const makeupId = Math.max(0, ...schedData.games.map(g => g.game_id || 0)) + 1;
  const makeupGame = {
    game_id: makeupId, status: 'scheduled', division_id: original.division_id, week: newWeek,
    date, day: dayName(date), time,
    field_id: field_id_p, field_name: resolvedFieldName, field_address: resolvedFieldAddress,
    home_team_id: original.home_team_id, home_team_name: original.home_team_name,
    away_team_id: original.away_team_id, away_team_name: original.away_team_name,
    is_rematch: !!original.is_rematch,
    is_makeup: true,
    rescheduled_from_game_id: original.game_id,
  };

  const cancelledAt = new Date().toISOString();
  const cancelledGame = {
    ...original,
    status: 'cancelled',
    cancelled_reason: reason || 'Rain out',
    cancelled_at: cancelledAt,
    rescheduled_to_game_id: makeupId,
  };
  schedData.games[gameIdx] = cancelledGame;
  schedData.games.push(makeupGame);
  schedData.games.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
  schedData.total_games = schedData.games.length;
  schedData.generated_at = cancelledAt;

  return { cancelledGame, makeupGame };
}

app.get('/api/change-requests/:id/approve', async (req, res) => {
  const found = findCrByToken(req.params.id, req.query.token, 'awaiting_response', 'approve');
  if (!found) return crAlreadyResolved(res);
  const { list, idx, cr } = found;

  let seasonData, schedData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); } catch { seasonData = { teams: [], fields: [] }; }
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch { schedData = { games: [] }; }

  // Snapshot the pre-change state before either branch below mutates it — the
  // home team's director needs to see original vs. new to know refs must be
  // rebooked (see the notification after the game is actually updated).
  // applyChangeRequestToGame overwrites schedData.games[gameIdx] in place, so
  // this has to be taken before it runs, not derived from it afterward.
  const beforeGame = { ...(schedData.games.find(g => g.game_id === cr.game_id) || {}) };

  // A rain-out was never just "move the game" — both coaches agreeing on a
  // makeup slot is the same negotiation as any other reschedule, but what
  // happens on agreement is different: the original stays as cancelled
  // history and a new linked makeup game gets created, exactly like the
  // admin's direct rain-out action (applyRainoutToGame — shared with it so
  // the two paths can't drift apart).
  let updatedGame;
  if (cr.is_rainout) {
    const gameIdx = schedData.games.findIndex(g => g.game_id === cr.game_id);
    if (gameIdx !== -1) {
      const { makeupGame } = applyRainoutToGame(schedData, seasonData, gameIdx, {
        date: cr.proposal.date, time: cr.proposal.time, field_id: cr.proposal.field_id, reason: cr.reason,
      });
      updatedGame = makeupGame;

      const teamsForContact = seasonData.teams || [];
      const homeTeam = teamsForContact.find(t => t.id === makeupGame.home_team_id);
      const awayTeam = teamsForContact.find(t => t.id === makeupGame.away_team_id);
      const teamContact = (t) => t ? { id: t.id, name: teamName(t), coach: t.coach || '', email: t.email || '', phone: t.phone || '' } : null;
      const divisionRec = (seasonData.divisions || []).find(d => d.id === cr.division_id);
      const changeRecord = {
        id: Date.now(),
        timestamp: makeupGame ? schedData.generated_at : new Date().toISOString(),
        type: 'rainout',
        game_id: cr.game_id,
        makeup_game_id: makeupGame.game_id,
        division_id: cr.division_id,
        division_name: divisionRec ? (divisionRec.name || divisionRec.label || divisionRec.id) : cr.division_id,
        before: { date: schedData.games[gameIdx]?.date, day: schedData.games[gameIdx]?.day, time: schedData.games[gameIdx]?.time, field_name: schedData.games[gameIdx]?.field_name },
        after: { ...makeupGame },
        changed_fields: [],
        reason: cr.reason || 'Rain out',
        home_team: teamContact(homeTeam),
        away_team: teamContact(awayTeam),
        forced: false,
      };
      let allChanges = [];
      try { if (fs.existsSync(CHANGES_FILE)) allChanges = JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); } catch {}
      allChanges.push(changeRecord);
      try { fs.writeFileSync(CHANGES_FILE, JSON.stringify(allChanges, null, 2)); } catch {}
    }
  } else {
    updatedGame = applyChangeRequestToGame(cr, schedData, seasonData);
  }
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedData, null, 2)); } catch {}

  cr.status = 'confirmed';
  cr.responded_at = new Date().toISOString();
  list[idx] = cr;
  writeChangeRequests(list);

  // Alert the HOME team's director specifically — not both teams' directors,
  // the way manual-override does — because refs are booked by whoever hosts,
  // and only the home program has anything to rebook. home_team_id never
  // changes through a negotiation (only date/time/field do), so beforeGame
  // and updatedGame always agree on who that is.
  if (updatedGame) {
    const teamsForRefNotice = seasonData.teams || [];
    const homeTeamForNotice = teamsForRefNotice.find(t => String(t.id) === String(updatedGame.home_team_id));
    const homeDirector = (seasonData.directors || []).find(d =>
      d.active !== false && d.program_id && d.program_id === homeTeamForNotice?.program_id);
    if (homeDirector?.email) {
      const refSubject = `${updatedGame.home_team_name} vs ${updatedGame.away_team_name}: reschedule refs — game moved`;
      const refHtml = emailShell(`
        ${emailHeading(refSubject)}
        ${emailP(`Both coaches agreed to ${cr.is_rainout ? 'a rain-out makeup' : 'move'} Game #${cr.game_id}. This is a home game for your program, so referees booked for the original time will need to be moved.`)}
        ${emailGameCard({ homeLabel: beforeGame.home_team_name, awayLabel: beforeGame.away_team_name, date: beforeGame.date, time: beforeGame.time, fieldName: beforeGame.field_name, fieldAddress: beforeGame.field_address, caption: cr.is_rainout ? 'Rained out — was scheduled' : 'Original' })}
        ${emailGameCard({ homeLabel: updatedGame.home_team_name, awayLabel: updatedGame.away_team_name, date: updatedGame.date, time: updatedGame.time, fieldName: updatedGame.field_name, fieldAddress: updatedGame.field_address, caption: cr.is_rainout ? 'Makeup game' : 'New date & time' })}
      `);
      await sendEmail({
        to: homeDirector.email,
        subject: refSubject,
        text: [
          `Both coaches agreed to ${cr.is_rainout ? 'a rain-out makeup for' : 'move'} Game #${cr.game_id}. This is a home game for your program, so referees booked for the original time will need to be moved.`,
          '',
          `Original: ${beforeGame.day} ${beforeGame.date} at ${beforeGame.time} — ${beforeGame.field_name}`,
          `New: ${updatedGame.day} ${updatedGame.date} at ${updatedGame.time} — ${updatedGame.field_name}`,
          '', '— Eastlake Scheduler',
        ].join('\n'),
        html: refHtml,
      });
    }
  }

  // Tell the coach who proposed it that it's locked in.
  const teams = seasonData.teams || [];
  const proposer = teams.find(t => String(t.id) === String(cr.proposing_team_id));
  const otherOfPair = [cr.initiating_team_id, cr.other_team_id].find(id => String(id) !== String(cr.proposing_team_id));
  const otherTeamForProposer = teams.find(t => String(t.id) === String(otherOfPair));
  if (proposer?.email && updatedGame) {
    const lockedSubject = cr.is_rainout
      ? `${updatedGame.home_team_name} vs ${updatedGame.away_team_name}: makeup game confirmed`
      : `${updatedGame.home_team_name} vs ${updatedGame.away_team_name}: agreed — schedule updated`;
    const lockedHtml = emailShell(`
      ${emailHeading(lockedSubject)}
      ${emailP(cr.is_rainout ? 'The makeup date was accepted. Game #' + cr.game_id + ' is cancelled and this is now on the schedule.' : 'Your proposed time was accepted. The schedule has been updated.')}
      ${emailGameCard({ homeLabel: updatedGame.home_team_name, awayLabel: updatedGame.away_team_name, date: updatedGame.date, time: updatedGame.time, fieldName: updatedGame.field_name, fieldAddress: updatedGame.field_address, caption: cr.is_rainout ? 'Makeup game' : 'New date & time' })}
      ${emailContactCard(otherTeamForProposer, `${otherTeamForProposer?.label || otherTeamForProposer?.name || 'The other coach'} (in case anything else needs sorting out)`)}
    `);
    await sendEmail({
      to: proposer.email,
      subject: lockedSubject,
      text: [
        `Your proposed time for Game #${cr.game_id} was accepted. The schedule has been updated.`,
        '', `New date: ${updatedGame.day} ${updatedGame.date}`, `New time: ${updatedGame.time}`, `Field: ${updatedGame.field_name}`,
        otherTeamForProposer ? '' : null,
        otherTeamForProposer ? `${otherTeamForProposer.label || otherTeamForProposer.name} — ${[otherTeamForProposer.phone, otherTeamForProposer.email].filter(Boolean).join(' · ')}` : null,
        '', '— Eastlake Scheduler',
      ].filter(l => l !== null).join('\n'),
      html: lockedHtml,
    });
  }

  res.send(crActionPage('Locked in',
    cr.is_rainout
      ? `Game #${cr.game_id} was rained out and rescheduled to ${describeSlot(cr.proposal, seasonData.fields)}. Both coaches have been notified.`
      : `Game #${cr.game_id} has been moved to ${describeSlot(cr.proposal, seasonData.fields)}. Both coaches have been notified.`));
});

// "This doesn't work" — instead of ending the thread, hand this coach the same
// picker so they can say what *would* work. Token-authenticated so it works
// straight from the email without logging in.
app.get('/api/change-requests/:id/counter', (req, res) => {
  const found = findCrByToken(req.params.id, req.query.token, 'awaiting_response', 'counter');
  if (!found) return crAlreadyResolved(res);
  const { cr } = found;

  let seasonData, schedData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); } catch { seasonData = { teams: [] }; }
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch { schedData = { games: [] }; }
  const game = schedData.games.find(g => g.game_id === cr.game_id);
  if (!game) return crAlreadyResolved(res);

  const { slots } = computeViableSlots(game, seasonData, schedData, { minDaysOut: CHANGE_REQUEST_MIN_DAYS });
  const available = slots.filter(x => !(x.date === cr.proposal?.date && x.time === cr.proposal?.time));

  if (!available.length) {
    return res.send(crActionPage('No other times work',
      `There's no other date that fits both teams' availability for Game #${cr.game_id}. Your directors have been notified and will help sort this out.`));
  }

  const opts = available.map((x, i) => `
    <label class="slot"><input type="radio" name="pick" value="${i}" data-date="${x.date}" required>
    ${describeSlot(x, seasonData.fields)}</label>`).join('');

  // Times are negotiable within the day type's window, so offer the slot's
  // standard time pre-selected plus every other legal kickoff.
  const timeOptionsByIndex = available.map(x =>
    (x.allowed_times || []).map(t => `<option value="${t}"${t === x.time ? ' selected' : ''}>${t}</option>`).join(''));

  res.send(crActionPage('Suggest another time',
    `You're saying the proposed time for Game #${cr.game_id} doesn't work. Pick a date that does — you can nudge the kickoff time too — and it'll go back to the other coach.`,
    `<div class="cur">Currently proposed: ${describeSlot(cr.proposal, seasonData.fields)}</div>
     <form method="POST" action="counter?token=${req.query.token}" id="cf">${opts}
     <div style="margin-top:14px"><label style="font-size:13px;color:#475569">Kickoff time
       <select name="time" id="tsel" style="margin-left:8px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px"></select>
     </label></div>
     <input type="hidden" name="date" id="dsel">
     <button class="btn" type="submit">Send this back to the other coach</button></form>
     <script>
       var TIMES = ${JSON.stringify(timeOptionsByIndex)};
       var DATES = ${JSON.stringify(available.map(x => x.date))};
       var form = document.getElementById('cf');
       form.addEventListener('change', function (e) {
         if (e.target.name !== 'pick') return;
         var i = parseInt(e.target.value, 10);
         document.getElementById('tsel').innerHTML = TIMES[i];
         document.getElementById('dsel').value = DATES[i];
       });
     </script>`));
});

app.post('/api/change-requests/:id/counter', express.urlencoded({ extended: false }), async (req, res) => {
  const found = findCrByToken(req.params.id, req.query.token, 'awaiting_response', 'counter');
  if (!found) return crAlreadyResolved(res);
  const { list, idx, cr } = found;

  let seasonData, schedData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); } catch { seasonData = { teams: [] }; }
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch { schedData = { games: [] }; }
  const game = schedData.games.find(g => g.game_id === cr.game_id);
  if (!game) return crAlreadyResolved(res);

  const date = String(req.body.date || '');
  const time = String(req.body.time || '');
  const { slots } = computeViableSlots(game, seasonData, schedData, { minDaysOut: CHANGE_REQUEST_MIN_DAYS });
  if (!slots.length) {
    cr.status = 'escalated';
    list[idx] = cr;
    writeChangeRequests(list);
    await notifyNoOptions(req, cr, seasonData, `Game #${cr.game_id} is stuck — no time fits both teams.`, game);
    return res.send(crActionPage('No other times work',
      `There's no other date that fits both teams for Game #${cr.game_id}. Your directors have been notified.`));
  }
  const picked = resolveProposedSlot(slots, { date, time }, schedData, cr.game_id, seasonData);
  if (picked.error) {
    return res.status(400).send(crActionPage('That time is no longer free',
      `${picked.error}. Please open the link again and pick another.`));
  }
  const chosen = { ...picked.slot, time: picked.time };

  // Flip the turn — the coach who rejected is now the one proposing.
  const nextAwaiting = cr.proposing_team_id;
  const nowProposing = cr.awaiting_team_id;
  advanceRound(cr, nowProposing, nextAwaiting, { date: chosen.date, time: chosen.time, field_id: chosen.field_id });
  list[idx] = cr;
  writeChangeRequests(list);

  await notifyTurn(req, cr, seasonData, game);
  res.send(crActionPage('Sent back',
    `Your suggested time for Game #${cr.game_id} has gone to the other coach. The game stays at its current time until you both agree.`));
});

app.post('/api/change-requests/:game_id/manual-override', requireVerified, async (req, res) => {
  const s = getSession(req);
  const gameId = parseInt(req.params.game_id, 10);
  const { team_id, date, time, field_id, who_spoke_to, how_connected, is_rainout } = req.body;
  if (!who_spoke_to?.trim() || !how_connected?.trim()) {
    return res.status(400).json({ error: 'who_spoke_to and how_connected are both required' });
  }

  let schedData, seasonData;
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read schedule.json' }); }
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }

  const gameIdx = schedData.games.findIndex(g => g.game_id === gameId);
  const game = gameIdx !== -1 ? schedData.games[gameIdx] : null;
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const teams = seasonData.teams || [];
  const requestingTeamId = resolveRequestingTeam(s, game, team_id, teams);
  if (!requestingTeamId) return res.status(403).json({ error: 'You can only override a change on your own game' });
  const otherTeamId = requestingTeamId === game.home_team_id ? game.away_team_id : game.home_team_id;
  const requestingTeam = teams.find(t => String(t.id) === String(requestingTeamId));
  const otherTeam = teams.find(t => String(t.id) === String(otherTeamId));

  const cr = {
    id: 'cr-' + Date.now(),
    game_id: gameId, division_id: game.division_id,
    requesting_team_id: requestingTeamId, other_team_id: otherTeamId,
    reason: is_rainout ? 'Rain out' : 'Manual override', details: '',
    is_rainout: !!is_rainout,
    proposal: { date: date || '', time: time || '', field_id: field_id || '' },
    proposing_team_id: requestingTeamId, awaiting_team_id: null,
    round: 0, history: [],
    status: 'confirmed',
    submitted_at: new Date().toISOString(), requested_at: new Date().toISOString(), responded_at: new Date().toISOString(),
    director_notified_at: null, admin_notified_at: null,
    tokens: {}, stalemate_notified_at: null, round_started_at: null,
    manual_override: { who: who_spoke_to.trim(), how: how_connected.trim(), submitted_by_team_id: requestingTeamId, at: new Date().toISOString() },
  };

  // Same "cancel + linked makeup" treatment as the negotiated rain-out path
  // (applyRainoutToGame) rather than a plain move — a rainout discovered the
  // morning of game day goes through Manual Override (inside the 7-day
  // window), and it should behave the same way regardless of how close to
  // game day it was reported.
  const updatedGame = is_rainout
    ? applyRainoutToGame(schedData, seasonData, gameIdx, { date, time, field_id, reason: 'Rain out' }).makeupGame
    : applyChangeRequestToGame(cr, schedData, seasonData);
  if (!updatedGame) return res.status(404).json({ error: 'Game not found' });
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedData, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write schedule.json' }); }

  const list = readChangeRequests();
  list.push(cr);
  writeChangeRequests(list);

  const directors = (seasonData.directors || []).filter(d =>
    d.active !== false && (d.program_id === requestingTeam?.program_id || d.program_id === otherTeam?.program_id)
  );
  const recipients = [otherTeam?.email, ...directors.map(d => d.email)].filter(Boolean);
  const uniqueRecipients = [...new Set(recipients)];
  if (uniqueRecipients.length) {
    const requesterName = requestingTeam?.label || requestingTeam?.name || 'A coach';
    const overrideSubject = is_rainout
      ? `${updatedGame.home_team_name} vs ${updatedGame.away_team_name}: rained out — makeup confirmed`
      : `${updatedGame.home_team_name} vs ${updatedGame.away_team_name}: changed by manual override`;
    const overrideHtml = emailShell(`
      ${emailHeading(overrideSubject)}
      ${emailP(is_rainout
        ? `${emailEsc(requesterName)} reported this game rained out and arranged a makeup directly (inside the 7-day window, by phone/text).`
        : `${emailEsc(requesterName)} changed this game directly (inside the 7-day window, arranged by phone/text — this bypasses the normal request/approve flow).`)}
      ${emailGameCard({ homeLabel: game.home_team_name, awayLabel: game.away_team_name, date: game.date, time: game.time, fieldName: game.field_name, fieldAddress: game.field_address, caption: is_rainout ? 'Rained out — was scheduled' : 'Original' })}
      ${emailGameCard({ homeLabel: updatedGame.home_team_name, awayLabel: updatedGame.away_team_name, date: updatedGame.date, time: updatedGame.time, fieldName: updatedGame.field_name, fieldAddress: updatedGame.field_address, caption: is_rainout ? 'Makeup game' : 'New' })}
      ${emailP(`<strong>Confirmed with:</strong> ${emailEsc(cr.manual_override.who)}<br><strong>How:</strong> ${emailEsc(cr.manual_override.how)}`)}
      ${emailContactCard(requestingTeam, `${requesterName} (made this change)`)}
    `);
    await sendEmail({
      to: uniqueRecipients,
      subject: overrideSubject,
      text: [
        `${requesterName} changed Game #${gameId} directly (inside the 7-day window, arranged by phone/text — this bypasses the normal request/approve flow).`,
        '',
        `Original: ${describeSlot({ date: game.date, time: game.time, field_id: game.field_id }, seasonData.fields)}`,
        `New date: ${updatedGame.day} ${updatedGame.date}`, `New time: ${updatedGame.time}`, `Field: ${updatedGame.field_name}`,
        '',
        `Confirmed with: ${cr.manual_override.who}`,
        `How: ${cr.manual_override.how}`,
        '',
        requestingTeam ? `${requesterName} — ${[requestingTeam.phone, requestingTeam.email].filter(Boolean).join(' · ')}` : null,
        '', '— Eastlake Scheduler',
      ].filter(l => l !== null).join('\n'),
      html: overrideHtml,
    });
  }

  res.json({ ok: true, game: updatedGame, change_request: cr });
});

// ── Missing coach info submission ─────────────────────────────────────────────

app.post('/api/missing-info', requireVerified, (req, res) => {
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

// A director may only touch fields/teams in their own program; admin is unrestricted.
function canManageProgram(session, programId) {
  if (session.role === 'admin') return true;
  // A falsy programId means a shared/admin-owned resource (e.g. a field with
  // no program_id) — only admin manages those. A director only ever owns
  // resources actually tagged with their own program_id, never "whoever gets
  // there first" on an unassigned one.
  if (session.role === 'director') return !!programId && programId === session.program_id;
  return false;
}

// Editing a team (not creating/deleting) is also allowed for a coach editing their own team.
function canEditTeam(session, team) {
  if (session.role === 'coach') return team.id === session.team_id;
  return canManageProgram(session, team.program_id);
}

// ── Geocoding ────────────────────────────────────────────────────────────────
// Nobody registering a field can be expected to know how to find latitude and
// longitude — that was the actual problem, not a wording issue on the label.
// Directors already have to enter a street address, so turning that into
// coordinates automatically removes the step entirely rather than explaining
// it better. Nominatim (OpenStreetMap) is free and needs no API key; its usage
// policy just asks for one request at a time and a descriptive User-Agent,
// both fine at this league's volume.
const GEOCODE_TIMEOUT_MS = 6000;

async function geocodeAddress(address) {
  const q = String(address || '').trim();
  if (!q) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'EastlakeLeagueScheduler/1.0 (contact: tedriolo@gmail.com)' },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    const hit = rows && rows[0];
    if (!hit) return null;
    const lat = parseFloat(hit.lat), lng = parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, display_name: hit.display_name || q };
  } catch {
    return null; // timeout, network error, or no match — caller treats as "not found"
  } finally {
    clearTimeout(timer);
  }
}

// Used by the "Find from address" button so a director can see and confirm the
// result before saving, rather than have it silently applied.
app.get('/api/geocode', requireAuth, async (req, res) => {
  const address = req.query.address || '';
  if (!address.trim()) return res.status(400).json({ error: 'Enter an address first' });
  const hit = await geocodeAddress(address);
  if (!hit) {
    return res.status(404).json({
      error: `Couldn't find that address. Double-check the spelling, or add the city and state — for example "12519 Chardon Windsor Rd, Chardon OH" works better than just the road name.`,
    });
  }
  res.json({
    ok: true,
    coordinates: `${hit.lat},${hit.lng}`,
    display_name: hit.display_name,
    map_url: `https://www.google.com/maps/search/?api=1&query=${hit.lat},${hit.lng}`,
  });
});

app.post('/api/season/fields', requireDirector, requireVerified, async (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const s = getSession(req);
  const { name, sub_field, address, notes, coordinates, program_id, availability } = req.body;
  const vName = V.validateName(name, { label: 'Venue name' });
  if (!vName.ok) return res.status(400).json({ error: vName.error, field: 'name' });
  const vCoords = V.validateCoordinates(coordinates);
  if (!vCoords.ok) return res.status(400).json({ error: vCoords.error, field: 'coordinates' });
  // Directors can only create fields for their own program; admin may set any program_id (or none, for a shared field).
  const fieldProgramId = s.role === 'director' ? s.program_id : (program_id || null);
  const f = { id: 'field-' + Date.now(), name: vName.value, address: (address || '').trim() };
  if (fieldProgramId) f.program_id = fieldProgramId;
  if (sub_field?.trim()) f.sub_field = sub_field.trim();
  if (notes?.trim()) f.notes = notes.trim();
  // If nobody entered or looked up coordinates, try the address they already
  // typed rather than leave travel balancing silently switched off for this
  // field. Best-effort: a failed or slow lookup never blocks the save.
  let coordsValue = vCoords.value;
  if (!coordsValue && f.address) {
    const hit = await geocodeAddress(f.address);
    if (hit) coordsValue = `${hit.lat},${hit.lng}`;
  }
  if (coordsValue) f.coordinates = coordsValue;
  if (availability && typeof availability === 'object') f.availability = availability;
  data.fields = [...(data.fields || []), f];
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true, field: f });
});

app.put('/api/season/fields/:id', requireDirector, requireVerified, async (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const s = getSession(req);
  const idx = (data.fields || []).findIndex(f => String(f.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Field not found' });
  if (!canManageProgram(s, data.fields[idx].program_id)) return res.status(403).json({ error: 'You can only edit fields in your own program' });
  const { name, sub_field, address, notes, coordinates, availability } = req.body;
  const vName = V.validateName(name, { label: 'Venue name' });
  if (!vName.ok) return res.status(400).json({ error: vName.error, field: 'name' });
  const vCoords = V.validateCoordinates(coordinates);
  if (!vCoords.ok) return res.status(400).json({ error: vCoords.error, field: 'coordinates' });
  const trimmedAddress = (address || '').trim();
  const updated = { ...data.fields[idx], name: vName.value, address: trimmedAddress };
  if (sub_field?.trim()) updated.sub_field = sub_field.trim(); else delete updated.sub_field;
  if (notes?.trim()) updated.notes = notes.trim(); else delete updated.notes;
  // Only auto-fill on a genuine gap (never had coordinates, still don't). If a
  // director clears a coordinate that was there before, that's a deliberate
  // edit and geocoding must not silently put it back.
  let coordsValue = vCoords.value;
  if (!coordsValue && !data.fields[idx].coordinates && trimmedAddress) {
    const hit = await geocodeAddress(trimmedAddress);
    if (hit) coordsValue = `${hit.lat},${hit.lng}`;
  }
  if (coordsValue) updated.coordinates = coordsValue; else delete updated.coordinates;
  if (availability && typeof availability === 'object') updated.availability = availability;
  delete updated.weekend_venue; delete updated.weekend_address;
  data.fields[idx] = updated;
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

app.delete('/api/season/fields/:id', requireDirector, requireVerified, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const s = getSession(req);
  const existing = (data.fields || []).find(f => String(f.id) === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Field not found' });
  if (!canManageProgram(s, existing.program_id)) return res.status(403).json({ error: 'You can only delete fields in your own program' });
  const blockers = fieldDeleteBlockers(existing.id, data);
  if (blockers.length && req.query.force !== 'true') {
    return res.status(409).json({
      error: `"${existing.name}" still has ${blockers.join(' and ')}. Reassign those first, or the schedule will reference a venue that no longer exists.`,
      blockers, can_force: true,
    });
  }
  const before = (data.fields || []).length;
  data.fields = (data.fields || []).filter(f => String(f.id) !== req.params.id);
  if (data.fields.length === before) return res.status(404).json({ error: 'Field not found' });
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true });
});

// ── Team CRUD (director or admin) ───────────────────────────────────────────────
// Directors register their own program's teams here, instead of a whole-season upload.
// New teams are live immediately — no confirm step (see NOTES.md).

app.post('/api/teams', requireDirector, requireVerified, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const s = getSession(req);
  const { label, coach, email, phone, division_id, home_field_id, program_id, target_games, earliest_date } = req.body;
  const vLabel = V.validateName(label, { label: 'Team name' });
  if (!vLabel.ok) return res.status(400).json({ error: vLabel.error, field: 'label' });
  const vCoach = V.validateName(coach, { label: 'Coach name', required: false });
  if (!vCoach.ok) return res.status(400).json({ error: vCoach.error, field: 'coach' });
  // Optional: directors routinely register a team before the coach is confirmed.
  // The team is flagged as having no contact until one is added.
  const vEmail = V.validateEmail(email, { required: false, label: 'Coach email' });
  if (!vEmail.ok) return res.status(400).json({ error: vEmail.error, field: 'email' });
  const vPhone = V.validatePhone(phone, { label: 'Coach phone' });
  const vTarget = V.validateTargetGames(target_games);
  if (!vTarget.ok) return res.status(400).json({ error: vTarget.error, field: 'target_games' });
  const vEarliest = V.validateEarliestDate(earliest_date);
  if (!vEarliest.ok) return res.status(400).json({ error: vEarliest.error, field: 'earliest_date' });
  if (!division_id || !(data.divisions || []).some(d => String(d.id) === String(division_id))) {
    return res.status(400).json({ error: 'A valid division_id is required', field: 'division_id' });
  }
  // Email is the login, and findByEmail takes the first match — so a duplicate
  // would leave the second team permanently unreachable by its own coach.
  const dupTeam = vEmail.value && (data.teams || []).find(t => (t.email || '').toLowerCase().trim() === vEmail.value);
  if (dupTeam) {
    return res.status(400).json({ field: 'email',
      error: `${vEmail.value} is already the contact for "${dupTeam.label}". Each team needs its own email, because the address is how that coach signs in. For someone coaching two teams, a plus-address like name+u10@gmail.com works and still reaches the same inbox.` });
  }
  const dupDir = vEmail.value && (data.directors || []).find(d => (d.email || '').toLowerCase().trim() === vEmail.value);
  if (dupDir) {
    return res.status(400).json({ field: 'email',
      error: `${vEmail.value} is already registered as a director. Use a different address for the coach — a director signing in with this address lands on the director page, not the team page.` });
  }
  const teamProgramId = s.role === 'director' ? s.program_id : (program_id || null);
  if (!canManageProgram(s, teamProgramId)) return res.status(403).json({ error: 'You can only add teams to your own program' });
  if (home_field_id) {
    const field = (data.fields || []).find(f => String(f.id) === String(home_field_id));
    if (!field) return res.status(400).json({ error: 'Home field not found' });
    if (field.program_id && field.program_id !== teamProgramId) {
      return res.status(400).json({ error: 'Home field does not belong to this program' });
    }
  }
  const t = {
    id: 'team-' + Date.now(),
    label: vLabel.value,
    coach: vCoach.value,
    email: vEmail.value,
    phone: vPhone.value,
    division_id,
    home_field_id: home_field_id || null,
    program_id: teamProgramId,
    confirmed: true,
    ...(vTarget.value !== undefined ? { target_games: vTarget.value } : {}),
    ...(vEarliest.value !== undefined ? { earliest_date: vEarliest.value } : {}),
  };
  data.teams = [...(data.teams || []), t];
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true, team: t });
});

app.put('/api/teams/:id', requireAuth, requireVerified, async (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const s = getSession(req);
  const idx = (data.teams || []).findIndex(t => String(t.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Team not found' });
  const existing = data.teams[idx];
  if (!canEditTeam(s, existing)) return res.status(403).json({ error: 'You can only edit your own team' });
  const { label, coach, email, phone, home_field_id, availability, target_games, earliest_date } = req.body;
  // Coaches can't move their own team to a different division — only a director/admin can.
  const division_id = s.role === 'coach' ? existing.division_id : req.body.division_id;
  const vLabel = V.validateName(label, { label: 'Team name' });
  if (!vLabel.ok) return res.status(400).json({ error: vLabel.error, field: 'label' });
  const vCoach = V.validateName(coach, { label: 'Coach name', required: false });
  if (!vCoach.ok) return res.status(400).json({ error: vCoach.error, field: 'coach' });
  const vPhone = V.validatePhone(phone, { label: 'Coach phone' });
  const vTarget = V.validateTargetGames(target_games);
  if (!vTarget.ok) return res.status(400).json({ error: vTarget.error, field: 'target_games' });
  const vEarliest = V.validateEarliestDate(earliest_date);
  if (!vEarliest.ok) return res.status(400).json({ error: vEarliest.error, field: 'earliest_date' });
  if (!division_id || !(data.divisions || []).some(d => String(d.id) === String(division_id))) {
    return res.status(400).json({ error: 'A valid division_id is required', field: 'division_id' });
  }
  const teamProgramId = existing.program_id;
  if (home_field_id) {
    const field = (data.fields || []).find(f => String(f.id) === String(home_field_id));
    if (!field) return res.status(400).json({ error: 'Home field not found' });
    if (field.program_id && field.program_id !== teamProgramId) {
      return res.status(400).json({ error: 'Home field does not belong to this program' });
    }
  }

  // Only validate the email when it's actually changing, so a team saved with a
  // legacy-format address on file isn't blocked from editing anything else.
  const rawEmail = V.cleanEmail(email);
  const emailChanged = rawEmail && rawEmail !== existing.email;
  let newEmail = rawEmail;
  if (emailChanged) {
    const vEmail = V.validateEmail(email, { required: true, label: 'Coach email' });
    if (!vEmail.ok) return res.status(400).json({ error: vEmail.error, field: 'email' });
    newEmail = vEmail.value;
    const dupTeam = (data.teams || []).find(t =>
      String(t.id) !== String(existing.id) && (t.email || '').toLowerCase().trim() === newEmail);
    if (dupTeam) {
      return res.status(400).json({ field: 'email',
        error: `${newEmail} is already the contact for "${dupTeam.label}". Each team needs its own email, because the address is how that coach signs in.` });
    }
    const dupDir = (data.directors || []).find(d => (d.email || '').toLowerCase().trim() === newEmail);
    if (dupDir) {
      return res.status(400).json({ field: 'email',
        error: `${newEmail} is already registered as a director. Use a different address for the coach.` });
    }
  }

  data.teams[idx] = {
    ...existing,
    label: vLabel.value,
    coach: vCoach.value,
    phone: vPhone.value,
    division_id,
    home_field_id: home_field_id || null,
    ...(availability && typeof availability === 'object' ? { availability } : {}),
    ...(target_games !== undefined ? { target_games: vTarget.value } : {}),
    ...(earliest_date !== undefined ? { earliest_date: vEarliest.value } : {}),
    // email is intentionally left as-is here — see confirm-email flow below
  };
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }

  if (emailChanged) {
    const result = await sendTeamEmailChangeConfirmation(req, data.teams[idx], newEmail);
    return res.json({ ok: true, team: data.teams[idx], email_change_pending: true, email_change_sent: result.ok, pending_email: newEmail });
  }

  res.json({ ok: true, team: data.teams[idx] });
});

// Redeems an email-change link. No session required — clicking the link at the
// new address IS the proof of ownership, distinct from a login session.
app.get('/api/teams/:id/confirm-email', (req, res) => {
  const result = redeemEmailChangeToken(req.query.token || '');
  if (!result || result.team_id !== req.params.id) {
    return res.status(400).send('This confirmation link is invalid or has expired. Please request the email change again.');
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).send('Could not read season.json'); }
  const idx = (data.teams || []).findIndex(t => String(t.id) === req.params.id);
  if (idx === -1) return res.status(404).send('Team not found.');
  data.teams[idx] = { ...data.teams[idx], email: result.newEmail };
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).send('Could not write season.json'); }
  res.send(`Email confirmed! ${data.teams[idx].label}'s contact email is now ${result.newEmail}. You can close this page.`);
});

app.delete('/api/teams/:id', requireDirector, requireVerified, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const s = getSession(req);
  const existing = (data.teams || []).find(t => String(t.id) === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Team not found' });
  if (!canManageProgram(s, existing.program_id)) return res.status(403).json({ error: 'You can only delete teams in your own program' });
  const blockers = teamDeleteBlockers(existing.id, data);
  if (blockers.length && req.query.force !== 'true') {
    return res.status(409).json({
      error: `"${existing.label}" still has ${blockers.join(' and ')}. Deleting it now would leave games pointing at a team that no longer exists.`,
      blockers, can_force: true,
    });
  }
  data.teams = (data.teams || []).filter(t => String(t.id) !== req.params.id);
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true });
});

// ── Program CRUD (admin) ────────────────────────────────────────────────────────

app.post('/api/season/programs', requireAdmin, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Program name is required' });
  const p = { id: 'program-' + Date.now(), name: name.trim(), created_at: new Date().toISOString() };
  data.programs = [...(data.programs || []), p];
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true, program: p });
});

app.put('/api/season/programs/:id', requireAdmin, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const idx = (data.programs || []).findIndex(p => String(p.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Program not found' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Program name is required' });
  data.programs[idx] = { ...data.programs[idx], name: name.trim() };
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true, program: data.programs[idx] });
});

app.delete('/api/season/programs/:id', requireAdmin, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  // Deleting a program that still owns directors/teams/fields would orphan them
  // (they'd keep a program_id pointing at nothing, silently breaking scoping).
  const blockers = [];
  const dirCount = (data.directors || []).filter(d => d.program_id === req.params.id).length;
  const teamCount = (data.teams || []).filter(t => t.program_id === req.params.id).length;
  const fieldCount = (data.fields || []).filter(f => f.program_id === req.params.id).length;
  if (dirCount)   blockers.push(`${dirCount} director${dirCount !== 1 ? 's' : ''}`);
  if (teamCount)  blockers.push(`${teamCount} team${teamCount !== 1 ? 's' : ''}`);
  if (fieldCount) blockers.push(`${fieldCount} field${fieldCount !== 1 ? 's' : ''}`);
  if (blockers.length) {
    return res.status(400).json({ error: `Cannot delete a program that still has ${blockers.join(', ')} assigned to it` });
  }
  const before = (data.programs || []).length;
  data.programs = (data.programs || []).filter(p => String(p.id) !== req.params.id);
  if (data.programs.length === before) return res.status(404).json({ error: 'Program not found' });
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true });
});

// ── Director CRUD (admin) ───────────────────────────────────────────────────────

app.post('/api/season/directors', requireAdmin, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const { name, email, phone, program_id } = req.body;
  const vName = V.validateName(name, { label: 'Director name' });
  if (!vName.ok) return res.status(400).json({ error: vName.error, field: 'name' });
  const vEmail = V.validateEmail(email, { required: true, label: 'Director email' });
  if (!vEmail.ok) return res.status(400).json({ error: vEmail.error, field: 'email' });
  const vPhone = V.validatePhone(phone, { label: 'Director phone' });
  const cleanEmail = vEmail.value;
  if (!program_id || !(data.programs || []).some(p => String(p.id) === String(program_id))) {
    return res.status(400).json({ error: 'A valid program_id is required', field: 'program_id' });
  }
  if ((data.directors || []).some(d => (d.email || '').toLowerCase().trim() === cleanEmail)) {
    return res.status(400).json({ error: 'A director with that email already exists', field: 'email' });
  }
  const clashTeam = (data.teams || []).find(t => (t.email || '').toLowerCase().trim() === cleanEmail);
  if (clashTeam) {
    return res.status(400).json({ field: 'email',
      error: `${cleanEmail} is already the coach contact for "${clashTeam.label}". One address can't be both — signing in would only ever reach the director page.` });
  }
  const d = {
    id: 'director-' + Date.now(),
    name: vName.value,
    email: cleanEmail,
    phone: vPhone.value,
    program_id,
    active: true,
    created_at: new Date().toISOString(),
  };
  data.directors = [...(data.directors || []), d];
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true, director: d });
});

app.put('/api/season/directors/:id', requireAdmin, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const idx = (data.directors || []).findIndex(d => String(d.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Director not found' });
  const { name, email, phone, program_id, active } = req.body;
  const cleanEmail = (email || '').toLowerCase().trim();
  if (!name || !name.trim()) return res.status(400).json({ error: 'Director name is required' });
  if (!cleanEmail) return res.status(400).json({ error: 'Director email is required' });
  if (!program_id || !(data.programs || []).some(p => String(p.id) === String(program_id))) {
    return res.status(400).json({ error: 'A valid program_id is required' });
  }
  if ((data.directors || []).some((d, i) => i !== idx && (d.email || '').toLowerCase().trim() === cleanEmail)) {
    return res.status(400).json({ error: 'A director with that email already exists' });
  }
  data.directors[idx] = {
    ...data.directors[idx],
    name: name.trim(),
    email: cleanEmail,
    phone: (phone || '').trim(),
    program_id,
    active: active !== false,
  };
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true, director: data.directors[idx] });
});

app.delete('/api/season/directors/:id', requireAdmin, (req, res) => {
  let data;
  try { data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read season.json' }); }
  const before = (data.directors || []).length;
  data.directors = (data.directors || []).filter(d => String(d.id) !== req.params.id);
  if (data.directors.length === before) return res.status(404).json({ error: 'Director not found' });
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
      status:         'scheduled',
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

  createSnapshot('Before importing schedule CSV', 'auto');

  const result = { success: true, games, total_games: games.length, generated_at: new Date().toISOString(), source: 'csv_import', warnings: [], failures: [] };
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(result, null, 2)); }
  catch (err) { return res.status(500).json({ error: `Could not save schedule: ${err.message}` }); }

  res.json({ ok: true, total_games: games.length, warnings });
});

// One-time admin sweep for games stuck without both coaches' confirmation.
// Replaces the old "Finalize Games" action — Ted: games are never really
// finalized, they're always subject to change (negotiation 7+ days out,
// manual override inside 7), so there's no state that should ever hard-block
// a change again. This just moves things along: any game not yet fully
// confirmed (Scheduled or Pending) gets force-confirmed, on the theory that a
// coach's silence isn't an objection. Anything actively Negotiating is left
// alone — force-settling a game mid-negotiation would steamroll a real,
// in-flight conversation, not just an unanswered confirmation request.
// ── Game history ─────────────────────────────────────────────────────────────
// One chronological story per game, merged from the two stores that already
// exist (changes.json = admin actions, change_requests.json = coach
// negotiations). Returns both what has happened and, separately, what is
// happening right now — so a director who goes looking can see an in-flight
// negotiation without waiting for an escalation email.
function buildGameHistory(gameId, changes, changeRequests, seasonData) {
  const teams = seasonData.teams || [];
  const nameOf = id => teams.find(t => String(t.id) === String(id))?.label
    || teams.find(t => String(t.id) === String(id))?.name || String(id || '—');
  const timeline = [];

  for (const c of changes) {
    if (c.game_id !== gameId) continue;
    if (c.type === 'deletion') {
      timeline.push({ at: c.timestamp, actor: 'Admin', kind: 'deleted', summary: 'Admin removed this game from the schedule' });
    } else if (c.type === 'addition') {
      timeline.push({ at: c.timestamp, actor: 'Admin', kind: 'created', summary: 'Admin added this game to the schedule' });
    } else {
      const fields = (c.changed_fields || []).map(f => `${f.field}: ${f.from} → ${f.to}`).join(', ');
      timeline.push({
        at: c.timestamp, actor: 'Admin', kind: 'edited',
        summary: fields ? `Admin edited the game (${fields})` : 'Admin edited the game',
        detail: c.forced ? 'Saved despite scheduling warnings' : null,
      });
    }
  }

  let active = null;
  for (const cr of changeRequests) {
    if (cr.game_id !== gameId) continue;

    if (cr.manual_override) {
      timeline.push({
        at: cr.manual_override.at, actor: nameOf(cr.requesting_team_id || cr.initiating_team_id), kind: 'manual_override',
        summary: `${nameOf(cr.requesting_team_id || cr.initiating_team_id)} changed the game directly (inside the 7-day window)`,
        detail: `Agreed with ${cr.manual_override.who} by ${cr.manual_override.how}`,
      });
      continue;
    }

    timeline.push({
      at: cr.submitted_at, actor: nameOf(cr.initiating_team_id), kind: 'requested',
      summary: `${nameOf(cr.initiating_team_id)} asked to change this game`,
      detail: cr.reason || null,
    });

    // Each superseded proposal, then whatever is currently on the table.
    for (const h of (cr.history || [])) {
      timeline.push({
        at: h.at, actor: nameOf(h.proposing_team_id), kind: 'proposed',
        summary: `${nameOf(h.proposing_team_id)} proposed ${h.date} at ${h.time} (round ${h.round})`,
      });
    }
    if (cr.proposal && cr.round >= 1) {
      timeline.push({
        at: cr.round_started_at || cr.submitted_at, actor: nameOf(cr.proposing_team_id), kind: 'proposed',
        summary: `${nameOf(cr.proposing_team_id)} proposed ${cr.proposal.date} at ${cr.proposal.time} (round ${cr.round})`,
      });
    }
    if (cr.director_notified_at) {
      timeline.push({ at: cr.director_notified_at, actor: 'System', kind: 'escalated',
        summary: `Deadline missed — ${nameOf(cr.awaiting_team_id)}'s director was notified` });
    }
    if (cr.admin_notified_at) {
      timeline.push({ at: cr.admin_notified_at, actor: 'System', kind: 'escalated',
        summary: 'Still unanswered — league admin was notified' });
    }
    if (cr.stalemate_notified_at) {
      timeline.push({ at: cr.stalemate_notified_at, actor: 'System', kind: 'escalated',
        summary: `No agreement after ${cr.round} rounds — both directors were looped in` });
    }
    if (cr.status === 'confirmed') {
      timeline.push({ at: cr.responded_at, actor: nameOf(cr.awaiting_team_id), kind: 'agreed',
        summary: `${nameOf(cr.awaiting_team_id)} agreed — game moved to ${cr.proposal?.date} at ${cr.proposal?.time}` });
    }
    if (cr.status === 'cancelled') {
      timeline.push({ at: cr.responded_at || cr.submitted_at, actor: nameOf(cr.initiating_team_id), kind: 'cancelled',
        summary: `${nameOf(cr.initiating_team_id)} cancelled the request` });
    }
    if (cr.status === 'escalated') {
      timeline.push({ at: cr.responded_at || cr.round_started_at, actor: 'System', kind: 'escalated',
        summary: 'No time works for both teams — handed to the directors' });
    }

    if (cr.status === 'awaiting_response' || cr.status === 'awaiting_requester_confirm') {
      active = {
        change_request_id: cr.id,
        status: cr.status,
        round: cr.round || 0,
        proposal: cr.proposal || null,
        proposed_by: cr.proposing_team_id ? nameOf(cr.proposing_team_id) : null,
        awaiting: cr.awaiting_team_id ? nameOf(cr.awaiting_team_id) : nameOf(cr.initiating_team_id),
        awaiting_team_id: cr.awaiting_team_id,
        response_due_at: cr.response_due_at || null,
        reason: cr.reason || null,
        escalated: {
          director: !!cr.director_notified_at,
          admin: !!cr.admin_notified_at,
          stalemate: !!cr.stalemate_notified_at,
        },
        summary: cr.status === 'awaiting_requester_confirm'
          ? `${nameOf(cr.initiating_team_id)} started a change request but hasn't confirmed it yet`
          : `Round ${cr.round} — ${nameOf(cr.proposing_team_id)} proposed ${cr.proposal?.date} at ${cr.proposal?.time}, waiting on ${nameOf(cr.awaiting_team_id)}`,
      };
    }
  }

  timeline.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return { timeline, active };
}

app.get('/api/games/:id/history', requireAuth, (req, res) => {
  const gameId = parseInt(req.params.id, 10);
  let seasonData, changes = [];
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); }
  catch { return res.status(500).json({ error: 'Could not read season.json' }); }
  try { if (fs.existsSync(CHANGES_FILE)) changes = JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); } catch {}

  const { timeline, active } = buildGameHistory(gameId, changes, readChangeRequests(), seasonData);
  res.json({ ok: true, game_id: gameId, timeline, active });
});

app.get('/api/change-requests', requireAdmin, (req, res) => {
  res.json(readChangeRequests());
});

// ── Snapshot endpoints (admin) ───────────────────────────────────────────────

// ── Season setup (admin) ─────────────────────────────────────────────────────

app.get('/api/season/config', requireAdmin, (req, res) => {
  const data = readJsonSafe(SEASON_FILE, null);
  if (!data) return res.status(500).json({ error: 'Could not read season.json' });
  const season = data.season || {};
  // Preview the calendar this config produces, so the effect of a start date is
  // visible before saving rather than only after running the scheduler.
  res.json({
    ok: true,
    season,
    divisions: data.divisions || [],
    calendar: buildSeasonWeeks(season).map(w => ({ week: w.week, first: w.weekdays[0], saturday: w.saturday })),
  });
});

app.put('/api/season/config', requireAdmin, (req, res) => {
  const data = readJsonSafe(SEASON_FILE, null);
  if (!data) return res.status(500).json({ error: 'Could not read season.json' });
  const { start, weeks, target_games, blackout_dates } = req.body || {};

  if (start !== undefined && start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return res.status(400).json({ error: 'Start date must be YYYY-MM-DD' });
  }
  if (weeks !== undefined && weeks !== null && !(Number(weeks) > 0 && Number(weeks) <= 52)) {
    return res.status(400).json({ error: 'Weeks must be between 1 and 52' });
  }
  const badDate = (blackout_dates || []).find(d => !/^\d{4}-\d{2}-\d{2}$/.test(d));
  if (badDate) return res.status(400).json({ error: `Blackout date "${badDate}" must be YYYY-MM-DD` });

  data.season = { ...(data.season || {}) };
  if (start !== undefined)          data.season.start = start;
  if (weeks !== undefined)          data.season.weeks = Number(weeks) || undefined;
  if (target_games !== undefined)   data.season.target_games = Number(target_games) || undefined;
  if (blackout_dates !== undefined) data.season.blackout_dates = blackout_dates;

  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write season.json' }); }

  res.json({ ok: true, season: data.season,
    calendar: buildSeasonWeeks(data.season).map(w => ({ week: w.week, first: w.weekdays[0], saturday: w.saturday })) });
});

// ── Division CRUD (admin) ────────────────────────────────────────────────────

app.post('/api/season/divisions', requireAdmin, (req, res) => {
  const data = readJsonSafe(SEASON_FILE, null);
  if (!data) return res.status(500).json({ error: 'Could not read season.json' });
  const { id, name, target_games, game_length_minutes } = req.body || {};
  if (!id || !String(id).trim())   return res.status(400).json({ error: 'Division id is required (e.g. u10b)' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Division name is required' });
  data.divisions = data.divisions || [];
  if (data.divisions.some(d => String(d.id) === String(id).trim())) {
    return res.status(400).json({ error: 'A division with that id already exists' });
  }
  const div = { id: String(id).trim(), name: String(name).trim() };
  if (target_games) div.target_games = Number(target_games);
  if (game_length_minutes) div.game_length_minutes = Number(game_length_minutes);
  data.divisions.push(div);
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true, division: div });
});

app.put('/api/season/divisions/:id', requireAdmin, (req, res) => {
  const data = readJsonSafe(SEASON_FILE, null);
  if (!data) return res.status(500).json({ error: 'Could not read season.json' });
  const idx = (data.divisions || []).findIndex(d => String(d.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Division not found' });
  const { name, target_games, game_length_minutes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Division name is required' });
  data.divisions[idx] = { ...data.divisions[idx], name: String(name).trim(),
    ...(target_games ? { target_games: Number(target_games) } : {}),
    ...(game_length_minutes ? { game_length_minutes: Number(game_length_minutes) } : {}) };
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true, division: data.divisions[idx] });
});

app.delete('/api/season/divisions/:id', requireAdmin, (req, res) => {
  const data = readJsonSafe(SEASON_FILE, null);
  if (!data) return res.status(500).json({ error: 'Could not read season.json' });
  // Same integrity guard as programs — deleting would orphan the teams in it.
  const inUse = (data.teams || []).filter(t => String(t.division_id) === req.params.id).length;
  if (inUse) return res.status(400).json({ error: `Cannot delete a division with ${inUse} team${inUse !== 1 ? 's' : ''} still in it` });
  const before = (data.divisions || []).length;
  data.divisions = (data.divisions || []).filter(d => String(d.id) !== req.params.id);
  if (data.divisions.length === before) return res.status(404).json({ error: 'Division not found' });
  try { fs.writeFileSync(SEASON_FILE, JSON.stringify(data, null, 2)); }
  catch { return res.status(500).json({ error: 'Could not write season.json' }); }
  res.json({ ok: true });
});

// Season rollover. Programs, directors and fields persist year to year, so they
// carry over; teams, the schedule and any in-flight requests are last season's
// and are cleared for a fresh registration.
app.post('/api/season/new', requireAdmin, (req, res) => {
  const { start, weeks, target_games, label } = req.body || {};
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return res.status(400).json({ error: 'A start date (YYYY-MM-DD) is required for the new season' });
  }
  const data = readJsonSafe(SEASON_FILE, null);
  if (!data) return res.status(500).json({ error: 'Could not read season.json' });

  const archived = createSnapshot(label ? `End of season: ${label}` : 'End of previous season', 'manual');
  if (!archived) return res.status(500).json({ error: 'Could not archive the current season — aborting' });

  const carried = {
    season: {
      ...(data.season || {}),
      start,
      weeks: Number(weeks) || data.season?.weeks,
      target_games: Number(target_games) || data.season?.target_games,
      blackout_dates: [],
    },
    divisions: data.divisions || [],
    programs: data.programs || [],
    directors: data.directors || [],
    fields: data.fields || [],
    teams: [],
  };

  try {
    fs.writeFileSync(SEASON_FILE, JSON.stringify(carried, null, 2));
    if (fs.existsSync(SCHEDULE_FILE)) fs.unlinkSync(SCHEDULE_FILE);
    fs.writeFileSync(CHANGE_REQUESTS_FILE, '[]');
  } catch (err) {
    return res.status(500).json({ error: `Could not start new season: ${err.message}` });
  }

  res.json({ ok: true, archived_snapshot: archived.id, season: carried.season,
    kept: { programs: carried.programs.length, directors: carried.directors.length, fields: carried.fields.length, divisions: carried.divisions.length } });
});

app.get('/api/snapshots', requireAdmin, (req, res) => {
  res.json({ ok: true, snapshots: listSnapshots() });
});

app.post('/api/snapshots', requireAdmin, (req, res) => {
  const label = (req.body?.label || '').trim() || 'Manual snapshot';
  const snap = createSnapshot(label, 'manual');
  if (!snap) return res.status(500).json({ error: 'Could not create snapshot' });
  res.json({ ok: true, snapshot: { id: snap.id, label: snap.label, kind: snap.kind, created_at: snap.created_at, summary: snap.summary } });
});

app.post('/api/snapshots/:id/restore', requireAdmin, (req, res) => {
  const file = path.join(SNAPSHOT_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Snapshot not found' });
  const snap = readJsonSafe(file, null);
  if (!snap) return res.status(500).json({ error: 'Snapshot is unreadable' });

  // Restoring is itself destructive, so capture the current state first —
  // a mistaken restore must also be undoable.
  createSnapshot(`Before restoring "${snap.label}"`, 'auto');

  try {
    if (snap.season)   fs.writeFileSync(SEASON_FILE, JSON.stringify(snap.season, null, 2));
    if (snap.schedule) fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(snap.schedule, null, 2));
    else if (fs.existsSync(SCHEDULE_FILE)) fs.unlinkSync(SCHEDULE_FILE);
    fs.writeFileSync(CHANGE_REQUESTS_FILE, JSON.stringify(snap.change_requests || [], null, 2));
  } catch (err) {
    return res.status(500).json({ error: `Restore failed: ${err.message}` });
  }
  res.json({ ok: true, restored: { id: snap.id, label: snap.label, created_at: snap.created_at }, summary: snap.summary });
});

app.delete('/api/snapshots/:id', requireAdmin, (req, res) => {
  const file = path.join(SNAPSHOT_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Snapshot not found' });
  try { fs.unlinkSync(file); } catch (err) { return res.status(500).json({ error: err.message }); }
  res.json({ ok: true });
});

app.post('/api/games/settle-pending', requireAdmin, (req, res) => {
  createSnapshot('Before settling pending game confirmations', 'auto');
  let schedData;
  try { schedData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch (err) { return res.status(500).json({ error: 'Could not read schedule.json' }); }

  let settled = 0;
  const skippedNegotiating = [];
  for (const g of schedData.games) {
    const status = g.status || 'scheduled';
    if (status === 'negotiating') { skippedNegotiating.push(g.game_id); continue; }
    if (status === 'confirmed') continue;
    g.status = 'confirmed';
    g.confirmations = { home: true, away: true };
    settled++;
  }
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedData, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write schedule.json' }); }

  res.json({ ok: true, settled, skipped_negotiating: skippedNegotiating });
});

// Coach-facing confirmation that a game, as currently scheduled, works for
// them — the first new lifecycle step, distinct from and unrelated to
// requesting a change. Director/admin can act on a coach's behalf, same
// permission model as everything else here (resolveRequestingTeam).
app.post('/api/games/:id/confirm', requireVerified, (req, res) => {
  const s = getSession(req);
  const gameId = parseInt(req.params.id, 10);
  const ctx = loadGameContext(req, gameId);
  if (ctx.error) return res.status(ctx.status || 500).json({ error: ctx.error });

  const myTeamId = resolveRequestingTeam(s, ctx.game, req.body?.team_id, ctx.teams);
  if (!myTeamId) return res.status(403).json({ error: 'You can only confirm your own game' });

  const status = ctx.game.status || 'scheduled';
  if (status === 'negotiating') {
    return res.status(400).json({ error: 'This game has an active change request — resolve that first, then confirm.' });
  }

  const side = String(myTeamId) === String(ctx.game.home_team_id) ? 'home' : 'away';
  const confirmations = { home: false, away: false, ...(ctx.game.confirmations || {}) };
  confirmations[side] = true;

  const newStatus = confirmations.home && confirmations.away ? 'confirmed' : 'pending';
  const gameIdx = ctx.schedData.games.findIndex(g => g.game_id === gameId);
  ctx.schedData.games[gameIdx] = { ...ctx.game, confirmations, status: newStatus };
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(ctx.schedData, null, 2)); }
  catch (err) { return res.status(500).json({ error: 'Could not write schedule.json' }); }

  res.json({ ok: true, status: newStatus, confirmations });
});

// ── Score reporting ──────────────────────────────────────────────────────────
// Deliberately NOT a negotiation like change requests — whoever gets there
// first enters it, the other side (or either director/admin) can correct it
// any time, and it's marked "final" purely as a display label once
// RESULT_EDIT_WINDOW_DAYS pass since the last edit with nothing more required
// from anyone (Ted: "doesn't hang as pending confirmation or similar").
// TODO: only show the entry button once the game's kickoff time has passed —
// left ungated for now so the flow can be tested, same as rainout visibility.
const RESULT_EDIT_WINDOW_DAYS = 7;

function resultEffectiveStatus(result) {
  if (!result || !result.history?.length) return null;
  const last = result.history[result.history.length - 1];
  return daysBetween(last.at, new Date().toISOString()) >= RESULT_EDIT_WINDOW_DAYS ? 'final' : 'reported';
}

app.post('/api/games/:id/result', requireVerified, (req, res) => {
  const s = getSession(req);
  const gameId = parseInt(req.params.id, 10);
  const ctx = loadGameContext(req, gameId);
  if (ctx.error) return res.status(ctx.status || 500).json({ error: ctx.error });
  if (ctx.game.status === 'cancelled') {
    return res.status(400).json({ error: 'This game was cancelled — nothing to score.' });
  }

  const myTeamId = resolveRequestingTeam(s, ctx.game, req.body?.team_id, ctx.teams);
  if (!myTeamId) return res.status(403).json({ error: 'You can only report a score for your own game' });

  const { home_score, away_score, note } = req.body || {};
  const hs = parseInt(home_score, 10), as = parseInt(away_score, 10);
  if (!Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0 ||
      String(home_score).trim() === '' || String(away_score).trim() === '') {
    return res.status(400).json({ error: 'Scores must be non-negative whole numbers' });
  }
  const trimmedNote = (note || '').trim();
  const isEdit = !!ctx.game.result;
  if (isEdit && !trimmedNote) {
    return res.status(400).json({ error: 'A short note is required when changing an already-reported score' });
  }

  const now = new Date().toISOString();
  const entry = { home_score: hs, away_score: as, note: trimmedNote, team_id: myTeamId, at: now };
  const result = isEdit
    ? { ...ctx.game.result, home_score: hs, away_score: as, note: trimmedNote, history: [...ctx.game.result.history, entry] }
    : { home_score: hs, away_score: as, note: trimmedNote, reported_by_team_id: myTeamId, reported_at: now, history: [entry] };

  const gameIdx = ctx.schedData.games.findIndex(g => g.game_id === gameId);
  ctx.schedData.games[gameIdx] = { ...ctx.game, result };
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(ctx.schedData, null, 2)); }
  catch { return res.status(500).json({ error: 'Could not write schedule.json' }); }

  res.json({ ok: true, result, status: resultEffectiveStatus(result) });
});

// Anything that throws inside a route lands here. Without this, Express's
// default handler renders an HTML stack-trace page — so an API caller doing
// `res.json()` gets "Unexpected token '<'" instead of the actual error, which
// is exactly how one intermittent 500 in the change-request options endpoint
// showed up during testing: a misleading JSON parse error, several layers
// away from the real fault. API paths now always get JSON.
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity; `next` must stay.
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Something went wrong handling that request.' });
  }
  res.status(500).send('Something went wrong. Please go back and try again.');
});

app.listen(PORT, () => {
  console.log(`Eastlake League Scheduler running at http://localhost:${PORT}`);
});

// ── Escalation timer ──────────────────────────────────────────────────────────
// Purely additive notifications — never changes a request's status, so the other
// coach's approve/reject links keep working throughout. Idempotent via the
// *_notified_at flags, so a missed tick (server restart) just delays the next
// email rather than duplicating or losing one.
const ESCALATION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function checkEscalations() {
  const list = readChangeRequests();
  let seasonData;
  try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); } catch { return; }
  const teams = seasonData.teams || [];
  const directors = seasonData.directors || [];
  let changed = false;
  const nameOf = id => teams.find(t => String(t.id) === String(id))?.label || teams.find(t => String(t.id) === String(id))?.name || id;

  for (const cr of list) {
    if (cr.status !== 'awaiting_response' || !cr.round_started_at) continue;
    // Measured per round: each new proposal restarts the clock, because it's a
    // genuinely fresh ask of the other coach.
    const daysElapsed = daysBetween(cr.round_started_at, new Date().toISOString());
    const deadlineDays = responseDeadlineDays(cr.round);
    const awaitingTeam = teams.find(t => String(t.id) === String(cr.awaiting_team_id));
    const proposingTeam = teams.find(t => String(t.id) === String(cr.proposing_team_id));

    // ── Nobody responded by their deadline ─────────────────────────────────
    if (daysElapsed >= deadlineDays && !cr.director_notified_at) {
      const emails = directors
        .filter(d => d.active !== false && d.program_id === awaitingTeam?.program_id)
        .map(d => d.email).filter(Boolean);
      if (emails.length) {
        const subj = `${nameOf(cr.initiating_team_id)} vs ${nameOf(cr.other_team_id)}: unanswered change request`;
        await sendEmail({
          to: emails,
          subject: subj,
          text: [
            `${awaitingTeam?.label || 'One of your coaches'} missed their deadline to respond to Game #${cr.game_id}.`,
            `Proposed by ${proposingTeam?.label || 'the other coach'}: ${describeSlot(cr.proposal, seasonData.fields)}`,
            `Round ${cr.round} — they had ${deadlineDays} day${deadlineDays !== 1 ? 's' : ''} (due ${formatDeadline(cr.response_due_at)}), now ${daysElapsed} days on.`,
            `Could you nudge them to either accept it or suggest another time?`,
            '', '— Eastlake Scheduler',
          ].join('\n'),
          html: emailShell(`
            ${emailHeading(subj)}
            ${emailP(`${emailEsc(awaitingTeam?.label || 'One of your coaches')} missed their deadline to respond.`)}
            ${emailGameCard({ homeLabel: nameOf(cr.initiating_team_id), awayLabel: nameOf(cr.other_team_id), date: cr.proposal.date, time: cr.proposal.time, fieldName: fieldLabel(cr.proposal.field_id, seasonData.fields), fieldAddress: fieldAddressOf(cr.proposal.field_id, seasonData.fields), caption: `Proposed by ${proposingTeam?.label || 'the other coach'}` })}
            ${emailP(`Round ${cr.round} — they had ${deadlineDays} day${deadlineDays !== 1 ? 's' : ''} (due ${emailEsc(formatDeadline(cr.response_due_at))}), now ${daysElapsed} days on.`)}
            ${emailContactCard(awaitingTeam)}
            ${emailP('Could you nudge them to either accept it or suggest another time?')}
          `),
        });
      }
      cr.director_notified_at = new Date().toISOString();
      changed = true;
    }

    if (daysElapsed >= deadlineDays + ADMIN_ESCALATION_GRACE_DAYS && !cr.admin_notified_at) {
      if (ADMIN_EMAIL) {
        const subj = `${nameOf(cr.initiating_team_id)} vs ${nameOf(cr.other_team_id)}: still unanswered — escalated`;
        await sendEmail({
          to: ADMIN_EMAIL,
          subject: subj,
          text: [
            `A proposed time for Game #${cr.game_id} has gone unanswered for ${daysElapsed} days (director already notified).`,
            `Round ${cr.round} — deadline was ${deadlineDays} day${deadlineDays !== 1 ? 's' : ''} (${formatDeadline(cr.response_due_at)}).`,
            `Waiting on: ${nameOf(cr.awaiting_team_id)}`,
            `Proposed by: ${nameOf(cr.proposing_team_id)}`,
            `Reason: ${cr.reason || '—'}`,
            '', '— Eastlake Scheduler',
          ].join('\n'),
          html: emailShell(`
            ${emailHeading(subj)}
            ${emailP(`A proposed time has gone unanswered for ${daysElapsed} days (director already notified).`)}
            ${emailGameCard({ homeLabel: nameOf(cr.initiating_team_id), awayLabel: nameOf(cr.other_team_id), date: cr.proposal.date, time: cr.proposal.time, fieldName: fieldLabel(cr.proposal.field_id, seasonData.fields), fieldAddress: fieldAddressOf(cr.proposal.field_id, seasonData.fields), caption: `Proposed by ${nameOf(cr.proposing_team_id)} — waiting on ${nameOf(cr.awaiting_team_id)}` })}
            ${emailP(`Round ${cr.round} — deadline was ${deadlineDays} day${deadlineDays !== 1 ? 's' : ''} (${emailEsc(formatDeadline(cr.response_due_at))}).${cr.reason ? ` Reason: ${emailEsc(cr.reason)}` : ''}`)}
          `),
        });
      }
      cr.admin_notified_at = new Date().toISOString();
      changed = true;
    }

    // ── Stalemate: they're both responding, just not agreeing ──────────────
    // Fires once. The thread stays open — this is visibility for the directors,
    // not a takeover, since the coaches may still settle it themselves.
    if ((cr.round || 0) > STALEMATE_ROUND_LIMIT && !cr.stalemate_notified_at) {
      const emails = directorsForTeams(seasonData, [cr.initiating_team_id, cr.other_team_id])
        .map(d => d.email).filter(Boolean);
      if (emails.length) {
        const subj = `${nameOf(cr.initiating_team_id)} vs ${nameOf(cr.other_team_id)}: stuck after ${cr.round} rounds`;
        await sendEmail({
          to: [...new Set(emails)],
          subject: subj,
          text: [
            `${nameOf(cr.initiating_team_id)} and ${nameOf(cr.other_team_id)} have exchanged ${cr.round} proposals for Game #${cr.game_id} without agreeing.`,
            `Currently on the table: ${describeSlot(cr.proposal, seasonData.fields)} (waiting on ${nameOf(cr.awaiting_team_id)})`,
            '',
            `Every option offered already fits both teams' stated availability, so this usually means one team's availability needs updating.`,
            `They can still resolve it themselves — this is just so you know it's stuck.`,
            '', '— Eastlake Scheduler',
          ].join('\n'),
          html: emailShell(`
            ${emailHeading(subj)}
            ${emailP(`${emailEsc(nameOf(cr.initiating_team_id))} and ${emailEsc(nameOf(cr.other_team_id))} have exchanged ${cr.round} proposals without agreeing.`)}
            ${emailGameCard({ homeLabel: nameOf(cr.initiating_team_id), awayLabel: nameOf(cr.other_team_id), date: cr.proposal.date, time: cr.proposal.time, fieldName: fieldLabel(cr.proposal.field_id, seasonData.fields), fieldAddress: fieldAddressOf(cr.proposal.field_id, seasonData.fields), caption: `Currently on the table — waiting on ${nameOf(cr.awaiting_team_id)}` })}
            ${emailP('Every option offered already fits both teams\' stated availability, so this usually means one team\'s availability needs updating. They can still resolve it themselves — this is just so you know it\'s stuck.')}
          `),
        });
      }
      cr.stalemate_notified_at = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) writeChangeRequests(list);
}

setInterval(() => { checkEscalations().catch(err => console.error('Escalation check failed:', err.message)); }, ESCALATION_CHECK_INTERVAL_MS);
