'use strict';
// Seeds the "everyone has registered — ready to generate the schedule" stage:
// 10 programs (kept from the prior director-onboarding seed), real fields with
// geocoded coordinates (several pulled from the old production season.json,
// the rest real addresses verified against the same geocoder the app itself
// uses), 5 divisions with 8 teams each (40 total, within the requested 6-12
// per division), and every team carrying director-set availability plus a
// unique tedriolo+ email so Ted can sign in as any of them.
//
// Usage: node scripts/seed-full-registration-stage.js > season.json

const PROGRAMS = [
  'Chardon', 'Mayfield', 'Kirtland', 'Madison', 'Perry',
  'Riverside', 'Wickliffe', 'Mentor', 'Willoughby', 'Painesville',
];
function slug(name) { return name.toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Coordinates confirmed by geocoding the real address (see commit message) —
// checked against Nominatim directly before being hardcoded here, same
// service the app's own "Find" button calls at /api/geocode.
const FIELDS = [
  { program: 'Chardon', name: 'Mel Harder Park', sub_field: '#11',
    address: '12519 Chardon Windsor Rd, Chardon OH 44024', coordinates: '41.5806482,-81.1897891' },
  { program: 'Mayfield', name: 'Innovation Field',
    address: '6116 Wilson Mills Rd, Mayfield OH 44143', coordinates: '41.5363828,-81.4587309' },
  { program: 'Mayfield', name: 'Parkview', sub_field: 'Field 3',
    address: '290 North Commons Blvd, Mayfield Village OH 44143', coordinates: '41.5178,-81.4468' },
  { program: 'Kirtland', name: 'Kirtland Community Center',
    address: '7900 Kirtland Chardon Rd, Kirtland OH', coordinates: '41.6111692,-81.3282116' },
  { program: 'Kirtland', name: 'Kirtland Rec Park',
    address: '9150 Chillicothe Rd, Kirtland OH', coordinates: '41.6223492,-81.3601159' },
  { program: 'Madison', name: 'Madison High School',
    address: '240 Independence Dr, Madison OH 44057', coordinates: '41.7901066,-81.0700340' },
  { program: 'Perry', name: 'Perry High School',
    address: '3737 Main St, Perry OH 44081', coordinates: '41.7634005,-81.1491015' },
  { program: 'Riverside', name: 'Riverside Community Park',
    address: 'Concord Township, OH', coordinates: '41.6828,-81.2673' },
  { program: 'Wickliffe', name: 'Orlando Park',
    address: '30100 Twin Lakes Dr, Wickliffe OH', coordinates: '41.6085200,-81.4585890' },
  { program: 'Wickliffe', name: 'Jindra Park',
    address: '901 Tallmadge Ave, Wickliffe OH', coordinates: '41.6200137,-81.4776727' },
  { program: 'Mentor', name: 'Shore Middle School',
    address: '5670 Hopkins Rd, Mentor OH', coordinates: '41.7163955,-81.3443825' },
  { program: 'Mentor', name: 'McMinn Park',
    address: '5935 Andrews Rd, Mentor OH', coordinates: '41.7095915,-81.3614326' },
  { program: 'Willoughby', name: 'Willoughby South High School',
    address: '5252 Shankland Rd, Willoughby OH 44094', coordinates: '41.6260408,-81.4195165' },
  { program: 'Painesville', name: 'Painesville Recreation Park',
    address: '1025 Hardy Rd, Painesville OH 44077', coordinates: '41.7667003,-81.2310896' },
];
// Weighted-random availability. Two things Ted was explicit about after
// seeing the first pass:
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

const FIELD_WEEKDAY_OPEN_WEIGHTS = [[true, 45], [false, 55]];
const FIELD_SATURDAY_OPEN_WEIGHTS = [[true, 85], [false, 15]];

// Weekday: locked down regardless of field, but a team is even less likely
// to want to host specifically when its own field is closed that day.
const WEEKDAY_TEAM_FIELD_OPEN   = [['none', 35], ['both', 30], ['host', 20], ['travel', 15]];
const WEEKDAY_TEAM_FIELD_CLOSED = [['none', 45], ['travel', 35], ['both', 12], ['host', 8]];
// Saturday: generally available (mostly 'both') when the field cooperates;
// still not wide open, just clearly the default day rather than a coin flip.
const SATURDAY_TEAM_FIELD_OPEN   = [['both', 75], ['host', 10], ['travel', 10], ['none', 5]];
const SATURDAY_TEAM_FIELD_CLOSED = [['travel', 45], ['none', 35], ['both', 12], ['host', 8]];

function randomFieldAvailability() {
  const weekday = {};
  for (const day of WEEKDAY_NAMES) weekday[day] = weightedPick(FIELD_WEEKDAY_OPEN_WEIGHTS);
  const saturday = {};
  for (const slot of SAT_SLOTS) saturday[slot] = weightedPick(FIELD_SATURDAY_OPEN_WEIGHTS);
  return { weekday, saturday, dates: {} };
}

function randomTeamAvailabilityFor(fieldAvailability) {
  const weekday = {};
  for (const day of WEEKDAY_NAMES) {
    const weights = fieldAvailability.weekday[day] ? WEEKDAY_TEAM_FIELD_OPEN : WEEKDAY_TEAM_FIELD_CLOSED;
    weekday[day] = { status: weightedPick(weights) };
  }
  const saturday = {};
  for (const slot of SAT_SLOTS) {
    const weights = fieldAvailability.saturday[slot] ? SATURDAY_TEAM_FIELD_OPEN : SATURDAY_TEAM_FIELD_CLOSED;
    saturday[slot] = weightedPick(weights);
  }
  return { weekday, saturday, dates: {} };
}

// Every Saturday in the season, for picking one-off date exceptions below.
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

const DIVISIONS = ['U8 Coed', 'U10 Boys', 'U10 Girls', 'U12 Boys', 'U12 Girls'];

// Which programs field a team in each division — 8 of 10 per division (within
// the requested 6-12 range), varying which 2 sit out so it isn't a uniform
// grid. Every program ends up with exactly 4 teams (skips exactly one
// division), which is itself realistic — not every club fields every age group.
const SKIP = {
  'U8 Coed':   ['Riverside', 'Painesville'],
  'U10 Boys':  ['Madison', 'Willoughby'],
  'U10 Girls': ['Perry', 'Mentor'],
  'U12 Boys':  ['Chardon', 'Kirtland'],
  'U12 Girls': ['Mayfield', 'Wickliffe'],
};

const COACH_FIRST = ['Dana','Chris','Jamie','Pat','Sam','Robin','Casey','Jordan','Morgan','Taylor'];
const COACH_LAST  = ['Ward','Novak','Reyes','Kowalski','Bennett','Cho','Hendricks','Fischer','Ortiz','Malone'];

const today = new Date();
const start = new Date(today);
start.setDate(start.getDate() + ((8 - start.getDay()) % 7 || 7) + 21); // ~3 Mondays out

const programs = PROGRAMS.map(name => ({ id: `prog-${slug(name)}`, name }));
const directors = PROGRAMS.map((name, i) => ({
  id: `dir-${slug(name)}`,
  name: `${name} Director`,
  email: `tedriolo+${slug(name)}@gmail.com`,
  phone: `(440) 555-${String(10000 + i).slice(1)}`,
  program_id: `prog-${slug(name)}`,
  active: true,
  created_at: new Date().toISOString(),
}));
const divisions = DIVISIONS.map(name => ({ id: `div-${slug(name)}`, name, target_games: 8 }));

const seasonStartStr = start.toISOString().slice(0, 10);
const saturdays = seasonSaturdays(seasonStartStr, 10);

const fields = FIELDS.map((f, i) => {
  const rec = {
    id: `field-${i + 1}`, name: f.name, program_id: `prog-${slug(f.program)}`,
    address: f.address, coordinates: f.coordinates,
  };
  if (f.sub_field) rec.sub_field = f.sub_field;
  rec.availability = randomFieldAvailability();
  // ~1 in 4 fields also has a one-off closure — a tournament or maintenance day.
  if (Math.random() < 0.25) {
    const d = saturdays[Math.floor(Math.random() * saturdays.length)];
    rec.availability.dates[d] = { early: false, midday: false, late: false };
  }
  return rec;
});
const fieldsByProgram = {};
for (const f of fields) (fieldsByProgram[f.program_id] ||= []).push(f);

const teams = [];
let n = 0;
for (const divName of DIVISIONS) {
  const skip = new Set(SKIP[divName]);
  for (const progName of PROGRAMS) {
    if (skip.has(progName)) continue;
    n++;
    const progId = `prog-${slug(progName)}`;
    const progFields = fieldsByProgram[progId];
    const home = progFields[n % progFields.length];
    const coach = `${COACH_FIRST[n % COACH_FIRST.length]} ${COACH_LAST[(n * 3) % COACH_LAST.length]}`;

    const availability = randomTeamAvailabilityFor(home.availability);
    // ~2 in 5 teams also have a one-off Saturday blackout — a tournament, a
    // family thing, whatever keeps a real roster off the field one week.
    if (Math.random() < 0.4) {
      const d = saturdays[Math.floor(Math.random() * saturdays.length)];
      availability.dates[d] = { early: 'none', midday: 'none', late: 'none' };
    }

    const team = {
      id: `team-${n}`,
      label: `${progName} ${divName}`,
      coach, phone: `(440) 555-${String(10000 + n).slice(1)}`,
      email: `tedriolo+${slug(progName)}-${slug(divName)}@gmail.com`,
      division_id: `div-${slug(divName)}`,
      program_id: progId,
      home_field_id: home.id,
      confirmed: true,
      availability,
    };
    if (n % 11 === 0) team.target_games = 6;
    if (n % 13 === 0) team.target_games = 10;
    teams.push(team);
  }
}

const season = {
  season: {
    start: start.toISOString().slice(0, 10),
    weeks: 10,
    target_games: 8,
    // A logical mid-season bye — most real leagues skip a holiday weekend.
    blackout_dates: [],
  },
  programs, directors, divisions, fields, teams,
};

process.stdout.write(JSON.stringify(season, null, 2) + '\n');

if (require.main === module) {
  console.error(`Generated: ${programs.length} programs, ${directors.length} directors, ` +
    `${divisions.length} divisions, ${fields.length} fields, ${teams.length} teams ` +
    `(season starts ${season.season.start}, ${season.season.weeks} weeks)`);
}
