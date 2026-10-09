function slugify(text) {
  return (text || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 14) || 'X';
}

function buildCode(companyName, batchNumber, serialNumber) {
  return `${slugify(companyName)}-${slugify(batchNumber)}-${serialNumber.trim().toUpperCase()}`;
}

// Distance in km between two lat/lng points (haversine formula).
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------- Settings (change here, or set the environment variables) ---------- */

// Only scans from this long ago count towards the duplicate check.
const FLAG_WINDOW_MS = Number(process.env.FLAG_WINDOW_MS || 7 * 24 * 60 * 60 * 1000); // 7 days

// "More than 3 devices" -> flag only when the number of devices is greater than this.
const FLAG_DEVICE_THRESHOLD = Number(process.env.FLAG_DEVICE_THRESHOLD || 3);

// Two scans further apart than this count as different locations.
// Anything closer (including everything within 200 m) counts as the same place.
const FLAG_FAR_RADIUS_M = Number(process.env.FLAG_FAR_RADIUS_M || 500);

// Scans whose location is less precise than this are refused.
const MAX_ACCURACY_M = Number(process.env.MAX_ACCURACY_M || 1000);

// True only when two scans are CERTAINLY more than FLAG_FAR_RADIUS_M apart.
// Each scan's location error (accuracy) is subtracted, so a rough reading
// can't make two nearby scans look far apart.
function isFarApart(a, b) {
  const metres = distanceKm(a.lat, a.lng, b.lat, b.lng) * 1000;
  const effective = metres - (a.accuracy || 0) - (b.accuracy || 0);
  return effective > FLAG_FAR_RADIUS_M;
}

// scans: this unit's scan rows ({ at, lat, lng, accuracy, device_id }), in any order.
// Rules:
//  - One device scanning the same product many times never flags (each device counts once).
//  - Devices close together (within the far radius) never flag, however many there are.
//  - Flag only when MORE THAN 3 different devices scanned in the last 7 days
//    AND their locations form 2 or more separate groups more than 500 m apart.
// `velocity` is kept (always false) so older code reading flags.velocity keeps working.
function computeFlags(scans, now = Date.now()) {
  const flags = { velocity: false, geoJump: false, geoJumpDetail: null };

  // Each device's most recent located scan inside the window.
  const latestPerDevice = new Map();
  for (const s of scans) {
    if (!s.device_id || s.lat == null || s.lng == null) continue;
    if (now - s.at > FLAG_WINDOW_MS) continue;
    const seen = latestPerDevice.get(s.device_id);
    if (!seen || s.at > seen.at) latestPerDevice.set(s.device_id, s);
  }

  const points = [...latestPerDevice.values()];
  if (points.length <= FLAG_DEVICE_THRESHOLD) return flags;

  // Group scans into locations: two scans that are NOT far apart share a group.
  const parent = points.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (!isFarApart(points[i], points[j])) parent[find(i)] = find(j);
    }
  }
  const locationGroups = new Set(points.map((_, i) => find(i))).size;

  if (locationGroups >= 2) {
    const days = Math.round(FLAG_WINDOW_MS / 86400000);
    flags.geoJump = true;
    flags.geoJumpDetail =
      `${points.length} different devices scanned it at ${locationGroups} separate locations in the last ${days} days`;
  }
  return flags;
}

module.exports = {
  slugify, buildCode, distanceKm, computeFlags,
  FLAG_WINDOW_MS, FLAG_DEVICE_THRESHOLD, FLAG_FAR_RADIUS_M, MAX_ACCURACY_M
};
