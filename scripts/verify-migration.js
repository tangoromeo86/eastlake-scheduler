#!/usr/bin/env node
// scripts/verify-migration.js
// Dry-run verification of the field migration against live data.
// Reads season.json and schedule.json, simulates the migration, reports
// any problems WITHOUT writing anything. Safe to run on production.
//
// Usage: node scripts/verify-migration.js

const fs   = require('fs');
const path = require('path');

const ROOT          = path.join(__dirname, '..');
const SEASON_FILE   = path.join(ROOT, 'season.json');
const SCHEDULE_FILE = path.join(ROOT, 'schedule.json');

// ── Must match migrate-fields.js exactly ─────────────────────────────────────

const NEW_FIELDS = [
  { id: 'woodland-3',          name: 'Woodland',                  sub_field: 'Field #3', address: '35574 Lakeshore Blvd, Eastlake OH' },
  { id: 'woodland-6',          name: 'Woodland',                  sub_field: 'Field #6', address: '35574 Lakeshore Blvd, Eastlake OH' },
  { id: 'woodland-7',          name: 'Woodland',                  sub_field: 'Field #7', address: '35574 Lakeshore Blvd, Eastlake OH' },
  { id: 'mel-harder-u10',      name: 'Mel Harder Park',           sub_field: 'U10',      address: '12519 Chardon Windsor Rd, Chardon OH 44024' },
  { id: 'mel-harder-u12',      name: 'Mel Harder Park',           sub_field: 'U12',      address: '12519 Chardon Windsor Rd, Chardon OH 44024' },
  { id: 'newbury-oberland',    name: 'Newbury Oberland',                                 address: '14639 Auburn Rd, Newbury OH' },
  { id: 'claridon-troy',       name: 'Claridon Troy Rd',                                 address: '14259 Claridon Troy Rd, Burton OH' },
  { id: 'euclid-babbitt',      name: 'Babbitt Field',                                    address: '22550 Milton Dr, Euclid OH' },
  { id: 'euclid-pool',         name: 'Euclid Pool Field',                                address: '22450 Milton Dr, Euclid OH' },
  { id: 'euclid-shore',        name: 'Shore Field',                                      address: '22450 Chore Center Dr, Euclid OH' },
  { id: 'orlando-park',        name: 'Orlando Park',                                     address: '30100 Twin Lakes Dr, Wickliffe OH' },
  { id: 'jindra-park',         name: 'Jindra Park',                                      address: '901 Tallmadge Ave, Wickliffe OH' },
  { id: 'wickliffe-tbd',       name: 'TBD',                                              address: 'TBD' },
  { id: 'willowick-middle',    name: 'Willowick Middle',                                 address: '31500 Royalview Dr, Willowick OH' },
  { id: 'lindsey-elementary',  name: 'Lindsey Elementary',                               address: '11844 Caves Rd, West G OH' },
  { id: 'west-geauga-commons', name: 'West Geauga Commons',                              address: '14070 Chillicothe Rd, West G OH' },
  { id: 'yoder-field',         name: 'Yoder Field',                                      address: '16175 Almeda Dr, Middlefield OH 44062' },
  { id: 'shore-middle',        name: 'Shore Middle School',                              address: '5670 Hopkins Rd, Mentor OH' },
  { id: 'mcminn-park',         name: 'McMinn Park',                                      address: '5935 Andrews Rd, Mentor OH' },
  { id: 'ridge-elementary',    name: 'Ridge Elementary',                                 address: '7860 Johnnycake Ridge Rd, Mentor OH' },
  { id: 'innovation-field',    name: 'Innovation Field',                                 address: '6116 Wilson Mills Rd, Mayfield OH 44143' },
  { id: 'twin-fields',         name: 'Twin Fields',                                      address: 'Behind Mayfield High School' },
  { id: 'parkview-3',          name: 'Parkview',                  sub_field: 'Field 3',  address: '290 North Commons Blvd, Mayfield Village 44143' },
  { id: 'parkview-4',          name: 'Parkview',                  sub_field: 'Field 4',  address: '290 North Commons Blvd, Mayfield Village 44143' },
  { id: 'kirtland-community',  name: 'Kirtland Community Center',                        address: '7900 Kirtland Chardon Rd, Kirtland OH' },
  { id: 'kirtland-rec',        name: 'Kirtland Rec Park',                                address: 'Behind High School - 9150 Chillicothe Rd, Kirtland OH' },
  { id: 'dave-mitchell',       name: 'Dave Mitchell Field',                              address: '12134 Kinsman Rd, Newbury OH 44065' },
];

const ID_MAP = {
  'EAK-U10C': 'woodland-3',     'EAK-U12C': 'woodland-6',     'EAK-U15C': 'woodland-7',
  'CHR-U10C': 'mel-harder-u10', 'CHR-U10G': 'mel-harder-u10', 'CHR-U12C': 'mel-harder-u12',
  'CHR-U12G': 'mel-harder-u12', 'CHR-U15C': 'newbury-oberland',
  'BUR-U10C': 'claridon-troy',  'BUR-U10G': 'claridon-troy',  'BUR-U12C': 'claridon-troy',
  'BUR-U12G': 'claridon-troy',  'BUR-U15C': 'claridon-troy',
  'EUC-U10C': 'euclid-babbitt', 'EUC-U12C': 'euclid-pool',    'EUC-U15C': 'euclid-shore',
  'WCK-U10C': 'orlando-park',   'WCK-U12C': 'jindra-park',    'WCK-U15C': 'wickliffe-tbd',
  'WLW-U15C': 'willowick-middle',
  'WEG-U10C': 'lindsey-elementary', 'WEG-U10G': 'lindsey-elementary',
  'WEG-U12C': 'west-geauga-commons','WEG-U12G': 'west-geauga-commons','WEG-U15C': 'west-geauga-commons',
  'MID-U10C': 'yoder-field',    'MID-U10G': 'yoder-field',    'MID-U12C': 'yoder-field',
  'MID-U12G': 'yoder-field',    'MID-U15C': 'yoder-field',
  'MEN-U10G': 'shore-middle',   'MEN-U12C': 'mcminn-park',    'MEN-U12G': 'mcminn-park',
  'MEN-U15C': 'ridge-elementary',
  'MAY-U12C': 'innovation-field','MAY-U12G': 'innovation-field','MAY-U15C': 'twin-fields',
  'KRT-U10C': 'kirtland-community','KRT-U10G': 'kirtland-community','KRT-U12G': 'kirtland-rec',
  'STH-U10C': 'dave-mitchell',
};

const NEW_IDS = new Set(NEW_FIELDS.map(f => f.id));

// ── Helpers ───────────────────────────────────────────────────────────────────

let errors   = 0;
let warnings = 0;

function ok(msg)   { console.log(`  ✓  ${msg}`); }
function warn(msg) { console.warn(`  ⚠  ${msg}`); warnings++; }
function fail(msg) { console.error(`  ✗  ${msg}`); errors++; }

function remap(id) { return ID_MAP[id] || id; }

// ── Load files ────────────────────────────────────────────────────────────────

console.log('\n── Eastlake Field Migration Verification ──────────────────────────\n');

let season, sched;
try {
  season = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  ok(`Loaded season.json`);
} catch (e) {
  fail(`Cannot read season.json: ${e.message}`);
  process.exit(1);
}

const hasSchedule = fs.existsSync(SCHEDULE_FILE);
if (hasSchedule) {
  try {
    sched = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    ok(`Loaded schedule.json (${(sched.games || []).length} games)`);
  } catch (e) {
    fail(`Cannot read schedule.json: ${e.message}`);
    process.exit(1);
  }
} else {
  warn('No schedule.json found — skipping game checks');
}

// ── Check: already migrated? ──────────────────────────────────────────────────

console.log('\n── Pre-migration state check ──────────────────────────────────────\n');

const currentFields = season.fields || [];
const alreadyMigrated = currentFields.some(f => NEW_IDS.has(f.id));

if (alreadyMigrated) {
  warn('season.json already contains new field IDs — may already be migrated or partially migrated');
} else {
  ok(`season.json has ${currentFields.length} old-format fields`);
}

const currentFieldIds = new Set(currentFields.map(f => f.id));

// ── Check: every old field ID has a mapping ───────────────────────────────────

console.log('\n── ID mapping completeness ────────────────────────────────────────\n');

let mappingOk = true;
for (const f of currentFields) {
  const newId = remap(f.id);
  if (newId === f.id && !NEW_IDS.has(f.id)) {
    fail(`No mapping for field "${f.id}" (${f.name}) — would be left unmapped after migration`);
    mappingOk = false;
  } else {
    ok(`${f.id} → ${newId}`);
  }
}
if (mappingOk && !alreadyMigrated) ok('All old field IDs have a mapping');

// ── Check: every new ID in mappings exists in NEW_FIELDS ─────────────────────

console.log('\n── New ID validity ────────────────────────────────────────────────\n');

const usedNewIds = new Set(Object.values(ID_MAP));
for (const newId of usedNewIds) {
  if (!NEW_IDS.has(newId)) {
    fail(`ID_MAP references "${newId}" which is NOT in NEW_FIELDS`);
  }
}
ok(`All mapped-to IDs exist in the new field directory`);

// ── Check: teams ──────────────────────────────────────────────────────────────

console.log('\n── Team home field references ─────────────────────────────────────\n');

const teams = season.teams || [];
ok(`${teams.length} teams found`);

let teamProblems = 0;
for (const t of teams) {
  const oldId = t.home_field_id;
  if (!oldId) {
    warn(`Team ${t.id} (${t.label}) has no home_field_id`);
    continue;
  }
  const newId = remap(oldId);
  if (!NEW_IDS.has(newId)) {
    fail(`Team ${t.id} (${t.label}): home_field_id "${oldId}" → "${newId}" NOT in new directory`);
    teamProblems++;
  }
}
if (!teamProblems) ok(`All ${teams.length} teams map to valid new field IDs`);

// ── Check: games ──────────────────────────────────────────────────────────────

if (sched) {
  console.log('\n── Game field references ──────────────────────────────────────────\n');

  const games = sched.games || [];
  ok(`${games.length} games found`);

  const unmappedGameFields = new Map(); // oldId → count
  let gameProblems = 0;

  for (const g of games) {
    const oldId = String(g.field_id);
    const newId = remap(oldId);
    if (!NEW_IDS.has(newId)) {
      unmappedGameFields.set(oldId, (unmappedGameFields.get(oldId) || 0) + 1);
      gameProblems++;
    }
  }

  if (gameProblems) {
    for (const [id, count] of unmappedGameFields) {
      fail(`Game field_id "${id}" has no valid mapping — affects ${count} game(s)`);
    }
  } else {
    ok(`All ${games.length} game field_ids map to valid new field IDs`);
  }

  // Verify field_name + field_address are intact (not blank)
  const blankName    = games.filter(g => !g.field_name).length;
  const blankAddress = games.filter(g => !g.field_address).length;
  if (blankName)    warn(`${blankName} games have no field_name`);
  else              ok('All games have a field_name');
  if (blankAddress) warn(`${blankAddress} games have no field_address`);
  else              ok('All games have a field_address');

  // Count: games by division
  const byDiv = {};
  for (const g of games) byDiv[g.division_id] = (byDiv[g.division_id] || 0) + 1;
  console.log('\n  Game counts by division (will be unchanged after migration):');
  for (const [div, count] of Object.entries(byDiv)) {
    console.log(`    ${div}: ${count} games`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n── Summary ────────────────────────────────────────────────────────\n');
console.log(`  Errors:   ${errors}`);
console.log(`  Warnings: ${warnings}`);

if (errors === 0 && warnings === 0) {
  console.log('\n  ✅ All checks passed. Safe to run migrate-fields.js on this data.\n');
  process.exit(0);
} else if (errors === 0) {
  console.log('\n  ⚠️  No errors, but review warnings above before migrating.\n');
  process.exit(0);
} else {
  console.log('\n  ❌ Errors found. Do NOT migrate until these are resolved.\n');
  process.exit(1);
}
