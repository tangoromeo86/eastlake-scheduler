'use strict';
// Sunset / civil-twilight calculation — NOAA's low-precision solar position
// algorithm (public-domain astronomy: https://gml.noaa.gov/grad/solcalc/).
// Accurate to within about a minute, far more precision than a weekday
// kickoff time needs. Pure math, no external data, no network calls.

const RAD = Math.PI / 180;

// Julian Day at UTC noon for a YYYY-MM-DD calendar date.
function toJulianDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

// Solar declination (deg) and equation of time (min) for a Julian Day —
// everything sunrise/sunset math needs about the sun's apparent position.
function solarPosition(jd) {
  const T = (jd - 2451545.0) / 36525; // Julian centuries since J2000
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
          + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T)
          + Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const apparentLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const meanObliquity = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliquity + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(apparentLong * RAD)) / RAD;
  const y = Math.tan((obliqCorr / 2) * RAD) ** 2;
  const eqTime = 4 / RAD * (
    y * Math.sin(2 * L0 * RAD)
    - 2 * e * Math.sin(M * RAD)
    + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
    - 0.5 * y * y * Math.sin(4 * L0 * RAD)
    - 1.25 * e * e * Math.sin(2 * M * RAD)
  );
  return { decl, eqTime };
}

// Minutes since UTC midnight of the evening sun-crossing of `zenithDeg` at
// (lat, lng) on the given Julian Day. Returns null if the sun never reaches
// that angle that day (polar cases — not a real concern for this league, kept
// for correctness rather than assuming it can't happen).
function utcSunsetCrossingMinutes(jd, lat, lng, zenithDeg) {
  const { decl, eqTime } = solarPosition(jd);
  const latR = lat * RAD, declR = decl * RAD, zenR = zenithDeg * RAD;
  const cosH = (Math.cos(zenR) - Math.sin(latR) * Math.sin(declR)) / (Math.cos(latR) * Math.cos(declR));
  if (cosH < -1 || cosH > 1) return null;
  const hourAngle = Math.acos(cosH) / RAD; // evening crossing = positive hour angle
  return 720 - 4 * lng - eqTime + 4 * hourAngle;
}

// Standard sunset (accounts for atmospheric refraction + the sun's apparent
// radius) vs. civil twilight end — the "still safe to play outdoors without
// lights" threshold this app actually schedules against.
const ZENITH_SUNSET = 90.833;
const ZENITH_CIVIL_TWILIGHT = 96;

// `timeZone` is an IANA name (e.g. 'America/New_York') — used only to convert
// the UTC crossing into the clock time a coach actually reads, DST included.
// Building a UTC instant and reading it back through Intl in the target zone
// is the standard way to get correct local time without carrying a separate
// timezone database — Intl already has one.
function localMinutesForCrossing(dateStr, lat, lng, zenithDeg, timeZone) {
  const jd = toJulianDay(dateStr);
  const utcMin = utcSunsetCrossingMinutes(jd, lat, lng, zenithDeg);
  if (utcMin == null) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcInstant = new Date(Date.UTC(y, m - 1, d, 0, Math.round(utcMin)));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(utcInstant);
  const hh = Number(parts.find(p => p.type === 'hour').value);
  const mm = Number(parts.find(p => p.type === 'minute').value);
  return hh * 60 + mm;
}

function sunsetMinutesLocal(dateStr, lat, lng, timeZone) {
  return localMinutesForCrossing(dateStr, lat, lng, ZENITH_SUNSET, timeZone);
}
function civilDuskMinutesLocal(dateStr, lat, lng, timeZone) {
  return localMinutesForCrossing(dateStr, lat, lng, ZENITH_CIVIL_TWILIGHT, timeZone);
}

module.exports = {
  sunsetMinutesLocal,
  civilDuskMinutesLocal,
  DEFAULT_TIMEZONE: 'America/New_York',
};
