const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../auth');
const { ROLES, newAccessCode, hashAccessCode } = require('../partnercodes');

const router = express.Router();

function ownPartner(id, companyId) {
  return db.prepare('SELECT * FROM partners WHERE id = ? AND company_id = ?').get(id, companyId);
}

function partnerView(p, events) {
  return {
    id: p.id, name: p.name, role: p.role, active: !!p.active,
    createdAt: p.created_at, lastSeenAt: p.last_seen_at, events: events || 0
  };
}

router.get('/company/partners', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM custody_events e WHERE e.partner_id = p.id) AS events
     FROM partners p WHERE p.company_id = ? ORDER BY p.created_at DESC`
  ).all(req.companyId);
  res.json({ partners: rows.map(r => partnerView(r, Number(r.events))) });
});

// Creates a partner and returns its access code. The code is shown ONCE; only a hash is kept.
router.post('/company/partners', requireAuth, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const role = req.body && req.body.role;
  if (name.length < 2 || name.length > 60) {
    return res.status(400).json({ error: 'Enter the partner\'s name (2 to 60 characters).' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: 'Choose distributor or retailer.' });
  }
  if (db.prepare('SELECT 1 FROM partners WHERE company_id = ? AND name = ?').get(req.companyId, name)) {
    return res.status(409).json({ error: 'You already have a partner with that name.' });
  }
  const id = crypto.randomUUID();
  const accessCode = newAccessCode();
  db.prepare(
    'INSERT INTO partners (id, company_id, name, role, access_hash, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
  ).run(id, req.companyId, name, role, hashAccessCode(accessCode), Date.now());
  res.status(201).json({ partner: partnerView(ownPartner(id, req.companyId), 0), accessCode });
});

// A new access code (for a lost one). The old code stops working at once.
// Someone already logged in stays logged in until their session ends: switch the partner off to cut access immediately.
router.post('/company/partners/:id/reset', requireAuth, (req, res) => {
  const p = ownPartner(req.params.id, req.companyId);
  if (!p) return res.status(404).json({ error: 'Partner not found.' });
  const accessCode = newAccessCode();
  db.prepare('UPDATE partners SET access_hash = ? WHERE id = ?').run(hashAccessCode(accessCode), p.id);
  res.json({ partner: partnerView(ownPartner(p.id, req.companyId)), accessCode });
});

router.post('/company/partners/:id/active', requireAuth, (req, res) => {
  const p = ownPartner(req.params.id, req.companyId);
  if (!p) return res.status(404).json({ error: 'Partner not found.' });
  const active = req.body && req.body.active ? 1 : 0;
  db.prepare('UPDATE partners SET active = ? WHERE id = ?').run(active, p.id);
  res.json({ partner: partnerView(ownPartner(p.id, req.companyId)) });
});

// The full chain of custody of one unit (company view, with locations).
router.get('/units/:code/custody', requireAuth, (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const unit = db.prepare('SELECT code FROM units WHERE code = ? AND company_id = ?').get(code, req.companyId);
  if (!unit) return res.status(404).json({ error: 'Code not found.' });
  const rows = db.prepare(
    `SELECT e.id, e.action, e.at, e.lat, e.lng, e.out_of_area, p.name AS partner_name, p.role
     FROM custody_events e JOIN partners p ON p.id = e.partner_id
     WHERE e.unit_code = ? ORDER BY e.at ASC`
  ).all(code);
  res.json({
    events: rows.map(r => ({
      id: r.id, action: r.action, at: r.at, lat: r.lat, lng: r.lng,
      outOfArea: !!r.out_of_area, partner: r.partner_name, role: r.role
    }))
  });
});

// An out-of-area alert has been looked at.
router.post('/custody/:id/dismiss', requireAuth, (req, res) => {
  const e = db.prepare('SELECT id FROM custody_events WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!e) return res.status(404).json({ error: 'Alert not found.' });
  db.prepare('UPDATE custody_events SET reviewed_at = ? WHERE id = ?').run(Date.now(), e.id);
  res.json({ ok: true });
});

/* ---------- Sales area (where a batch is meant to be sold) ---------- */
function ownBatch(batchId, companyId) {
  return db.prepare('SELECT * FROM batches WHERE id = ? AND company_id = ?').get(batchId, companyId);
}
function areaOf(b) {
  if (b.sales_radius_km == null || b.sales_lat == null || b.sales_lng == null) return null;
  return { label: b.sales_label || '', lat: b.sales_lat, lng: b.sales_lng, radiusKm: b.sales_radius_km };
}

router.get('/batches/:batchId/sales-area', requireAuth, (req, res) => {
  const b = ownBatch(req.params.batchId, req.companyId);
  if (!b) return res.status(404).json({ error: 'Batch not found.' });
  res.json({ area: areaOf(b) });
});

// Body { label, lat, lng, radiusKm }, or { clear: true } to remove the area.
router.put('/batches/:batchId/sales-area', requireAuth, (req, res) => {
  const b = ownBatch(req.params.batchId, req.companyId);
  if (!b) return res.status(404).json({ error: 'Batch not found.' });

  if (req.body && req.body.clear) {
    db.prepare('UPDATE batches SET sales_lat = NULL, sales_lng = NULL, sales_radius_km = NULL, sales_label = NULL WHERE id = ?').run(b.id);
    return res.json({ area: null });
  }
  const lat = Number(req.body && req.body.lat);
  const lng = Number(req.body && req.body.lng);
  const radiusKm = Number(req.body && req.body.radiusKm);
  const label = String((req.body && req.body.label) || '').trim().slice(0, 80);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Enter a valid centre point (latitude and longitude), or use "Use my location".' });
  }
  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 5000) {
    return res.status(400).json({ error: 'The radius must be between 1 and 5000 km.' });
  }
  db.prepare('UPDATE batches SET sales_lat = ?, sales_lng = ?, sales_radius_km = ?, sales_label = ? WHERE id = ?')
    .run(lat, lng, radiusKm, label || null, b.id);
  res.json({ area: areaOf(ownBatch(b.id, req.companyId)) });
});

module.exports = router;
