'use strict';
// Shared "Teams to Avoid" editor, used by the coach page (my-team), the
// director page, and admin's Editor tab — same reuse pattern as
// availability-editor.js. Loaded before those scripts so its functions are
// available as globals.
//
// Backs lib/scheduler.js's team.restrictions[] with type 'no_matchup' and
// either opponent_program_id (avoid a whole program) or opponent_team_id
// (avoid one specific team) — the scheduler mechanism already existed for
// the program case; this is the first UI for it, and adds the team-level
// case alongside it (Ted, 2026-08-07).

function reEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// team: the team being edited. allTeams/allPrograms: full season lists.
// restrictions: team.restrictions array (or null/undefined).
function renderRestrictionsEditor(containerId, team, allTeams, allPrograms, restrictions) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const list = Array.isArray(restrictions) ? restrictions : [];
  const excludedProgramIds = new Set(list.filter(r => r?.type === 'no_matchup' && r.opponent_program_id).map(r => r.opponent_program_id));
  const excludedTeamIds = new Set(list.filter(r => r?.type === 'no_matchup' && r.opponent_team_id).map(r => r.opponent_team_id));

  const otherPrograms = (allPrograms || [])
    .filter(p => p.id !== team.program_id)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // Only teams that could ever actually be matched against this one are
  // worth showing — same division, different program. Listing every team in
  // the league would bury the handful that matter under dozens that don't.
  const candidateTeams = (allTeams || [])
    .filter(t => t.id !== team.id && t.division_id === team.division_id && t.program_id !== team.program_id)
    .sort((a, b) => (a.label || a.name || '').localeCompare(b.label || b.name || ''));

  const programRows = otherPrograms.length
    ? otherPrograms.map(p => `
        <label class="restriction-row">
          <input type="checkbox" class="re-program" value="${reEsc(p.id)}" ${excludedProgramIds.has(p.id) ? 'checked' : ''}>
          ${reEsc(p.name)}
        </label>`).join('')
    : '<p class="field-form-hint">No other programs yet.</p>';

  const teamRows = candidateTeams.length
    ? candidateTeams.map(t => `
        <label class="restriction-row" data-program="${reEsc(t.program_id)}">
          <input type="checkbox" class="re-team" value="${reEsc(t.id)}"
            ${excludedTeamIds.has(t.id) ? 'checked' : ''} ${excludedProgramIds.has(t.program_id) ? 'disabled' : ''}>
          ${reEsc(t.label || t.name)}
        </label>`).join('')
    : '<p class="field-form-hint">No other teams in this division yet.</p>';

  el.innerHTML = `
    <p class="field-form-hint" style="margin:0 0 10px">For rivalries, travel, or any reason this team shouldn't be
      matched against a specific opponent. Excluding a whole program also covers every one of its teams below —
      checking the program grays out its teams here so it's clear they're already covered.</p>
    <p class="field-form-hint" style="margin:10px 0 4px"><strong>Avoid an entire program</strong></p>
    <div class="restriction-list">${programRows}</div>
    <p class="field-form-hint" style="margin:14px 0 4px"><strong>Avoid a specific team</strong> <span class="field-form-hint">(same division only — teams elsewhere can't be matched against this one anyway)</span></p>
    <div class="restriction-list">${teamRows}</div>
  `;

  // Checking a whole program should immediately greyscale its individual
  // teams below, without waiting for a save+re-render round trip.
  el.querySelectorAll('.re-program').forEach(cb => {
    cb.addEventListener('change', () => {
      el.querySelectorAll(`label.restriction-row[data-program="${cb.value}"] .re-team`).forEach(teamCb => {
        teamCb.disabled = cb.checked;
      });
    });
  });
}

function readRestrictionsEditor(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return [];
  const out = [];
  el.querySelectorAll('.re-program:checked').forEach(cb => out.push({ type: 'no_matchup', opponent_program_id: cb.value }));
  // A team checkbox that got disabled by its program being checked is
  // already covered above — don't also emit a redundant per-team rule.
  el.querySelectorAll('.re-team:checked:not(:disabled)').forEach(cb => out.push({ type: 'no_matchup', opponent_team_id: cb.value }));
  return out;
}
