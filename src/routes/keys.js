const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../auth');
const { generateKey, hashKey } = require('../apikeys');

const router = express.Router();
const MAX_ACTIVE_KEYS = 10;

const view = k => ({
  id: k.id, label: k.label, prefix: k.key_prefix,
  createdAt: Number(k.created_at), lastUsedAt: k.last_used_at ? Number(k.last_used_at) : null,
  revoked: !!k.revoked_at
});

router.get('/company/api-keys', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM api_keys WHERE company_id = ? ORDER BY created_at DESC').all(req.companyId);
  res.json({ keys: rows.map(view) });
});

// The full key is shown ONCE, in this response. Only a hash is kept.
router.post('/company/api-keys', requireAuth, (req, res) => {
  const label = String((req.body && req.body.label) || '').trim();
  if (label.length < 2 || label.length > 60) {
    return res.status(400).json({ error: 'Give the key a name (2 to 60 characters), for example "Online shop".' });
  }
  const active = db.prepare('SELECT COUNT(*) n FROM api_keys WHERE company_id = ? AND revoked_at IS NULL').get(req.companyId).n;
  if (active >= MAX_ACTIVE_KEYS) {
    return res.status(400).json({ error: `You can have up to ${MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use.` });
  }
  const key = generateKey();
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO api_keys (id, company_id, label, key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, req.companyId, label, hashKey(key), key.slice(0, 12), Date.now());
  res.status(201).json({ key, record: view(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id)) });
});

// Stops the key working straight away.
router.delete('/company/api-keys/:id', requireAuth, (req, res) => {
  const k = db.prepare('SELECT * FROM api_keys WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!k) return res.status(404).json({ error: 'Key not found.' });
  db.prepare('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(Date.now(), k.id);
  res.json({ ok: true });
});

module.exports = router;
