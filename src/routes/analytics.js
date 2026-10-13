const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
const DAY = 86400000;

const round2 = n => Math.round(n * 100) / 100;

function roiOf(company, confirmedInPeriod, days) {
  const inputs = {
    currency: company.roi_currency || 'NGN',
    price: company.roi_price,
    fakeUnitsPerCode: company.roi_fake_units == null ? 5 : company.roi_fake_units,
    substitutionPct: company.roi_substitution_pct == null ? 25 : company.roi_substitution_pct,
    monthlyCost: company.roi_monthly_cost
  };
  let result = null;
  if (inputs.price > 0) {
    const revenueProtected = confirmedInPeriod * inputs.fakeUnitsPerCode * inputs.price * (inputs.substitutionPct / 100);
    const cost = inputs.monthlyCost > 0 ? inputs.monthlyCost * (days / 30) : null;
    result = {
      revenueProtected: round2(revenueProtected),
      cost: cost === null ? null : round2(cost),
      roiPct: cost ? round2(((revenueProtected - cost) / cost) * 100) : null
    };
  }
  return { inputs, result, confirmedInPeriod };
}

router.get('/analytics/summary', requireAuth, (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const offsetMin = Math.max(-840, Math.min(840, Number(req.query.tzOffset) || 0)); // minutes east of UTC
  const offsetMs = offsetMin * 60000;
  const now = Date.now();
  const since = now - days * DAY;
  const cid = req.companyId;

  const one = (sql, ...args) => db.prepare(sql).get(...args);

  const totalUnits = one('SELECT COUNT(*) n FROM units WHERE company_id = ?', cid).n;
  const scanRow = one(
    `SELECT COUNT(*) scans, COUNT(DISTINCT s.device_id) devices, COUNT(DISTINCT s.unit_code) units
     FROM scans s JOIN units u ON u.code = s.unit_code
     WHERE u.company_id = ? AND s.at >= ?`, cid, since);
  const open = one("SELECT COUNT(*) n FROM units WHERE company_id = ? AND flag_status = 'open'", cid).n;
  const confirmed = one("SELECT COUNT(*) n FROM units WHERE company_id = ? AND flag_status = 'confirmed'", cid).n;
  const cleared = one("SELECT COUNT(*) n FROM units WHERE company_id = ? AND flag_status = 'reviewed'", cid).n;
  const confirmedInPeriod = one(
    "SELECT COUNT(*) n FROM units WHERE company_id = ? AND flag_status = 'confirmed' AND reviewed_at >= ?", cid, since).n;
  const diversionsOpen = one(
    'SELECT COUNT(*) n FROM custody_events WHERE company_id = ? AND out_of_area = 1 AND reviewed_at IS NULL', cid).n;
  const tradeEvents = one('SELECT COUNT(*) n FROM custody_events WHERE company_id = ? AND at >= ?', cid, since).n;
  const partners = one('SELECT COUNT(*) n FROM partners WHERE company_id = ? AND active = 1', cid).n;

  // Scans per day (in the viewer's own time zone), zero-filled.
  const perDay = new Map(db.prepare(
    `SELECT CAST((s.at + ?) / 86400000 AS INTEGER) AS d, COUNT(*) AS n,
            SUM(CASE WHEN u.flag_status IN ('open', 'confirmed') THEN 1 ELSE 0 END) AS f
     FROM scans s JOIN units u ON u.code = s.unit_code
     WHERE u.company_id = ? AND s.at >= ? GROUP BY d`
  ).all(offsetMs, cid, since).map(r => [Number(r.d), r]));
  const todayIdx = Math.floor((now + offsetMs) / DAY);
  const byDay = [];
  for (let i = days - 1; i >= 0; i--) {
    const idx = todayIdx - i;
    const r = perDay.get(idx);
    byDay.push({
      date: new Date(idx * DAY).toISOString().slice(0, 10),
      scans: r ? Number(r.n) : 0,
      flagged: r ? Number(r.f || 0) : 0
    });
  }

  // Where scans happen. Coordinates are rounded to about 10 m.
  const points = db.prepare(
    `SELECT s.lat, s.lng, u.flag_status
     FROM scans s JOIN units u ON u.code = s.unit_code
     WHERE u.company_id = ? AND s.at >= ? AND s.lat IS NOT NULL
     ORDER BY s.at DESC LIMIT 800`
  ).all(cid, since).map(r => [
    Math.round(r.lat * 10000) / 10000,
    Math.round(r.lng * 10000) / 10000,
    r.flag_status === 'open' || r.flag_status === 'confirmed' ? 1 : 0
  ]);

  // Busiest areas (about 1 km squares), flagged ones first.
  const hotspots = db.prepare(
    `SELECT ROUND(s.lat, 2) AS la, ROUND(s.lng, 2) AS ln, COUNT(*) AS n,
            COUNT(DISTINCT s.device_id) AS devices,
            SUM(CASE WHEN u.flag_status IN ('open', 'confirmed') THEN 1 ELSE 0 END) AS f
     FROM scans s JOIN units u ON u.code = s.unit_code
     WHERE u.company_id = ? AND s.at >= ? AND s.lat IS NOT NULL
     GROUP BY la, ln ORDER BY f DESC, n DESC LIMIT 8`
  ).all(cid, since).map(r => ({
    lat: r.la, lng: r.ln, scans: Number(r.n), devices: Number(r.devices), flaggedScans: Number(r.f || 0)
  }));

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(cid);

  res.json({
    days,
    totals: {
      units: Number(totalUnits),
      scans: Number(scanRow.scans), devices: Number(scanRow.devices), unitsScanned: Number(scanRow.units),
      open: Number(open), confirmed: Number(confirmed), cleared: Number(cleared),
      diversionsOpen: Number(diversionsOpen), tradeEvents: Number(tradeEvents), partners: Number(partners)
    },
    byDay, points, hotspots,
    roi: roiOf(company, Number(confirmedInPeriod), days)
  });
});

// Saves the assumptions behind the impact estimate.
router.put('/company/roi', requireAuth, (req, res) => {
  const b = req.body || {};
  const num = v => (v === '' || v === null || v === undefined ? null : Number(v));
  const price = num(b.price), fake = num(b.fakeUnitsPerCode), pct = num(b.substitutionPct), cost = num(b.monthlyCost);
  const currency = String(b.currency || 'NGN').trim().toUpperCase().slice(0, 6) || 'NGN';

  for (const [label, v, max] of [['Average price', price, 1e12], ['Fake units per copied code', fake, 1e6], ['Switch-to-genuine share', pct, 100], ['Monthly cost', cost, 1e12]]) {
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > max)) {
      return res.status(400).json({ error: `${label} must be a number between 0 and ${max}.` });
    }
  }
  db.prepare(
    'UPDATE companies SET roi_currency = ?, roi_price = ?, roi_fake_units = ?, roi_substitution_pct = ?, roi_monthly_cost = ? WHERE id = ?'
  ).run(currency, price, fake, pct, cost, req.companyId);
  res.json({ ok: true });
});

module.exports = router;
