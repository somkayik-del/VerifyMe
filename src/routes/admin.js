const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const { requireAdminToken, tokenMatches } = require('../security');

const router = express.Router();

// The administrator page uses this to confirm the token is right before showing anything.
router.get('/check', requireAdminToken, (req, res) => res.json({ ok: true }));

// Every company account, with a few totals. Never includes passwords.
router.get('/companies', requireAdminToken, (req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.name, c.created_at,
            (SELECT COUNT(*) FROM batches b WHERE b.company_id = c.id) AS batches,
            (SELECT COUNT(*) FROM units u WHERE u.company_id = c.id) AS units,
            (SELECT COUNT(*) FROM partners p WHERE p.company_id = c.id) AS partners
     FROM companies c ORDER BY c.created_at DESC`
  ).all();
  res.json({
    companies: rows.map(r => ({
      id: r.id, name: r.name, createdAt: Number(r.created_at),
      batches: Number(r.batches), units: Number(r.units), partners: Number(r.partners)
    }))
  });
});

// Downloads a consistent copy of the whole database. Only works if you set the
// ADMIN_TOKEN variable on the server, and the request carries the same token:
//   curl.exe -H "x-admin-token: YOUR_TOKEN" -o backup.db https://your-site/api/admin/backup
router.get('/backup', async (req, res) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(404).json({ error: 'Not found.' });
  if (!tokenMatches(req.headers['x-admin-token'] || '', expected)) {
    return res.status(401).json({ error: 'Not allowed.' });
  }
  const file = path.join(os.tmpdir(), `backup-${Date.now()}.db`);
  try {
    await db.backup(file);
    res.download(file, 'authenticator-backup.db', () => fs.unlink(file, () => {}));
  } catch (e) {
    console.error('Backup failed:', e.message);
    res.status(500).json({ error: 'Backup failed.' });
  }
});

module.exports = router;
