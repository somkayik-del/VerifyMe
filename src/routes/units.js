const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { requireAuth } = require('../auth');
const { buildCode } = require('../helpers');

const router = express.Router();

function getOwnedBatch(batchId, companyId) {
  return db.prepare('SELECT * FROM batches WHERE id = ? AND company_id = ?').get(batchId, companyId);
}

function createOneUnit(batch, company, serialNumber) {
  const serial = String(serialNumber).trim();
  if (!serial) return { error: 'Enter a serial number.' };

  const dup = db.prepare(
    'SELECT code FROM units WHERE batch_id = ? AND serial_number = ?'
  ).get(batch.id, serial);
  if (dup) return { error: `Serial "${serial}" already exists in this batch.` };

  const code = buildCode(company.name, batch.batch_number, serial);
  db.prepare(
    `INSERT INTO units (code, company_id, batch_id, serial_number, verify_count, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(code, company.id, batch.id, serial, Date.now());

  return { code, serialNumber: serial };
}

// Create one unit, or a numbered range: { prefix, start, count } (max 500 per call).
router.post('/batches/:batchId/units', requireAuth, (req, res) => {
  const batch = getOwnedBatch(req.params.batchId, req.companyId);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.companyId);

  const { serialNumber, prefix, start, count } = req.body || {};

  if (serialNumber !== undefined) {
    const result = createOneUnit(batch, company, serialNumber);
    if (result.error) return res.status(409).json({ error: result.error });
    return res.status(201).json({ created: [result] });
  }

  if (prefix !== undefined && start !== undefined && count !== undefined) {
    const startNum = parseInt(start, 10);
    const countNum = parseInt(count, 10);
    if (!prefix || isNaN(startNum) || isNaN(countNum) || countNum < 1 || countNum > 500) {
      return res.status(400).json({ error: 'Enter a prefix, a starting number, and a count (max 500 at a time).' });
    }
    const width = String(startNum + countNum - 1).length;
    const created = [];
    for (let i = 0; i < countNum; i++) {
      const serial = `${prefix}${String(startNum + i).padStart(width, '0')}`;
      const result = createOneUnit(batch, company, serial);
      if (result.error) {
        return res.status(409).json({ error: result.error, created });
      }
      created.push(result);
    }
    return res.status(201).json({ created });
  }

  return res.status(400).json({ error: 'Provide either serialNumber, or prefix + start + count.' });
});

// List units in a batch, with current flag status, for the company dashboard.
router.get('/batches/:batchId/units', requireAuth, (req, res) => {
  const batch = getOwnedBatch(req.params.batchId, req.companyId);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });

  const units = db.prepare(
    'SELECT * FROM units WHERE batch_id = ? ORDER BY serial_number ASC'
  ).all(batch.id);

  res.json({
    units: units.map(u => ({
      code: u.code,
      serialNumber: u.serial_number,
      verifyCount: u.verify_count,
      lastVerifiedAt: u.last_verified_at,
      flags: { velocity: !!u.last_flag_velocity, geoJump: !!u.last_flag_geo, geoJumpDetail: u.last_flag_detail }
    }))
  });
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
