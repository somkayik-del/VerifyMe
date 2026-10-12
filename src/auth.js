const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET is not set. Set it in your environment variables before going live.');
}

function signToken(companyId) {
  return jwt.sign({ companyId }, JWT_SECRET, { expiresIn: '30d' });
}

// Reads "Authorization: Bearer <token>", attaches req.companyId, or 401s.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing or invalid Authorization header.' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
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

module.exports = { signToken, requireAuth };
