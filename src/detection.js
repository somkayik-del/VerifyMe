const { distanceKm } = require('./helpers');

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : fallback;
};
const HOUR = 3600000;
const DAY = 24 * HOUR;

/* ---------- Settings (change here, or set the environment variables) ---------- */
const CONFIG = {
  // Rule 1 - spread: MORE THAN this many different devices, in 2+ places > far radius apart
  spreadWindowMs: num('FLAG_WINDOW_MS', 7 * DAY),
  spreadDevices: num('FLAG_DEVICE_THRESHOLD', 3),
  farRadiusM: num('FLAG_FAR_RADIUS_M', 500),

  // Rule 2 - impossible travel: two different devices, far apart, too close in time
  travelMinKm: num('TRAVEL_MIN_KM', 20),
  travelMaxKmh: num('TRAVEL_MAX_SPEED_KMH', 150),
  travelLookbackMs: num('TRAVEL_LOOKBACK_MS', 24 * HOUR),

  // Rule 3 - too many devices overall, wherever they are
  manyDevices: num('MANY_DEVICES_THRESHOLD', 8),
  manyWindowMs: num('MANY_DEVICES_WINDOW_MS', 30 * DAY)
};
// How far back the scan history has to reach to apply every rule.
CONFIG.lookbackMs = Math.max(CONFIG.spreadWindowMs, CONFIG.manyWindowMs, CONFIG.travelLookbackMs);

/* ---------- Helpers ---------- */

// Distance between two scans, minus each scan's location error, in metres.
// Two scans only count as "far apart" if they are CERTAINLY that far apart.
function effectiveMetres(a, b) {
  const metres = distanceKm(a.lat, a.lng, b.lat, b.lng) * 1000;
  return Math.max(0, metres - (a.accuracy || 0) - (b.accuracy || 0));
}

function humanDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${Math.round(minutes / 60)} hours`;
}

const daysOf = ms => Math.round(ms / DAY);

function parseReasons(json) {
  if (!json) return [];
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list.filter(r => r && r.code && r.text) : [];
  } catch (e) {
    return [];
  }
}

/* ---------- The three rules ---------- */

// Rule 1: more than N devices, at 2+ separate places, within the window.
// Each device counts once (its latest scan), so one device scanning many times,
// or many devices close together, never trips it.
function ruleSpread(scans, now, since) {
  const cutoff = Math.max(since, now - CONFIG.spreadWindowMs);
  const latestPerDevice = new Map();
  for (const s of scans) {
    if (!s.device_id || s.lat == null || s.lng == null || s.at < cutoff) continue;
    const seen = latestPerDevice.get(s.device_id);
    if (!seen || s.at > seen.at) latestPerDevice.set(s.device_id, s);
  }
  const points = [...latestPerDevice.values()];
  if (points.length <= CONFIG.spreadDevices) return null;

  const parent = points.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (effectiveMetres(points[i], points[j]) <= CONFIG.farRadiusM) parent[find(i)] = find(j);
    }
  }
  const places = new Set(points.map((_, i) => find(i))).size;
  if (places < 2) return null;
  return {
    code: 'spread',
    text: `${points.length} different devices scanned it at ${places} separate locations in the last ${daysOf(CONFIG.spreadWindowMs)} days`
  };
}

// Rule 2: this scan is far from a recent scan by a DIFFERENT device, and the time
// between them is too short to have travelled that far.
function ruleImpossibleTravel(scans, current, since) {
  if (!current || current.lat == null || !current.device_id) return null;
  let worst = null;
  for (const p of scans) {
    if (!p.device_id || p.device_id === current.device_id || p.lat == null) continue;
    const dt = current.at - p.at;
    if (dt < 0 || dt > CONFIG.travelLookbackMs || p.at < since) continue;
    const km = effectiveMetres(current, p) / 1000;
    if (km < CONFIG.travelMinKm) continue;
    const hours = Math.max(dt / HOUR, 1 / 60); // never divide by less than a minute
    const speed = km / hours;
    if (speed > CONFIG.travelMaxKmh && (!worst || speed > worst.speed)) worst = { km, dt, speed };
  }
  if (!worst) return null;
  return {
    code: 'impossible_travel',
    text: `two different devices scanned it about ${Math.round(worst.km)} km apart, only ${humanDuration(worst.dt)} apart`
  };
}

// Rule 3: too many different devices overall, even if they are all in one place.
// (A copied code sold in a single market would slip past Rule 1 without this.)
function ruleManyDevices(scans, now, since) {
  const cutoff = Math.max(since, now - CONFIG.manyWindowMs);
  const devices = new Set();
  for (const s of scans) if (s.device_id && s.at >= cutoff) devices.add(s.device_id);
  if (devices.size <= CONFIG.manyDevices) return null;
  return {
    code: 'many_devices',
    text: `${devices.size} different devices have checked it in the last ${daysOf(CONFIG.manyWindowMs)} days`
  };
}

/**
 * scans:   this unit's scan rows { at, lat, lng, accuracy, device_id } (any order),
 *          including the scan that just happened
 * current: the scan that just happened
 * since:   ignore anything older than this (set when a company clears a flag)
 * Returns a list of { code, text } for every rule that tripped.
 */
function evaluate({ scans, current, now = Date.now(), since = 0 }) {
  const reasons = [];
  const a = ruleSpread(scans, now, since);
  const b = ruleImpossibleTravel(scans, current, since);
  const c = ruleManyDevices(scans, now, since);
  if (a) reasons.push(a);
  if (b) reasons.push(b);
  if (c) reasons.push(c);
  return reasons;
}

module.exports = { CONFIG, evaluate, parseReasons, effectiveMetres };
