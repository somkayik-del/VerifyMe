const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');

const router = express.Router();

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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
