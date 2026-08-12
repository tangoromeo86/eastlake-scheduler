'use strict';

// Driving-distance matrix between fields, via OSRM's public routing server —
// the same no-key/no-billing philosophy as the existing Nominatim geocoding
// in server.js (Ted, 2026-08-13: wanted driving distance instead of
// straight-line, without adding a paid API/key to manage).
//
// This deliberately never runs per-game. The scheduler evaluates travel
// distance thousands of times in a single run (100 shuffle attempts x 12
// substitution rounds x every matchup), so a live routing call per lookup
// would be far too slow. Fields don't move, so instead: fetch the WHOLE
// field-to-field matrix in one OSRM /table request, cache it to disk, and
// only ever refresh it when a field's location actually changes. Everything
// that needs a distance (scheduler, stats pages, reports) reads the cache
// and falls back to straight-line for any pair that isn't in it yet.

const OSRM_TABLE_URL = 'https://router.project-osrm.org/table/v1/driving/';
const OSRM_TIMEOUT_MS = 20000;
const METERS_PER_MILE = 1609.344;

function parseCoordinates(str) {
  if (!str) return null;
  const parts = String(str).split(',').map(s => parseFloat(s.trim()));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return { lat: parts[0], lng: parts[1] };
}

// Canonical, order-independent key for a field pair — mirrors scheduler.js's
// teamPairKey convention exactly, so a lookup never has to know or care
// which field was "home" vs "away" when the cache was built.
function fieldPairKey(idA, idB) {
  const [x, y] = [String(idA), String(idB)].sort();
  return `${x}|${y}`;
}

// Fetches the full driving-distance matrix for every field with valid
// coordinates, in a single OSRM /table request. Returns
// `{ ok: true, pairs: {key: miles}, skipped: [fieldId, ...] }` on success —
// `skipped` lists fields left out for lacking usable coordinates, not an
// error. Returns `{ ok: false, reason }` on any failure (timeout, network,
// malformed response) — callers must treat that as "OSRM unavailable right
// now" and keep whatever cache they already have, never wipe it out over a
// transient failure. `fetchImpl` is injectable so tests never make a real
// network call.
async function fetchDrivingDistanceMatrix(fields, fetchImpl = fetch) {
  const withCoords = [];
  const skipped = [];
  for (const f of (fields || [])) {
    const coords = parseCoordinates(f.coordinates);
    if (coords) withCoords.push({ id: f.id, coords });
    else skipped.push(f.id);
  }
  if (withCoords.length < 2) return { ok: true, pairs: {}, skipped };

  const coordStr = withCoords.map(f => `${f.coords.lng},${f.coords.lat}`).join(';');
  const url = `${OSRM_TABLE_URL}${coordStr}?annotations=distance`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OSRM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, reason: `OSRM returned HTTP ${res.status}` };
    const data = await res.json();
    if (!data || data.code !== 'Ok' || !Array.isArray(data.distances)) {
      return { ok: false, reason: (data && data.message) || 'OSRM returned an unexpected response' };
    }
    const pairs = {};
    for (let i = 0; i < withCoords.length; i++) {
      for (let j = i + 1; j < withCoords.length; j++) {
        const meters = data.distances?.[i]?.[j];
        if (Number.isFinite(meters)) {
          pairs[fieldPairKey(withCoords[i].id, withCoords[j].id)] = meters / METERS_PER_MILE;
        }
      }
    }
    return { ok: true, pairs, skipped };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'OSRM request timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Single source of truth for "what's the distance between these two
// fields": prefer a cached driving distance, fall back to straight-line
// (Haversine) when the pair isn't cached — a brand new field, or the cache
// hasn't been generated yet. Never returns null just because driving data
// is missing; only when neither field has usable coordinates at all, same
// as the straight-line-only behavior this replaces.
function distanceMilesFor(fieldA, fieldB, cache) {
  if (!fieldA || !fieldB) return null;
  const cached = cache && cache.pairs && cache.pairs[fieldPairKey(fieldA.id, fieldB.id)];
  if (Number.isFinite(cached)) return cached;

  const a = parseCoordinates(fieldA.coordinates);
  const b = parseCoordinates(fieldB.coordinates);
  if (!a || !b) return null;
  const R = 3958.8;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const sinLat = Math.sin(dLat / 2), sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

module.exports = { fieldPairKey, parseCoordinates, fetchDrivingDistanceMatrix, distanceMilesFor };
