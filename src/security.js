// Small in-memory protections. They reset when the server restarts, which is
// fine for slowing down abuse; they are not a replacement for a firewall.

function clientIp(req) {
  return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

// Allow at most `max` requests per `windowMs` for each key.
function createLimiter({ windowMs, max, keyFn = clientIp, message }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, 60000);
  if (sweep.unref) sweep.unref();

  return function limiter(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests. Please slow down and try again shortly.' });
    }
    next();
  };
}

// Counts failures per key; after `maxFailures` inside `windowMs` the key is
// blocked for `blockMs`.
function createBlocker({ windowMs, maxFailures, blockMs }) {
  const state = new Map();
  return {
    // seconds still blocked, or 0
    isBlocked(key) {
      const e = state.get(key);
      if (!e || !e.blockedUntil) return 0;
      const left = e.blockedUntil - Date.now();
      if (left <= 0) { state.delete(key); return 0; }
      return Math.ceil(left / 1000);
    },
    fail(key) {
      const now = Date.now();
      let e = state.get(key);
      if (!e || (!e.blockedUntil && now - e.firstAt > windowMs)) e = { count: 0, firstAt: now, blockedUntil: 0 };
      e.count++;
      if (e.count >= maxFailures) { e.blockedUntil = now + blockMs; e.count = 0; }
      state.set(key, e);
    },
    clear(key) { state.delete(key); }
  };
}

/* ---------- General limits ---------- */
const apiLimiter = createLimiter({ windowMs: 60000, max: 300 });
const verifyLimiter = createLimiter({ windowMs: 60000, max: 60 });
const registerLimiter = createLimiter({
  windowMs: 60 * 60000, max: 10,
  message: 'Too many accounts were created from this connection. Please try again later.'
});

/* ---------- Log-in protection ---------- */
// 5 wrong attempts for the same name from the same connection -> 15 minute pause.
const loginBlocker = createBlocker({ windowMs: 15 * 60000, maxFailures: 5, blockMs: 15 * 60000 });
const loginIpBlocker = createBlocker({ windowMs: 15 * 60000, maxFailures: 30, blockMs: 15 * 60000 });

function loginGuard(req, res, next) {
  const ip = clientIp(req);
  const name = String((req.body && req.body.name) || '').trim().toLowerCase();
  const key = `${ip}|${name}`;
  const wait = Math.max(loginBlocker.isBlocked(key), loginIpBlocker.isBlocked(ip));
  if (wait) {
    return res.status(429).json({
      error: `Too many failed log-in attempts. Please try again in ${Math.ceil(wait / 60)} minute(s).`
    });
  }
  res.on('finish', () => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      loginBlocker.fail(key);
      loginIpBlocker.fail(ip);
    } else if (res.statusCode >= 200 && res.statusCode < 300) {
      loginBlocker.clear(key);
    }
  });
  next();
}

const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '11111111', '00000000', '87654321',
  'password', 'password1', 'qwertyui', 'qwerty123', 'iloveyou'
]);

// The API field is still called "pin" so the existing route keeps working,
// but the page now asks for a password of at least 8 characters.
function registerRules(req, res, next) {
  const pin = String((req.body && req.body.pin) || '');
  if (pin.length < 8) {
    return res.status(400).json({ error: 'Choose a password of at least 8 characters.' });
  }
  if (WEAK_PASSWORDS.has(pin.toLowerCase())) {
    return res.status(400).json({ error: 'That password is too easy to guess. Choose a different one.' });
  }
  next();
}

/* ---------- Code-guessing protection (for /api/verify) ---------- */
// 5 unknown codes from one device in 10 minutes, or 30 from one connection,
// pauses checking for 30 minutes. (The connection limit is higher because many
// phones can share one mobile-network address.)
const deviceGuess = createBlocker({ windowMs: 10 * 60000, maxFailures: 5, blockMs: 30 * 60000 });
const ipGuess = createBlocker({ windowMs: 10 * 60000, maxFailures: 30, blockMs: 30 * 60000 });

function checkGuessBlock(deviceId, ip) {
  return Math.max(deviceGuess.isBlocked(deviceId), ipGuess.isBlocked(ip));
}
function recordInvalidCode(deviceId, ip) {
  deviceGuess.fail(deviceId);
  ipGuess.fail(ip);
}

module.exports = {
  clientIp, createLimiter, createBlocker,
  apiLimiter, verifyLimiter, registerLimiter,
  loginGuard, registerRules,
  checkGuessBlock, recordInvalidCode
};
