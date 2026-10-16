const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireApiKey } = require('../auth');
const { apiKeyLimiter } = require('../security');
const { createUnits } = require('../unitcreate');
const { unitSummary } = require('../summary');
const { BATCH_RE, validDate } = require('../rules');

const router = express.Router();
router.use(apiKeyLimiter, requireApiKey);

const baseUrl = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const qrUrl = (req, code) => `${baseUrl(req)}/api/units/${encodeURIComponent(code)}/qr.png`;

function batchView(b, unitCount) {
  return {
    id: b.id, productName: b.product_name, batchNumber: b.batch_number,
    manufacturingDate: b.manufacturing_date, unitCount: Number(unitCount),
    salesArea: b.sales_radius_km == null ? null
      : { label: b.sales_label || '', lat: b.sales_lat, lng: b.sales_lng, radiusKm: b.sales_radius_km }
  };
}


router.get('/batches', (req, res) => {
  const rows = db.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM units u WHERE u.batch_id = b.id) AS n
     FROM batches b WHERE b.company_id = ? ORDER BY b.created_at DESC LIMIT 500`
  ).all(req.companyId);
  res.json({ batches: rows.map(b => batchView(b, b.n)) });
});

router.post('/batches', (req, res) => {
  const body = req.body || {};
  const productName = String(body.productName || '').trim();
  const batchNumber = String(body.batchNumber || '').trim();
  const manufacturingDate = String(body.manufacturingDate || '').trim();
  if (productName.length < 1 || productName.length > 120) {
    return res.status(400).json({ error: 'productName is required (up to 120 characters).' });
  }
  if (!BATCH_RE.test(batchNumber)) {
    return res.status(400).json({ error: 'batchNumber is required: letters, numbers, spaces, dots, dashes and underscores, up to 40 characters.' });
  }
  if (!validDate(manufacturingDate)) {
    return res.status(400).json({ error: 'manufacturingDate must be a real date written YYYY-MM-DD.' });
  }
  if (db.prepare('SELECT 1 FROM batches WHERE company_id = ? AND batch_number = ?').get(req.companyId, batchNumber)) {
    return res.status(409).json({ error: `You already have a batch numbered "${batchNumber}".` });
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO batches (id, company_id, batch_number, product_name, manufacturing_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, req.companyId, batchNumber, productName, manufacturingDate, Date.now());
  res.status(201).json({ batch: batchView(db.prepare('SELECT * FROM batches WHERE id = ?').get(id), 0) });
});

router.get('/batches/:batchId/units', (req, res) => {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ? AND company_id = ?').get(req.params.batchId, req.companyId);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const total = db.prepare('SELECT COUNT(*) n FROM units WHERE batch_id = ?').get(batch.id).n;
  const rows = db.prepare(
    `SELECT code, serial_number, verify_count, last_verified_at, flag_status
     FROM units WHERE batch_id = ? ORDER BY serial_number LIMIT ? OFFSET ?`
  ).all(batch.id, limit, offset);
  res.json({
    total: Number(total), limit, offset,
    units: rows.map(u => ({
      code: u.code, serialNumber: u.serial_number, qrUrl: qrUrl(req, u.code),
      timesChecked: Number(u.verify_count), lastCheckedAt: u.last_verified_at ? Number(u.last_verified_at) : null,
      status: u.flag_status === 'confirmed' ? 'confirmed_copy' : u.flag_status === 'open' ? 'possible_duplicate' : 'ok'
    }))
  });
});

// Body: { "serials": ["0001", "0002"] } or { "prefix": "SN-", "start": 1, "count": 100 }  (max 500)
router.post('/batches/:batchId/units', (req, res) => {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ? AND company_id = ?').get(req.params.batchId, req.companyId);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.companyId);
  const r = createUnits(batch, company, req.body);
  if (r.status === 201) {
    r.body.created = r.body.created.map(c => ({ ...c, qrUrl: qrUrl(req, c.code) }));
  }
  res.status(r.status).json(r.body);
});

// Is this code genuine, or flagged? Does not count as a shopper check.
router.get('/units/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const s = unitSummary(req.companyId, code);
  if (!s) return res.status(404).json({ error: 'That code was not found for your company.' });
  res.json(s);
});

module.exports = router;
