// Turns rows into CSV text that opens cleanly in Excel and Google Sheets.
// Text that starts with = + - @ could be run as a formula by a spreadsheet,
// so it gets a leading apostrophe. Real numbers (like -1.5) are left alone.
function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(rows) {
  return '\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

function sendCsv(res, filename, rows) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(rows));
}

module.exports = { cell, toCsv, sendCsv };
