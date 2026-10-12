const crypto = require('crypto');

function slugify(text) {
  return (text || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 14) || 'X';
}

// Letters and digits without look-alikes (no I, L, O, 0, 1) so a code typed by
// hand is less likely to be misread.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RANDOM_LENGTH = 8;

// Cryptographically random, evenly distributed (no modulo bias).
function randomCodePart(length = CODE_RANDOM_LENGTH) {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const b of bytes) {
      if (b < limit) {
        out += CODE_ALPHABET[b % CODE_ALPHABET.length];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

// e.g. PEAKMILK-BATCH2026001-0042-K7M2QX9R
// The readable part helps people; the random tail makes the code impossible to
// guess from another code, so nobody can invent a valid-looking one.
function buildCode(companyName, batchNumber, serialNumber) {
  const serial = String(serialNumber).trim().toUpperCase();
  return `${slugify(companyName)}-${slugify(batchNumber)}-${serial}-${randomCodePart()}`;
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

// Scans whose location is less precise than this (metres) are refused.
const MAX_ACCURACY_M = Number(process.env.MAX_ACCURACY_M || 1000);

module.exports = { slugify, buildCode, randomCodePart, distanceKm, MAX_ACCURACY_M, CODE_ALPHABET };
