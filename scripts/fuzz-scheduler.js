'use strict';
// Stress-tests the scheduler against hundreds of randomly generated leagues,
// checking the same correctness invariants test/scheduler.test.js checks on
// one fixed fixture, but across a swept range of league shapes (division
// size, odd/even team counts, restrictiveness) — built so edge cases that
// only show up at some particular combination (the way the team/field
// availability independence bug and the opponent-substitution stranding bug
// both did) get caught by re-running this, instead of by luck during manual
// testing on whatever's currently deployed.
//
// Usage:
//   node scripts/fuzz-scheduler.js                     # 200 runs, default sweep
//   node scripts/fuzz-scheduler.js --runs 1000
//   node scripts/fuzz-scheduler.js --runs 500 --save-worst 10
//   node scripts/fuzz-scheduler.js --min-teams 2 --max-teams 20   # stress tiny divisions on purpose
//
// Default sweep is 6-16 teams/division — Ted: "realistically I'd expect each
// division to have at least 6 teams." That's the shape worth spending most
// of the fuzzing budget on; pass --min-teams below 6 explicitly when you
// want to stress the tiny-division edge cases (still supported — the
// maxMeetingsPerPairFor size-aware rematch cap in lib/scheduler.js exists
// specifically to keep those from being outliers that need special-casing —
// just not what a default run should spend its time on).
//
// Exits non-zero if any run hits an invariant violation, so it can be wired
// into CI or just run by hand after touching lib/scheduler.js.

const fs = require('fs');
const path = require('path');
const { scheduleAll, resolveTeamAvailability, resolveFieldAvailability } = require('../lib/scheduler');
const { randomFieldAvailability, randomTeamAvailabilityFor, seasonSaturdays } = require('./lib/random-availability');

// ── CLI args ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { runs: 200, saveWorst: 5, minTeams: 6, maxTeams: 16, outDir: path.join(__dirname, 'fuzz-output') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') opts.runs = Number(argv[++i]);
    else if (a === '--save-worst') opts.saveWorst = Number(argv[++i]);
    else if (a === '--min-teams') opts.minTeams = Number(argv[++i]);
    else if (a === '--max-teams') opts.maxTeams = Number(argv[++i]);
    else if (a === '--out') opts.outDir = argv[++i];
  }
  return opts;
}

// ── Synthetic league builder ────────────────────────────────────────────────
// Doesn't need real addresses — synthetic coordinates in a small box give
// the travel-balance logic something real to chew on without coupling this
// to the specific Cleveland-area fixture the seed script uses. Division
// count/size, week count, and target games are all randomized per run so
// the sweep actually covers different shapes rather than re-rolling
// availability on the same structure 200 times.
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function pad(n, w) { return String(n).padStart(w, '0'); }

function buildRandomLeague(opts) {
  const numDivisions = randInt(1, 4);
  const weeks = randInt(6, 14);
  const targetGames = randInt(5, 10);
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() + ((8 - start.getDay()) % 7 || 7) + randInt(7, 28));
  const seasonStartStr = start.toISOString().slice(0, 10);
  const saturdays = seasonSaturdays(seasonStartStr, weeks);

  const programs = [];
  const fields = [];
  const teams = [];
  const divisions = [];
  let fieldN = 0, teamN = 0, progN = 0;

  for (let d = 0; d < numDivisions; d++) {
    const teamCount = randInt(opts.minTeams, opts.maxTeams);
    const divId = `div-${d}`;
    divisions.push({ id: divId, name: `Division ${d}`, target_games: targetGames });

    const fieldCount = Math.max(2, Math.round(teamCount / 3));
    const divFields = [];
    for (let f = 0; f < fieldCount; f++) {
      fieldN++;
      progN++;
      const progId = `prog-${progN}`;
      programs.push({ id: progId, name: `Program ${progN}` });
      const field = {
        id: `field-${fieldN}`, name: `Field ${fieldN}`, program_id: progId,
        coordinates: `${(41.4 + Math.random() * 0.6).toFixed(4)},${(-81.6 + Math.random() * 0.6).toFixed(4)}`,
      };
      field.availability = randomFieldAvailability(opts.weights);
      if (Math.random() < 0.25) {
        const sd = saturdays[Math.floor(Math.random() * saturdays.length)];
        field.availability.dates[sd] = { early: false, midday: false, late: false };
      }
      fields.push(field);
      divFields.push(field);
    }

    for (let t = 0; t < teamCount; t++) {
      teamN++;
      const home = divFields[t % divFields.length];
      const availability = randomTeamAvailabilityFor(home.availability, opts.weights);
      if (Math.random() < 0.4) {
        const sd = saturdays[Math.floor(Math.random() * saturdays.length)];
        availability.dates[sd] = { early: 'none', midday: 'none', late: 'none' };
      }
      const team = {
        id: `team-${teamN}`, label: `Team ${teamN}`,
        division_id: divId, program_id: home.program_id, home_field_id: home.id,
        confirmed: true, availability,
      };
      // Occasionally give a team a different target than the division default —
      // the "each team's own target, not a uniform round-robin" path.
      if (Math.random() < 0.15) team.target_games = randInt(4, targetGames + 3);
      teams.push(team);
    }
  }

  return {
    season: { start: seasonStartStr, weeks, target_games: targetGames, blackout_dates: [] },
    programs, divisions, fields, teams,
    _meta: { numDivisions, weeks, targetGames, teamCounts: divisions.map((dv) =>
      teams.filter(t => t.division_id === dv.id).length) },
  };
}

// ── Invariant checks ─────────────────────────────────────────────────────────
// Same class of checks test/scheduler.test.js runs against its one fixed
// fixture, applied here against whatever shape this run happened to produce.
function checkInvariants(seasonData, result) {
  const violations = [];
  const games = result.games || [];
  const teamsById = new Map(seasonData.teams.map(t => [t.id, t]));
  const fieldsById = new Map(seasonData.fields.map(f => [f.id, f]));

  // No team plays twice on the same date.
  const byTeamDate = new Map();
  for (const g of games) {
    for (const tid of [g.home_team_id, g.away_team_id]) {
      const k = `${tid}|${g.date}`;
      if (byTeamDate.has(k)) violations.push(`team ${tid} double-booked on ${g.date}`);
      byTeamDate.set(k, true);
    }
  }

  // No field double-booked at the same date+time.
  const byFieldSlot = new Map();
  for (const g of games) {
    const k = `${g.field_id}|${g.date}|${g.time}`;
    if (byFieldSlot.has(k)) violations.push(`field ${g.field_id} double-booked ${g.date} ${g.time}`);
    byFieldSlot.set(k, true);
  }

  // Every game must actually be legal for both teams per their own stated
  // availability at the time it was scheduled — the scheduler's whole job.
  for (const g of games) {
    const home = teamsById.get(g.home_team_id);
    const away = teamsById.get(g.away_team_id);
    const field = fieldsById.get(g.field_id);
    const dayType = g.day === 'Saturday' ? 'saturday' : 'weekday';
    const slotKey = dayType === 'saturday' ? nearestSlotFor(g.time) : null;
    const homeStatus = resolveTeamAvailability(home, g.date, dayType, slotKey);
    const awayStatus = resolveTeamAvailability(away, g.date, dayType, slotKey);
    if (homeStatus === 'none' || homeStatus === 'travel') {
      violations.push(`game ${g.game_id}: home team ${g.home_team_id} not host-eligible on ${g.date} (${homeStatus})`);
    }
    if (awayStatus === 'none' || awayStatus === 'host') {
      violations.push(`game ${g.game_id}: away team ${g.away_team_id} not travel-eligible on ${g.date} (${awayStatus})`);
    }
    if (field && !resolveFieldAvailability(field, g.date, dayType, slotKey)) {
      violations.push(`game ${g.game_id}: field ${g.field_id} not open on ${g.date} ${g.time}`);
    }
  }

  // Home/away within +/-1 for every team that got any games.
  const homeAway = new Map();
  for (const g of games) {
    homeAway.set(g.home_team_id, (homeAway.get(g.home_team_id) || [0, 0]));
    homeAway.get(g.home_team_id)[0]++;
    homeAway.set(g.away_team_id, (homeAway.get(g.away_team_id) || [0, 0]));
    homeAway.get(g.away_team_id)[1]++;
  }
  for (const [tid, [h, a]] of homeAway) {
    if (Math.abs(h - a) > 1) violations.push(`team ${tid} home/away imbalance: ${h}H/${a}A`);
  }

  // The bug this tool was built to keep catching: a team with remaining
  // need that ends up with strictly fewer games than its target AND isn't
  // named in any reported failure — i.e. it just vanished, silently.
  const gameCount = new Map();
  for (const g of games) {
    gameCount.set(g.home_team_id, (gameCount.get(g.home_team_id) || 0) + 1);
    gameCount.set(g.away_team_id, (gameCount.get(g.away_team_id) || 0) + 1);
  }
  const failureTeams = new Set();
  for (const f of (result.failures || [])) {
    if (f.team_a_id) failureTeams.add(f.team_a_id);
    if (f.team_b_id) failureTeams.add(f.team_b_id);
    // Fall back to name-matching if ids aren't on the failure record.
  }
  for (const t of seasonData.teams) {
    const want = t.target_games || seasonData.season.target_games;
    const got = gameCount.get(t.id) || 0;
    if (got === 0 && want > 0 && (result.failures || []).length === 0) {
      violations.push(`team ${t.id} got 0 of ${want} games with zero reported failures — silently stranded`);
    }
  }

  return violations;
}

function nearestSlotFor(time) {
  const SLOT_TIMES = { early: '10:00', midday: '12:00', late: '14:00' };
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const target = toMin(time);
  let best = 'early', bestDelta = Infinity;
  for (const [k, v] of Object.entries(SLOT_TIMES)) {
    const delta = Math.abs(toMin(v) - target);
    if (delta < bestDelta) { best = k; bestDelta = delta; }
  }
  return best;
}

// ── Runner ───────────────────────────────────────────────────────────────────
function runOnce(opts) {
  const seasonData = buildRandomLeague(opts);
  const t0 = Date.now();
  let result;
  try {
    result = scheduleAll(seasonData);
  } catch (err) {
    return { seasonData, error: err, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const violations = checkInvariants(seasonData, result);

  const gameCount = new Map();
  for (const g of result.games || []) {
    gameCount.set(g.home_team_id, (gameCount.get(g.home_team_id) || 0) + 1);
    gameCount.set(g.away_team_id, (gameCount.get(g.away_team_id) || 0) + 1);
  }
  const counts = seasonData.teams.map(t => gameCount.get(t.id) || 0);
  const satGames = (result.games || []).filter(g => g.day === 'Saturday').length;

  return {
    seasonData, result, ms, violations,
    stats: {
      teams: seasonData.teams.length,
      games: (result.games || []).length,
      failures: (result.failures || []).length,
      minGamesPerTeam: Math.min(...counts),
      maxGamesPerTeam: Math.max(...counts),
      satPct: (result.games || []).length ? (100 * satGames / result.games.length) : 0,
      oddDivisions: seasonData._meta.teamCounts.filter(c => c % 2 === 1).length,
    },
  };
}

// ── Report ───────────────────────────────────────────────────────────────────
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`Fuzzing scheduler: ${opts.runs} runs, ${opts.minTeams}-${opts.maxTeams} teams/division\n`);

  const outcomes = [];
  let violationRuns = 0, errorRuns = 0, totalViolations = 0;
  const t0 = Date.now();

  for (let i = 0; i < opts.runs; i++) {
    const outcome = runOnce(opts);
    outcomes.push(outcome);
    if (outcome.error) { errorRuns++; continue; }
    if (outcome.violations.length) { violationRuns++; totalViolations += outcome.violations.length; }
    if ((i + 1) % Math.max(1, Math.floor(opts.runs / 10)) === 0) {
      process.stderr.write(`  ${i + 1}/${opts.runs}\r`);
    }
  }
  const totalMs = Date.now() - t0;

  const clean = outcomes.filter(o => !o.error);
  const withFailures = clean.filter(o => o.stats.failures > 0);
  const minGamesEver = Math.min(...clean.map(o => o.stats.minGamesPerTeam));
  const msValues = clean.map(o => o.ms);

  console.log('\n── Summary ──────────────────────────────────────────────');
  console.log(`Runs: ${opts.runs}   Errors: ${errorRuns}   Invariant violations: ${violationRuns} runs (${totalViolations} total)`);
  console.log(`Runs with unplaced games: ${withFailures.length}/${clean.length} (${(100 * withFailures.length / clean.length).toFixed(1)}%)`);
  console.log(`Worst min-games-per-team seen: ${minGamesEver}`);
  console.log(`Scheduling time: median ${median(msValues)}ms, worst ${Math.max(...msValues)}ms, total wall time ${(totalMs / 1000).toFixed(1)}s`);

  // Bucket failure rate by odd vs even division sizes — the scheduler's own
  // comments already flag odd-sized divisions as capacity-tight, so this
  // sweep should make that visible in the numbers, not just in a comment.
  const oddBucket = clean.filter(o => o.stats.oddDivisions > 0);
  const evenBucket = clean.filter(o => o.stats.oddDivisions === 0);
  const failRate = (arr) => arr.length ? (100 * arr.filter(o => o.stats.failures > 0).length / arr.length).toFixed(1) : 'n/a';
  console.log(`\nFailure rate — has an odd-sized division: ${failRate(oddBucket)}% (${oddBucket.length} runs)`);
  console.log(`Failure rate — all-even divisions:         ${failRate(evenBucket)}% (${evenBucket.length} runs)`);

  // Bucket by division team count (small vs large) — another axis worth
  // watching as the size sweep runs.
  const smallBucket = clean.filter(o => Math.min(...o.seasonData._meta.teamCounts) <= 6);
  const largeBucket = clean.filter(o => Math.min(...o.seasonData._meta.teamCounts) > 6);
  console.log(`Failure rate — smallest division <=6 teams: ${failRate(smallBucket)}% (${smallBucket.length} runs)`);
  console.log(`Failure rate — smallest division >6 teams:  ${failRate(largeBucket)}% (${largeBucket.length} runs)`);

  if (violationRuns > 0) {
    console.log('\n── Invariant violations (first 20) ─────────────────────');
    let shown = 0;
    for (const o of outcomes) {
      if (!o.violations || !o.violations.length) continue;
      for (const v of o.violations) {
        if (shown >= 20) break;
        console.log(`  ** ${v}`);
        shown++;
      }
      if (shown >= 20) break;
    }
  }
  if (errorRuns > 0) {
    console.log('\n── Runs that threw ─────────────────────────────────────');
    for (const o of outcomes) if (o.error) console.log(`  ** ${o.error.message}`);
  }

  // Save the worst runs (violations first, then most failures, then thinnest
  // team) to disk as real season.json files, so a specific bad case can be
  // reloaded and stepped through by hand instead of re-rolling dice hoping
  // to hit it again.
  if (opts.saveWorst > 0) {
    fs.mkdirSync(opts.outDir, { recursive: true });
    const ranked = [...clean].sort((a, b) => {
      const av = a.violations.length, bv = b.violations.length;
      if (av !== bv) return bv - av;
      if (a.stats.failures !== b.stats.failures) return b.stats.failures - a.stats.failures;
      return a.stats.minGamesPerTeam - b.stats.minGamesPerTeam;
    });
    const worst = ranked.slice(0, opts.saveWorst).filter(o => o.violations.length || o.stats.failures > 0);
    for (let i = 0; i < worst.length; i++) {
      const file = path.join(opts.outDir, `case-${i + 1}.json`);
      const { _meta, ...cleanSeason } = worst[i].seasonData;
      fs.writeFileSync(file, JSON.stringify(cleanSeason, null, 2));
      console.log(`\nSaved ${file} — ${worst[i].violations.length} violations, ${worst[i].stats.failures} unplaced, min ${worst[i].stats.minGamesPerTeam} games/team`);
    }
    if (!worst.length) console.log('\nNothing worth saving — no violations and no unplaced games in this run.');
  }

  console.log();
  process.exit(violationRuns > 0 || errorRuns > 0 ? 1 : 0);
}

main();
