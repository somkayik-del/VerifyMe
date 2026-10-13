const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../auth');
const { sendCsv } = require('../csv');
const { parseReasons } = require('../detection');
const { ACTION_LABELS } = require('../partnercodes');

const router = express.Router();
const DAY = 86400000;

const iso = ms => (ms ? new Date(Number(ms)).toISOString() : '');
const shortHash = id => (id ? crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 10) : '');
const daysOf = req => Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
const statusText = s => (s === 'open' ? 'possible duplicate' : s === 'confirmed' ? 'confirmed copy' : s === 'reviewed' ? 'reviewed (false alarm)' : 'ok');

// Every shopper check of this company's products.
router.get('/export/scans.csv', requireAuth, (req, res) => {
  const since = Date.now() - daysOf(req) * DAY;
  const rows = db.prepare(
    `SELECT s.at, s.unit_code, u.serial_number, b.product_name, b.batch_number,
            s.device_id, s.lat, s.lng, s.accuracy, u.flag_status
     FROM scans s JOIN units u ON u.code = s.unit_code JOIN batches b ON b.id = u.batch_id
     WHERE u.company_id = ? AND s.at >= ? ORDER BY s.at DESC LIMIT 50000`
  ).all(req.companyId, since);
  sendCsv(res, 'scans.csv', [
    ['Time (UTC)', 'Code', 'Serial', 'Product', 'Batch', 'Device (anonymous)', 'Latitude', 'Longitude', 'Accuracy (m)', 'Code status now'],
    ...rows.map(r => [iso(r.at), r.unit_code, r.serial_number, r.product_name, r.batch_number,
      shortHash(r.device_id), r.lat, r.lng, r.accuracy, statusText(r.flag_status)])
  ]);
});

// Every distributor / retailer scan.
router.get('/export/custody.csv', requireAuth, (req, res) => {
  const since = Date.now() - daysOf(req) * DAY;
  const rows = db.prepare(
    `SELECT e.at, e.unit_code, u.serial_number, b.product_name, b.batch_number,
            p.name AS partner, p.role, e.action, e.lat, e.lng, e.accuracy, e.out_of_area
     FROM custody_events e
     JOIN partners p ON p.id = e.partner_id
     JOIN units u ON u.code = e.unit_code
     JOIN batches b ON b.id = u.batch_id
     WHERE e.company_id = ? AND e.at >= ? ORDER BY e.at DESC LIMIT 50000`
  ).all(req.companyId, since);
  sendCsv(res, 'custody.csv', [
    ['Time (UTC)', 'Code', 'Serial', 'Product', 'Batch', 'Partner', 'Role', 'Action', 'Latitude', 'Longitude', 'Accuracy (m)', 'Outside sales area'],
    ...rows.map(r => [iso(r.at), r.unit_code, r.serial_number, r.product_name, r.batch_number,
      r.partner, r.role, ACTION_LABELS[r.action] || r.action, r.lat, r.lng, r.accuracy, r.out_of_area ? 'yes' : 'no'])
  ]);
});

// The list of codes (for printing or an ERP system), optionally for one batch.
router.get('/export/units.csv', requireAuth, (req, res) => {
  const batchId = req.query.batchId ? String(req.query.batchId) : null;
  if (batchId && !db.prepare('SELECT 1 FROM batches WHERE id = ? AND company_id = ?').get(batchId, req.companyId)) {
    return res.status(404).json({ error: 'Batch not found.' });
  }
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const rows = db.prepare(
    `SELECT u.code, u.serial_number, b.product_name, b.batch_number, u.verify_count,
            u.last_verified_at, u.last_lat, u.last_lng, u.flag_status
     FROM units u JOIN batches b ON b.id = u.batch_id
     WHERE u.company_id = ? AND (? IS NULL OR u.batch_id = ?)
     ORDER BY b.batch_number, u.serial_number LIMIT 100000`
  ).all(req.companyId, batchId, batchId);
  sendCsv(res, 'codes.csv', [
    ['Code', 'Serial', 'Product', 'Batch', 'QR image link', 'Times checked', 'Last checked (UTC)', 'Last latitude', 'Last longitude', 'Status'],
    ...rows.map(r => [r.code, r.serial_number, r.product_name, r.batch_number,
      `${base}/api/units/${encodeURIComponent(r.code)}/qr.png`, r.verify_count,
      iso(r.last_verified_at), r.last_lat, r.last_lng, statusText(r.flag_status)])
  ]);
});

// One sheet that tells the whole story of one code: for the company's records or to hand to the authorities.
router.get('/units/:code/evidence.csv', requireAuth, (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const u = db.prepare(
    `SELECT u.*, b.product_name, b.batch_number, b.manufacturing_date, c.name AS company_name
     FROM units u JOIN batches b ON b.id = u.batch_id JOIN companies c ON c.id = u.company_id
     WHERE u.code = ? AND u.company_id = ?`
  ).get(code, req.companyId);
  if (!u) return res.status(404).json({ error: 'Code not found.' });

  const scans = db.prepare('SELECT at, lat, lng, accuracy, device_id FROM scans WHERE unit_code = ? ORDER BY at ASC LIMIT 20000').all(code);
  const custody = db.prepare(
    `SELECT e.at, e.lat, e.lng, e.accuracy, e.action, e.out_of_area, p.name, p.role
     FROM custody_events e JOIN partners p ON p.id = e.partner_id
     WHERE e.unit_code = ? ORDER BY e.at ASC`
  ).all(code);

  const rows = [['Section', 'Time (UTC)', 'Who', 'What', 'Latitude', 'Longitude', 'Accuracy (m)']];
  rows.push(['PRODUCT', iso(u.created_at), u.company_name, `${u.product_name} | batch ${u.batch_number} | made ${u.manufacturing_date} | serial ${u.serial_number} | code ${u.code}`, '', '', '']);
  rows.push(['STATUS', iso(u.reviewed_at || u.flagged_at), '', `${statusText(u.flag_status)}${u.review_note ? ' | note: ' + u.review_note : ''}`, '', '', '']);
  parseReasons(u.flag_reasons).forEach(r => rows.push(['FLAG', iso(u.flagged_at), '', r.text, '', '', '']));
  custody.forEach(e => rows.push(['CUSTODY', iso(e.at), `${e.name} (${e.role})`,
    `${ACTION_LABELS[e.action] || e.action}${e.out_of_area ? ' - outside sales area' : ''}`, e.lat, e.lng, e.accuracy]));
  scans.forEach(s => rows.push(['SHOPPER CHECK', iso(s.at), `device ${shortHash(s.device_id)}`, 'Code checked', s.lat, s.lng, s.accuracy]));

  sendCsv(res, `evidence-${code}.csv`.replace(/[^A-Za-z0-9._-]/g, '_'), rows);
});

module.exports = router;
