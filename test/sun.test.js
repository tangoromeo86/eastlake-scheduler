'use strict';
// Sanity checks for lib/sun.js's civil-twilight math — not pinned to exact
// clock times (no authoritative reference table to check against offline),
// but to properties any correct sunset calculation must have: later sunsets
// in summer than winter, dusk always after sunset, monotonic movement across
// the season, and a plausible clock-time range for a mid-latitude US city.
const sun = require('../lib/sun');

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  if (!ok) console.log(`  FAIL ${name}: got ${got}, want ${want}`);
}
function ok(name, cond, detail) {
  cond ? pass++ : fail++;
  if (!cond) console.log(`  FAIL ${name}${detail ? ': ' + detail : ''}`);
}

// Chardon, OH — the coordinates this project's own fixtures use.
const LAT = 41.578, LNG = -81.209, TZ = 'America/New_York';

const summerSolstice = sun.sunsetMinutesLocal('2026-06-21', LAT, LNG, TZ);
const winterSolstice = sun.sunsetMinutesLocal('2026-12-21', LAT, LNG, TZ);
const springEquinox   = sun.sunsetMinutesLocal('2026-03-20', LAT, LNG, TZ);
const fallEquinox     = sun.sunsetMinutesLocal('2026-09-22', LAT, LNG, TZ);

ok('summer solstice has the latest sunset of the year', summerSolstice > springEquinox && summerSolstice > fallEquinox && summerSolstice > winterSolstice,
   `summer=${summerSolstice} spring=${springEquinox} fall=${fallEquinox} winter=${winterSolstice}`);
ok('winter solstice has the earliest sunset of the year', winterSolstice < springEquinox && winterSolstice < fallEquinox,
   `winter=${winterSolstice}`);
ok('sunset falls in a plausible clock-time window at this latitude', summerSolstice > 20 * 60 && summerSolstice < 22 * 60 && winterSolstice > 16 * 60 && winterSolstice < 18 * 60,
   `summer=${summerSolstice} winter=${winterSolstice}`);

// Civil dusk is always after sunset, by roughly the expected margin (not an
// exact figure — varies with latitude/season, but never wildly off).
for (const date of ['2026-06-21', '2026-09-01', '2026-10-15', '2026-12-21']) {
  const ss = sun.sunsetMinutesLocal(date, LAT, LNG, TZ);
  const dusk = sun.civilDuskMinutesLocal(date, LAT, LNG, TZ);
  ok(`civil dusk is after sunset (${date})`, dusk > ss, `sunset=${ss} dusk=${dusk}`);
  ok(`civil dusk is a reasonable amount after sunset (${date})`, (dusk - ss) >= 20 && (dusk - ss) <= 40, `gap=${dusk - ss}min`);
}

// Sunset moves steadily earlier week over week through a fall season —
// exactly the trend this feature exists to react to.
const fallDates = ['2026-08-31', '2026-09-14', '2026-09-28', '2026-10-12', '2026-10-26', '2026-11-09'];
const fallSunsets = fallDates.map(d => sun.sunsetMinutesLocal(d, LAT, LNG, TZ));
let monotonic = true;
for (let i = 1; i < fallSunsets.length; i++) {
  // DST ends in this window (first Sunday of November), which jumps the
  // clock time back an hour — only enforce the downward trend within each
  // continuous DST segment, not across the jump itself.
  if (fallSunsets[i] > fallSunsets[i - 1] + 5) continue;
  if (fallSunsets[i] > fallSunsets[i - 1]) monotonic = false;
}
ok('sunset gets steadily earlier across a fall season', monotonic, fallSunsets.join(','));

// A location further north loses daylight faster into winter than one
// further south — basic astronomical fact, useful as a cross-check that
// latitude is actually wired into the math correctly.
const north = sun.sunsetMinutesLocal('2026-12-21', 45.0, LNG, TZ);
const south = sun.sunsetMinutesLocal('2026-12-21', 35.0, LNG, TZ);
ok('a more southern latitude has a later winter sunset than a more northern one', south > north, `south=${south} north=${north}`);

// ── weekdayStartTimeForField / allowedWeekdayTimesForField ──────────────────
const { weekdayStartTimeForField, allowedWeekdayTimesForField, DEFAULT_GAME_LENGTH_MINUTES } = require('../lib/scheduler');
const field = { coordinates: `${LAT},${LNG}` };

t('plenty of daylight keeps the season default kickoff', weekdayStartTimeForField('18:30', 60, field, '2026-09-01'), '18:30');

// Mid-October: civil dusk is early enough to pull the 18:30 default back,
// but there's still a legal 60-minute window before it.
const octStart = weekdayStartTimeForField('18:30', 60, field, '2026-10-15');
ok('short daylight pulls the default kickoff earlier', octStart !== null && octStart < '18:30', `got ${octStart}`);
ok('the adjusted kickoff lands on the weekday 15-minute grid', octStart === null || /:(00|15|30|45)$/.test(octStart), `got ${octStart}`);
// Oct 10 lands the adjustment exactly on a :15 boundary — proof the finer
// weekday grid is actually active, not coincidentally landing on :00/:30.
t('weekday snapping actually uses 15-minute increments, not 30', weekdayStartTimeForField('18:30', 60, field, '2026-10-10'), '18:15');

// Early November (post-DST-fallback): dark by ~17:40 here, too early for a
// 60-minute game to fit even at the earliest allowed 17:00 kickoff.
const novStart = weekdayStartTimeForField('18:30', 60, field, '2026-11-09');
t('a field/date that genuinely cannot fit the game even at the earliest bound returns null', novStart, null);

t('a field with no coordinates is unaffected (falls back to default)', weekdayStartTimeForField('18:30', 60, { coordinates: null }, '2026-12-01'), '18:30');
t('a division with no game length uses the 60-minute default', DEFAULT_GAME_LENGTH_MINUTES, 60);

const times = allowedWeekdayTimesForField(60, field, '2026-10-15');
ok('allowed weekday times narrow down (not the full unfiltered range) once daylight is short', times.length > 0 && times.length < 6, `${times.length} times: ${times.join(',')}`);
ok('every offered time actually finishes before civil dusk', times.every(tm => {
  const [h, m] = tm.split(':').map(Number);
  const dusk = sun.civilDuskMinutesLocal('2026-10-15', LAT, LNG, TZ);
  return h * 60 + m + 60 <= dusk;
}), times.join(','));

console.log(`\nsun: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
