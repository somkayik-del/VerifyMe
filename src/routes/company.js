const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { parseReasons } = require('../detection');
const { isSafeWebhookUrl, newWebhookSecret, deliver, emailConfigured } = require('../notify');

const router = express.Router();

const EMAIL_RE = /^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,100}$/;

function getCompany(id) {
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

function settingsOf(c) {
  return {
    alertEmail: c.alert_email || '',
    webhookUrl: c.webhook_url || '',
    webhookSecret: c.webhook_secret || '',
    emailConfigured: emailConfigured()
  };
}

// Flagged codes that need attention, plus how many alerts are unread.
router.get('/company/alerts', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT u.code, u.serial_number, u.flag_status, u.flag_reasons, u.flagged_at,
            u.last_verified_at, u.last_lat, u.last_lng, u.verify_count, u.review_note,
            b.product_name, b.batch_number
     FROM units u JOIN batches b ON b.id = u.batch_id
     WHERE u.company_id = ? AND u.flag_status IN ('open', 'confirmed')
     ORDER BY CASE u.flag_status WHEN 'open' THEN 0 ELSE 1 END, u.flagged_at DESC
     LIMIT 200`
  ).all(req.companyId);

  const unread = db.prepare(
    'SELECT COUNT(*) AS n FROM notifications WHERE company_id = ? AND read_at IS NULL'
  ).get(req.companyId).n;

  res.json({
    unread,
    alerts: rows.map(r => ({
      code: r.code,
      serialNumber: r.serial_number,
      productName: r.product_name,
      batchNumber: r.batch_number,
      status: r.flag_status,
      reasons: parseReasons(r.flag_reasons).map(x => x.text),
      flaggedAt: r.flagged_at,
      lastVerifiedAt: r.last_verified_at,
      lastLat: r.last_lat,
      lastLng: r.last_lng,
      verifyCount: r.verify_count,
      note: r.review_note
    }))
  });
});

router.post('/company/alerts/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE company_id = ? AND read_at IS NULL')
    .run(Date.now(), req.companyId);
  res.json({ ok: true });
});

router.get('/company/settings', requireAuth, (req, res) => {
  const company = getCompany(req.companyId);
  if (!company) return res.status(404).json({ error: 'Company not found.' });
  res.json(settingsOf(company));
});

router.put('/company/settings', requireAuth, (req, res) => {
  const company = getCompany(req.companyId);
  if (!company) return res.status(404).json({ error: 'Company not found.' });

  const alertEmail = String((req.body && req.body.alertEmail) || '').trim();
  const webhookUrl = String((req.body && req.body.webhookUrl) || '').trim();

  if (alertEmail && (alertEmail.length > 200 || !EMAIL_RE.test(alertEmail))) {
    return res.status(400).json({ error: 'Enter a valid email address, or leave it empty.' });
  }
  if (webhookUrl && (webhookUrl.length > 500 || !isSafeWebhookUrl(webhookUrl))) {
    return res.status(400).json({ error: 'The webhook address must be a public https:// address.' });
  }

  const secret = company.webhook_secret || (webhookUrl ? newWebhookSecret() : null);
  db.prepare('UPDATE companies SET alert_email = ?, webhook_url = ?, webhook_secret = ? WHERE id = ?')
    .run(alertEmail || null, webhookUrl || null, secret, company.id);

  res.json(settingsOf(getCompany(company.id)));
});

// Sends a sample alert so a company can check its email and webhook work.
router.post('/company/settings/test', requireAuth, async (req, res) => {
  const company = getCompany(req.companyId);
  if (!company) return res.status(404).json({ error: 'Company not found.' });
  try {
    const result = await deliver(
      company,
      'test',
      'Test alert from Product Authenticator',
      'This is a test alert. If you can read this, alerts are working.',
      { message: 'This is a test alert.' }
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'The test could not be completed.' });
  }
});

module.exports = router;
