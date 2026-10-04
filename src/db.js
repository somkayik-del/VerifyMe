const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
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

module.exports = db;
