const express = require('express');
const db = require('../db');
const { computeFlags, FLAG_WINDOW_MS, MAX_ACCURACY_M } = require('../helpers');

const router = express.Router();

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const isNum = v => typeof v === 'number' && Number.isFinite(v);

// Public — no auth. This is the endpoint a consumer's scan/manual entry calls.
router.post('/', (req, res) => {
  const { code, lat, lng, accuracy, deviceId } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code is required.' });

  if (!deviceId || !DEVICE_ID_RE.test(String(deviceId))) {
    return res.status(400).json({ error: 'Could not identify this device. Refresh the page and try again.' });
  }

  // A verification without a usable location is refused outright.
  if (!isNum(lat) || !isNum(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || !isNum(accuracy) || accuracy < 0) {
    return res.status(400).json({
      error: 'Location is required to verify a product. Allow location access for this site and try again.',
      locationRequired: true
    });
  }
  if (accuracy > MAX_ACCURACY_M) {
    return res.status(400).json({
      error: `Your location is not precise enough (about ${Math.round(accuracy)} m). Move near a window or outdoors and try again.`,
      locationRequired: true
    });
  }

  const normalizedCode = String(code).trim().toUpperCase();
  const unit = db.prepare('SELECT * FROM units WHERE code = ?').get(normalizedCode);

  if (!unit) {
    return res.json({ found: false });
  }

  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(unit.batch_id);
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(unit.company_id);

  const now = Date.now();
  const device = String(deviceId);

  // When was it scanned before this time? (null if this is the first scan)
  const previous = db.prepare('SELECT at FROM scans WHERE unit_code = ? ORDER BY at DESC LIMIT 1').get(unit.code);

  // Record this scan and update the unit's "last scanned" date and location together.
  db.transaction(() => {
    db.prepare(
      'INSERT INTO scans (unit_code, at, lat, lng, accuracy, device_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(unit.code, now, lat, lng, accuracy, device);

    db.prepare(
      `UPDATE units
       SET verify_count = verify_count + 1,
           last_verified_at = ?, last_lat = ?, last_lng = ?, last_accuracy = ?
       WHERE code = ?`
    ).run(now, lat, lng, accuracy, unit.code);
  })();

  // Only scans inside the look-back window are needed to apply the rules.
  const windowScans = db.prepare(
    `SELECT at, lat, lng, accuracy, device_id
     FROM scans WHERE unit_code = ? AND at >= ?
     ORDER BY at DESC LIMIT 2000`
  ).all(unit.code, now - FLAG_WINDOW_MS);
  const flags = computeFlags(windowScans, now);

  db.prepare(
    'UPDATE units SET last_flag_velocity = ?, last_flag_geo = ?, last_flag_detail = ? WHERE code = ?'
  ).run(0, flags.geoJump ? 1 : 0, flags.geoJumpDetail, unit.code);

  res.json({
    found: true,
    product: {
      productName: batch.product_name,
      companyName: company.name,
      batchNumber: batch.batch_number,
      manufacturingDate: batch.manufacturing_date,
      serialNumber: unit.serial_number
    },
    verifyCount: unit.verify_count + 1,
    // Consumers only see WHEN it was last checked; exact locations stay with the company.
    previousScanAt: previous ? previous.at : null,
    flags
  });
});

module.exports = router;
