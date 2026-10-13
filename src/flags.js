const db = require('./db');
const { parseReasons } = require('./detection');
const { notifyFlag } = require('./notify');

// Marks a unit as "possible duplicate" (or adds reasons to an existing flag).
// Used by shopper scans and by distributor/retailer scans.
// Returns null if there is nothing to do (confirmed already, or no reasons),
// otherwise { status: 'open', reasons: [...all reasons now on the flag], raised }.
function raiseFlag(code, reasons, now = Date.now()) {
  if (!reasons || !reasons.length) return null;
  const unit = db.prepare('SELECT * FROM units WHERE code = ?').get(code);
  if (!unit || unit.flag_status === 'confirmed') return null;

  const wasOpen = unit.flag_status === 'open';
  const stored = parseReasons(unit.flag_reasons);
  const known = new Set(wasOpen ? stored.map(r => r.code) : []);
  const fresh = reasons.filter(r => !known.has(r.code));

  if (wasOpen && !fresh.length) return { status: 'open', reasons: stored, raised: false };

  // A flag stays on until the company reviews it, so keep the earlier reasons too.
  const merged = new Map();
  if (wasOpen) stored.forEach(r => merged.set(r.code, r));
  reasons.forEach(r => merged.set(r.code, r));
  const list = [...merged.values()];

  db.prepare(
    `UPDATE units SET flag_status = 'open', flag_reasons = ?,
       flagged_at = CASE WHEN ? = 1 THEN flagged_at ELSE ? END
     WHERE code = ?`
  ).run(JSON.stringify(list), wasOpen ? 1 : 0, now, code);

  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(unit.batch_id);
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(unit.company_id);
  notifyFlag(company, unit, batch, list);

  return { status: 'open', reasons: list, raised: true };
}

module.exports = { raiseFlag };
