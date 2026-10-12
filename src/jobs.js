const db = require('./db');

const DAY = 24 * 60 * 60 * 1000;

// Precise locations are personal data, so old scans are deleted automatically.
// SCAN_RETENTION_DAYS defaults to 365; set it to 0 to keep scans forever.
function purge() {
  const days = Number(process.env.SCAN_RETENTION_DAYS === undefined ? 365 : process.env.SCAN_RETENTION_DAYS);
  if (days > 0) {
    const r = db.prepare('DELETE FROM scans WHERE at < ?').run(Date.now() - days * DAY);
    if (r.changes) console.log(`Cleanup: deleted ${r.changes} scan(s) older than ${days} days`);
  }
  db.prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?').run(Date.now() - 90 * DAY);
}

function start() {
  const run = () => { try { purge(); } catch (e) { console.error('Cleanup failed:', e.message); } };
  run();
  const timer = setInterval(run, DAY);
  if (timer.unref) timer.unref();
}

module.exports = { start, purge };
