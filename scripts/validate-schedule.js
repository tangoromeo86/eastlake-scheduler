'use strict';

/**
 * validate-schedule.js
 * Checks the generated schedule.json against constraints in season.json.
 *
 * Checks:
 *   1. Global blackout dates (blackout_dates + blackout_weekends)
 *   2. Per-team blackout dates
 *   3. Team no_matchup restrictions (team.restrictions[].type === 'no_matchup')
 *   4. Saturday game times match season.weekend_times / saturday_times by age group
 *
 * Usage:  node scripts/validate-schedule.js
 *         node scripts/validate-schedule.js --season path/to/season.json --schedule path/to/schedule.json
 *
 * Exit code 0 = all clear, 1 = violations found or files missing.
 */

const fs = require('fs');
const path = require('path');

// ── Argument parsing ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const ROOT          = path.join(__dirname, '..');
const SEASON_FILE   = getArg('--season')   || path.join(ROOT, 'season.json');
const SCHEDULE_FILE = getArg('--schedule') || path.join(ROOT, 'schedule.json');

// ── Load files ────────────────────────────────────────────────────────────────
function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: File not found: ${filePath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const seasonData   = loadJSON(SEASON_FILE);
const scheduleData = loadJSON(SCHEDULE_FILE);

const games     = scheduleData.games || [];
const season    = seasonData.season  || {};
const teams     = seasonData.teams   || [];

// ── Team lookup helpers ───────────────────────────────────────────────────────
const teamById = {};
teams.forEach(t => { teamById[t.id] = t; });

function tName(id) {
  const t = teamById[id];
  return t ? (t.name || t.label || t.team_name || `Team ${id}`) : `Team ${id}`;
}

// ── 1. Global blackout set ────────────────────────────────────────────────────
const globalBlackouts = new Set(season.blackout_dates || []);
for (const weekend of (season.blackout_weekends || [])) {
  if (Array.isArray(weekend.dates)) weekend.dates.forEach(d => globalBlackouts.add(d));
  if (weekend.saturday) globalBlackouts.add(weekend.saturday);
  if (weekend.sunday)   globalBlackouts.add(weekend.sunday);
}

// ── 2. Per-team blackout sets ─────────────────────────────────────────────────
const teamBlackouts = {};
for (const team of teams) {
  if (team.blackout_dates?.length) teamBlackouts[team.id] = new Set(team.blackout_dates);
}

// ── 3. No-matchup forbidden pairs ────────────────────────────────────────────
// Built from team.restrictions[].type === 'no_matchup' with opponent_club
// Key: "minId-maxId" → description string
const forbiddenPairs = new Map();
const pairKey = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;

for (const team of teams) {
  for (const restriction of (team.restrictions || [])) {
    if (restriction.type !== 'no_matchup') continue;
    if (restriction.opponent_club) {
      const opponents = teams.filter(t =>
        t.club_id === restriction.opponent_club && t.division_id === team.division_id
      );
      for (const opp of opponents) {
        const key = pairKey(team.id, opp.id);
        forbiddenPairs.set(key,
          `${tName(team.id)} (${team.club_id}) has a no_matchup restriction against ${tName(opp.id)} (${opp.club_id})`
        );
      }
    }
  }
}

// ── 4. Saturday times by age group ───────────────────────────────────────────
const saturdayTimes = season.saturday_times || season.weekend_times || {};

// ── Run checks ────────────────────────────────────────────────────────────────
let violations = 0;
let checked    = 0;

function fail(label, reason) {
  console.error(`FAIL ${label}`);
  console.error(`     → ${reason}`);
  violations++;
}

// ── 5. Field usage map (for double-booking check) ─────────────────────────────
// key: "field_id|date|time" → first game_id seen
const fieldUsage = {};
for (const game of games) {
  const key = `${game.field_id}|${game.date}|${game.time}`;
  if (!fieldUsage[key]) fieldUsage[key] = game.game_id;
}

for (const game of games) {
  const { game_id, date, day, time, division_id, home_team_id, away_team_id, home_team_name, away_team_name } = game;
  const label = `Game #${game_id} (${division_id} · ${date} · ${home_team_name} vs ${away_team_name})`;
  checked++;

  // 1. Global blackout
  if (globalBlackouts.has(date)) {
    fail(label, `${date} is a global blackout date`);
  }

  // 2. Team blackout dates
  if (teamBlackouts[home_team_id]?.has(date)) {
    fail(label, `Home team "${tName(home_team_id)}" is blacked out on ${date}`);
  }
  if (teamBlackouts[away_team_id]?.has(date)) {
    fail(label, `Away team "${tName(away_team_id)}" is blacked out on ${date}`);
  }

  // 3. No-matchup restriction
  const key = pairKey(home_team_id, away_team_id);
  if (forbiddenPairs.has(key)) {
    fail(label, `No-matchup restriction violated: ${forbiddenPairs.get(key)}`);
  }

  // 4. Saturday time correctness
  if (day === 'Saturday') {
    const ageGroup = division_id.split('-')[0]; // U10, U12, U15
    const expectedTime = saturdayTimes[ageGroup];
    if (expectedTime && time !== expectedTime) {
      fail(label, `Saturday time should be ${expectedTime} for ${ageGroup} but is ${time}`);
    }
  }

  // 5. Field double-booking (same field, same date, same time)
  const fieldKey = `${game.field_id}|${date}|${time}`;
  const firstGameId = fieldUsage[fieldKey];
  if (firstGameId !== game_id) {
    fail(label, `Field "${game.field_name}" already booked at ${date} ${time} by game #${firstGameId}`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nChecked ${checked} game(s).`);
console.log(`  Global blackout dates : ${globalBlackouts.size}`);
console.log(`  Teams with blackouts  : ${Object.keys(teamBlackouts).length}`);
console.log(`  No-matchup pairs      : ${forbiddenPairs.size}`);
console.log(`  Saturday time rules   : ${Object.keys(saturdayTimes).length} age group(s)`);
console.log(`  Field slots checked   : ${Object.keys(fieldUsage).length} unique field/date/time slots`);

if (violations === 0) {
  console.log('\n✓ All clear — no violations found.');
  process.exit(0);
} else {
  console.error(`\n✗ ${violations} violation(s) found.`);
  process.exit(1);
}
