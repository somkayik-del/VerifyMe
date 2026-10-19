const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// QRCode.create gives the QR's squares. Some versions of the library only expose it deeper down.
let createQr = QRCode.create;
if (typeof createQr !== 'function') {
  try { createQr = require('qrcode/lib/core/qrcode').create; } catch (e) { createQr = null; }
}

// Packs a QR code's dark/light squares into bits (row by row, 8 to a byte) and base64-encodes them.
function packModules(modules) {
  const n = modules.size;
  const bit = (r, c) => (typeof modules.get === 'function' ? modules.get(r, c) : modules.data[r * n + c]) ? 1 : 0;
  const bytes = Buffer.alloc(Math.ceil((n * n) / 8));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (bit(r, c)) { const i = r * n + c; bytes[i >> 3] |= 0x80 >> (i & 7); }
    }
  }
  return { n, bits: bytes.toString('base64') };
}

// The squares of each unit's QR code, so the company's browser can draw them at any size:
// on a label design, in a print-ready PDF, or as separate images. The code inside each QR is the
// same link the single-QR image uses, so a phone camera opens the verification page.
router.get('/batches/:batchId/qr-data', requireAuth, (req, res) => {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ? AND company_id = ?').get(req.params.batchId, req.companyId);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  if (!createQr) return res.status(500).json({ error: 'QR codes cannot be generated on this server (the QR library is missing).' });

  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 500));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const total = db.prepare('SELECT COUNT(*) AS n FROM units WHERE batch_id = ?').get(batch.id).n;
  const rows = db.prepare(
    'SELECT code, serial_number FROM units WHERE batch_id = ? ORDER BY serial_number LIMIT ? OFFSET ?'
  ).all(batch.id, limit, offset);

  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  res.json({
    total: Number(total), offset, limit,
    batch: { productName: batch.product_name, batchNumber: batch.batch_number },
    units: rows.map(u => {
      const qr = createQr(`${base}/?code=${encodeURIComponent(u.code)}`, { errorCorrectionLevel: 'M' });
      return { code: u.code, serial: u.serial_number, ...packModules(qr.modules) };
    })
  });
});

module.exports = router;
