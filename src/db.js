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

  CREATE INDEX IF NOT EXISTS idx_scans_unit_code_at ON scans(unit_code, at);
  CREATE INDEX IF NOT EXISTS idx_batches_company ON batches(company_id);
  CREATE INDEX IF NOT EXISTS idx_units_batch ON units(batch_id);
`);

// --- Upgrades for databases created before the device/location rules ---
// Safe to run every start: a column is only added if it isn't there yet,
// and existing data is never touched.
function addColumnIfMissing(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('scans', 'device_id', 'TEXT');      // anonymous per-browser ID
addColumnIfMissing('scans', 'accuracy', 'REAL');       // location error radius, metres
addColumnIfMissing('units', 'last_lat', 'REAL');       // where the last scan happened
addColumnIfMissing('units', 'last_lng', 'REAL');
addColumnIfMissing('units', 'last_accuracy', 'REAL');

db.exec('CREATE INDEX IF NOT EXISTS idx_scans_unit_device ON scans(unit_code, device_id, at)');

module.exports = db;
