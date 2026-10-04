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

const VELOCITY_WINDOW_MS = Number(process.env.VELOCITY_WINDOW_MS || 10 * 60 * 1000);
const VELOCITY_THRESHOLD = Number(process.env.VELOCITY_THRESHOLD || 3);
const IMPOSSIBLE_TRAVEL_KM = Number(process.env.IMPOSSIBLE_TRAVEL_KM || 300);
const IMPOSSIBLE_TRAVEL_MS = Number(process.env.IMPOSSIBLE_TRAVEL_MS || 6 * 60 * 60 * 1000);

// scans: full chronological history for this unit (ascending by `at`), including the
// just-inserted scan as the last element. Returns which anti-cloning signals are tripped.
function computeFlags(scans) {
  const flags = { velocity: false, geoJump: false, geoJumpDetail: null };
  if (!scans.length) return flags;

  const latest = scans[scans.length - 1];

  const recentCount = scans.filter(s => latest.at - s.at <= VELOCITY_WINDOW_MS).length;
  if (recentCount >= VELOCITY_THRESHOLD) flags.velocity = true;

  if (latest.lat != null) {
    for (let i = scans.length - 2; i >= 0; i--) {
      const prev = scans[i];
      const dt = latest.at - prev.at;
      if (dt > IMPOSSIBLE_TRAVEL_MS) break; // chronological, so older scans are only further out
      if (prev.lat == null) continue;
      const km = distanceKm(latest.lat, latest.lng, prev.lat, prev.lng);
      if (km >= IMPOSSIBLE_TRAVEL_KM) {
        flags.geoJump = true;
        flags.geoJumpDetail = `${Math.round(km)} km apart, ${Math.round(dt / 60000)} min apart`;
        break;
      }
    }
  }
  return flags;
}

module.exports = { slugify, buildCode, distanceKm, computeFlags };
