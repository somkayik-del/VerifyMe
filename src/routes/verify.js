const express = require('express');
const db = require('../db');
const { MAX_ACCURACY_M } = require('../helpers');
const { CONFIG, evaluate, parseReasons } = require('../detection');
const { raiseFlag } = require('../flags');
const { clientIp, checkGuessBlock, recordInvalidCode } = require('../security');

const router = express.Router();

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const isNum = v => typeof v === 'number' && Number.isFinite(v);

// Public - no auth. This is the endpoint a consumer's scan/manual entry calls.
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

  const device = String(deviceId);
  const ip = clientIp(req);

  // Stop people from trying lots of invented codes.
  const wait = checkGuessBlock(device, ip);
  if (wait) {
    return res.status(429).json({
      error: `Too many unknown codes were entered. Please wait ${Math.ceil(wait / 60)} minute(s), then check the code carefully.`
    });
  }

  const normalizedCode = String(code).trim().toUpperCase();
  const unit = db.prepare('SELECT * FROM units WHERE code = ?').get(normalizedCode);

  if (!unit) {
    recordInvalidCode(device, ip);
    return res.json({ found: false });
  }

  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(unit.batch_id);
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(unit.company_id);

  const now = Date.now();

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

  // ---- Duplicate detection ----
  // flag_status: NULL (never flagged) | 'open' | 'reviewed' (false alarm) | 'confirmed' (copy)
  let status = unit.flag_status || null;
  let stored = parseReasons(unit.flag_reasons);

  if (status !== 'confirmed') {
    // After a false alarm is cleared, only newer scans count.
    const since = status === 'reviewed' ? (unit.reviewed_at || 0) : 0;
    const lower = Math.max(now - CONFIG.lookbackMs, since);
    const scans = db.prepare(
      `SELECT at, lat, lng, accuracy, device_id
       FROM scans WHERE unit_code = ? AND at >= ?
       ORDER BY at DESC LIMIT 5000`
    ).all(unit.code, lower);
    const current = { at: now, lat, lng, accuracy, device_id: device };

    const reasons = evaluate({ scans, current, now, since });
    const raised = raiseFlag(unit.code, reasons, now);
    if (raised) { status = raised.status; stored = raised.reasons; }
  }

  // The product's journey so far, as recorded by distributors and retailers.
  const journey = db.prepare(
    `SELECT e.action, e.at, p.name AS partner_name, p.role
     FROM custody_events e JOIN partners p ON p.id = e.partner_id
     WHERE e.unit_code = ? ORDER BY e.at DESC LIMIT 8`
  ).all(unit.code).reverse();

  const outStatus = status === 'confirmed' ? 'confirmed' : status === 'open' ? 'unusual' : 'genuine';

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
    // Shoppers only see WHEN it was last checked; exact locations stay with the company.
    previousScanAt: previous ? previous.at : null,
    status: outStatus,
    reasons: outStatus === 'unusual' ? stored.map(r => r.text) : [],
    journey: journey.map(j => ({ action: j.action, at: j.at, partner: j.partner_name, role: j.role }))
  });
});

module.exports = router;
