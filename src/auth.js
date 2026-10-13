const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET is not set. Set it in your environment variables before going live.');
}

function signToken(companyId) {
  return jwt.sign({ companyId }, JWT_SECRET, { expiresIn: '30d' });
}

// Distributors and retailers get their own kind of token.
function signPartnerToken(partnerId) {
  return jwt.sign({ partnerId, kind: 'partner' }, JWT_SECRET, { expiresIn: '14d' });
}

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// Reads "Authorization: Bearer <token>", attaches req.companyId, or 401s.
function requireAuth(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Missing or invalid Authorization header.' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session — please log in again.' });
  }
  if (!payload.companyId) {
    return res.status(401).json({ error: 'Invalid or expired session — please log in again.' });
  }

  // The token can be valid even if the company no longer exists (for example
  // after the database was replaced). Catch that here so it logs the person
  // out cleanly instead of crashing later with a FOREIGN KEY error.
  const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(payload.companyId);
  if (!company) {
    return res.status(401).json({ error: 'This account no longer exists — please register or log in again.' });
  }

  req.companyId = payload.companyId;
  next();
}

// For the distributor / retailer portal. Attaches req.partner.
function requirePartner(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Please log in with your access code.' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Your session expired — please log in again.' });
  }
  if (!payload.partnerId) {
    return res.status(401).json({ error: 'Your session expired — please log in again.' });
  }

  const partner = db.prepare(
    `SELECT p.*, c.name AS company_name
     FROM partners p JOIN companies c ON c.id = p.company_id
     WHERE p.id = ? AND p.active = 1`
  ).get(payload.partnerId);
  if (!partner) {
    return res.status(401).json({ error: 'This access has been switched off — please contact the manufacturer.' });
  }

  req.partner = partner;
  next();
}

module.exports = { signToken, signPartnerToken, requireAuth, requirePartner };
