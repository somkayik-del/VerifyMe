const crypto = require('crypto');
const { randomCodePart } = require('./helpers');

const KEY_PREFIX = 'pa_live_';

// e.g. pa_live_K7M2QX9R4TWB... (about 160 bits of randomness)
function generateKey() {
  return KEY_PREFIX + randomCodePart(32);
}

// Only a hash is stored, like a password.
function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

module.exports = { KEY_PREFIX, generateKey, hashKey };
