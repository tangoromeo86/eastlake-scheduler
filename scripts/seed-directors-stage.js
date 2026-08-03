'use strict';
// Seeds the "admin has just finished onboarding" stage: season config, 10
// programs, 5 divisions, and one director per program — no teams, no fields,
// nothing scheduled. This is the state right after e2e.sh STEP 1-2, meant to
// be a starting point Ted plays forward from himself rather than a finished
// fixture.
//
// Directors use plus-addressed emails (tedriolo+<program>@gmail.com) so every
// magic-link email actually lands in Ted's real inbox — he can sign in as any
// "director" just by using that address at /login.
//
// Usage: node scripts/seed-directors-stage.js > season.json

const PROGRAMS = [
  'Chardon', 'Mayfield', 'Kirtland', 'Madison', 'Perry',
  'Riverside', 'Wickliffe', 'Mentor', 'Willoughby', 'Painesville',
];

const DIVISIONS = ['U8 Coed', 'U10 Boys', 'U10 Girls', 'U12 Boys', 'U12 Girls'];

function slug(name) { return name.toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Season starts about 5 weeks out so the 7-day change-request window and the
// multi-round negotiation deadlines are both exercisable right away.
const today = new Date();
const start = new Date(today);
start.setDate(start.getDate() + ((8 - start.getDay()) % 7 || 7) + 28);

const programs = PROGRAMS.map((name, i) => ({ id: `prog-${slug(name)}`, name }));

const directors = PROGRAMS.map((name, i) => ({
  id: `dir-${slug(name)}`,
  name: `${name} Director`,
  email: `tedriolo+${slug(name)}@gmail.com`,
  phone: `(440) 555-${String(1000 + i).slice(1)}`,
  program_id: `prog-${slug(name)}`,
  active: true,
  created_at: new Date().toISOString(),
}));

const divisions = DIVISIONS.map((name, i) => ({
  id: `div-${slug(name)}`,
  name,
  target_games: 8,
}));

const season = {
  season: {
    start: start.toISOString().slice(0, 10),
    weeks: 12,
    target_games: 8,
    blackout_dates: [],
  },
  programs,
  directors,
  divisions,
  fields: [],
  teams: [],
};

process.stdout.write(JSON.stringify(season, null, 2) + '\n');
