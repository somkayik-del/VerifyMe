// Rules for batch details, shared by the API and the spreadsheet import.
const BATCH_RE = /^[A-Za-z0-9._ -]{1,40}$/;

// A real calendar date written YYYY-MM-DD (so 2026-02-30 is refused).
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
}

module.exports = { BATCH_RE, validDate };
