const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { requireAuth } = require('../auth');
const { createUnits } = require('../unitcreate');
const { parseReasons } = require('../detection');

const router = express.Router();

function getOwnedBatch(batchId, companyId) {
  return db.prepare('SELECT * FROM batches WHERE id = ? AND company_id = ?').get(batchId, companyId);
}

// Create one unit, a list of serials, or a numbered range: { prefix, start, count } (max 500 per call).
router.post('/batches/:batchId/units', requireAuth, (req, res) => {
  const batch = getOwnedBatch(req.params.batchId, req.companyId);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.companyId);
  const result = createUnits(batch, company, req.body);
  res.status(result.status).json(result.body);
});

// List units in a batch, with last scan and flag status, for the company dashboard.
router.get('/batches/:batchId/units', requireAuth, (req, res) => {
  const batch = getOwnedBatch(req.params.batchId, req.companyId);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });

  const units = db.prepare(
    'SELECT * FROM units WHERE batch_id = ? ORDER BY serial_number ASC'
  ).all(batch.id);

  // Each unit's most recent step in the supply chain (if any).
  const last = new Map(db.prepare(
    `SELECT e.unit_code, e.action, e.at, e.out_of_area, p.name AS partner_name, p.role
     FROM custody_events e JOIN partners p ON p.id = e.partner_id
     WHERE e.unit_code IN (SELECT code FROM units WHERE batch_id = ?)
       AND e.id = (SELECT MAX(x.id) FROM custody_events x WHERE x.unit_code = e.unit_code)`
  ).all(batch.id).map(r => [r.unit_code, r]));

  res.json({
    units: units.map(u => ({
      custody: last.has(u.code)
        ? { action: last.get(u.code).action, at: last.get(u.code).at, partner: last.get(u.code).partner_name,
            role: last.get(u.code).role, outOfArea: !!last.get(u.code).out_of_area }
        : null,
      code: u.code,
      serialNumber: u.serial_number,
      verifyCount: u.verify_count,
      lastVerifiedAt: u.last_verified_at,
      lastLat: u.last_lat,
      lastLng: u.last_lng,
      lastAccuracy: u.last_accuracy,
      flag: {
        status: u.flag_status || null,
        reasons: parseReasons(u.flag_reasons).map(r => r.text),
        flaggedAt: u.flagged_at,
        reviewedAt: u.reviewed_at,
        outcome: u.review_outcome,
        note: u.review_note
      }
    }))
  });
});

// A company reviews a flagged code:
//   outcome 'cleared'   -> false alarm; the flag is removed and only newer scans count from now on
//   outcome 'confirmed' -> the code was copied; shoppers see a "do not trust" warning from now on
router.post('/units/:code/review', requireAuth, (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const unit = db.prepare('SELECT * FROM units WHERE code = ? AND company_id = ?').get(code, req.companyId);
  if (!unit) return res.status(404).json({ error: 'Code not found.' });

  const outcome = req.body && req.body.outcome;
  if (outcome !== 'cleared' && outcome !== 'confirmed') {
    return res.status(400).json({ error: 'Outcome must be "cleared" or "confirmed".' });
  }
  const note = String((req.body && req.body.note) || '').trim().slice(0, 500) || null;
  const now = Date.now();

  if (outcome === 'confirmed') {
    db.prepare(
      `UPDATE units SET flag_status = 'confirmed', review_outcome = 'confirmed', review_note = ?, reviewed_at = ?,
         flagged_at = COALESCE(flagged_at, ?)
       WHERE code = ?`
    ).run(note, now, now, code);
  } else {
    db.prepare(
      `UPDATE units SET flag_status = 'reviewed', flag_reasons = NULL, review_outcome = 'cleared',
         review_note = ?, reviewed_at = ?
       WHERE code = ?`
    ).run(note, now, code);
  }
  res.json({ ok: true, status: outcome === 'confirmed' ? 'confirmed' : 'reviewed' });
});

// Public: render a QR PNG for a code. The QR encodes a full web link
// (https://your-site/?code=THE-CODE) so a phone's normal camera app can open
// it and verify straight away. The in-app scanner reads this link too.
router.get('/units/:code/qr.png', async (req, res) => {
  try {
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const link = `${base}/?code=${encodeURIComponent(req.params.code)}`;
    const buffer = await QRCode.toBuffer(link, { width: 400, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: 'Could not generate QR code.' });
  }
});

module.exports = router;
