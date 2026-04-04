'use strict';

/**
 * Eastlake Scheduler - Automated Test Suite
 * Run: node scripts/test-schedule.js
 * Or to regenerate first: node scripts/test-schedule.js --regen
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCHEDULE_FILE = path.join(ROOT, 'schedule.json');
const SEASON_FILE = path.join(ROOT, 'season.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0, warned = 0;
const results = [];

function pass(label) {
  passed++;
  results.push({ status: 'PASS', label });
}
function fail(label, detail) {
  failed++;
  results.push({ status: 'FAIL', label, detail });
}
function warn(label, detail) {
  warned++;
  results.push({ status: 'WARN', label, detail });
}

// ── Load data ─────────────────────────────────────────────────────────────────

const regen = process.argv.includes('--regen');

if (regen) {
  console.log('Regenerating schedule...');
  const { scheduleAll } = require('../lib/scheduler');
  const seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  const result = scheduleAll(seasonData);
  for (const g of result.games) delete g._fieldKey;
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(result, null, 2));
  console.log();
}

const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
const season = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
const games = data.games || [];
const teams = season.teams || [];
const divisions = season.divisions || [];

function tName(t) { return t.label || t.name || `Team ${t.id}`; }

// ── Test 1: No failures ───────────────────────────────────────────────────────

const failures = data.failures || [];
if (failures.length === 0) {
  pass('No scheduler failures');
} else {
  fail('Scheduler failures', failures.map(f => f.blocking_matchup || f.reason).join('; '));
}

// ── Test 2: Game counts per team ──────────────────────────────────────────────

const divMap = Object.fromEntries(divisions.map(d => [d.id, d]));
const teamMap = Object.fromEntries(teams.map(t => [t.id, t]));

for (const t of teams) {
  const target = divMap[t.division_id]?.target_games ?? season.season?.target_games ?? 8;
  const count = games.filter(g => g.home_team_id === t.id || g.away_team_id === t.id).length;
  if (count === target) {
    pass(`${tName(t)}: ${count}/${target} games`);
  } else {
    fail(`${tName(t)}: wrong game count`, `expected ${target}, got ${count}`);
  }
}

// ── Test 2b: No team plays twice on the same day ─────────────────────────────

let sameDayViolations = [];
for (const t of teams) {
  const datesSeen = [];
  for (const g of games) {
    if (g.home_team_id !== t.id && g.away_team_id !== t.id) continue;
    if (datesSeen.includes(g.date)) {
      sameDayViolations.push(`${tName(t)} plays twice on ${g.date}`);
    } else {
      datesSeen.push(g.date);
    }
  }
}
if (sameDayViolations.length === 0) {
  pass('No team plays more than once on the same day');
} else {
  fail('Same-day double booking', sameDayViolations.join('; '));
}

// ── Test 3: Blackout dates respected ─────────────────────────────────────────

let blackoutViolations = [];
for (const t of teams) {
  if (!t.blackout_dates || t.blackout_dates.length === 0) continue;
  for (const g of games) {
    if (g.home_team_id !== t.id && g.away_team_id !== t.id) continue;
    if (t.blackout_dates.includes(g.date)) {
      blackoutViolations.push(`${tName(t)} plays on blackout ${g.date}`);
    }
  }
}
if (blackoutViolations.length === 0) {
  pass('No blackout date violations');
} else {
  fail('Blackout date violations', blackoutViolations.join('; '));
}

// ── Test 4: No field double-booking ──────────────────────────────────────────

const fieldSlots = {};
let doubleBooked = [];
for (const g of games) {
  const key = g.field_id + '_' + g.date;
  if (fieldSlots[key]) {
    doubleBooked.push(`${g.field_id} on ${g.date} (game #${g.game_id} conflicts with #${fieldSlots[key]})`);
  } else {
    fieldSlots[key] = g.game_id;
  }
}
if (doubleBooked.length === 0) {
  pass('No field double-booking');
} else {
  fail('Field double-booking', doubleBooked.join('; '));
}

// ── Test 5: No consecutive days ───────────────────────────────────────────────

let consecutiveViolations = [];
for (const t of teams) {
  const tDates = games
    .filter(g => g.home_team_id === t.id || g.away_team_id === t.id)
    .map(g => g.date).sort();
  for (let i = 0; i < tDates.length - 1; i++) {
    const d1 = new Date(tDates[i] + 'T12:00:00Z');
    const d2 = new Date(tDates[i+1] + 'T12:00:00Z');
    if ((d2 - d1) / 86400000 === 1) {
      consecutiveViolations.push(`${tName(t)}: ${tDates[i]} and ${tDates[i+1]}`);
    }
  }
}
if (consecutiveViolations.length === 0) {
  pass('No consecutive-day violations');
} else {
  fail('Consecutive-day violations', consecutiveViolations.join('; '));
}

// ── Test 6: Weekly game limits ────────────────────────────────────────────────

let weeklyViolations = [];
for (const t of teams) {
  const byWeek = {}, satByWeek = {}, wdByWeek = {};
  for (const g of games) {
    if (g.home_team_id !== t.id && g.away_team_id !== t.id) continue;
    byWeek[g.week] = (byWeek[g.week] || 0) + 1;
    if (g.day === 'Saturday') satByWeek[g.week] = (satByWeek[g.week] || 0) + 1;
    else wdByWeek[g.week] = (wdByWeek[g.week] || 0) + 1;
  }
  for (const [wk, n] of Object.entries(byWeek)) {
    if (n > 3) weeklyViolations.push(`${tName(t)} week ${wk}: ${n} games (max 3)`);
    if ((satByWeek[wk] || 0) > 1) weeklyViolations.push(`${tName(t)} week ${wk}: ${satByWeek[wk]} Saturday games (max 1)`);
    if ((wdByWeek[wk] || 0) > 2) weeklyViolations.push(`${tName(t)} week ${wk}: ${wdByWeek[wk]} weekday games (max 2)`);
  }
}
if (weeklyViolations.length === 0) {
  pass('No weekly game limit violations');
} else {
  fail('Weekly game limit violations', weeklyViolations.join('; '));
}

// ── Test 7: No-matchup rules ──────────────────────────────────────────────────

let noMatchupViolations = [];
for (const div of divisions) {
  for (const rule of (div.no_matchups || [])) {
    for (const aId of (rule.team_ids || [])) {
      for (const bId of (rule.vs_team_ids || [])) {
        for (const g of games) {
          if ((g.home_team_id === aId && g.away_team_id === bId) ||
              (g.home_team_id === bId && g.away_team_id === aId)) {
            noMatchupViolations.push(
              `${tName(teamMap[aId] || {id:aId})} vs ${tName(teamMap[bId] || {id:bId})} on ${g.date}`
            );
          }
        }
      }
    }
  }
}
if (noMatchupViolations.length === 0) {
  pass('No no-matchup rule violations');
} else {
  fail('No-matchup rule violations', noMatchupViolations.join('; '));
}

// ── Test 8: Rematch home/away flip ────────────────────────────────────────────

const sortedGames = [...games].sort((a, b) => a.game_id - b.game_id);
const firstGameOrient = {};
let flipOk = 0, flipBad = [];

for (const g of sortedGames) {
  const key = [Math.min(g.home_team_id, g.away_team_id), Math.max(g.home_team_id, g.away_team_id)].join('-');
  if (!firstGameOrient[key]) {
    firstGameOrient[key] = { homeId: g.home_team_id, awayId: g.away_team_id };
  } else if (g.is_rematch) {
    const first = firstGameOrient[key];
    if (g.home_team_id === first.awayId && g.away_team_id === first.homeId) {
      flipOk++;
    } else {
      flipBad.push(`${tName(teamMap[g.home_team_id] || {id:g.home_team_id})} vs ${tName(teamMap[g.away_team_id] || {id:g.away_team_id})} on ${g.date}: home/away not flipped`);
    }
  }
}

if (flipBad.length === 0) {
  pass(`All rematches have home/away flipped (${flipOk} checked)`);
} else {
  warn('Rematch home/away not flipped (may be forced by constraints)', flipBad.join('; '));
}

// ── Test 9: Home/away balance (max 2 gap) ────────────────────────────────────

const homeCount = {}, awayCount = {};
for (const g of games) {
  homeCount[g.home_team_id] = (homeCount[g.home_team_id] || 0) + 1;
  awayCount[g.away_team_id] = (awayCount[g.away_team_id] || 0) + 1;
}
let imbalanced = [];
for (const t of teams) {
  const h = homeCount[t.id] || 0;
  const a = awayCount[t.id] || 0;
  if (Math.abs(h - a) > 2) {
    imbalanced.push(`${tName(t)}: ${h} home, ${a} away`);
  }
}
if (imbalanced.length === 0) {
  pass('Home/away balance (≤2 gap for all teams)');
} else {
  warn('Home/away imbalance (>2 gap)', imbalanced.join('; '));
}

// ── Test 10: saturday_date_only preference (Team 19) ─────────────────────────

const t19 = teams.find(t => t.id === 19);
if (t19) {
  const saturdayPref = typeof t19.preferences === 'object' && !Array.isArray(t19.preferences)
    ? t19.preferences.saturday_date_only
    : null;
  if (saturdayPref) {
    const t19Games = games.filter(g => g.home_team_id === 19 || g.away_team_id === 19);
    const wrongSat = t19Games.filter(g => g.day === 'Saturday' && g.date !== saturdayPref);
    if (wrongSat.length === 0) {
      pass(`Team 19 (${t19.name}): saturday_date_only ${saturdayPref} respected`);
    } else {
      fail(`Team 19 (${t19.name}): Saturday games on wrong dates`, wrongSat.map(g => g.date).join(', '));
    }
  }
}

// ── Test 11: Team 3 blackout 2026-05-02 (Saturday) ───────────────────────────

const t3 = teams.find(t => t.id === 3);
if (t3 && t3.blackout_dates && t3.blackout_dates.includes('2026-05-02')) {
  const violation = games.find(g =>
    (g.home_team_id === 3 || g.away_team_id === 3) && g.date === '2026-05-02'
  );
  if (!violation) {
    pass('Burton U10 Coed: 2026-05-02 blackout respected');
  } else {
    fail('Burton U10 Coed: plays on 2026-05-02 blackout', `game #${violation.game_id}`);
  }
}

// ── Test 12: Opponent play counts are balanced (spread ≤ 1) ──────────────────
// A team may play one opponent more times than another, but the difference must
// be at most 1.  e.g. playing A×3 and B×2 is fine; A×3 and B×1 is not.

let spreadViolations = [];
for (const t of teams) {
  const opponentCounts = {};
  for (const g of games) {
    if (g.home_team_id !== t.id && g.away_team_id !== t.id) continue;
    const opp = g.home_team_id === t.id ? g.away_team_id : g.home_team_id;
    opponentCounts[opp] = (opponentCounts[opp] || 0) + 1;
  }
  const counts = Object.values(opponentCounts);
  if (counts.length < 2) continue;
  const spread = Math.max(...counts) - Math.min(...counts);
  if (spread > 1) {
    const detail = Object.entries(opponentCounts)
      .map(([id, n]) => `${tName(teamMap[id] || {id})}×${n}`)
      .join(', ');
    spreadViolations.push(`${tName(t)}: spread=${spread} (${detail})`);
  }
}
// Deduplicate (each pair reported from both sides)
const deduped = [...new Set(spreadViolations)];
if (deduped.length === 0) {
  pass('Opponent play counts balanced (spread ≤ 1 for all teams)');
} else {
  warn('Opponent play count imbalance (spread > 1)', deduped.join('; '));
}

// ── Test 13: Global blackout dates not used ───────────────────────────────────

const globalBlackouts = new Set(season.season?.blackout_dates || []);
for (const weekend of (season.season?.blackout_weekends || [])) {
  if (Array.isArray(weekend.dates)) weekend.dates.forEach(d => globalBlackouts.add(d));
}
const blackoutGames = games.filter(g => globalBlackouts.has(g.date));
if (blackoutGames.length === 0) {
  pass('No games scheduled on global blackout dates');
} else {
  fail('Games on global blackout dates', blackoutGames.map(g => g.date).join(', '));
}

// ── Print results ─────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════');
console.log('  Eastlake Scheduler Test Results');
console.log('══════════════════════════════════════════');

for (const r of results) {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'WARN' ? '⚠' : '✗';
  if (r.status !== 'PASS') {
    console.log(`  ${icon} ${r.status}  ${r.label}`);
    if (r.detail) console.log(`       ${r.detail}`);
  }
}

console.log('\n──────────────────────────────────────────');
console.log(`  Passed: ${passed}   Warned: ${warned}   Failed: ${failed}`);
console.log('══════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
