const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { signToken } = require('../auth');

const router = express.Router();

router.post('/register', (req, res) => {
  const { name, pin } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'Company name and PIN are required.' });
  if (String(pin).length < 4) return res.status(400).json({ error: 'PIN must be at least 4 characters.' });

  const existing = db.prepare('SELECT id FROM companies WHERE name = ?').get(name.trim());
  if (existing) return res.status(409).json({ error: 'A company with this name is already registered.' });

  const id = uuid();
  const pinHash = bcrypt.hashSync(String(pin), 10);
  db.prepare('INSERT INTO companies (id, name, pin_hash, created_at) VALUES (?, ?, ?, ?)').run(
    id, name.trim(), pinHash, Date.now()
  );

  res.status(201).json({ token: signToken(id), company: { id, name: name.trim() } });
});

router.post('/login', (req, res) => {
  const { name, pin } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'Company name and PIN are required.' });

  const company = db.prepare('SELECT * FROM companies WHERE name = ?').get(name.trim());
  if (!company || !bcrypt.compareSync(String(pin), company.pin_hash)) {
    return res.status(401).json({ error: 'No match for that company name and PIN.' });
  }

  res.json({ token: signToken(company.id), company: { id: company.id, name: company.name } });
});

module.exports = router;
