'use strict';
// Small shared UI helpers loaded by the coach, director and admin pages.
// Replaces the alert()/prompt() calls that had accumulated — fine while
// building, wrong for something coaches use on a phone mid-season.

function uiEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Transient confirmation. Non-blocking, unlike alert().
function toast(message, kind) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0';
                     setTimeout(() => el.remove(), 300); }, kind === 'bad' ? 5200 : 3600);
}

// Slide-over panel. Closes on backdrop click or Escape.
function openPanel(title, bodyHtml) {
  closePanel();
  const wrap = document.createElement('div');
  wrap.className = 'panel-overlay';
  wrap.id = 'ui-panel';
  wrap.innerHTML = `<div class="panel" role="dialog" aria-modal="true">
      <div class="panel-head"><h2>${uiEsc(title)}</h2>
        <button class="panel-close" aria-label="Close">&times;</button></div>
      <div class="panel-body">${bodyHtml}</div>
    </div>`;
  wrap.addEventListener('click', e => { if (e.target === wrap) closePanel(); });
  wrap.querySelector('.panel-close').addEventListener('click', closePanel);
  document.body.appendChild(wrap);
  document.body.style.overflow = 'hidden';
}
function closePanel() {
  const p = document.getElementById('ui-panel');
  if (p) p.remove();
  document.body.style.overflow = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

// Typed confirmation for destructive actions, where a plain OK/Cancel is too
// easy to click through.
function confirmTyped(title, message, word) {
  return new Promise(resolve => {
    // The message already names the word, so the input carries no second copy of
    // the instruction — seen side by side on a phone it read as a stutter.
    openPanel(title, `
      <p class="confirm-msg">${message}</p>
      <div class="confirm-row">
        <input id="ui-confirm-input" type="text" autocomplete="off"
               autocapitalize="none" autocorrect="off" spellcheck="false"
               aria-label="Type ${uiEsc(word)} to confirm" placeholder="${uiEsc(word)}">
      </div>
      <div id="ui-confirm-err" class="notice notice-bad" style="display:none">
        That didn't match — nothing has been changed.</div>
      <div class="confirm-actions">
        <button class="btn btn-secondary" id="ui-confirm-no">Cancel</button>
        <button class="btn btn-danger" id="ui-confirm-yes">Confirm</button>
      </div>`);
    const done = (v) => { closePanel(); resolve(v); };
    document.getElementById('ui-confirm-no').onclick = () => done(false);
    document.getElementById('ui-confirm-yes').onclick = () => {
      const typed = (document.getElementById('ui-confirm-input').value || '').trim().toLowerCase();
      if (typed === String(word).toLowerCase()) return done(true);
      document.getElementById('ui-confirm-err').style.display = '';
    };
    const input = document.getElementById('ui-confirm-input');
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('ui-confirm-yes').click(); }
    });
    // Clear the mismatch warning as soon as they start correcting it.
    input.addEventListener('input', () => {
      document.getElementById('ui-confirm-err').style.display = 'none';
    });
    setTimeout(() => input.focus(), 50);
  });
}

// ── Game history ────────────────────────────────────────────────────────────
// Previously an alert() dumping plain text. This is the surface Ted asked to be
// "very clear", and directors need to read it mid-negotiation, so it gets a
// proper timeline with the live state called out at the top.

function uiWhen(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US',
    { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function uiDue(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric' });
}

async function showGameHistory(gameId) {
  openPanel(`Game #${gameId}`, '<p class="muted">Loading history…</p>');
  let data;
  try {
    const res = await fetch(`api/games/${gameId}/history`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch {
    openPanel(`Game #${gameId}`, '<p class="danger-text">Could not load history for this game.</p>');
    return;
  }

  let html = '';
  if (data.active) {
    const a = data.active;
    const overdue = a.response_due_at && new Date(a.response_due_at) < new Date();
    const flags = [
      a.escalated?.director ? 'director notified' : null,
      a.escalated?.admin ? 'admin notified' : null,
      a.escalated?.stalemate ? 'stalemate — directors looped in' : null,
    ].filter(Boolean);
    html += `<div class="live-box">
      <h3>Change in progress</h3>
      <p>${uiEsc(a.summary)}</p>
      ${a.response_due_at ? `<p class="due">${overdue ? 'Response was due' : 'Response due'} ${uiEsc(uiDue(a.response_due_at))}${overdue ? ' — now overdue' : ''}</p>` : ''}
      ${flags.length ? `<p class="due">${uiEsc(flags.join(' · '))}</p>` : ''}
    </div>`;
  }

  const items = (data.timeline || []);
  if (!items.length) {
    html += '<p class="empty-note">Nothing has changed on this game yet.</p>';
  } else {
    html += '<ul class="tl">' + items.map(e => {
      const cls = e.kind === 'agreed' ? 'is-agreed'
                : e.kind === 'escalated' ? 'is-escalated'
                : e.kind === 'proposed' ? 'is-proposed' : '';
      return `<li class="${cls}">
        <div class="tl-when">${uiEsc(uiWhen(e.at))}</div>
        <div class="tl-what">${uiEsc(e.summary)}</div>
        ${e.detail ? `<div class="tl-detail">${uiEsc(e.detail)}</div>` : ''}
      </li>`;
    }).join('') + '</ul>';
  }
  openPanel(`Game #${gameId}`, html);
}

// ── Form validation ─────────────────────────────────────────────────────────
// Mirrors lib/validate.js so obvious mistakes are caught before a round-trip,
// and pins the message to the field that caused it. The server still validates
// everything — this is for speed of feedback, not security.

const UI_EMAIL_RE = /^[^\s@,;<>()[\]\\]+@[^\s@,;<>()[\]\\]+\.[a-z]{2,}$/i;

// Attaches (or clears) an error message directly under one input.
function fieldError(inputId, message) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const label = input.closest('label') || input.parentElement;
  let note = label.querySelector('.field-err');
  if (!message) {
    input.classList.remove('has-error');
    input.removeAttribute('aria-invalid');
    if (note) note.remove();
    return;
  }
  input.classList.add('has-error');
  input.setAttribute('aria-invalid', 'true');
  if (!note) {
    note = document.createElement('div');
    note.className = 'field-err';
    label.appendChild(note);
  }
  note.textContent = message;
}

// Non-blocking advisory shown under a field.
function fieldNote(inputId, message) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const label = input.closest('label') || input.parentElement;
  let note = label.querySelector('.field-note');
  if (!message) { if (note) note.remove(); return; }
  if (!note) {
    note = document.createElement('div');
    note.className = 'field-note';
    label.appendChild(note);
  }
  note.textContent = message;
}

function clearFieldErrors(scopeEl) {
  const root = typeof scopeEl === 'string' ? document.getElementById(scopeEl) : (scopeEl || document);
  if (!root) return;
  root.querySelectorAll('.field-err, .field-note').forEach(n => n.remove());
  root.querySelectorAll('.has-error').forEach(n => {
    n.classList.remove('has-error');
    n.removeAttribute('aria-invalid');
  });
}

// Puts a server error on its field when the response names one, so the user
// isn't left scanning a long form for what went wrong.
function applyServerError(data, fallbackEl) {
  if (data && data.field && document.getElementById(data.field)) {
    fieldError(data.field, data.error);
    document.getElementById(data.field).focus();
    return true;
  }
  return false;
}

// Client-side checks. Returns true if everything passed.
// spec: [{ id, label, required, type: 'email'|'phone'|'coords'|'int'|'text', min, max }]
function validateForm(spec) {
  let firstBad = null;
  for (const f of spec) {
    const el = document.getElementById(f.id);
    if (!el) continue;
    fieldError(f.id, null);
    const raw = (el.value || '').trim();
    let err = null;

    if (!raw) {
      if (f.required) err = `${f.label} is required.`;
    } else if (f.type === 'email' && !UI_EMAIL_RE.test(raw)) {
      err = `That doesn't look like an email address — check for a missing @ or a typo in the domain.`;
    } else if (f.type === 'phone') {
      // Advisory only. Phone formats vary too much to block a save over, but a
      // short number is worth flagging since it's the fallback contact inside
      // 7 days of a game.
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 10) fieldNote(f.id, `This looks short for a phone number — worth double-checking.`);
    } else if (f.type === 'coords') {
      const m = raw.replace(/\s+/g, '').match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
      const url = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.test(raw);
      if (!m && !url) {
        err = `Should look like "41.535017, -81.461610" — right-click the spot in Google Maps and click the numbers to copy them.`;
      }
    } else if (f.type === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n)) err = `${f.label} must be a whole number.`;
      else if (f.min != null && n < f.min) err = `${f.label} must be at least ${f.min}.`;
      else if (f.max != null && n > f.max) err = `${f.label} can be at most ${f.max}.`;
    }

    if (err) { fieldError(f.id, err); if (!firstBad) firstBad = el; }
  }
  if (firstBad) {
    firstBad.focus();
    firstBad.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return false;
  }
  return true;
}

// Delete helper for the routes that now 409 with a list of blockers rather than
// silently orphaning schedule rows.
async function deleteWithBlockers(url, name, word) {
  if (!await confirmTyped(`Delete ${name}?`,
      `This can't be undone. Type <strong>${word}</strong> below to confirm.`, word)) return false;
  let res = await fetch(url, { method: 'DELETE' });
  let data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.can_force) {
    const ok = await confirmTyped('Still in use — delete anyway?',
      `${uiEsc(data.error)}<br><br>You can force this, but you should expect to re-run the scheduler afterwards. Type <strong>force</strong> to go ahead.`,
      'force');
    if (!ok) return false;
    res = await fetch(url + (url.includes('?') ? '&' : '?') + 'force=true', { method: 'DELETE' });
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok || !data.ok) { toast(data.error || 'Delete failed.', 'bad'); return false; }
  toast(`${name} deleted.`);
  return true;
}

// ── Field geocoding ──────────────────────────────────────────────────────────
// Nobody registering a field should need to know what a coordinate is. The
// address is something every director already has, so this turns that into
// coordinates for them, with a manual fallback for the times it doesn't match.

function wireFieldGeocode() {
  const addressEl = document.getElementById('ffe-address');
  const coordsEl  = document.getElementById('ffe-coords');
  const btn       = document.getElementById('ffe-geocode-btn');
  const resultEl  = document.getElementById('ffe-geocode-result');
  const mapsLink  = document.getElementById('ffe-maps-link');
  if (!addressEl || !coordsEl || !btn) return; // page has no field form (e.g. my-team)

  function updateMapsLink() {
    const q = (addressEl.value || '').trim();
    mapsLink.href = q
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
      : 'https://www.google.com/maps';
  }
  addressEl.addEventListener('input', updateMapsLink);
  updateMapsLink();

  function showResult(kind, html) {
    resultEl.className = 'geocode-result ' + kind;
    resultEl.innerHTML = html;
  }

  btn.addEventListener('click', async () => {
    const address = (addressEl.value || '').trim();
    if (!address) {
      showResult('bad', 'Enter the venue’s address above first, then click Find.');
      addressEl.focus();
      return;
    }
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Finding…';
    showResult('pending', 'Looking that address up…');
    try {
      const res = await fetch(`api/geocode?address=${encodeURIComponent(address)}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showResult('bad', uiEsc(data.error || "Couldn't find that address."));
        return;
      }
      coordsEl.value = data.coordinates;
      fieldError('ffe-coords', null);
      const mapUrl = data.map_url || `https://www.google.com/maps/search/?api=1&query=${data.coordinates}`;
      showResult('good',
        `Found it: ${uiEsc(data.display_name)}. ` +
        `<a href="${mapUrl}" target="_blank" rel="noopener">Check it on the map</a> ` +
        `— if that's the wrong spot, use the manual steps below instead.`);
    } catch {
      showResult('bad', 'Network error — try again, or use the manual steps below.');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

// Called by openFieldAdd/openFieldEdit so a stale "Found it" message from a
// previously edited field doesn't linger under the next one.
function resetFieldGeocodeUI() {
  const resultEl = document.getElementById('ffe-geocode-result');
  if (resultEl) { resultEl.className = 'geocode-result hidden'; resultEl.innerHTML = ''; }
  const mapsLink = document.getElementById('ffe-maps-link');
  const addressEl = document.getElementById('ffe-address');
  if (mapsLink) {
    const q = (addressEl?.value || '').trim();
    mapsLink.href = q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : 'https://www.google.com/maps';
  }
}

document.addEventListener('DOMContentLoaded', wireFieldGeocode);
if (document.readyState !== 'loading') wireFieldGeocode();

// ── Verify banner (link + code) ──────────────────────────────────────────────
// Shared by director.js and my-team.js — was two near-identical copies. The
// code path exists because clicking the emailed link navigates away from
// whatever form was being filled in; typing the code verifies in place.
// `sessionObj` is mutated directly (not reassigned) so the caller's own
// `session` variable — which points at this same object — sees `.verified`
// flip to true without needing any global cross-script wiring.
function initVerifyBanner(sessionObj, message, next) {
  if (!sessionObj || sessionObj.verified) return;
  const banner = document.createElement('div');
  banner.id = 'verify-banner';
  banner.className = 'verify-banner';
  banner.innerHTML = `
    <span>${uiEsc(message)}</span>
    <button id="verify-banner-btn" class="btn btn-secondary btn-sm">Send verification link</button>
    <span id="verify-code-row" class="verify-code-row hidden">
      <input id="verify-code-input" type="text" inputmode="numeric" autocomplete="one-time-code"
             maxlength="6" placeholder="6-digit code">
      <button id="verify-code-btn" class="btn btn-secondary btn-sm">Verify</button>
    </span>`;
  document.body.prepend(banner);

  const sendBtn   = document.getElementById('verify-banner-btn');
  const codeRow   = document.getElementById('verify-code-row');
  const codeInput = document.getElementById('verify-code-input');
  const codeBtn   = document.getElementById('verify-code-btn');

  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    try {
      const res = await fetch('api/auth/request-verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ next }),
      });
      const data = await res.json();
      if (data.ok) {
        sendBtn.textContent = 'Sent — click the link, or enter the code below';
        codeRow.classList.remove('hidden');
        codeInput.focus();
      } else {
        sendBtn.textContent = data.error || 'Failed — try again';
        sendBtn.disabled = false;
      }
    } catch { sendBtn.textContent = 'Network error — try again'; sendBtn.disabled = false; }
  });

  async function submitCode() {
    const code = codeInput.value.trim();
    if (!code) { codeInput.focus(); return; }
    codeBtn.disabled = true;
    try {
      const res = await fetch('api/auth/verify-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (data.ok) {
        sessionObj.verified = true;
        toast('Verified — you can carry on where you left off.');
        banner.remove();
      } else {
        toast(data.error || 'That code is wrong or has expired.', 'bad');
        codeInput.select();
      }
    } catch { toast('Network error — try again.', 'bad'); }
    codeBtn.disabled = false;
  }
  codeBtn.addEventListener('click', submitCode);
  codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitCode(); } });
}

// ── Game confirmation status ─────────────────────────────────────────────────
// Scheduled -> Pending (one side confirmed) -> Confirmed (both), independent
// of Negotiating (an active change request in progress — unrelated concept,
// was itself called "pending" until it got renamed to stop colliding with
// this one). Shared by every page that lists games, so the four states read
// identically everywhere rather than drifting per-file.
//
// mySide ('home'/'away') personalizes Pending's text for a coach — whether
// it's their turn or they're waiting on the other coach. Omit it (director,
// admin, the public viewer) for a neutral "Pending" with no assumed side.
function gameStatusBadge(status, confirmations, mySide) {
  confirmations = confirmations || {};
  if (status === 'negotiating') return '<span class="unconfirmed-badge">Negotiating</span>';
  if (status === 'confirmed')   return '<span class="confirmed-badge">Confirmed</span>';
  if (status === 'pending') {
    if (mySide && !confirmations[mySide]) return '<span class="unconfirmed-badge">Pending — your confirmation</span>';
    if (mySide && confirmations[mySide])  return '<span class="unconfirmed-badge">Pending — waiting on the other coach</span>';
    return '<span class="unconfirmed-badge">Pending</span>';
  }
  return '<span class="pill pill-neutral">Scheduled</span>';
}

// ── Field availability summary ───────────────────────────────────────────────
// Overview signal for a Fields table — before this, the only way to know a
// field had any hosting restrictions at all was to open its edit form. Shared
// by admin and director (both load ui.js) so the same field shows the same
// summary in both places rather than two independently-computed versions.
function fieldAvailabilitySummary(field) {
  const a = field.availability;
  if (!a || typeof a !== 'object') return { text: 'Fully open', restricted: false };
  const patternClosed =
    Object.values(a.weekday || {}).filter(v => v === false).length +
    Object.values(a.saturday || {}).filter(v => v === false).length;
  const dateOverrides = Object.keys(a.dates || {}).length;
  const parts = [];
  if (patternClosed) parts.push(`${patternClosed} day${patternClosed !== 1 ? 's' : ''} closed`);
  if (dateOverrides) parts.push(`${dateOverrides} date exception${dateOverrides !== 1 ? 's' : ''}`);
  return parts.length ? { text: parts.join(', '), restricted: true } : { text: 'Fully open', restricted: false };
}

// ── Availability calendar (shared by coach/director/admin) ──────────────────
// Derives the calendar's month tiles from the actual season (start + weeks),
// not a hardcoded range — same logic that used to live independently in both
// viewer.js and app.js (issue #13) until it was centralized here.
function calendarMonthsFor(season, games) {
  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];
  const dates = [];
  if (season?.start) {
    const start = new Date(season.start + 'T00:00:00Z');
    dates.push(start);
    const weeks = Number(season.weeks) || 1;
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + weeks * 7);
    dates.push(end);
  }
  for (const g of (games || [])) {
    if (g?.date) dates.push(new Date(g.date + 'T00:00:00Z'));
  }
  if (!dates.length) dates.push(new Date());

  const minD = new Date(Math.min(...dates.map(d => d.getTime())));
  const maxD = new Date(Math.max(...dates.map(d => d.getTime())));
  const months = [];
  let y = minD.getUTCFullYear(), m = minD.getUTCMonth();
  const endY = maxD.getUTCFullYear(), endM = maxD.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    months.push({ year: y, month: m + 1, label: `${MONTH_NAMES[m]} ${y}` });
    m++; if (m > 11) { m = 0; y++; }
  }
  return months;
}

const UI_SAT_SLOTS = ['early', 'midday', 'late'];

function uiDayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()];
}

// Mirrors lib/scheduler.js's resolveTeamAvailability, collapsed to one status
// per day for calendar display (a Saturday with different-per-slot answers
// shows as "mixed" rather than picking one slot arbitrarily).
function resolveTeamAvailabilityStatus(availability, dateStr, isSaturday) {
  const a = (availability && typeof availability === 'object') ? availability : {};
  const ex = a.dates && a.dates[dateStr];
  if (isSaturday) {
    const vals = UI_SAT_SLOTS.map(k => {
      if (ex && typeof ex === 'object' && ex[k]) return ex[k];
      return (a.saturday && a.saturday[k]) || 'both';
    });
    const uniq = [...new Set(vals)];
    return uniq.length === 1 ? uniq[0] : 'mixed';
  }
  if (ex && typeof ex === 'object' && ex.status) return ex.status;
  const day = uiDayName(dateStr);
  const entry = (a.weekday && a.weekday[day]) || {};
  return entry.status || 'both';
}

// Mirrors lib/scheduler.js's resolveFieldAvailability, collapsed to one
// open/closed/mixed status per day.
function resolveFieldAvailabilityStatus(availability, dateStr, isSaturday) {
  const a = (availability && typeof availability === 'object') ? availability : {};
  const ex = a.dates && a.dates[dateStr];
  if (isSaturday) {
    const vals = UI_SAT_SLOTS.map(k => {
      const v = (ex && typeof ex === 'object' && ex[k] !== undefined) ? ex[k] : (a.saturday ? a.saturday[k] : true);
      return v !== false;
    });
    if (vals.every(Boolean)) return 'open';
    if (vals.every(v => !v)) return 'closed';
    return 'mixed';
  }
  if (ex !== undefined && ex !== null && typeof ex !== 'object') return ex !== false ? 'open' : 'closed';
  if (ex && typeof ex === 'object' && ex.status !== undefined) return ex.status !== false ? 'open' : 'closed';
  const day = uiDayName(dateStr);
  return (a.weekday ? a.weekday[day] : true) !== false ? 'open' : 'closed';
}

const AV_STATUS_LABEL = {
  both: 'Available', home: 'Home only', away: 'Away only', none: 'Unavailable', mixed: 'Mixed',
  open: 'Open', closed: 'Closed',
};

function renderAvailabilityMonth(year, month, label, statusFn) {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const DAY_HEADS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<td class="cal-empty"></td>');
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = year + '-' + String(month).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    const status = statusFn(dateStr) || 'both';
    cells.push(`<td class="cal-day av-${status}" title="${AV_STATUS_LABEL[status] || status}"><span class="cal-day-num">${d}</span><span class="av-label">${AV_STATUS_LABEL[status] || status}</span></td>`);
  }
  const remaining = (7 - (cells.length % 7)) % 7;
  for (let i = 0; i < remaining; i++) cells.push('<td class="cal-empty"></td>');
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push('<tr>' + cells.slice(i, i+7).join('') + '</tr>');
  return `<div class="cal-month"><div class="cal-month-label">${uiEsc(label)}</div>
    <div class="table-wrap"><table class="cal-table">
      <thead><tr>${DAY_HEADS.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div></div>`;
}

function availabilityLegend(kind) {
  const items = kind === 'field'
    ? [['open','Open'], ['mixed','Mixed'], ['closed','Closed']]
    : [['both','Available'], ['home','Home only'], ['away','Away only'], ['mixed','Mixed'], ['none','Unavailable']];
  return '<div class="cal-legend">' + items.map(([cls, label]) =>
    `<span class="cal-legend-item"><span class="cal-legend-swatch av-${cls}"></span> ${label}</span>`
  ).join('') + '</div>';
}

// containerId: where to render. season: seasonData.season. statusFn(dateStr) => status string.
function renderAvailabilityCalendar(containerId, season, statusFn, kind) {
  const wrapper = document.getElementById(containerId);
  if (!wrapper) return;
  const months = calendarMonthsFor(season, []);
  if (!months.length) { wrapper.innerHTML = '<p class="empty-state">No season configured.</p>'; return; }
  wrapper.innerHTML = availabilityLegend(kind) + months.map(m => renderAvailabilityMonth(m.year, m.month, m.label, statusFn)).join('');
}
