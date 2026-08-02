'use strict';
// Shared input validation, used by every write route in server.js.
//
// The rule here is that bad input gets rejected with a message explaining how to
// fix it, rather than being silently coerced into something plausible. Several
// of these exist because the coercing version caused real, quiet breakage:
// an unvalidated coach email produced a team nobody could contact, and an
// unparseable coordinate string turned travel balancing off for that field
// without telling anyone.

// Deliberately permissive — this is a typo check, not an RFC 5322 parser. It
// catches the mistakes that actually happen (missing @, missing dot, trailing
// comma, a pasted "Name <addr>") without rejecting valid unusual addresses.
const EMAIL_RE = /^[^\s@,;<>()[\]\\]+@[^\s@,;<>()[\]\\]+\.[a-z]{2,}$/i;

function cleanEmail(v) {
  return String(v == null ? '' : v).toLowerCase().trim();
}

// Returns { ok: true, value } or { ok: false, error }.
function validateEmail(raw, { required = true, label = 'Email' } = {}) {
  const value = cleanEmail(raw);
  if (!value) {
    return required ? { ok: false, error: `${label} is required` } : { ok: true, value: '' };
  }
  if (!EMAIL_RE.test(value)) {
    return { ok: false, error: `"${raw}" doesn't look like an email address. Check for a missing @ or a typo in the domain.` };
  }
  return { ok: true, value };
}

// Phones are stored as digits-with-formatting, but we normalise to a consistent
// display form so the "call the other coach" path inside 7 days shows something
// tappable rather than whatever each director happened to type.
function validatePhone(raw, { required = false, label = 'Phone' } = {}) {
  const trimmed = String(raw == null ? '' : raw).trim();
  if (!trimmed) {
    return required ? { ok: false, error: `${label} is required` } : { ok: true, value: '' };
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) {
    return { ok: true, value: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` };
  }
  if (digits.length === 11 && digits[0] === '1') {
    return { ok: true, value: `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}` };
  }
  // Anything else passes through as typed. Deliberately never rejected: phone
  // numbers legitimately vary (extensions, international, a desk line with no
  // area code), and blocking the whole record over a contact detail is worse
  // than storing an odd-looking one. `suspect` lets the UI hint without
  // stopping the save.
  return { ok: true, value: trimmed, suspect: digits.length < 10 };
}

// Accepts what people actually paste from Google Maps: "41.535017, -81.461610",
// the same without a space, or a full Maps URL containing an @lat,lng segment.
// Rejects anything else rather than letting parseFloat salvage a partial number,
// because a wrong coordinate silently produces wrong travel distances — worse
// than no coordinate at all, which at least degrades visibly.
function validateCoordinates(raw, { required = false } = {}) {
  const trimmed = String(raw == null ? '' : raw).trim();
  if (!trimmed) {
    return required ? { ok: false, error: 'Coordinates are required' } : { ok: true, value: '' };
  }

  let candidate = trimmed;
  const urlMatch = trimmed.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (urlMatch) candidate = `${urlMatch[1]},${urlMatch[2]}`;

  const m = candidate.replace(/\s+/g, '').match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!m) {
    return { ok: false, error: 'Coordinates should look like "41.535017, -81.461610". Right-click the spot in Google Maps and click the numbers at the top to copy them.' };
  }

  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { ok: false, error: `Latitude ${lat} is out of range — it must be between -90 and 90. Latitude comes first.` };
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { ok: false, error: `Longitude ${lng} is out of range — it must be between -180 and 180.` };
  }
  // This league is in Northeast Ohio. A coordinate far outside that is almost
  // always lat/lng swapped or a stray paste, and would quietly skew every
  // travel calculation in the division, so it's worth querying.
  if (lat < 24 || lat > 50 || lng < -125 || lng > -66) {
    return { ok: false, error: `${lat}, ${lng} isn't in the continental US — check the order (latitude first) and that nothing was cut off when pasting.` };
  }
  return { ok: true, value: `${lat},${lng}` };
}

// Previously `Math.max(1, Math.min(20, Number(x) || 0))`, which turned "abc"
// into 1 — a team silently scheduled for a single game all season.
function validateTargetGames(raw, { max = 20 } = {}) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: 'Games this season must be a whole number' };
  }
  if (n < 1 || n > max) {
    return { ok: false, error: `Games this season must be between 1 and ${max}` };
  }
  return { ok: true, value: n };
}

function validateName(raw, { label = 'Name', max = 120, required = true } = {}) {
  const value = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!value) {
    return required ? { ok: false, error: `${label} is required` } : { ok: true, value: '' };
  }
  if (value.length > max) {
    return { ok: false, error: `${label} must be ${max} characters or fewer` };
  }
  return { ok: true, value };
}

module.exports = {
  EMAIL_RE,
  cleanEmail,
  validateEmail,
  validatePhone,
  validateCoordinates,
  validateTargetGames,
  validateName,
};
