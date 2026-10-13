const express = require('express');
const db = require('../db');
const { signPartnerToken, requirePartner } = require('../auth');
const { distanceKm, MAX_ACCURACY_M } = require('../helpers');
const { raiseFlag } = require('../flags');
const { notifyDiversion } = require('../notify');
const { ROLE_ACTIONS, ACTION_LABELS, normalize, hashAccessCode } = require('../partnercodes');

const router = express.Router();
const isNum = v => typeof v === 'number' && Number.isFinite(v);

function actionsFor(role) {
  return (ROLE_ACTIONS[role] || []).map(id => ({ id, label: ACTION_LABELS[id] }));
}

// Log in with the access code the manufacturer gave you.
router.post('/login', (req, res) => {
  const normalized = normalize(req.body && req.body.accessCode);
  const partner = normalized.length === 12
    ? db.prepare(
        `SELECT p.*, c.name AS company_name FROM partners p JOIN companies c ON c.id = p.company_id
         WHERE p.access_hash = ? AND p.active = 1`
      ).get(hashAccessCode(normalized))
    : null;
  if (!partner) return res.status(401).json({ error: 'That access code was not recognised.' });

  db.prepare('UPDATE partners SET last_seen_at = ? WHERE id = ?').run(Date.now(), partner.id);
  res.json({
    token: signPartnerToken(partner.id),
    partner: { name: partner.name, role: partner.role, companyName: partner.company_name, actions: actionsFor(partner.role) }
  });
});

router.get('/me', requirePartner, (req, res) => {
  const p = req.partner;
  const recent = db.prepare(
    `SELECT e.action, e.at, e.out_of_area, u.serial_number, b.product_name
     FROM custody_events e
     JOIN units u ON u.code = e.unit_code
     JOIN batches b ON b.id = u.batch_id
     WHERE e.partner_id = ? ORDER BY e.at DESC LIMIT 20`
  ).all(p.id);
  res.json({
    partner: { name: p.name, role: p.role, companyName: p.company_name, actions: actionsFor(p.role) },
    recent: recent.map(r => ({
      action: r.action, at: r.at, outOfArea: !!r.out_of_area,
      serialNumber: r.serial_number, productName: r.product_name
    }))
  });
});

// Record that a unit was received / shipped / stocked / sold.
router.post('/scan', requirePartner, (req, res) => {
  const p = req.partner;
  const { code, action, lat, lng, accuracy } = req.body || {};

  if (!(ROLE_ACTIONS[p.role] || []).includes(action)) {
    return res.status(400).json({ error: 'Choose what you are recording first.' });
  }
  if (!isNum(lat) || !isNum(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || !isNum(accuracy) || accuracy < 0) {
    return res.status(400).json({ error: 'Location is required. Allow location access and try again.' });
  }
  if (accuracy > MAX_ACCURACY_M) {
    return res.status(400).json({ error: `Your location is not precise enough (about ${Math.round(accuracy)} m). Move near a window or outdoors and try again.` });
  }

  const normalizedCode = String(code || '').trim().toUpperCase();
  const unit = db.prepare(
    `SELECT u.*, b.product_name, b.batch_number, b.sales_lat, b.sales_lng, b.sales_radius_km, b.sales_label
     FROM units u JOIN batches b ON b.id = u.batch_id
     WHERE u.code = ? AND u.company_id = ?`
  ).get(normalizedCode, p.company_id);
  if (!unit) {
    return res.status(404).json({ error: `That code was not found for ${p.company_name}. Check it and try again.` });
  }

  const now = Date.now();
  const product = { productName: unit.product_name, batchNumber: unit.batch_number, serialNumber: unit.serial_number };

  // Same partner, same unit, same action within a minute = a double scan. Ignore it.
  const dup = db.prepare(
    'SELECT id FROM custody_events WHERE partner_id = ? AND unit_code = ? AND action = ? AND at >= ?'
  ).get(p.id, unit.code, action, now - 60000);
  if (dup) return res.json({ ok: true, duplicate: true, action, product, warnings: [] });

  // Outside the batch's sales area?
  let kmOutside = null;
  if (unit.sales_radius_km != null && unit.sales_lat != null && unit.sales_lng != null) {
    const distKm = distanceKm(lat, lng, unit.sales_lat, unit.sales_lng) - accuracy / 1000;
    if (distKm > unit.sales_radius_km) kmOutside = Math.max(1, Math.round(distKm - unit.sales_radius_km));
  }

  db.transaction(() => {
    db.prepare(
      `INSERT INTO custody_events (company_id, partner_id, unit_code, action, at, lat, lng, accuracy, out_of_area)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(p.company_id, p.id, unit.code, action, now, lat, lng, accuracy, kmOutside !== null ? 1 : 0);
    db.prepare('UPDATE partners SET last_seen_at = ? WHERE id = ?').run(now, p.id);
  })();

  const warnings = [];
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(p.company_id);
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(unit.batch_id);

  if (kmOutside !== null) {
    notifyDiversion(company, unit, batch, p, action, kmOutside);
    warnings.push(`This product is about ${kmOutside} km outside the area it was meant to be sold in. ${p.company_name} has been told.`);
  }

  // A unit can only be sold once. Two different shops selling the same code means it was copied.
  if (action === 'sold') {
    const other = db.prepare(
      "SELECT 1 FROM custody_events WHERE unit_code = ? AND action = 'sold' AND partner_id != ? LIMIT 1"
    ).get(unit.code, p.id);
    if (other) {
      raiseFlag(unit.code, [{ code: 'sold_twice', text: 'it was recorded as sold by two different shops' }], now);
      warnings.push('This product was already recorded as sold by another shop. The manufacturer has been alerted.');
    }
  }

  const state = db.prepare('SELECT flag_status FROM units WHERE code = ?').get(unit.code);
  if (state && state.flag_status === 'confirmed') {
    warnings.push(`${p.company_name} has confirmed this code was copied. Do not sell this product.`);
  } else if (state && state.flag_status === 'open' && !warnings.length) {
    warnings.push('This code is being reviewed by the manufacturer.');
  }

  res.json({ ok: true, duplicate: false, action, product, warnings });
});

module.exports = router;
