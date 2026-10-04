const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(companyId) {
  return jwt.sign({ companyId }, JWT_SECRET, { expiresIn: '30d' });
}

// Reads "Authorization: Bearer <token>", attaches req.companyId, or 401s.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing or invalid Authorization header.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.companyId = payload.companyId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session — please log in again.' });
  }
}

module.exports = { signToken, requireAuth };
