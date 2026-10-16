const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../auth');
const { createOneUnit, SERIAL_RE } = require('../unitcreate');
const { BATCH_RE, validDate } = require('../rules');

const router = express.Router();
const MAX_CHECK = 5000;   // rows per check request
const MAX_COMMIT = 1000;  // rows per import request
const MAX_ERRORS_SHOWN = 100;

class UserError extends Error {}
const lower = s => String(s).toLowerCase();

function cleanRows(input, max) {
  if (!Array.isArray(input) || input.length === 0) return { error: 'No rows were sent.' };
  if (input.length > max) return { error: `Send at most ${max} rows at a time.` };
  return {
    rows: input.map((r, i) => ({
      n: Number.isInteger(r && r.n) ? r.n : i + 1,
      product: String((r && r.product) || '').trim(),
      batch: String((r && r.batch) || '').trim(),
      date: String((r && r.date) || '').trim(),
      serial: String((r && r.serial) || '').trim()
    }))
  };
}

function loadBatches(companyId) {
  return new Map(db.prepare('SELECT * FROM batches WHERE company_id = ?').all(companyId).map(b => [lower(b.batch_number), b]));
}

// Everything that can be wrong with one row.
//   kind 'existing': the batch already exists, so its product and date are not needed
//   kind 'first':    first row of a NEW batch, which sets the batch's product and date
//   kind 'later':    another row of that new batch: product/date may be blank, but if given they must be valid
function problemWith(row, kind) {
  if (!row.serial) return 'There is no serial number.';
  if (!SERIAL_RE.test(row.serial)) return `Serial "${row.serial}" can only use letters, numbers, dots, dashes and underscores (max 40 characters).`;
  if (!row.batch) return 'There is no batch number.';
  if (!BATCH_RE.test(row.batch)) return `Batch "${row.batch}" can only use letters, numbers, spaces, dots, dashes and underscores (max 40 characters).`;
  if (kind === 'first') {
    if (row.product.length < 1 || row.product.length > 120) return 'There is no product name (or it is longer than 120 characters).';
    if (!validDate(row.date)) return `The date "${row.date}" is not a real date. Dates must look like 2026-07-31.`;
  } else if (kind === 'later') {
    if (row.product.length > 120) return 'The product name is longer than 120 characters.';
    if (row.date && !validDate(row.date)) return `The date "${row.date}" is not a real date. Dates must look like 2026-07-31.`;
  }
  return null;
}

// Shared by check and import: finds every problem, without writing anything.
function analyse(companyId, rows, skipExisting) {
  const batches = loadBatches(companyId);
  const errors = [];
  const seen = new Set();
  const newBatches = new Map();      // lower batch -> { batch, product, date, rows }
  const existingBatches = new Map(); // lower batch -> { batch, rows }
  const wanted = new Map();          // batch id -> [{ row, serial }] to look up
  const plan = [];                   // valid rows with their batch (if it exists)

  for (const row of rows) {
    const key = lower(row.batch);
    const existing = batches.get(key) || null;
    const kind = existing ? 'existing' : (newBatches.has(key) ? 'later' : 'first');
    const bad = problemWith(row, kind);
    if (bad) { errors.push({ row: row.n, message: bad }); continue; }

    const dupKey = key + '\u0000' + lower(row.serial);
    if (seen.has(dupKey)) { errors.push({ row: row.n, message: `Serial "${row.serial}" appears more than once in batch ${row.batch}.` }); continue; }
    seen.add(dupKey);

    if (existing) {
      const e = existingBatches.get(key) || { batch: existing.batch_number, rows: 0 };
      e.rows++; existingBatches.set(key, e);
      if (!wanted.has(existing.id)) wanted.set(existing.id, []);
      wanted.get(existing.id).push(row);
    } else {
      const nb = newBatches.get(key) || { batch: row.batch, product: row.product, date: row.date, rows: 0, differs: false };
      if ((row.product && row.product !== nb.product) || (row.date && row.date !== nb.date)) nb.differs = true;
      nb.rows++; newBatches.set(key, nb);
    }
    plan.push({ row, batch: existing });
  }

  // Which serials already have a code in an existing batch?
  const already = new Set();
  for (const [batchId, list] of wanted) {
    for (let i = 0; i < list.length; i += 400) {
      const part = list.slice(i, i + 400).map(r => r.serial);
      const found = db.prepare(
        `SELECT serial_number FROM units WHERE batch_id = ? AND serial_number IN (${part.map(() => '?').join(',')})`
      ).all(batchId, ...part);
      found.forEach(f => already.add(batchId + '\u0000' + lower(f.serial_number)));
    }
  }

  let alreadyThere = 0, toCreate = 0;
  for (const p of plan) {
    const isThere = p.batch && already.has(p.batch.id + '\u0000' + lower(p.row.serial));
    if (isThere) {
      if (skipExisting) alreadyThere++;
      else errors.push({ row: p.row.n, message: `Serial "${p.row.serial}" already has a code in batch ${p.batch.batch_number}.` });
    } else toCreate++;
  }
  errors.sort((a, b) => a.row - b.row);
  const warnings = [...newBatches.values()].filter(b => b.differs).slice(0, 10).map(b =>
    `Batch ${b.batch}: some rows have a different product name or date. The batch is created with the first row's details (${b.product}, ${b.date}).`);
  return { errors, warnings, newBatches: [...newBatches.values()], existingBatches: [...existingBatches.values()], alreadyThere, toCreate };
}

// Dry run: reports every problem and what would happen. Writes nothing.
router.post('/company/import/check', requireAuth, (req, res) => {
  const c = cleanRows(req.body && req.body.rows, MAX_CHECK);
  if (c.error) return res.status(400).json({ error: c.error });
  const a = analyse(req.companyId, c.rows, !(req.body && req.body.skipExisting === false));
  res.json({
    rows: c.rows.length,
    errorCount: a.errors.length,
    errors: a.errors.slice(0, MAX_ERRORS_SHOWN),
    warnings: a.warnings,
    newBatches: a.newBatches, existingBatches: a.existingBatches,
    alreadyThere: a.alreadyThere, toCreate: a.toCreate
  });
});

// Creates the batches (if new) and one unique code per row. All or nothing for each request.
router.post('/company/import/commit', requireAuth, (req, res) => {
  const c = cleanRows(req.body && req.body.rows, MAX_COMMIT);
  if (c.error) return res.status(400).json({ error: c.error });
  const skipExisting = !(req.body && req.body.skipExisting === false);

  const a = analyse(req.companyId, c.rows, skipExisting);
  if (a.errors.length) {
    return res.status(400).json({
      error: `Row ${a.errors[0].row}: ${a.errors[0].message}`,
      errorCount: a.errors.length, errors: a.errors.slice(0, 20)
    });
  }

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.companyId);
  try {
    const out = db.transaction(() => {
      const batches = loadBatches(req.companyId);
      const created = [], existing = [];
      let batchesCreated = 0;
      for (const row of c.rows) {
        const key = lower(row.batch);
        let b = batches.get(key);
        if (!b) {
          const id = crypto.randomUUID();
          db.prepare(
            `INSERT INTO batches (id, company_id, batch_number, product_name, manufacturing_date, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(id, req.companyId, row.batch, row.product, row.date, Date.now());
          b = db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
          batches.set(key, b);
          batchesCreated++;
        }
        const there = db.prepare('SELECT code FROM units WHERE batch_id = ? AND serial_number = ?').get(b.id, row.serial);
        if (there) {
          existing.push({ batch: b.batch_number, serial: row.serial, code: there.code });
          continue;
        }
        const r = createOneUnit(b, company, row.serial);
        if (r.error) throw new UserError(`Row ${row.n}: ${r.error}`);
        created.push({ batch: b.batch_number, serial: r.serialNumber, code: r.code });
      }
      return { created, existing, batchesCreated };
    })();
    res.status(201).json(out);
  } catch (e) {
    if (e instanceof UserError) return res.status(409).json({ error: e.message });
    throw e;
  }
});

module.exports = router;
