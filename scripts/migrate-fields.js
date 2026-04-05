#!/usr/bin/env node
// scripts/migrate-fields.js
// Migrates season.json and schedule.json to the new standalone fields directory.
// Run on the server: node scripts/migrate-fields.js
// Safe to run multiple times (idempotent — skips if already migrated).

const fs   = require('fs');
const path = require('path');

const ROOT          = path.join(__dirname, '..');
const SEASON_FILE   = path.join(ROOT, 'season.json');
const SCHEDULE_FILE = path.join(ROOT, 'schedule.json');

// ── New field directory ───────────────────────────────────────────────────────

const NEW_FIELDS = [
  { id: 'woodland-3',         name: 'Woodland',                  sub_field: 'Field #3', address: '35574 Lakeshore Blvd, Eastlake OH' },
  { id: 'woodland-6',         name: 'Woodland',                  sub_field: 'Field #6', address: '35574 Lakeshore Blvd, Eastlake OH' },
  { id: 'woodland-7',         name: 'Woodland',                  sub_field: 'Field #7', address: '35574 Lakeshore Blvd, Eastlake OH' },
  { id: 'mel-harder-u10',     name: 'Mel Harder Park',           sub_field: 'U10',      address: '12519 Chardon Windsor Rd, Chardon OH 44024' },
  { id: 'mel-harder-u12',     name: 'Mel Harder Park',           sub_field: 'U12',      address: '12519 Chardon Windsor Rd, Chardon OH 44024' },
  { id: 'newbury-oberland',   name: 'Newbury Oberland',                                 address: '14639 Auburn Rd, Newbury OH' },
  { id: 'claridon-troy',      name: 'Claridon Troy Rd',                                 address: '14259 Claridon Troy Rd, Burton OH' },
  { id: 'euclid-babbitt',     name: 'Babbitt Field',                                    address: '22550 Milton Dr, Euclid OH' },
  { id: 'euclid-pool',        name: 'Euclid Pool Field',                                address: '22450 Milton Dr, Euclid OH' },
  { id: 'euclid-shore',       name: 'Shore Field',                                      address: '22450 Chore Center Dr, Euclid OH' },
  { id: 'orlando-park',       name: 'Orlando Park',                                     address: '30100 Twin Lakes Dr, Wickliffe OH' },
  { id: 'jindra-park',        name: 'Jindra Park',                                      address: '901 Tallmadge Ave, Wickliffe OH' },
  { id: 'wickliffe-tbd',      name: 'TBD',                                              address: 'TBD' },
  { id: 'willowick-middle',   name: 'Willowick Middle',                                 address: '31500 Royalview Dr, Willowick OH' },
  { id: 'lindsey-elementary', name: 'Lindsey Elementary',                               address: '11844 Caves Rd, West G OH' },
  { id: 'west-geauga-commons',name: 'West Geauga Commons',                              address: '14070 Chillicothe Rd, West G OH' },
  { id: 'yoder-field',        name: 'Yoder Field',                                      address: '16175 Almeda Dr, Middlefield OH 44062' },
  { id: 'shore-middle',       name: 'Shore Middle School',                              address: '5670 Hopkins Rd, Mentor OH' },
  { id: 'mcminn-park',        name: 'McMinn Park',                                      address: '5935 Andrews Rd, Mentor OH' },
  { id: 'ridge-elementary',   name: 'Ridge Elementary',                                 address: '7860 Johnnycake Ridge Rd, Mentor OH' },
  { id: 'innovation-field',   name: 'Innovation Field',                                 address: '6116 Wilson Mills Rd, Mayfield OH 44143' },
  { id: 'twin-fields',        name: 'Twin Fields',                                      address: 'Behind Mayfield High School' },
  { id: 'parkview-3',         name: 'Parkview',                  sub_field: 'Field 3',  address: '290 North Commons Blvd, Mayfield Village 44143' },
  { id: 'parkview-4',         name: 'Parkview',                  sub_field: 'Field 4',  address: '290 North Commons Blvd, Mayfield Village 44143' },
  { id: 'kirtland-community', name: 'Kirtland Community Center',                        address: '7900 Kirtland Chardon Rd, Kirtland OH' },
  { id: 'kirtland-rec',       name: 'Kirtland Rec Park',                                address: 'Behind High School - 9150 Chillicothe Rd, Kirtland OH' },
  { id: 'dave-mitchell',      name: 'Dave Mitchell Field',                              address: '12134 Kinsman Rd, Newbury OH 44065' },
];

// ── Old ID → New ID map ───────────────────────────────────────────────────────

const ID_MAP = {
  'EAK-U10C': 'woodland-3',
  'EAK-U12C': 'woodland-6',
  'EAK-U15C': 'woodland-7',
  'CHR-U10C': 'mel-harder-u10',
  'CHR-U10G': 'mel-harder-u10',
  'CHR-U12C': 'mel-harder-u12',
  'CHR-U12G': 'mel-harder-u12',
  'CHR-U15C': 'newbury-oberland',
  'BUR-U10C': 'claridon-troy',
  'BUR-U10G': 'claridon-troy',
  'BUR-U12C': 'claridon-troy',
  'BUR-U12G': 'claridon-troy',
  'BUR-U15C': 'claridon-troy',
  'EUC-U10C': 'euclid-babbitt',
  'EUC-U12C': 'euclid-pool',
  'EUC-U15C': 'euclid-shore',
  'WCK-U10C': 'orlando-park',
  'WCK-U12C': 'jindra-park',
  'WCK-U15C': 'wickliffe-tbd',
  'WLW-U15C': 'willowick-middle',
  'WEG-U10C': 'lindsey-elementary',
  'WEG-U10G': 'lindsey-elementary',
  'WEG-U12C': 'west-geauga-commons',
  'WEG-U12G': 'west-geauga-commons',
  'WEG-U15C': 'west-geauga-commons',
  'MID-U10C': 'yoder-field',
  'MID-U10G': 'yoder-field',
  'MID-U12C': 'yoder-field',
  'MID-U12G': 'yoder-field',
  'MID-U15C': 'yoder-field',
  'MEN-U10G': 'shore-middle',
  'MEN-U12C': 'mcminn-park',
  'MEN-U12G': 'mcminn-park',
  'MEN-U15C': 'ridge-elementary',
  'MAY-U12C': 'innovation-field',
  'MAY-U12G': 'innovation-field',
  'MAY-U15C': 'twin-fields',
  'KRT-U10C': 'kirtland-community',
  'KRT-U10G': 'kirtland-community',
  'KRT-U12G': 'kirtland-rec',
  'STH-U10C': 'dave-mitchell',
};

function remap(id) {
  return ID_MAP[id] || id;
}

function displayName(f) {
  return f.sub_field ? `${f.name} – ${f.sub_field}` : f.name;
}

// ── Migrate season.json ───────────────────────────────────────────────────────

const season = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));

// Idempotency check: if the first field already has sub_field or matches a new ID, skip
const alreadyMigrated = (season.fields || []).some(f => NEW_FIELDS.find(n => n.id === f.id));
if (alreadyMigrated) {
  console.log('season.json appears already migrated (new field IDs found). Skipping season.json update.');
} else {
  const backup = SEASON_FILE.replace('.json', `.backup-premigration-${Date.now()}.json`);
  fs.copyFileSync(SEASON_FILE, backup);
  console.log(`Backed up season.json → ${path.basename(backup)}`);

  // Replace fields array
  season.fields = NEW_FIELDS;

  // Update team home_field_id and remove home_field_saturday_id
  let teamUpdates = 0;
  for (const team of (season.teams || [])) {
    const oldId  = team.home_field_id;
    const newId  = remap(oldId);
    if (newId !== oldId) {
      console.log(`  Team ${team.id} (${team.label}): home_field_id ${oldId} → ${newId}`);
      team.home_field_id = newId;
      teamUpdates++;
    }
    if (team.home_field_saturday_id !== undefined) {
      delete team.home_field_saturday_id;
    }
  }

  fs.writeFileSync(SEASON_FILE, JSON.stringify(season, null, 2));
  console.log(`season.json updated: ${NEW_FIELDS.length} fields, ${teamUpdates} team home_field_id remaps`);
}

// ── Migrate schedule.json ─────────────────────────────────────────────────────

if (!fs.existsSync(SCHEDULE_FILE)) {
  console.log('No schedule.json found — skipping.');
  process.exit(0);
}

const sched = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
const alreadyMigratedSched = (sched.games || []).some(g => NEW_FIELDS.find(f => f.id === g.field_id));

if (alreadyMigratedSched) {
  console.log('schedule.json appears already migrated. Skipping.');
} else {
  const backup2 = SCHEDULE_FILE.replace('.json', `.backup-premigration-${Date.now()}.json`);
  fs.copyFileSync(SCHEDULE_FILE, backup2);
  console.log(`Backed up schedule.json → ${path.basename(backup2)}`);

  let gameUpdates = 0;
  const unmapped = new Set();
  for (const game of (sched.games || [])) {
    const oldId = game.field_id;
    const newId = remap(String(oldId));
    if (newId !== String(oldId)) {
      game.field_id = newId;
      gameUpdates++;
    } else if (!NEW_FIELDS.find(f => f.id === oldId)) {
      unmapped.add(oldId);
    }
    // field_name and field_address are intentionally left as-is
  }

  if (unmapped.size) {
    console.warn(`  WARNING: ${unmapped.size} field_id(s) in schedule not in ID_MAP:`, [...unmapped]);
  }

  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(sched, null, 2));
  console.log(`schedule.json updated: ${gameUpdates} game field_id remaps`);
}

console.log('\nMigration complete.');
