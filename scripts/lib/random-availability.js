'use strict';
// Shared weighted-random availability generation, used by both the seed
// script (scripts/seed-full-registration-stage.js) and the scheduler fuzzer
// (scripts/fuzz-scheduler.js) — pulled out so the two can't quietly drift
// apart and start testing/demoing two different distributions.
//
// Two things Ted was explicit about after seeing the first pass:
//   1. Weekdays should be genuinely locked down; Saturdays should stay
//      generally available, with only a few random segments restricted —
//      not comparably restricted to weekdays.
//   2. A team's own availability and its home field's availability are
//      correlated in real life, not independent dice rolls — a director
//      wouldn't have set that field as home if the two rarely lined up.
//      "If the field is available, the team likely will be as well" (not
//      100%, but close).
// So availability is generated field-first, then team status is picked from
// a distribution conditioned on whether the team's own field is open that
// same slot, rather than two independent rolls that occasionally produce a
// team that wants to host on a day its own field is closed.

function weightedPick(weights) {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of weights) { if (r < w) return v; r -= w; }
  return weights[weights.length - 1][0];
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const SAT_SLOTS = ['early', 'midday', 'late'];

const DEFAULT_WEIGHTS = {
  fieldWeekdayOpen: [[true, 45], [false, 55]],
  fieldSaturdayOpen: [[true, 85], [false, 15]],
  // Weekday: locked down regardless of field, but a team is even less
  // likely to want to host specifically when its own field is closed.
  weekdayTeamFieldOpen: [['none', 35], ['both', 30], ['host', 20], ['travel', 15]],
  weekdayTeamFieldClosed: [['none', 45], ['travel', 35], ['both', 12], ['host', 8]],
  // Saturday: generally available (mostly 'both') when the field
  // cooperates; still not wide open, just clearly the default day.
  saturdayTeamFieldOpen: [['both', 75], ['host', 10], ['travel', 10], ['none', 5]],
  saturdayTeamFieldClosed: [['travel', 45], ['none', 35], ['both', 12], ['host', 8]],
};

// `weights` lets a caller (the fuzzer, mainly) override any subset of the
// above to explore a different point in the restrictiveness space, without
// duplicating this whole file to do it.
function randomFieldAvailability(weights) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const weekday = {};
  for (const day of WEEKDAY_NAMES) weekday[day] = weightedPick(w.fieldWeekdayOpen);
  const saturday = {};
  for (const slot of SAT_SLOTS) saturday[slot] = weightedPick(w.fieldSaturdayOpen);
  return { weekday, saturday, dates: {} };
}

function randomTeamAvailabilityFor(fieldAvailability, weights) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const weekday = {};
  for (const day of WEEKDAY_NAMES) {
    const dayWeights = fieldAvailability.weekday[day] ? w.weekdayTeamFieldOpen : w.weekdayTeamFieldClosed;
    weekday[day] = { status: weightedPick(dayWeights) };
  }
  const saturday = {};
  for (const slot of SAT_SLOTS) {
    const slotWeights = fieldAvailability.saturday[slot] ? w.saturdayTeamFieldOpen : w.saturdayTeamFieldClosed;
    saturday[slot] = weightedPick(slotWeights);
  }
  return { weekday, saturday, dates: {} };
}

// Every Saturday in a season starting on `startStr` (a Monday), for picking
// one-off date exceptions.
function seasonSaturdays(startStr, weeks) {
  const start = new Date(startStr + 'T00:00:00Z');
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + w * 7 + 5); // Monday + 5 = Saturday
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

module.exports = {
  weightedPick, randomFieldAvailability, randomTeamAvailabilityFor, seasonSaturdays,
  WEEKDAY_NAMES, SAT_SLOTS, DEFAULT_WEIGHTS,
};
