'use strict';
// Unit tests for lib/driving-distance.js. Deliberately network-free — every
// OSRM call goes through an injected fake `fetchImpl`, so this suite runs
// the same offline as every other test here, with no dependency on the
// public OSRM server being up or reachable from CI.

const { fieldPairKey, distanceMilesFor, fetchDrivingDistanceMatrix } = require('../lib/driving-distance');

let pass = 0, fail = 0;
const ok  = (name, extra) => { pass++; console.log(`  PASS: ${name}${extra ? ` (${extra})` : ''}`); };
const bad = (name, why)   => { fail++; console.log(`  ** FAIL: ${name} — ${why}`); };

function testFieldPairKey() {
  const k1 = fieldPairKey('field-a', 'field-b');
  const k2 = fieldPairKey('field-b', 'field-a');
  k1 === k2
    ? ok('fieldPairKey is order-independent')
    : bad('fieldPairKey depends on argument order', `${k1} vs ${k2}`);
}

function testDistanceMilesFor() {
  const fieldA = { id: 'f-a', coordinates: '41.60,-81.40' };
  const fieldB = { id: 'f-b', coordinates: '41.70,-81.50' };
  const cache = { pairs: { [fieldPairKey('f-a', 'f-b')]: 12.34 } };

  distanceMilesFor(fieldA, fieldB, cache) === 12.34
    ? ok('a cached driving distance is used when present')
    : bad('cached distance was not preferred', distanceMilesFor(fieldA, fieldB, cache));

  distanceMilesFor(fieldB, fieldA, cache) === 12.34
    ? ok('the cache lookup is order-independent for the caller too')
    : bad('reversed argument order missed the cache', distanceMilesFor(fieldB, fieldA, cache));

  const straightLine = distanceMilesFor(fieldA, fieldB, null);
  (straightLine !== null && Math.abs(straightLine - 8.4) < 1)
    ? ok('falls back to straight-line (Haversine) when no cache is given', `${straightLine.toFixed(2)} mi`)
    : bad('straight-line fallback looks wrong', straightLine);

  const emptyCache = { pairs: {} };
  const fallbackWithCache = distanceMilesFor(fieldA, fieldB, emptyCache);
  Math.abs(fallbackWithCache - straightLine) < 0.001
    ? ok('an uncached pair falls back to straight-line even when a cache object exists')
    : bad('uncached pair did not fall back correctly', fallbackWithCache);

  distanceMilesFor(null, fieldB, cache) === null
    ? ok('a missing field returns null rather than throwing')
    : bad('missing field did not return null', distanceMilesFor(null, fieldB, cache));

  const noCoords = { id: 'f-c' };
  distanceMilesFor(fieldA, noCoords, null) === null
    ? ok('a field with no coordinates and no cache entry returns null')
    : bad('should have returned null with no coordinates and no cache', distanceMilesFor(fieldA, noCoords, null));
}

async function testFetchSuccessPath() {
  const fields = [
    { id: 'f-1', coordinates: '41.60,-81.40' },
    { id: 'f-2', coordinates: '41.70,-81.50' },
    { id: 'f-3', coordinates: '41.55,-81.30' },
    { id: 'f-no-coords', coordinates: '' },
  ];
  // OSRM's /table response: a square matrix of meters, diagonal is 0.
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      code: 'Ok',
      distances: [
        [0, 16093.4, 8046.7],
        [16093.4, 0, 24140.2],
        [8046.7, 24140.2, 0],
      ],
    }),
  });

  const result = await fetchDrivingDistanceMatrix(fields, fakeFetch);

  (result.ok && result.skipped.length === 1 && result.skipped[0] === 'f-no-coords')
    ? ok('a field with no coordinates is skipped, not sent to OSRM, and reported back')
    : bad('coordinate-less field handling is wrong', JSON.stringify(result));

  const d12 = result.pairs[fieldPairKey('f-1', 'f-2')];
  (d12 !== undefined && Math.abs(d12 - 10) < 0.01)
    ? ok('meters from OSRM are converted to miles correctly', `${d12} mi`)
    : bad('mile conversion looks wrong', d12);

  const pairCount = Object.keys(result.pairs).length;
  pairCount === 3
    ? ok('every unique pair among the coordinate-bearing fields is present exactly once', `${pairCount} pairs`)
    : bad('wrong number of pairs in the result', pairCount);
}

async function testFetchFailurePaths() {
  const fields = [
    { id: 'f-1', coordinates: '41.60,-81.40' },
    { id: 'f-2', coordinates: '41.70,-81.50' },
  ];

  const httpError = async () => ({ ok: false, status: 503 });
  const r1 = await fetchDrivingDistanceMatrix(fields, httpError);
  (r1.ok === false && typeof r1.reason === 'string')
    ? ok('a non-200 OSRM response is reported as a failure, not thrown')
    : bad('HTTP error path did not degrade gracefully', JSON.stringify(r1));

  const badBody = async () => ({ ok: true, json: async () => ({ code: 'InvalidUrl' }) });
  const r2 = await fetchDrivingDistanceMatrix(fields, badBody);
  r2.ok === false
    ? ok('a malformed/error OSRM body is reported as a failure, not thrown')
    : bad('malformed body was not caught', JSON.stringify(r2));

  const throws = async () => { throw new Error('network unreachable'); };
  const r3 = await fetchDrivingDistanceMatrix(fields, throws);
  (r3.ok === false && r3.reason.includes('network unreachable'))
    ? ok('a thrown network error is caught and reported, not propagated')
    : bad('thrown error was not caught', JSON.stringify(r3));

  const tooFewFields = await fetchDrivingDistanceMatrix(
    [fields[0]], async () => { throw new Error('should never be called'); }
  );
  (tooFewFields.ok === true && Object.keys(tooFewFields.pairs).length === 0)
    ? ok('fewer than 2 usable fields short-circuits without ever calling OSRM')
    : bad('single-field case should short-circuit cleanly', JSON.stringify(tooFewFields));
}

(async () => {
  testFieldPairKey();
  testDistanceMilesFor();
  await testFetchSuccessPath();
  await testFetchFailurePaths();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
