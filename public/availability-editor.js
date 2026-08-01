'use strict';
// Shared two-stage availability editor, used by the coach page (my-team) and the
// director page for both teams and fields. Loaded before those scripts so its
// functions are available as globals, matching how these pages already work.
//
// Stage 1 sets the weekly pattern ("Tuesdays work"). Stage 2 lists every actual
// date in the season, pre-filled from that pattern, so a coach can knock out one
// Tuesday or open up a single Monday the pattern rules out. A date only becomes
// an override once it's explicitly set to something other than "Use pattern",
// which keeps stage 1 meaningful after stage 2 has been touched.

const AV_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday'];
const AV_SAT_SLOTS = [['early', '10:00'], ['midday', '12:00'], ['late', '2:00']];
const AV_STATUS = [
  ['both', 'Available for both'],
  ['host', 'Available to host'],
  ['travel', 'Available to travel'],
  ['none', 'Not available'],
];

function avEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function avNiceDate(d) {
  return new Date(d + 'T12:00:00Z')
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function avDayOf(d) {
  return new Date(d + 'T12:00:00Z')
    .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

// Flattens /api/season/slots into a plain, ordered list of season dates.
function avSeasonDates(seasonSlots) {
  const out = [];
  for (const wk of (seasonSlots || [])) {
    for (const d of (wk.dates || [])) out.push({ date: d.date, type: d.type, day: d.day || avDayOf(d.date) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Team availability (four-state) ───────────────────────────────────────────

function renderAvailabilityGrid(containerId, availability, seasonSlots) {
  const a = availability || {};
  const pattern = a.weekday || {};
  const sat = a.saturday || {};
  const dates = a.dates || {};
  const opts = (cur, includeInherit) =>
    (includeInherit ? '<option value="">Use pattern</option>' : '') +
    AV_STATUS.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('');

  const patternRows = AV_WEEKDAYS.map(day => `<tr>
      <td>${day}</td>
      <td><select class="av-pat" data-kind="weekday" data-key="${day}">${opts((pattern[day] || {}).status || 'both', false)}</select></td>
    </tr>`).join('') +
    AV_SAT_SLOTS.map(([k, t]) => `<tr>
      <td>Saturday <span style="color:#94a3b8">${t}</span></td>
      <td><select class="av-pat" data-kind="saturday" data-key="${k}">${opts(sat[k] || 'both', false)}</select></td>
    </tr>`).join('');

  // Stage 2 — group every season date under its weekday so the list is scannable.
  const all = avSeasonDates(seasonSlots);
  const groups = {};
  for (const d of all) (groups[d.type === 'saturday' ? 'Saturday' : d.day] ||= []).push(d);

  const groupHtml = Object.entries(groups).map(([label, list]) => {
    const rows = list.map(d => {
      if (d.type === 'saturday') {
        const ex = dates[d.date] || {};
        return `<tr><td>${avNiceDate(d.date)}</td>` + AV_SAT_SLOTS.map(([k]) =>
          `<td><select class="av-date" data-date="${d.date}" data-type="saturday" data-key="${k}">${opts(ex[k] || '', true)}</select></td>`
        ).join('') + '</tr>';
      }
      const ex = dates[d.date] || {};
      return `<tr><td>${avNiceDate(d.date)}</td>
        <td colspan="3"><select class="av-date" data-date="${d.date}" data-type="weekday" data-key="status">${opts(ex.status || '', true)}</select></td></tr>`;
    }).join('');
    const head = label === 'Saturday'
      ? `<tr><th>Date</th>${AV_SAT_SLOTS.map(([, t]) => `<th>${t}</th>`).join('')}</tr>`
      : '<tr><th>Date</th><th colspan="3">Status</th></tr>';
    return `<details style="margin:6px 0"><summary style="cursor:pointer;padding:6px 0;font-weight:600">All ${label}s <span style="color:#94a3b8;font-weight:400">(${list.length})</span></summary>
      <table class="fields-table"><thead>${head}</thead><tbody>${rows}</tbody></table></details>`;
  }).join('');

  document.getElementById(containerId).innerHTML = `
    <table class="fields-table"><thead><tr><th>Day</th><th>Usual status</th></tr></thead><tbody>${patternRows}</tbody></table>
    <div style="margin-top:14px">
      <p class="field-form-hint" style="margin-bottom:6px">Need to change a specific week? Open a day below — every date starts on "Use pattern", so you only set the exceptions.</p>
      ${groupHtml || '<p style="color:#94a3b8">Season dates appear here once a start date is set.</p>'}
    </div>`;
}

function readAvailabilityGrid(containerId) {
  const c = document.getElementById(containerId);
  const weekday = {}, saturday = {}, dates = {};
  c.querySelectorAll('select.av-pat[data-kind="weekday"]').forEach(s => { weekday[s.dataset.key] = { status: s.value }; });
  c.querySelectorAll('select.av-pat[data-kind="saturday"]').forEach(s => { saturday[s.dataset.key] = s.value; });
  // Only non-empty values are exceptions; "Use pattern" deliberately stores nothing.
  c.querySelectorAll('select.av-date').forEach(s => {
    if (!s.value) return;
    const d = s.dataset.date;
    if (s.dataset.type === 'saturday') (dates[d] ||= {})[s.dataset.key] = s.value;
    else (dates[d] ||= {}).status = s.value;
  });
  return { weekday, saturday, dates };
}

// ── Field availability (open / closed) ───────────────────────────────────────

function renderFieldAvailabilityGrid(containerId, availability, seasonSlots) {
  const a = availability || {};
  const pattern = a.weekday || {};
  const sat = a.saturday || {};
  const dates = a.dates || {};
  const openOpts = (cur, includeInherit) =>
    (includeInherit ? '<option value="">Use pattern</option>' : '') +
    `<option value="open"${cur === true || cur === 'open' ? ' selected' : ''}>Open</option>` +
    `<option value="closed"${cur === false || cur === 'closed' ? ' selected' : ''}>Closed</option>`;

  const patternRows = AV_WEEKDAYS.map(day => `<tr>
      <td>${day}</td><td><select class="fav-pat" data-kind="weekday" data-key="${day}">${openOpts(pattern[day] !== false, false)}</select></td>
    </tr>`).join('') +
    AV_SAT_SLOTS.map(([k, t]) => `<tr>
      <td>Saturday <span style="color:#94a3b8">${t}</span></td>
      <td><select class="fav-pat" data-kind="saturday" data-key="${k}">${openOpts(sat[k] !== false, false)}</select></td>
    </tr>`).join('');

  const all = avSeasonDates(seasonSlots);
  const groups = {};
  for (const d of all) (groups[d.type === 'saturday' ? 'Saturday' : d.day] ||= []).push(d);

  const groupHtml = Object.entries(groups).map(([label, list]) => {
    const rows = list.map(d => {
      const ex = dates[d.date];
      if (d.type === 'saturday') {
        const exo = (ex && typeof ex === 'object') ? ex : {};
        return `<tr><td>${avNiceDate(d.date)}</td>` + AV_SAT_SLOTS.map(([k]) =>
          `<td><select class="fav-date" data-date="${d.date}" data-type="saturday" data-key="${k}">${openOpts(exo[k] === undefined ? '' : exo[k], true)}</select></td>`
        ).join('') + '</tr>';
      }
      const cur = (ex && typeof ex === 'object') ? (ex.status === undefined ? '' : ex.status) : (ex === undefined ? '' : ex);
      return `<tr><td>${avNiceDate(d.date)}</td>
        <td colspan="3"><select class="fav-date" data-date="${d.date}" data-type="weekday" data-key="status">${openOpts(cur, true)}</select></td></tr>`;
    }).join('');
    const head = label === 'Saturday'
      ? `<tr><th>Date</th>${AV_SAT_SLOTS.map(([, t]) => `<th>${t}</th>`).join('')}</tr>`
      : '<tr><th>Date</th><th colspan="3">Open to host</th></tr>';
    return `<details style="margin:6px 0"><summary style="cursor:pointer;padding:6px 0;font-weight:600">All ${label}s <span style="color:#94a3b8;font-weight:400">(${list.length})</span></summary>
      <table class="fields-table"><thead>${head}</thead><tbody>${rows}</tbody></table></details>`;
  }).join('');

  document.getElementById(containerId).innerHTML = `
    <table class="fields-table"><thead><tr><th>Day</th><th>Usually</th></tr></thead><tbody>${patternRows}</tbody></table>
    <div style="margin-top:14px">
      <p class="field-form-hint" style="margin-bottom:6px">Close this field for one specific date below — everything defaults to the pattern above.</p>
      ${groupHtml || '<p style="color:#94a3b8">Season dates appear here once a start date is set.</p>'}
    </div>`;
}

function readFieldAvailabilityGrid(containerId) {
  const c = document.getElementById(containerId);
  const weekday = {}, saturday = {}, dates = {};
  c.querySelectorAll('select.fav-pat[data-kind="weekday"]').forEach(s => { weekday[s.dataset.key] = s.value === 'open'; });
  c.querySelectorAll('select.fav-pat[data-kind="saturday"]').forEach(s => { saturday[s.dataset.key] = s.value === 'open'; });
  c.querySelectorAll('select.fav-date').forEach(s => {
    if (!s.value) return;
    const d = s.dataset.date;
    if (s.dataset.type === 'saturday') (dates[d] ||= {})[s.dataset.key] = s.value === 'open';
    else (dates[d] ||= {}).status = s.value === 'open';
  });
  return { weekday, saturday, dates };
}
