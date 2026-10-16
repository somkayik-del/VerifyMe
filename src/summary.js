const db = require('./db');
const { parseReasons } = require('./detection');

// Looks a code up WITHOUT recording a shopper check (used by the API).
// Returns null if the code is not this company's.
function unitSummary(companyId, code) {
  const u = db.prepare(
    `SELECT u.*, b.product_name, b.batch_number, b.manufacturing_date
     FROM units u JOIN batches b ON b.id = u.batch_id
     WHERE u.code = ? AND u.company_id = ?`
  ).get(code, companyId);
  if (!u) return null;

  const status = u.flag_status === 'confirmed' ? 'confirmed_copy'
    : u.flag_status === 'open' ? 'possible_duplicate' : 'ok';

  const journey = db.prepare(
    `SELECT e.action, e.at, p.name AS partner, p.role
     FROM custody_events e JOIN partners p ON p.id = e.partner_id
     WHERE e.unit_code = ? ORDER BY e.at ASC LIMIT 50`
  ).all(code).map(j => ({ action: j.action, at: Number(j.at), partner: j.partner, role: j.role }));

  return {
    code: u.code,
    serialNumber: u.serial_number,
    productName: u.product_name,
    batchNumber: u.batch_number,
    manufacturingDate: u.manufacturing_date,
    status,
    reasons: status === 'possible_duplicate' ? parseReasons(u.flag_reasons).map(r => r.text) : [],
    timesChecked: Number(u.verify_count),
    lastCheckedAt: u.last_verified_at ? Number(u.last_verified_at) : null,
    journey
  };
}

module.exports = { unitSummary };
