'use strict';

// Season week definitions per spec calendar
const SEASON_WEEKS = [
  { week: 1, weekdays: ['2026-04-20','2026-04-21','2026-04-22','2026-04-23'], saturday: '2026-04-25' },
  { week: 2, weekdays: ['2026-04-27','2026-04-28','2026-04-29','2026-04-30'], saturday: '2026-05-02' },
  { week: 3, weekdays: ['2026-05-04','2026-05-05','2026-05-06','2026-05-07'], saturday: '2026-05-09' },
  { week: 4, weekdays: ['2026-05-11','2026-05-12','2026-05-13','2026-05-14'], saturday: '2026-05-16' },
  { week: 5, weekdays: ['2026-05-18','2026-05-19','2026-05-20','2026-05-21'], saturday: null },   // 5/23 blacked out
  { week: 6, weekdays: ['2026-05-26','2026-05-27','2026-05-28'],              saturday: '2026-05-30' }, // 5/25 Mon blacked out
  { week: 7, weekdays: ['2026-06-01','2026-06-02','2026-06-03','2026-06-04'], saturday: '2026-06-06' },
];

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function teamName(team) {
  return team.name || team.label || team.team_name || team.full_name || `Team ${team.id}`;
}
function divName(division) {
  return division.name || division.label || division.id;
}
function dayName(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return DAY_NAMES[d.getUTCDay()];
}
function adjacentDate(dateStr, delta) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function formatDateShort(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${parseInt(m)}/${parseInt(d)}`;
}
function saturdayTime(divisionId, season) {
  const ageGroup = divisionId.split('-')[0];
  const times = season.saturday_times || season.weekend_times;
  return (times && times[ageGroup]) || '10:00';
}
function resolveField(team, isSaturday, fields) {
  const fieldId = (isSaturday && team.home_field_saturday_id)
    ? team.home_field_saturday_id
    : team.home_field_id;
  const field = fields.find(f => f.id === fieldId);
  if (!field) return null;
  // Support split weekday/weekend venues (e.g. Mayfield)
  const name    = isSaturday ? (field.weekend_venue    || field.name)    : (field.name);
  const address = isSaturday ? (field.weekend_address  || field.address  || '') : (field.address || '');
  return { ...field, name, address, resolved_id: fieldId };
}

// ── Preference parsing ────────────────────────────────────────────────────────
//
// FIX: Team preferences are stored as a string array (e.g. ["no_monday_weekday",
// "prefer_tuesday", ...]) but the original code tried to access them as object
// properties — so none of them worked. This function converts the array into a
// structured object that the rest of the scheduler can use.
//
function parsePreferences(team) {
  let prefs;
  if (Array.isArray(team.preferences)) {
    prefs = team.preferences;
  } else if (team.preferences && typeof team.preferences === 'object') {
    // Legacy object format — extract truthy keys
    prefs = Object.entries(team.preferences)
      .filter(([, v]) => v)
      .map(([k, v]) => (typeof v === 'string' ? `${k}_${v}` : k));
  } else {
    prefs = [];
  }

  const result = {
    forbiddenDays: new Set(),     // weekday names blocked for any game
    allowedWeekdays: null,        // if set, weekday games ONLY on these day names
    noThursdayBefore: null,       // 'YYYY-MM-DD': no Thursday before this date
    weekdayHomeOnly: false,       // must be home team on all weekday games
    saturdayAwayPreferred: false, // prefer away on Saturday (soft)
    specificGames: [],            // [{ date, isHome, time }]
    preferredDays: [],            // preferred weekday day names (soft)
    startTimes: {},               // { 'Monday': '18:30', 'Thursday': '19:00' }
    saturdayDateOnly: null,       // only play Saturday on this specific date
  };

  for (const pref of prefs) {
    if (typeof pref !== 'string') continue;

    if (pref === 'no_monday_weekday') {
      result.forbiddenDays.add('Monday');

    } else if (pref === 'prefer_tuesday') {
      result.preferredDays.push('Tuesday');

    } else if (pref === 'prefer_monday_weekday') {
      result.preferredDays.push('Monday');

    } else if (pref === 'thursday_ok') {
      // explicit acknowledgment Thursday is OK — no action needed

    } else if (pref === 'saturday_away_after_1400') {
      // Soft preference: prefer to be away on Saturday
      // Treated as soft (not hard) to avoid conflicting with specific_game constraints
      result.saturdayAwayPreferred = true;

    } else if (pref === 'weekday_home_only') {
      result.weekdayHomeOnly = true;

    } else if (pref === 'weekday_monday_or_thursday') {
      result.allowedWeekdays = new Set(['Monday', 'Thursday']);

    } else if (pref === 'no_thursday_before_may1') {
      result.noThursdayBefore = '2026-05-01';

    } else if (pref === 'monday_home_start_630') {
      result.startTimes['Monday'] = '18:30';

    } else if (pref === 'thursday_home_start_700') {
      result.startTimes['Thursday'] = '19:00';

    } else if (pref === 'wednesday_saturday_only') {
      result.allowedWeekdays = new Set(['Wednesday']);

    } else if (pref === 'no_tuesday') {
      result.forbiddenDays.add('Tuesday');

    } else if (pref === 'prefer_monday') {
      result.preferredDays.push('Monday');

    } else if (pref.startsWith('saturday_date_only_')) {
      result.saturdayDateOnly = pref.slice('saturday_date_only_'.length);

    } else if (pref.startsWith('specific_game_')) {
      // Format: specific_game_YYYY-MM-DD_home_HHMM  (home or away)
      const rest = pref.slice('specific_game_'.length);
      const parts = rest.split('_');
      if (parts.length === 3) {
        const [date, homeAway, timeRaw] = parts;
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && (homeAway === 'home' || homeAway === 'away')) {
          const time = timeRaw.length === 4
            ? `${timeRaw.slice(0, 2)}:${timeRaw.slice(2)}`
            : timeRaw;
          result.specificGames.push({ date, isHome: homeAway === 'home', time });
        }
      }
    }
  }

  return result;
}

// ── Slot pool building ────────────────────────────────────────────────────────

function buildAllSlots(globalBlackouts) {
  const slots = [];
  for (const wk of SEASON_WEEKS) {
    for (const date of wk.weekdays) {
      if (!globalBlackouts.has(date)) {
        slots.push({ date, week: wk.week, dayType: 'weekday', day: dayName(date) });
      }
    }
    if (wk.saturday && !globalBlackouts.has(wk.saturday)) {
      slots.push({ date: wk.saturday, week: wk.week, dayType: 'saturday', day: 'Saturday' });
    }
  }
  return slots;
}

// ── Matchup generation ────────────────────────────────────────────────────────
//
// Two-pass round-robin:
//   Pass 1 — non-same-club matchups only (prefer diverse opponents first)
//   Pass 2 — same-club matchups to fill remaining game quota
//
// Within each pass, a fairness check prevents scheduling the Nth game between
// A and B until both have played every other available opponent at least N-1
// times.  This is a soft preference in round-robin order: if a round produces
// no fair games the algorithm keeps cycling until it finds one or gets stuck.
//
function buildMatchupList(teams, targetGames, noMatchupRules) {
  if (teams.length < 2) return [];

  const pairKey = (a, b) => `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;

  const forbidden = new Set();
  for (const rule of (noMatchupRules || [])) {
    for (const a of (rule.team_ids || [])) {
      for (const b of (rule.vs_team_ids || [])) {
        forbidden.add(`${Math.min(a, b)}-${Math.max(a, b)}`);
      }
    }
  }

  const sameClub = new Set();
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      if (teams[i].club_id === teams[j].club_id) {
        sameClub.add(`${teams[i].id}-${teams[j].id}`);
      }
    }
  }

  function generateRRRounds(teamList) {
    const list = teamList.length % 2 === 0 ? [...teamList] : [...teamList, null];
    const n = list.length;
    const fixed = list[n - 1];
    const rotating = [...list.slice(0, n - 1)];
    const rounds = [];
    for (let r = 0; r < n - 1; r++) {
      const round = [];
      if (fixed && rotating[0]) round.push([fixed, rotating[0]]);
      for (let i = 1; i < n / 2; i++) {
        const a = rotating[i];
        const b = rotating[(n - 1) - i];
        if (a && b) round.push([a, b]);
      }
      rotating.unshift(rotating.pop());
      rounds.push(round);
    }
    return rounds;
  }

  // Check whether adding the (currentCount+1)th game between side and other
  // would violate the spread-≤1 fairness rule.  Returns true if the game
  // should be skipped (unfair), false if it may proceed.
  // Only opponents valid in the current pass (same filterSameClub) are considered,
  // so same-club teams don't block cross-club rematches in pass 1 (and vice versa).
  function isFairnessViolation(side, other, currentCount, filterSameClub) {
    if (currentCount === 0) return false;
    for (const opp of teams) {
      if (opp.id === side.id || opp.id === other.id) continue;
      if (gameCounts[opp.id] >= targetGames) continue;
      const oppKey = pairKey(side, opp);
      if (forbidden.has(oppKey)) continue;
      if (sameClub.has(oppKey) !== filterSameClub) continue;
      if ((matchupCounts[oppKey] || 0) < currentCount) return true;
    }
    return false;
  }

  const rrRounds = generateRRRounds(teams);
  const gameCounts = {};
  const crossClubGames = {};
  const matchupCounts = {};
  teams.forEach(t => { gameCounts[t.id] = 0; crossClubGames[t.id] = 0; });

  const matchups = [];

  for (const filterSameClub of [false, true]) {
    let roundIdx = 0;
    const MAX_ROUNDS = rrRounds.length * (targetGames * 6 + 10);

    const isDone = (t) => gameCounts[t.id] >= targetGames;

    while (roundIdx < MAX_ROUNDS) {
      if (teams.every(t => gameCounts[t.id] >= targetGames)) break;

      const round = rrRounds[roundIdx % rrRounds.length];
      roundIdx++;

      // Prioritize pairs where teams have fewest games (same-club members catch up together).
      const sortedRound = [...round].sort((pA, pB) => {
        const minA = Math.min(gameCounts[pA[0].id], gameCounts[pA[1].id]);
        const minB = Math.min(gameCounts[pB[0].id], gameCounts[pB[1].id]);
        return minA - minB;
      });

      // Collect fair and unfair games separately for this round;
      // add fair ones immediately, defer unfair ones until round is done.
      const deferred = [];

      for (const [teamA, teamB] of sortedRound) {
        const key = pairKey(teamA, teamB);
        if (forbidden.has(key)) continue;
        if (isDone(teamA)) continue;
        if (isDone(teamB)) continue;
        if (sameClub.has(key) !== filterSameClub) continue;

        const currentCount = matchupCounts[key] || 0;
        const unfairA = isFairnessViolation(teamA, teamB, currentCount, filterSameClub);
        const unfairB = isFairnessViolation(teamB, teamA, currentCount, filterSameClub);

        if (unfairA || unfairB) {
          deferred.push({ teamA, teamB, key, currentCount });
        } else {
          matchups.push({ teamA, teamB, isSameClub: filterSameClub, isRematch: currentCount > 0, round: currentCount + 1 });
          gameCounts[teamA.id]++;
          gameCounts[teamB.id]++;
          if (!filterSameClub) { crossClubGames[teamA.id]++; crossClubGames[teamB.id]++; }
          matchupCounts[key] = currentCount + 1;
        }
      }

      // Add deferred (unfair) games only if neither team has a fair alternative
      // available in this pass.  This prevents a same-club pair from being
      // scheduled repeatedly while a fairer pairing still exists.
      for (const { teamA, teamB, key, currentCount } of deferred) {
        if (isDone(teamA)) continue;
        if (isDone(teamB)) continue;

        const hasFairAlt = (side) => teams.some(opp => {
          if (opp.id === side.id || opp.id === teamA.id || opp.id === teamB.id) return false;
          if (isDone(opp)) return false;
          const k = pairKey(side, opp);
          if (forbidden.has(k)) return false;
          if (sameClub.has(k) !== filterSameClub) return false;
          return !isFairnessViolation(side, opp, matchupCounts[k] || 0, filterSameClub);
        });

        if (hasFairAlt(teamA) || hasFairAlt(teamB)) continue;

        matchups.push({ teamA, teamB, isSameClub: filterSameClub, isRematch: currentCount > 0, round: currentCount + 1 });
        gameCounts[teamA.id]++;
        gameCounts[teamB.id]++;
        if (!filterSameClub) { crossClubGames[teamA.id]++; crossClubGames[teamB.id]++; }
        matchupCounts[key] = currentCount + 1;
      }

      const stuck = teams.every(t => {
        if (isDone(t)) return true;
        return teams.every(other => {
          if (other.id === t.id) return true;
          const key = pairKey(t, other);
          if (forbidden.has(key)) return true;
          if (isDone(other)) return true;
          return sameClub.has(key) !== filterSameClub;
        });
      });
      if (stuck) break;
    }
  }

  return matchups;
}

// ── Team state tracking ───────────────────────────────────────────────────────

function initTeamState(teams) {
  const state = {};
  teams.forEach(t => {
    state[t.id] = {
      homeCount: 0,
      awayCount: 0,
      gamesPlayed: 0,
      weekdayByWeek: {},
      saturdayByWeek: {},
      weekdayCounts: {},
      opponents: [],
      playedDates: new Set(),
    };
  });
  return state;
}

// ── Assignment validity ───────────────────────────────────────────────────────
//
// FIX: Added hard enforcement of day-restriction preferences:
//   • forbiddenDays (no_monday_weekday, etc.)
//   • allowedWeekdays (wednesday_saturday_only, weekday_monday_or_thursday)
//   • noThursdayBefore (no_thursday_before_may1)
//   • weekdayHomeOnly  (team can only be home on weekdays)
//   • saturdayDateOnly (old object-format preference, still supported)
//
function isValidAssignment(home, away, slot, teamState, fieldUsage, globalBlackouts) {
  const { date, week, dayType } = slot;
  const isSaturday = dayType === 'saturday';
  const homeState = teamState[home.id];
  const awayState = teamState[away.id];

  // Global blackout
  if (globalBlackouts.has(date))
    return { ok: false, reason: `Global blackout on ${date}` };

  // Team blackout dates
  if ((home.blackout_dates || []).includes(date))
    return { ok: false, reason: `${teamName(home)} is blacked out on ${date}` };
  if ((away.blackout_dates || []).includes(date))
    return { ok: false, reason: `${teamName(away)} is blacked out on ${date}` };

  // No two games on the same day
  if (homeState.playedDates.has(date))
    return { ok: false, reason: `${teamName(home)} already has a game on ${date}` };
  if (awayState.playedDates.has(date))
    return { ok: false, reason: `${teamName(away)} already has a game on ${date}` };

  // No consecutive-day games
  const prevDay = adjacentDate(date, -1);
  const nextDay = adjacentDate(date, +1);
  if (homeState.playedDates.has(prevDay) || homeState.playedDates.has(nextDay))
    return { ok: false, reason: `${teamName(home)} would play on consecutive days around ${date}` };
  if (awayState.playedDates.has(prevDay) || awayState.playedDates.has(nextDay))
    return { ok: false, reason: `${teamName(away)} would play on consecutive days around ${date}` };

  // ── Hard preference enforcement ──────────────────────────────────────────
  const homePrefs = parsePreferences(home);
  const awayPrefs = parsePreferences(away);

  if (!isSaturday) {
    const day = slot.day;

    // Forbidden weekdays
    if (homePrefs.forbiddenDays.has(day))
      return { ok: false, reason: `${teamName(home)} cannot play on ${day}` };
    if (awayPrefs.forbiddenDays.has(day))
      return { ok: false, reason: `${teamName(away)} cannot play on ${day}` };

    // Allowed-weekday restriction (e.g. wednesday_saturday_only, weekday_monday_or_thursday)
    if (homePrefs.allowedWeekdays && !homePrefs.allowedWeekdays.has(day))
      return { ok: false, reason: `${teamName(home)} can only play weekdays on ${[...homePrefs.allowedWeekdays].join('/')}` };
    if (awayPrefs.allowedWeekdays && !awayPrefs.allowedWeekdays.has(day))
      return { ok: false, reason: `${teamName(away)} can only play weekdays on ${[...awayPrefs.allowedWeekdays].join('/')}` };

    // No Thursday before a date
    if (day === 'Thursday' && homePrefs.noThursdayBefore && date < homePrefs.noThursdayBefore)
      return { ok: false, reason: `${teamName(home)} cannot play Thursday before ${homePrefs.noThursdayBefore}` };
    if (day === 'Thursday' && awayPrefs.noThursdayBefore && date < awayPrefs.noThursdayBefore)
      return { ok: false, reason: `${teamName(away)} cannot play Thursday before ${awayPrefs.noThursdayBefore}` };

    // weekday_home_only: away team cannot have this constraint
    if (awayPrefs.weekdayHomeOnly)
      return { ok: false, reason: `${teamName(away)} can only be home team on weekdays` };
  }

  if (isSaturday) {
    // saturdayDateOnly (legacy object-format preference)
    if (homePrefs.saturdayDateOnly && homePrefs.saturdayDateOnly !== date)
      return { ok: false, reason: `${teamName(home)} can only play Saturday on ${homePrefs.saturdayDateOnly}` };
    if (awayPrefs.saturdayDateOnly && awayPrefs.saturdayDateOnly !== date)
      return { ok: false, reason: `${teamName(away)} can only play Saturday on ${awayPrefs.saturdayDateOnly}` };
  }

  // ── Week/game-count limits ───────────────────────────────────────────────
  if (!isSaturday) {
    if ((homeState.weekdayByWeek[week] || 0) >= 2)
      return { ok: false, reason: `${teamName(home)} already has 2 weekday games in week ${week}` };
    if ((awayState.weekdayByWeek[week] || 0) >= 2)
      return { ok: false, reason: `${teamName(away)} already has 2 weekday games in week ${week}` };
  }
  if (isSaturday) {
    if ((homeState.saturdayByWeek[week] || 0) >= 1)
      return { ok: false, reason: `${teamName(home)} already has a Saturday game in week ${week}` };
    if ((awayState.saturdayByWeek[week] || 0) >= 1)
      return { ok: false, reason: `${teamName(away)} already has a Saturday game in week ${week}` };
  }

  const homeWeekTotal = (homeState.weekdayByWeek[week] || 0) + (homeState.saturdayByWeek[week] || 0);
  const awayWeekTotal = (awayState.weekdayByWeek[week] || 0) + (awayState.saturdayByWeek[week] || 0);
  if (homeWeekTotal >= 3)
    return { ok: false, reason: `${teamName(home)} already has 3 games in week ${week}` };
  if (awayWeekTotal >= 3)
    return { ok: false, reason: `${teamName(away)} already has 3 games in week ${week}` };

  return { ok: true };
}

// ── Slot finder ───────────────────────────────────────────────────────────────
//
// FIX: Team-specific time overrides now applied for weekday games
//   (monday_home_start_630 → 18:30, thursday_home_start_700 → 19:00).
// FIX: specific_game time overrides applied when game lands on the requested date.
//
function findSlot(home, away, slots, teamState, fieldUsage, fields, globalBlackouts, season, divisionId) {
  const homePrefs = parsePreferences(home);
  const awayPrefs = parsePreferences(away);

  for (const slot of slots) {
    const check = isValidAssignment(home, away, slot, teamState, fieldUsage, globalBlackouts);
    if (!check.ok) continue;

    const isSat = slot.dayType === 'saturday';
    const field = resolveField(home, isSat, fields);
    if (!field) continue;

    const fieldKey = `${field.resolved_id}_${slot.date}`;
    if (fieldUsage[fieldKey]) continue;

    // Determine game time
    let time;
    if (isSat) {
      // Check for a specific_game time override on this date
      const homeSpec = homePrefs.specificGames.find(sg => sg.date === slot.date);
      const awaySpec = awayPrefs.specificGames.find(sg => sg.date === slot.date);
      time = homeSpec?.time || awaySpec?.time || saturdayTime(divisionId, season);
    } else {
      const day = slot.day;
      // Home team's per-day time takes precedence; fall back to away or season default
      time = homePrefs.startTimes[day] || awayPrefs.startTimes[day] || season.weekday_time || '18:00';
    }

    return {
      game_id: null,
      division_id: divisionId,
      date: slot.date,
      day: slot.day,
      time,
      home_team_id: home.id,
      home_team_name: teamName(home),
      away_team_id: away.id,
      away_team_name: teamName(away),
      field_id: field.resolved_id,
      field_name: field.name,
      field_address: field.address || '',
      week: slot.week,
      is_rematch: false, // set by caller
      _fieldKey: fieldKey,
    };
  }
  return null;
}

function recordGame(game, teamState, fieldUsage) {
  const homeState = teamState[game.home_team_id];
  const awayState = teamState[game.away_team_id];
  const isSaturday = game.day === 'Saturday';

  homeState.homeCount++;
  homeState.gamesPlayed++;
  homeState.opponents.push(game.away_team_id);

  awayState.awayCount++;
  awayState.gamesPlayed++;
  awayState.opponents.push(game.home_team_id);

  if (isSaturday) {
    homeState.saturdayByWeek[game.week] = (homeState.saturdayByWeek[game.week] || 0) + 1;
    awayState.saturdayByWeek[game.week] = (awayState.saturdayByWeek[game.week] || 0) + 1;
  } else {
    homeState.weekdayByWeek[game.week] = (homeState.weekdayByWeek[game.week] || 0) + 1;
    awayState.weekdayByWeek[game.week] = (awayState.weekdayByWeek[game.week] || 0) + 1;
    homeState.weekdayCounts[game.day] = (homeState.weekdayCounts[game.day] || 0) + 1;
    awayState.weekdayCounts[game.day] = (awayState.weekdayCounts[game.day] || 0) + 1;
  }

  homeState.playedDates.add(game.date);
  awayState.playedDates.add(game.date);

  fieldUsage[game._fieldKey] = true;
}

// ── Slot ordering ─────────────────────────────────────────────────────────────
//
// FIX: Now reads parsed preferences correctly (was broken — tried to access
// array elements as object properties).  Adds scoring for:
//   • specific_game dates (extreme priority boost)
//   • preferred weekday names
//   • saturday_date_only penalty for non-preferred Saturdays
//
function buildSlotList(allSlots, teamA, teamB, teamState, usedSpecificDates) {
  const prefsA = parsePreferences(teamA);
  const prefsB = parsePreferences(teamB);
  const stA = teamState?.[teamA.id];
  const stB = teamState?.[teamB.id];

  // Unsatisfied specific-game dates for either team
  const pendingSpecA = prefsA.specificGames
    .filter(sg => !usedSpecificDates.has(`${teamA.id}_${sg.date}`))
    .map(sg => sg.date);
  const pendingSpecB = prefsB.specificGames
    .filter(sg => !usedSpecificDates.has(`${teamB.id}_${sg.date}`))
    .map(sg => sg.date);

  const slots = allSlots.map(s => {
    let score = 0;

    // specific_game date: highest possible priority
    if (pendingSpecA.includes(s.date) || pendingSpecB.includes(s.date)) {
      score -= 1000;
    }

    // saturday_date_only: heavily penalise non-preferred Saturday slots
    if (s.dayType === 'saturday') {
      if ((prefsA.saturdayDateOnly && prefsA.saturdayDateOnly !== s.date) ||
          (prefsB.saturdayDateOnly && prefsB.saturdayDateOnly !== s.date)) {
        score += 10000;
      }
    }

    // Preferred weekdays: give them a small priority boost
    if (s.dayType === 'weekday') {
      if (prefsA.preferredDays.includes(s.day)) score -= 2;
      if (prefsB.preferredDays.includes(s.day)) score -= 2;
    }

    // Spread across weeks; Saturday strongly preferred — all Saturdays score before any weekday
    score += s.week + (s.dayType === 'weekday' ? 8 : 0) + Math.random() * 0.49;

    // 3rd-game-in-week penalty: exhaust all Sat+WD pairs before tripling up
    if (stA && stB) {
      const weekA = (stA.weekdayByWeek[s.week] || 0) + (stA.saturdayByWeek[s.week] || 0);
      const weekB = (stB.weekdayByWeek[s.week] || 0) + (stB.saturdayByWeek[s.week] || 0);
      if (Math.max(weekA, weekB) >= 2) score += 10;
    }

    // Day-variety penalty: discourage repeating the same weekday
    if (s.dayType === 'weekday') {
      const dayA = stA?.weekdayCounts?.[s.day] || 0;
      const dayB = stB?.weekdayCounts?.[s.day] || 0;
      score += (dayA + dayB) * 3;
    }

    return { ...s, _score: score };
  });

  slots.sort((a, b) => a._score - b._score);
  return slots;
}

// ── Division scheduling (one attempt) ────────────────────────────────────────
//
// FIX: Rematch home/away flip — when two teams meet a second time, home and
// away roles are swapped from their first encounter.
//
// FIX: Orientation selection now accounts for weekday_home_only and
// saturday_away_after_1400 preferences when picking who plays home.
//
// FIX: specific_game time overrides are applied when a game lands on the
// requested date, and that constraint is marked satisfied so it isn't
// double-applied to a second matchup.
//
function tryScheduleDivision(matchups, teams, division, season, fields, globalBlackouts, allSlots, fieldUsage) {
  const teamState = initTeamState(teams);
  const games = [];
  const halfTarget = Math.ceil((season.target_games || 8) / 2);
  const pairKey = (a, b) => `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;

  // Track first-game home/away so rematches can flip correctly
  const firstGameOrient = {}; // pairKey → { homeId, awayId }

  // Track which specific-game date constraints have already been satisfied
  const usedSpecificDates = new Set();

  for (const matchup of matchups) {
    const { teamA, teamB } = matchup;
    const prefsA = parsePreferences(teamA);
    const prefsB = parsePreferences(teamB);

    // Detect rematch at runtime so flip works regardless of shuffle order.
    const key = pairKey(teamA, teamB);
    const isActualRematch = !!firstGameOrient[key];

    let orientations;

    if (isActualRematch) {
      // Flip home/away from first encounter
      const first = firstGameOrient[key];
      const origHome = teams.find(t => t.id === first.homeId);
      const origAway = teams.find(t => t.id === first.awayId);
      if (origHome && origAway) {
        orientations = [
          { home: origAway, away: origHome }, // flipped (preferred)
          { home: origHome, away: origAway }, // original (fallback if flipped is impossible)
        ];
      }
    }

    if (!orientations) {
      // For weekdayHomeOnly teams, canSchedule() already enforces home-only on weekdays.
      // Projecting those forced-home weekday games into the effective home count prevents
      // the Saturday orientation from also defaulting to home, which causes imbalance.
      function projectedHomeCount(team, prefs) {
        const st = teamState[team.id];
        if (!prefs.weekdayHomeOnly) return st.homeCount;
        const gamesLeft = (halfTarget * 2) - st.gamesPlayed;
        // Conservative: half of remaining games may be weekday (all forced home)
        return st.homeCount + Math.floor(gamesLeft / 2);
      }

      const aAtCap   = projectedHomeCount(teamA, prefsA) >= halfTarget;
      const bAtCap   = projectedHomeCount(teamB, prefsB) >= halfTarget;
      const aHomeAdv = teamState[teamA.id].homeCount - teamState[teamA.id].awayCount;
      const bHomeAdv = teamState[teamB.id].homeCount - teamState[teamB.id].awayCount;

      // weekdayHomeOnly is only a tiebreaker; balance-based signals take priority
      // so Saturday orientation is driven by actual counts, not the hard weekday rule.
      const aWantsHome = prefsA.weekdayHomeOnly;
      const bWantsHome = prefsB.weekdayHomeOnly;

      if (aAtCap && !bAtCap) {
        orientations = [{ home: teamB, away: teamA }, { home: teamA, away: teamB }];
      } else if (bAtCap && !aAtCap) {
        orientations = [{ home: teamA, away: teamB }, { home: teamB, away: teamA }];
      } else if (aHomeAdv < bHomeAdv) {
        orientations = [{ home: teamA, away: teamB }, { home: teamB, away: teamA }];
      } else if (aHomeAdv > bHomeAdv) {
        orientations = [{ home: teamB, away: teamA }, { home: teamA, away: teamB }];
      } else if (aWantsHome && !bWantsHome) {
        orientations = [{ home: teamA, away: teamB }, { home: teamB, away: teamA }];
      } else if (bWantsHome && !aWantsHome) {
        orientations = [{ home: teamB, away: teamA }, { home: teamA, away: teamB }];
      } else {
        orientations = Math.random() < 0.5
          ? [{ home: teamA, away: teamB }, { home: teamB, away: teamA }]
          : [{ home: teamB, away: teamA }, { home: teamA, away: teamB }];
      }
    }

    let assigned = false;

    for (const { home, away } of orientations) {
      const slots = buildSlotList(allSlots, home, away, teamState, usedSpecificDates);
      const game = findSlot(home, away, slots, teamState, fieldUsage, fields, globalBlackouts, season, division.id);

      if (game) {
        game.is_rematch = isActualRematch;

        // Mark any specific-game date constraint satisfied
        const hPrefs = parsePreferences(home);
        const aPrefs = parsePreferences(away);
        for (const sg of hPrefs.specificGames) {
          if (sg.date === game.date) {
            usedSpecificDates.add(`${home.id}_${game.date}`);
            // Apply the requested time if the game landed on the specific date
            if (sg.isHome) game.time = sg.time;
          }
        }
        for (const sg of aPrefs.specificGames) {
          if (sg.date === game.date) {
            usedSpecificDates.add(`${away.id}_${game.date}`);
          }
        }

        // Record first-game orientation for rematch flip
        if (!isActualRematch) {
          firstGameOrient[key] = { homeId: home.id, awayId: away.id };
        }

        recordGame(game, teamState, fieldUsage);
        games.push(game);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      return {
        success: false,
        failure: {
          division_id: division.id,
          division_name: divName(division),
          blocking_matchup: `${teamName(teamA)} vs ${teamName(teamB)}`,
          reason: `No valid slot could be found for ${teamName(teamA)} vs ${teamName(teamB)} in ${divName(division)}. ` +
            `Both teams may have conflicting blackouts, full weeks, or field conflicts.`,
        },
      };
    }
  }

  return { success: true, games };
}

// Schedule one division with multiple shuffle attempts.
function scheduleDivision(division, teams, season, fields, globalBlackouts, sharedFieldUsage) {
  const targetGames = division.target_games || season.target_games || 8;

  const noMatchupRules = [...(division.no_matchups || [])];
  for (const team of teams) {
    for (const restriction of (team.restrictions || [])) {
      if (restriction.type === 'no_matchup' && restriction.opponent_club) {
        const opponentIds = teams
          .filter(t => t.club_id === restriction.opponent_club)
          .map(t => t.id);
        if (opponentIds.length) {
          noMatchupRules.push({ team_ids: [team.id], vs_team_ids: opponentIds });
        }
      }
    }
  }

  const matchupList = buildMatchupList(teams, targetGames, noMatchupRules);
  const allSlots = buildAllSlots(globalBlackouts);

  if (matchupList.length === 0) {
    return {
      success: false,
      failure: {
        division_id: division.id,
        division_name: divName(division),
        reason: 'No valid matchups could be generated (check no_matchup rules and team count)',
      },
    };
  }

  const MAX_ATTEMPTS = 100;
  let lastFailure = null;
  const fieldUsageSnapshot = { ...sharedFieldUsage };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    Object.keys(sharedFieldUsage).forEach(k => delete sharedFieldUsage[k]);
    Object.assign(sharedFieldUsage, fieldUsageSnapshot);

    const shuffled = shuffle([...matchupList]);
    const result = tryScheduleDivision(
      shuffled, teams, division, season, fields, globalBlackouts, allSlots, sharedFieldUsage
    );

    if (result.success) {
      return { success: true, games: result.games, division_id: division.id };
    }

    lastFailure = result.failure;
  }

  Object.keys(sharedFieldUsage).forEach(k => delete sharedFieldUsage[k]);
  Object.assign(sharedFieldUsage, fieldUsageSnapshot);

  return { success: false, failure: lastFailure };
}

// ── Top-level ─────────────────────────────────────────────────────────────────
//
// FIX: Pre-run validation now collects warnings for specific_game dates that
// fall outside the season (e.g. before season start) or on global blackout days.
// These are returned in the result as `warnings` for the UI to display.
//
function scheduleAll(seasonData) {
  const season = seasonData.season;
  const fields = seasonData.fields || [];
  const globalBlackouts = new Set(season.blackout_dates || []);
  for (const weekend of (season.blackout_weekends || [])) {
    if (Array.isArray(weekend.dates)) weekend.dates.forEach(d => globalBlackouts.add(d));
    if (weekend.saturday) globalBlackouts.add(weekend.saturday);
    if (weekend.sunday)   globalBlackouts.add(weekend.sunday);
  }

  // Build set of all valid season game dates for validation
  const validSeasonDates = new Set();
  for (const wk of SEASON_WEEKS) {
    for (const d of wk.weekdays) validSeasonDates.add(d);
    if (wk.saturday) validSeasonDates.add(wk.saturday);
  }

  // Pre-run preference warnings
  const warnings = [];
  for (const team of (seasonData.teams || [])) {
    if (team.confirmed === false) continue;
    const prefs = parsePreferences(team);
    for (const sg of prefs.specificGames) {
      if (!validSeasonDates.has(sg.date)) {
        warnings.push({
          type: 'preference_warning',
          team_id: team.id,
          team_name: teamName(team),
          message: `${teamName(team)}: specific_game date ${sg.date} is not a valid season date — constraint skipped`,
        });
      } else if (globalBlackouts.has(sg.date)) {
        warnings.push({
          type: 'preference_warning',
          team_id: team.id,
          team_name: teamName(team),
          message: `${teamName(team)}: specific_game date ${sg.date} falls on a global blackout — constraint skipped`,
        });
      }
    }
  }

  const allGames = [];
  const failures = [];
  let gameIdCounter = 1;

  const startYear = (season.start || season.start_date || '').slice(2, 4)
    || String(new Date().getFullYear()).slice(2);
  const seasonName = (season.name || '').toLowerCase();
  const seasonNum = seasonName.includes('fall') ? '2' : '1';
  const gameIdPrefix = startYear + seasonNum;

  const sharedFieldUsage = {};

  for (const division of seasonData.divisions) {
    const divTeams = (seasonData.teams || []).filter(t =>
      t.division_id === division.id && t.confirmed !== false
    );

    if (divTeams.length < 2) {
      failures.push({
        division_id: division.id,
        division_name: divName(division),
        reason: `Only ${divTeams.length} confirmed team(s) — need at least 2`,
      });
      continue;
    }

    const result = scheduleDivision(division, divTeams, season, fields, globalBlackouts, sharedFieldUsage);

    if (result.success) {
      for (const game of result.games) {
        game.game_id = parseInt(gameIdPrefix + String(gameIdCounter++).padStart(3, '0'), 10);
      }
      allGames.push(...result.games);
    } else {
      failures.push(result.failure);
    }
  }

  return {
    success: failures.length === 0,
    games: allGames,
    failures,
    warnings,  // NEW: soft warnings surfaced to the UI
    generated_at: new Date().toISOString(),
    total_games: allGames.length,
  };
}

// ── Game edit validation ──────────────────────────────────────────────────────

function validateGameEdit(editedGame, allGames, season) {
  const violations = [];
  const { id, date, time, field_id, home_team_id, away_team_id } = editedGame;

  if (home_team_id === away_team_id) {
    violations.push('Home team and away team cannot be the same.');
  }

  const globalBlackouts = new Set(season.blackout_dates || []);
  if (season.blackout_weekends) {
    for (const weekend of season.blackout_weekends) {
      if (weekend.saturday) globalBlackouts.add(weekend.saturday);
      if (weekend.sunday)   globalBlackouts.add(weekend.sunday);
      if (weekend.dates)    for (const d of weekend.dates) globalBlackouts.add(d);
    }
  }

  let weekEntry = null;
  let dateType = null;
  for (const wk of SEASON_WEEKS) {
    if (wk.weekdays.includes(date)) { weekEntry = wk; dateType = 'weekday'; break; }
    if (wk.saturday === date)        { weekEntry = wk; dateType = 'saturday'; break; }
  }

  if (!weekEntry) {
    violations.push(`${date} is not a valid season date.`);
    return violations;
  }

  if (globalBlackouts.has(date)) {
    violations.push(`${date} is a global blackout date.`);
  }

  const teams = season._teams || [];
  const homeTeam = teams.find(t => t.id === home_team_id);
  const awayTeam = teams.find(t => t.id === away_team_id);

  if (homeTeam && (homeTeam.blackout_dates || []).includes(date))
    violations.push(`Home team (${teamName(homeTeam)}) is blacked out on ${date}.`);
  if (awayTeam && (awayTeam.blackout_dates || []).includes(date))
    violations.push(`Away team (${teamName(awayTeam)}) is blacked out on ${date}.`);

  const others = allGames.filter(g => g.game_id !== id && g.id !== id);

  const fieldConflict = others.find(g => g.field_id === field_id && g.date === date && g.time === time);
  if (fieldConflict)
    violations.push(`Field is already booked at ${date} ${time} (game #${fieldConflict.game_id || fieldConflict.id}).`);

  const homeConflict = others.find(g =>
    (g.home_team_id === home_team_id || g.away_team_id === home_team_id) && g.date === date && g.time === time
  );
  if (homeConflict)
    violations.push(`Home team already has a game at ${date} ${time}.`);

  const awayConflict = others.find(g =>
    (g.home_team_id === away_team_id || g.away_team_id === away_team_id) && g.date === date && g.time === time
  );
  if (awayConflict)
    violations.push(`Away team already has a game at ${date} ${time}.`);

  const week = weekEntry.week;
  const isSaturday = dateType === 'saturday';
  const day = dayName(date);

  // ── Consecutive-day check ──────────────────────────────────────────────────
  const prevDay = adjacentDate(date, -1);
  const nextDay = adjacentDate(date, +1);
  const homeConsec = others.find(g =>
    (g.home_team_id === home_team_id || g.away_team_id === home_team_id) &&
    (g.date === prevDay || g.date === nextDay)
  );
  if (homeConsec)
    violations.push(`Home team would play on consecutive days (existing game on ${homeConsec.date}).`);
  const awayConsec = others.find(g =>
    (g.home_team_id === away_team_id || g.away_team_id === away_team_id) &&
    (g.date === prevDay || g.date === nextDay)
  );
  if (awayConsec)
    violations.push(`Away team would play on consecutive days (existing game on ${awayConsec.date}).`);

  // ── Team preference checks ─────────────────────────────────────────────────
  if (homeTeam) {
    const prefs = parsePreferences(homeTeam);
    if (!isSaturday) {
      if (prefs.forbiddenDays.has(day))
        violations.push(`Home team (${teamName(homeTeam)}) cannot play on ${day}.`);
      if (prefs.allowedWeekdays && !prefs.allowedWeekdays.has(day))
        violations.push(`Home team (${teamName(homeTeam)}) can only play weekdays on ${[...prefs.allowedWeekdays].join('/')}.`);
      if (day === 'Thursday' && prefs.noThursdayBefore && date < prefs.noThursdayBefore)
        violations.push(`Home team (${teamName(homeTeam)}) cannot play Thursday before ${prefs.noThursdayBefore}.`);
    } else {
      if (prefs.saturdayDateOnly && prefs.saturdayDateOnly !== date)
        violations.push(`Home team (${teamName(homeTeam)}) can only play Saturday on ${formatDateShort(prefs.saturdayDateOnly)}.`);
    }
  }
  if (awayTeam) {
    const prefs = parsePreferences(awayTeam);
    if (!isSaturday) {
      if (prefs.forbiddenDays.has(day))
        violations.push(`Away team (${teamName(awayTeam)}) cannot play on ${day}.`);
      if (prefs.allowedWeekdays && !prefs.allowedWeekdays.has(day))
        violations.push(`Away team (${teamName(awayTeam)}) can only play weekdays on ${[...prefs.allowedWeekdays].join('/')}.`);
      if (day === 'Thursday' && prefs.noThursdayBefore && date < prefs.noThursdayBefore)
        violations.push(`Away team (${teamName(awayTeam)}) cannot play Thursday before ${prefs.noThursdayBefore}.`);
      if (prefs.weekdayHomeOnly)
        violations.push(`Away team (${teamName(awayTeam)}) can only be listed as home team on weekday games.`);
    } else {
      if (prefs.saturdayDateOnly && prefs.saturdayDateOnly !== date)
        violations.push(`Away team (${teamName(awayTeam)}) can only play Saturday on ${formatDateShort(prefs.saturdayDateOnly)}.`);
    }
  }

  if (isSaturday) {
    const homeSat = others.filter(g =>
      (g.home_team_id === home_team_id || g.away_team_id === home_team_id) &&
      g.week === week && g.day === 'Saturday'
    ).length;
    if (homeSat >= 1) violations.push(`Home team already has a Saturday game in week ${week}.`);

    const awaySat = others.filter(g =>
      (g.home_team_id === away_team_id || g.away_team_id === away_team_id) &&
      g.week === week && g.day === 'Saturday'
    ).length;
    if (awaySat >= 1) violations.push(`Away team already has a Saturday game in week ${week}.`);
  } else {
    const homeWd = others.filter(g =>
      (g.home_team_id === home_team_id || g.away_team_id === home_team_id) &&
      g.week === week && g.day !== 'Saturday'
    ).length;
    if (homeWd >= 2) violations.push(`Home team already has 2 weekday games in week ${week}.`);

    const awayWd = others.filter(g =>
      (g.home_team_id === away_team_id || g.away_team_id === away_team_id) &&
      g.week === week && g.day !== 'Saturday'
    ).length;
    if (awayWd >= 2) violations.push(`Away team already has 2 weekday games in week ${week}.`);

    const homeTot = others.filter(g =>
      (g.home_team_id === home_team_id || g.away_team_id === home_team_id) && g.week === week
    ).length;
    if (homeTot >= 3) violations.push(`Home team already has 3 games in week ${week}.`);

    const awayTot = others.filter(g =>
      (g.home_team_id === away_team_id || g.away_team_id === away_team_id) && g.week === week
    ).length;
    if (awayTot >= 3) violations.push(`Away team already has 3 games in week ${week}.`);
  }

  return violations;
}

module.exports = { scheduleAll, validateGameEdit, SEASON_WEEKS, dayName, teamName };
