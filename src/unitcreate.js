const db = require('./db');
const { buildCode } = require('./helpers');

// Serial numbers end up inside codes and web addresses, so keep them simple.
const SERIAL_RE = /^[A-Za-z0-9._-]{1,40}$/;

function createOneUnit(batch, company, serialNumber) {
  const serial = String(serialNumber).trim();
  if (!serial) return { error: 'Enter a serial number.' };
  if (!SERIAL_RE.test(serial)) {
    return { error: 'Serial numbers can use letters, numbers, dots, dashes and underscores only (max 40 characters).' };
  }

  const dup = db.prepare('SELECT code FROM units WHERE batch_id = ? AND serial_number = ?').get(batch.id, serial);
  if (dup) return { error: `Serial "${serial}" already exists in this batch.` };

  // The random part makes a clash practically impossible, but retry just in case.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = buildCode(company.name, batch.batch_number, serial);
    if (db.prepare('SELECT 1 FROM units WHERE code = ?').get(code)) continue;
    db.prepare(
      `INSERT INTO units (code, company_id, batch_id, serial_number, verify_count, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    ).run(code, company.id, batch.id, serial, Date.now());
    return { code, serialNumber: serial };
  }
  return { error: 'Could not create a unique code. Please try again.' };
}

// Body can be { serialNumber } or { serials: [...] } or { prefix, start, count } (max 500 at a time).
// Codes are made one after another. If one serial is a problem, the ones before it are kept,
// and the reply lists them. Returns { status, body } ready to send.
function createUnits(batch, company, body) {
  const { serialNumber, serials, prefix, start, count } = body || {};

  if (serialNumber !== undefined) {
    const r = createOneUnit(batch, company, serialNumber);
    if (r.error) return { status: 409, body: { error: r.error } };
    return { status: 201, body: { created: [r] } };
  }

  let list;
  if (Array.isArray(serials)) {
    if (!serials.length || serials.length > 500) {
      return { status: 400, body: { error: 'Send between 1 and 500 serial numbers at a time.' } };
    }
    list = serials.map(x => String(x));
  } else if (prefix !== undefined && start !== undefined && count !== undefined) {
    const startNum = parseInt(start, 10);
    const countNum = parseInt(count, 10);
    if (!prefix || isNaN(startNum) || isNaN(countNum) || countNum < 1 || countNum > 500) {
      return { status: 400, body: { error: 'Enter a prefix, a starting number, and a count (max 500 at a time).' } };
    }
    const width = String(startNum + countNum - 1).length;
    list = [];
    for (let i = 0; i < countNum; i++) list.push(`${prefix}${String(startNum + i).padStart(width, '0')}`);
  } else {
    return { status: 400, body: { error: 'Provide serialNumber, serials, or prefix + start + count.' } };
  }

  const created = [];
  for (const serial of list) {
    const r = createOneUnit(batch, company, serial);
    if (r.error) return { status: 409, body: { error: r.error, created } };
    created.push(r);
  }
  return { status: 201, body: { created } };
}

module.exports = { createOneUnit, createUnits, SERIAL_RE };
