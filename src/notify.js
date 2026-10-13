const crypto = require('crypto');
const db = require('./db');

/* ---------- Webhook safety ---------- */
// Only public https:// addresses are allowed, so a company can't point the
// server at its own internal network.
function isSafeWebhookUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h.startsWith('[') || h.includes(':')) return false; // no IPv6 addresses
  if (!h.includes('.')) return false;                     // no single-word internal hosts
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}

function newWebhookSecret() {
  return crypto.randomBytes(24).toString('hex');
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function sendWebhook(company, event, data) {
  if (!company.webhook_url) return { status: 'skipped', detail: 'No webhook address is set' };
  if (!isSafeWebhookUrl(company.webhook_url)) return { status: 'failed', detail: 'The webhook address is not allowed' };
  const body = JSON.stringify({ event, createdAt: new Date().toISOString(), data });
  try {
    const res = await fetch(company.webhook_url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        'Content-Type': 'application/json',
        'X-Authenticator-Event': event,
        'X-Authenticator-Signature': sign(company.webhook_secret || '', body)
      },
      body
    });
    if (!res.ok) return { status: 'failed', detail: `The receiver answered with status ${res.status}` };
    return { status: 'sent' };
  } catch (e) {
    return { status: 'failed', detail: e.message || 'Could not reach the webhook address' };
  }
}

/* ---------- Email (optional; needs SMTP settings on the server) ---------- */
let transporter = null;

function emailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

async function sendEmail(to, subject, text) {
  if (!to) return { status: 'skipped', detail: 'No alert email is set' };
  if (!emailConfigured()) return { status: 'skipped', detail: 'Email is not set up on the server yet' };
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (e) { return { status: 'failed', detail: 'The email library is not installed' }; }
  try {
    if (!transporter) {
      const port = Number(process.env.SMTP_PORT || 587);
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: String(process.env.SMTP_SECURE || '') === 'true' || port === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
      });
    }
    await transporter.sendMail({ from: process.env.SMTP_FROM, to, subject, text });
    return { status: 'sent' };
  } catch (e) {
    return { status: 'failed', detail: e.message };
  }
}

/* ---------- Delivery ---------- */
async function deliver(company, event, subject, text, data) {
  const [webhook, email] = await Promise.all([
    sendWebhook(company, event, data),
    sendEmail(company.alert_email, subject, text)
  ]);
  return { webhook, email };
}

function recordNotification(companyId, unitCode, type, message) {
  db.prepare(
    'INSERT INTO notifications (company_id, unit_code, type, message, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(companyId, unitCode, type, message, Date.now());
}

// A unit just became (or gained another reason to be) flagged.
// Saved in the dashboard straight away; email and webhook go out in the background.
function notifyFlag(company, unit, batch, reasons) {
  const message =
    `Needs attention: ${batch.product_name}, serial ${unit.serial_number} (code ${unit.code}). ` +
    reasons.map(r => r.text).join('; ') + '.';
  recordNotification(company.id, unit.code, 'flag', message);

  const data = {
    code: unit.code,
    serialNumber: unit.serial_number,
    productName: batch.product_name,
    batchNumber: batch.batch_number,
    reasons: reasons.map(r => ({ code: r.code, text: r.text }))
  };
  deliver(company, 'unit.flagged', `Alert: ${batch.product_name} needs attention`, message, data)
    .catch(e => console.error('Alert delivery failed:', e.message));
}

// A distributor or retailer recorded a unit outside the batch's sales area.
function notifyDiversion(company, unit, batch, partner, action, km) {
  const where = batch.sales_label ? ` (${batch.sales_label})` : '';
  const message =
    `Out of area: ${partner.name} (${partner.role}) recorded "${action}" for ${batch.product_name}, ` +
    `serial ${unit.serial_number}, about ${km} km outside its sales area${where}.`;
  recordNotification(company.id, unit.code, 'diversion', message);

  const data = {
    code: unit.code,
    serialNumber: unit.serial_number,
    productName: batch.product_name,
    batchNumber: batch.batch_number,
    partner: partner.name,
    role: partner.role,
    action,
    kmOutsideArea: km
  };
  deliver(company, 'unit.out_of_area', `Alert: ${batch.product_name} outside its sales area`, message, data)
    .catch(e => console.error('Alert delivery failed:', e.message));
}

module.exports = {
  isSafeWebhookUrl, newWebhookSecret, sign,
  sendWebhook, sendEmail, emailConfigured,
  deliver, recordNotification, notifyFlag, notifyDiversion
};
