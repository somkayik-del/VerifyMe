const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Create a batch. Rejects if this company already used this batch number —
// the UNIQUE(company_id, batch_number) constraint is the real enforcement;
// we check first so we can return a friendly, specific error message.
router.post('/', (req, res) => {
  const { productName, batchNumber, manufacturingDate } = req.body || {};
  if (!productName || !batchNumber || !manufacturingDate) {
    return res.status(400).json({ error: 'Product name, batch number, and manufacturing date are required.' });
  }

  const dup = db.prepare(
    'SELECT * FROM batches WHERE company_id = ? AND batch_number = ?'
  ).get(req.companyId, batchNumber.trim());
  if (dup) {
    return res.status(409).json({
      error: `Batch number "${batchNumber}" is already registered (${dup.manufacturing_date}) — batch numbers can't be reused.`
    });
  }

  const id = uuid();
  db.prepare(
    'INSERT INTO batches (id, company_id, batch_number, product_name, manufacturing_date, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, req.companyId, batchNumber.trim(), productName.trim(), manufacturingDate, Date.now());

  res.status(201).json({ id, batchNumber: batchNumber.trim(), productName: productName.trim(), manufacturingDate });
});

// List this company's batches, with unit + flagged-unit counts for the dashboard.
router.get('/', (req, res) => {
  const batches = db.prepare(
    'SELECT * FROM batches WHERE company_id = ? ORDER BY created_at DESC'
  ).all(req.companyId);

  const withCounts = batches.map(b => {
    const unitCount = db.prepare('SELECT COUNT(*) AS n FROM units WHERE batch_id = ?').get(b.id).n;
    return {
      id: b.id,
      batchNumber: b.batch_number,
      productName: b.product_name,
      manufacturingDate: b.manufacturing_date,
      unitCount
    };
  });

  res.json({ batches: withCounts });
});

module.exports = router;
