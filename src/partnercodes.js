const crypto = require('crypto');
const { randomCodePart } = require('./helpers');

const ROLES = ['distributor', 'retailer'];

// What each kind of partner can record.
const ROLE_ACTIONS = {
  distributor: ['received', 'shipped'],
  retailer: ['received', 'stocked', 'sold']
};
const ACTION_LABELS = {
  received: 'Received',
  shipped: 'Shipped on',
  stocked: 'Put on shelf',
  sold: 'Sold to customer'
};

function normalize(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Access codes are stored only as a hash, like passwords.
function hashAccessCode(code) {
  return crypto.createHash('sha256').update(normalize(code)).digest('hex');
}

// e.g. K7M2-QX9R-4TWB (12 characters, no look-alike letters)
function newAccessCode() {
  const raw = randomCodePart(12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

module.exports = { ROLES, ROLE_ACTIONS, ACTION_LABELS, normalize, hashAccessCode, newAccessCode };
