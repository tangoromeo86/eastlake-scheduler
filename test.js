#!/usr/bin/env node
'use strict';

// Eastlake Scheduler Test Suite — runs scheduler directly (no HTTP)
// Usage: node test.js [--regenerate]

const fs = require('fs');
const path = require('path');

const BASE = '/root/eastlake-scheduler';
const SCHEDULE_FILE = path.join(BASE, 'schedule.json');
const SEASON_FILE = path.join(BASE, 'season.json');
const REGENERATE = process.argv.includes('--regenerate');

let pass = 0, fail = 0, warn = 0;
function ok(msg)      { console.log('  ✓ ' + msg); pass++; }
function bad(msg)     { console.log('  ✗ ' + msg); fail++; }
function warning(msg) { console.log('  ⚠ ' + msg); warn++; }
function section(t)   { console.log('\n── ' + t + ' ──'); }

function main() {
  console.log('Eastlake Scheduler Test Suite');
  console.log('==============================\n');

  const season = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));

  if (REGENERATE) {
    console.log('Regenerating schedule...');
    const { scheduleAll } = require(path.join(BASE, 'lib/scheduler'));
    const result = scheduleAll(season);
    for (const g of result.games) delete g._fieldKey;
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(result, null, 2));
    console.log('Generated ' + result.total_games + ' games');
    if (result.warnings?.length) result.warnings.forEach(w => warning(w.message));
    if (result.failures?.length) result.failures.forEach(f => bad('Failure: ' + f.division_name + ' — ' + f.reason));
    console.log('');
  }

  const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  const games = data.games || [];
  const teams = season.teams;
  const divisions = season.divisions;

  // 1. Generation failures
  section('1. Generation Failures');
  const failures = data.failures || [];
  if (failures.length === 0) ok('No division scheduling failures');
  else failures.forEach(f => bad(f.division_name + ': ' + f.reason));

  // 2. Game counts
  section('2. Game Counts Per Team');
  const counts = {}, homeC = {}, awayC = {};
  for (const t of teams) { counts[t.id]=0; homeC[t.id]=0; awayC[t.id]=0; }
  for (const g of games) {
    counts[g.home_team_id]++; homeC[g.home_team_id]++;
    counts[g.away_team_id]++; awayC[g.away_team_id]++;
  }
  for (const t of teams) {
    const div = divisions.find(d => d.id === t.division_id);
    const target = div?.target_games || season.season?.target_games || 8;
    const label = t.name + ': ' + counts[t.id] + '/' + target + ' (' + homeC[t.id] + 'H/' + awayC[t.id] + 'A)';
    counts[t.id] === target ? ok(label) : bad(label);
  }

  // 3. Blackout date violations
  section('3. Blackout Date Violations');
  let anyViol = false;
  for (const t of teams) {
    if (!t.blackout_dates?.length) continue;
    for (const g of games) {
      if ((g.home_team_id === t.id || g.away_team_id === t.id) && t.blackout_dates.includes(g.date)) {
        bad(t.name + ' plays on blackout ' + g.date + ' (game #' + g.game_id + ')');
        anyViol = true;
      }
    }
  }
  if (!anyViol) ok('No blackout violations');

  // 4. Field double-booking
  section('4. Field Double-Booking');
  anyViol = false;
  const fieldSlots = {};
  for (const g of games) {
    const key = g.field_id + '_' + g.date;
    if (fieldSlots[key]) {
      bad('Field ' + g.field_id + ' double-booked on ' + g.date + ' (games #' + fieldSlots[key] + ' and #' + g.game_id + ')');
      anyViol = true;
    } else fieldSlots[key] = g.game_id;
  }
  if (!anyViol) ok('No field double-bookings');

  // 5. Weekly game limits
  section('5. Weekly Game Limits (max 3 total, 2 weekday, 1 Saturday)');
  anyViol = false;
  for (const t of teams) {
    const byWeek = {}, satByWeek = {}, wdByWeek = {};
    for (const g of games) {
      if (g.home_team_id !== t.id && g.away_team_id !== t.id) continue;
      byWeek[g.week] = (byWeek[g.week]||0)+1;
      if (g.day === 'Saturday') satByWeek[g.week] = (satByWeek[g.week]||0)+1;
      else wdByWeek[g.week] = (wdByWeek[g.week]||0)+1;
    }
    for (const wk of Object.keys(byWeek)) {
      if (byWeek[wk] > 3) { bad(t.name + ' has ' + byWeek[wk] + ' games in week ' + wk); anyViol=true; }
      if ((satByWeek[wk]||0) > 1) { bad(t.name + ' has ' + satByWeek[wk] + ' Sat games wk ' + wk); anyViol=true; }
      if ((wdByWeek[wk]||0) > 2) { bad(t.name + ' has ' + wdByWeek[wk] + ' weekday games wk ' + wk); anyViol=true; }
    }
  }
  if (!anyViol) ok('All weekly limits respected');

  // 6. Consecutive day games
  section('6. Consecutive Day Games (soft — ideally zero)');
  let consecCount = 0;
  for (const t of teams) {
    const dates = games.filter(g => g.home_team_id===t.id || g.away_team_id===t.id)
      .map(g => g.date).sort();
    for (let i=0; i<dates.length-1; i++) {
      const diff = (new Date(dates[i+1]+'T12:00:00Z') - new Date(dates[i]+'T12:00:00Z')) / 86400000;
      if (diff === 1) { warning(t.name + ': ' + dates[i] + ' then ' + dates[i+1]); consecCount++; }
    }
  }
  if (consecCount === 0) ok('No consecutive-day games');

  // 7. No-matchup rules
  section('7. No-Matchup Rules');
  anyViol = false;
  for (const div of divisions) {
    for (const rule of (div.no_matchups || [])) {
      for (const aId of rule.team_ids) {
        for (const bId of rule.vs_team_ids) {
          const viols = games.filter(g =>
            (g.home_team_id===aId && g.away_team_id===bId) ||
            (g.home_team_id===bId && g.away_team_id===aId)
          );
          viols.forEach(g => { bad('No-matchup: ' + g.home_team_name + ' vs ' + g.away_team_name + ' on ' + g.date); anyViol=true; });
        }
      }
    }
  }
  if (!anyViol) ok('All no-matchup rules respected');

  // 8. Rematch home/away flip
  section('8. Rematch Home/Away Flip');
  const seenPair = {};
  let flipOk = 0, flipBad = 0;
  const sorted = [...games].sort((a,b) => a.game_id - b.game_id);
  for (const g of sorted) {
    const key = [Math.min(g.home_team_id,g.away_team_id), Math.max(g.home_team_id,g.away_team_id)].join('-');
    if (!seenPair[key]) {
      seenPair[key] = g;
    } else {
      const first = seenPair[key];
      if (g.home_team_id === first.away_team_id && g.away_team_id === first.home_team_id) {
        flipOk++;
      } else {
        bad('NOT flipped: ' + g.home_team_name + ' vs ' + g.away_team_name +
          ' (' + first.date + ' first → ' + g.date + ' rematch, same home)');
        flipBad++;
      }
    }
  }
  if (flipOk > 0 && flipBad === 0) ok('All ' + flipOk + ' rematches correctly flipped home/away');
  else if (flipOk > 0) ok(flipOk + ' rematches flipped correctly');

  // 9. Home/away balance
  section('9. Home/Away Balance (flag if gap > 2)');
  anyViol = false;
  for (const t of teams) {
    if (Math.abs((homeC[t.id]||0) - (awayC[t.id]||0)) > 2) {
      warning(t.name + ': ' + homeC[t.id] + 'H/' + awayC[t.id] + 'A');
      anyViol = true;
    }
  }
  if (!anyViol) ok('All teams within 2-game home/away balance');

  // 10. Preference compliance
  section('10. Preference Compliance');

  // Team 51 (Spicuzza): saturday_date_only 2026-05-09
  const t51sat = games.filter(g => (g.home_team_id===51||g.away_team_id===51) && g.day==='Saturday');
  const badSat = t51sat.filter(g => g.date !== '2026-05-09');
  if (badSat.length === 0) ok('Team 51 (Spicuzza): only Saturday game on 2026-05-09 ✓');
  else badSat.forEach(g => bad('Team 51 (Spicuzza) plays Saturday on ' + g.date + ' (only allowed: 2026-05-09)'));

  // Team 52 (Flick): prefer Monday weekdays
  const t52wd = games.filter(g => (g.home_team_id===52||g.away_team_id===52) && g.day!=='Saturday');
  const t52mon = t52wd.filter(g => g.day==='Monday').length;
  if (t52mon >= Math.ceil(t52wd.length / 2)) ok('Team 52 (Flick): ' + t52mon + '/' + t52wd.length + ' weekday games on Monday ✓');
  else warning('Team 52 (Flick): only ' + t52mon + '/' + t52wd.length + ' weekday games on Monday (prefers Monday)');

  // 11. is_rematch flag accuracy
  section('11. is_rematch Flag Accuracy');
  const seenPair2 = {};
  let flagOk = 0, flagBad = 0;
  for (const g of sorted) {
    const key = [Math.min(g.home_team_id,g.away_team_id), Math.max(g.home_team_id,g.away_team_id)].join('-');
    const shouldBeRematch = !!seenPair2[key];
    if (g.is_rematch !== shouldBeRematch) {
      bad('is_rematch wrong for game #' + g.game_id + ' (' + g.home_team_name + ' vs ' + g.away_team_name + ' on ' + g.date + '): expected ' + shouldBeRematch + ', got ' + g.is_rematch);
      flagBad++;
    } else flagOk++;
    if (!seenPair2[key]) seenPair2[key] = true;
  }
  if (flagBad === 0) ok('All ' + flagOk + ' is_rematch flags accurate');

  // Summary
  console.log('\n══════════════════════════════════════');
  console.log('RESULTS: ' + pass + ' passed  ' + fail + ' failed  ' + warn + ' warnings');
  console.log('Total games: ' + games.length);
  if (fail > 0) console.log('\n>>> ' + fail + ' ISSUES NEED FIXING <<<');
  console.log('══════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
}

main();
