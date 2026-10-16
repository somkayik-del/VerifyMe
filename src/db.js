const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Where to keep the database file. Order of preference:
//  1. DB_PATH, if you set it
//  2. the folder of a Railway volume, if one is attached
//  3. a local file next to the code (fine on your own computer, but Railway
//     erases it on every deploy)
const volumeDir = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DB_PATH =
  process.env.DB_PATH ||
  (volumeDir ? path.join(volumeDir, 'data.db') : path.join(__dirname, '..', 'data.db'));

// Create the folder if it's missing so the app never crashes on startup.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

console.log('Database file:', DB_PATH);
if ((process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME) && !volumeDir) {
  console.warn('WARNING: no Railway volume is attached. The database will be erased on every deploy.');
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
// COLLATE NOCASE on names/codes makes lookups and uniqueness checks
// case-insensitive ("Peak Milk" and "peak milk" collide), which matches
// how people will actually type these in the real world.

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin_hash   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS batches (
    id                 TEXT PRIMARY KEY,
    company_id         TEXT NOT NULL REFERENCES companies(id),
    batch_number       TEXT NOT NULL COLLATE NOCASE,
    product_name       TEXT NOT NULL,
    manufacturing_date TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    UNIQUE(company_id, batch_number)
  );

  CREATE TABLE IF NOT EXISTS units (
    code               TEXT PRIMARY KEY,
    company_id         TEXT NOT NULL REFERENCES companies(id),
    batch_id           TEXT NOT NULL REFERENCES batches(id),
    serial_number      TEXT NOT NULL COLLATE NOCASE,
    verify_count       INTEGER NOT NULL DEFAULT 0,
    last_verified_at   INTEGER,
    created_at         INTEGER NOT NULL,
    last_flag_velocity INTEGER NOT NULL DEFAULT 0,
    last_flag_geo      INTEGER NOT NULL DEFAULT 0,
    last_flag_detail   TEXT,
    UNIQUE(batch_id, serial_number)
  );

  CREATE TABLE IF NOT EXISTS scans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_code  TEXT NOT NULL REFERENCES units(code),
    at         INTEGER NOT NULL,
    lat        REAL,
    lng        REAL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL REFERENCES companies(id),
    unit_code  TEXT,
    type       TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at    INTEGER
  );

  -- Distributors and retailers a company lets scan products as they pass through.
  CREATE TABLE IF NOT EXISTS partners (
    id          TEXT PRIMARY KEY,
    company_id  TEXT NOT NULL REFERENCES companies(id),
    name        TEXT NOT NULL COLLATE NOCASE,
    role        TEXT NOT NULL,
    access_hash TEXT NOT NULL UNIQUE,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    last_seen_at INTEGER,
    UNIQUE(company_id, name)
  );

  -- Chain of custody: every time a partner records a unit moving.
  CREATE TABLE IF NOT EXISTS custody_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id  TEXT NOT NULL REFERENCES companies(id),
    partner_id  TEXT NOT NULL REFERENCES partners(id),
    unit_code   TEXT NOT NULL REFERENCES units(code),
    action      TEXT NOT NULL,
    at          INTEGER NOT NULL,
    lat         REAL,
    lng         REAL,
    accuracy    REAL,
    out_of_area INTEGER NOT NULL DEFAULT 0,
    reviewed_at INTEGER
  );

  -- Keys that let a company's own systems (ERP, online shop) use the API.
  CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,
    company_id   TEXT NOT NULL REFERENCES companies(id),
    label        TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    key_prefix   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_scans_unit_code_at ON scans(unit_code, at);
  CREATE INDEX IF NOT EXISTS idx_batches_company ON batches(company_id);
  CREATE INDEX IF NOT EXISTS idx_units_batch ON units(batch_id);
`);

// --- Upgrades for databases created by earlier versions ---
// Safe to run every start: a column is only added if it isn't there yet,
// and existing data is never touched.
function addColumnIfMissing(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// scans: who/where
addColumnIfMissing('scans', 'device_id', 'TEXT');      // anonymous per-browser ID
addColumnIfMissing('scans', 'accuracy', 'REAL');       // location error radius, metres

// units: last scan + duplicate-flag state
addColumnIfMissing('units', 'last_lat', 'REAL');
addColumnIfMissing('units', 'last_lng', 'REAL');
addColumnIfMissing('units', 'last_accuracy', 'REAL');
addColumnIfMissing('units', 'flag_status', 'TEXT');    // NULL | 'open' | 'reviewed' | 'confirmed'
addColumnIfMissing('units', 'flag_reasons', 'TEXT');   // JSON: [{ code, text }]
addColumnIfMissing('units', 'flagged_at', 'INTEGER');
addColumnIfMissing('units', 'reviewed_at', 'INTEGER');
addColumnIfMissing('units', 'review_outcome', 'TEXT'); // 'cleared' | 'confirmed'
addColumnIfMissing('units', 'review_note', 'TEXT');

// companies: where to send alerts
addColumnIfMissing('companies', 'alert_email', 'TEXT');
addColumnIfMissing('companies', 'webhook_url', 'TEXT');
addColumnIfMissing('companies', 'webhook_secret', 'TEXT');

// batches: where this batch is meant to be sold (optional)
addColumnIfMissing('batches', 'sales_lat', 'REAL');
addColumnIfMissing('batches', 'sales_lng', 'REAL');
addColumnIfMissing('batches', 'sales_radius_km', 'REAL');
addColumnIfMissing('batches', 'sales_label', 'TEXT');

// companies: assumptions for the impact estimate
addColumnIfMissing('companies', 'roi_currency', 'TEXT');
addColumnIfMissing('companies', 'roi_price', 'REAL');
addColumnIfMissing('companies', 'roi_fake_units', 'REAL');
addColumnIfMissing('companies', 'roi_substitution_pct', 'REAL');
addColumnIfMissing('companies', 'roi_monthly_cost', 'REAL');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_api_keys_company ON api_keys(company_id);
  CREATE INDEX IF NOT EXISTS idx_custody_unit ON custody_events(unit_code, at);
  CREATE INDEX IF NOT EXISTS idx_custody_partner ON custody_events(partner_id, at);
  CREATE INDEX IF NOT EXISTS idx_custody_company_area ON custody_events(company_id, out_of_area, reviewed_at);
  CREATE INDEX IF NOT EXISTS idx_partners_company ON partners(company_id);
  CREATE INDEX IF NOT EXISTS idx_scans_unit_device ON scans(unit_code, device_id, at);
  CREATE INDEX IF NOT EXISTS idx_notifications_company ON notifications(company_id, read_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_units_company_flag ON units(company_id, flag_status);
`);

// Product registration, warranty and rewards were removed. If this database was created by a
// version that had them, remove what they left behind. Customer details are never thrown away
// automatically: the old table is only dropped when it is empty.
try {
  const oldTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registrations'").get();
  if (oldTable) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n;
    if (n === 0 || process.env.DROP_OLD_REGISTRATIONS === 'yes') {
      db.exec('DROP TABLE registrations');
      if (n > 0) console.log(`Removed ${n} old product registration(s), as you asked.`);
    } else {
      console.log(`Note: ${n} old product registration(s) are still stored. The feature has been removed, so nothing uses them. To delete them, set the variable DROP_OLD_REGISTRATIONS to yes, restart once, then remove the variable.`);
    }
  }
  const companyCols = db.prepare('PRAGMA table_info(companies)').all().map(c => c.name);
  for (const col of ['warranty_months', 'reward_text']) {
    if (companyCols.includes(col)) db.exec(`ALTER TABLE companies DROP COLUMN ${col}`);
  }
} catch (e) {
  console.warn('Could not tidy up old registration data:', e.message);
}

module.exports = db;
