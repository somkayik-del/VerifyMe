const express = require('express');
const db = require('../db');
const { computeFlags } = require('../helpers');

const router = express.Router();

// Public — no auth. This is the endpoint a consumer's scan/manual entry calls.
router.post('/', (req, res) => {
  const { code, lat, lng } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code is required.' });

  const normalizedCode = String(code).trim().toUpperCase();
  const unit = db.prepare('SELECT * FROM units WHERE code = ?').get(normalizedCode);

  if (!unit) {
    return res.json({ found: false });
  }

  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(unit.batch_id);
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(unit.company_id);

  const now = Date.now();
  const hasLoc = typeof lat === 'number' && typeof lng === 'number';

  db.prepare('INSERT INTO scans (unit_code, at, lat, lng) VALUES (?, ?, ?, ?)').run(
    unit.code, now, hasLoc ? lat : null, hasLoc ? lng : null
  );
  db.prepare('UPDATE units SET verify_count = verify_count + 1, last_verified_at = ? WHERE code = ?').run(
    now, unit.code
  );

  // Recompute flags from this unit's recent scan history (capped — we only need
  // enough history to evaluate the velocity window and impossible-travel window).
  const recentScans = db.prepare(
    'SELECT at, lat, lng FROM scans WHERE unit_code = ? ORDER BY at ASC LIMIT 100'
  ).all(unit.code);
  const flags = computeFlags(recentScans);

  db.prepare(
    'UPDATE units SET last_flag_velocity = ?, last_flag_geo = ?, last_flag_detail = ? WHERE code = ?'
  ).run(flags.velocity ? 1 : 0, flags.geoJump ? 1 : 0, flags.geoJumpDetail, unit.code);

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
    flags
  });
});

module.exports = router;
