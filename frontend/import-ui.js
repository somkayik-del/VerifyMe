/* Import units from a spreadsheet (CSV). Loaded after app.js.
   The file is read in the browser; only rows are sent to the server, a few hundred at a time. */

let imp = null;          // { fileName, headers, data }  the chosen file
let impPlan = null;      // { rows, skipExisting }       ready to import
let impResults = new Map(); // "batch|serial" -> code

const IMP_MAX_ROWS = 50000;

/* ---------- reading the file ---------- */
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  // Excel in some countries uses ; or tabs instead of commas.
  const first = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
  const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const sep = counts[delim] > 0 ? delim : ',';

  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const norm = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const GUESS = {
  serial: ['serial', 'serialnumber', 'serialno', 'serialnum', 'sn', 'unitserial', 'unitid', 'unitno', 'itemserial'],
  batch: ['batch', 'batchnumber', 'batchno', 'batchnum', 'lot', 'lotnumber', 'lotno', 'productionbatch'],
  product: ['product', 'productname', 'item', 'itemname', 'description', 'name'],
  date: ['date', 'manufacturingdate', 'mfgdate', 'mfg', 'productiondate', 'manufactured', 'dateofmanufacture']
};
function guessColumn(headers, kind) {
  const h = headers.map(norm);
  let i = h.findIndex(x => GUESS[kind].includes(x));
  if (i < 0) { const key = { serial: 'serial', batch: 'batch', product: 'product', date: 'date' }[kind]; i = h.findIndex(x => x.includes(key)); }
  if (i < 0 && kind === 'batch') i = h.findIndex(x => x.includes('lot'));
  return i;
}

/* ---------- dates ---------- */
function splitDate(v) {
  const p = String(v).trim().split(/[ T]/)[0].split(/[-/.]/);
  return p.length === 3 && p.every(x => /^\d+$/.test(x)) ? p : null;
}
function detectDateMode(values) {
  let iso = 0, dmy = false, mdy = false;
  for (const v of values) {
    const p = splitDate(v);
    if (!p) continue;
    if (p[0].length === 4) { iso++; continue; }
    if (+p[0] > 12) dmy = true; else if (+p[1] > 12) mdy = true;
  }
  if (iso > 0 && !dmy && !mdy) return 'ymd';
  return mdy && !dmy ? 'mdy' : 'dmy';
}
function normalizeDate(v, mode) {
  const p = splitDate(v);
  if (!p) return String(v).trim();
  let y, m, d;
  if (p[0].length === 4) { y = p[0]; m = p[1]; d = p[2]; }
  else if (mode === 'mdy') { m = p[0]; d = p[1]; y = p[2]; }
  else { d = p[0]; m = p[1]; y = p[2]; }
  if (y.length === 2) y = '20' + y;
  if (y.length !== 4) return String(v).trim();
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const DATE_MODES = { ymd: 'Year-Month-Day (2026-07-31)', dmy: 'Day/Month/Year (31/07/2026)', mdy: 'Month/Day/Year (07/31/2026)' };

/* ---------- step 1: choose the file ---------- */
async function impFileChosen(input) {
  const setup = document.getElementById('impSetup');
  document.getElementById('impOut').innerHTML = '';
  impPlan = null;
  const file = input.files && input.files[0];
  if (!file) { imp = null; setup.innerHTML = ''; return; }
  try {
    const rows = parseCsv(await file.text());
    if (rows.length < 2) { imp = null; setup.innerHTML = '<p class="error-text">That file has no rows. The first row should be the column names, followed by one row per unit.</p>'; return; }
    if (rows.length - 1 > IMP_MAX_ROWS) { imp = null; setup.innerHTML = `<p class="error-text">That file has more than ${IMP_MAX_ROWS.toLocaleString()} rows. Please split it into smaller files.</p>`; return; }
    imp = { fileName: file.name, headers: rows[0].map(h => h.trim()), data: rows.slice(1) };
    impRenderSetup();
  } catch (e) {
    imp = null;
    setup.innerHTML = '<p class="error-text">That file could not be read. Save it as CSV (not .xlsx) and try again.</p>';
  }
}

function impOptions(selected, allowNone) {
  return (allowNone ? '<option value="">— not in my file —</option>' : '<option value="">Choose a column…</option>') +
    imp.headers.map((h, i) => `<option value="${i}" ${String(i) === String(selected) ? 'selected' : ''}>${escapeHTML(h || 'Column ' + (i + 1))}</option>`).join('');
}

function impRenderSetup() {
  const g = k => guessColumn(imp.headers, k);
  const dateCol = g('date');
  const mode = dateCol >= 0 ? detectDateMode(imp.data.map(r => r[dateCol] || '')) : 'ymd';
  document.getElementById('impSetup').innerHTML = `
    <p class="small-note"><strong>${escapeHTML(imp.fileName)}</strong>: ${imp.data.length.toLocaleString()} rows. Tell us which column is which.</p>
    <div class="row2">
      <div class="field"><label class="field-label">Serial number column *</label>
        <select id="impSerial">${impOptions(g('serial'), false)}</select></div>
      <div class="field"><label class="field-label">Batch / lot column</label>
        <select id="impBatchCol" onchange="impToggle()">${impOptions(g('batch'), true)}</select>
        <input type="text" id="impBatchFixed" placeholder="Batch number for every row" maxlength="40" style="margin-top:6px;"></div>
    </div>
    <div class="row2">
      <div class="field"><label class="field-label">Product name column</label>
        <select id="impProductCol" onchange="impToggle()">${impOptions(g('product'), true)}</select>
        <input type="text" id="impProductFixed" placeholder="Product name for every row" maxlength="120" style="margin-top:6px;"></div>
      <div class="field"><label class="field-label">Manufacturing date column</label>
        <select id="impDateCol" onchange="impToggle()">${impOptions(dateCol, true)}</select>
        <input type="date" id="impDateFixed" style="margin-top:6px;">
        <select id="impDateFormat" style="margin-top:6px;">
          ${Object.entries(DATE_MODES).map(([k, v]) => `<option value="${k}" ${k === mode ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
    </div>
    <label class="check-row"><input type="checkbox" id="impSkip" checked>
      <span>If a unit already has a code, keep that code instead of making an error. Leave this ticked to finish an import that was interrupted, or to get a fresh results file.</span></label>
    <div class="alert-actions"><button class="btn" onclick="impCheck()">Check my file</button></div>`;
  impToggle();
}

function impToggle() {
  const show = (id, on) => { document.getElementById(id).style.display = on ? '' : 'none'; };
  show('impBatchFixed', document.getElementById('impBatchCol').value === '');
  show('impProductFixed', document.getElementById('impProductCol').value === '');
  const hasDate = document.getElementById('impDateCol').value !== '';
  show('impDateFixed', !hasDate);
  show('impDateFormat', hasDate);
}

/* ---------- step 2: check ---------- */
function impBuildRows() {
  const v = id => document.getElementById(id).value;
  const col = id => (v(id) === '' ? -1 : Number(v(id)));
  const cSerial = col('impSerial'), cBatch = col('impBatchCol'), cProduct = col('impProductCol'), cDate = col('impDateCol');
  const mode = v('impDateFormat');
  const rows = [], errors = [], seen = new Set();

  imp.data.forEach((cells, i) => {
    const n = i + 2; // the row number as it looks in a spreadsheet
    const get = c => (c >= 0 ? String(cells[c] === undefined ? '' : cells[c]).trim() : '');
    const row = {
      n,
      serial: get(cSerial),
      batch: cBatch >= 0 ? get(cBatch) : v('impBatchFixed').trim(),
      product: cProduct >= 0 ? get(cProduct) : v('impProductFixed').trim(),
      date: cDate >= 0 ? normalizeDate(get(cDate), mode) : v('impDateFixed').trim(),
      cells
    };
    if (row.serial && row.batch) {
      const key = row.batch.toLowerCase() + '\u0000' + row.serial.toLowerCase();
      if (seen.has(key)) { errors.push({ row: n, message: `Serial "${row.serial}" appears more than once in batch ${row.batch}.` }); return; }
      seen.add(key);
    }
    rows.push(row);
  });
  return { rows, errors };
}

const bare = r => ({ n: r.n, product: r.product, batch: r.batch, date: r.date, serial: r.serial });

async function impCheck() {
  const out = document.getElementById('impOut');
  if (document.getElementById('impSerial').value === '') {
    out.innerHTML = '<p class="error-text">Choose which column holds the serial numbers.</p>';
    return;
  }
  const skipExisting = document.getElementById('impSkip').checked;
  const built = impBuildRows();
  out.innerHTML = '<p class="small-note">Checking your file…</p>';

  let errors = built.errors.slice(), errorCount = built.errors.length;
  let alreadyThere = 0, toCreate = 0;
  const warnings = new Set();
  const newB = new Map(), oldB = new Map();
  try {
    for (let i = 0; i < built.rows.length; i += 2000) {
      const r = await api('/company/import/check', {
        method: 'POST',
        body: JSON.stringify({ rows: built.rows.slice(i, i + 2000).map(bare), skipExisting })
      });
      errorCount += r.errorCount; errors = errors.concat(r.errors);
      alreadyThere += r.alreadyThere; toCreate += r.toCreate;
      (r.warnings || []).forEach(w => warnings.add(w));
      r.newBatches.forEach(b => { const k = b.batch.toLowerCase(); const x = newB.get(k) || { ...b, rows: 0 }; x.rows += b.rows; newB.set(k, x); });
      r.existingBatches.forEach(b => { const k = b.batch.toLowerCase(); const x = oldB.get(k) || { ...b, rows: 0 }; x.rows += b.rows; oldB.set(k, x); });
    }
  } catch (e) {
    if (e.status === 401) { setSession(null); renderCompanyView(); return; }
    out.innerHTML = `<p class="error-text">${escapeHTML(e.message)}</p>`;
    return;
  }

  if (errorCount > 0) {
    errors.sort((a, b) => a.row - b.row);
    out.innerHTML = `<div class="claim-banner bad">${errorCount.toLocaleString()} problem${errorCount === 1 ? '' : 's'} found. Nothing has been created.</div>
      <ul class="imp-problems">${errors.slice(0, 20).map(e => `<li>Row ${e.row}: ${escapeHTML(e.message)}</li>`).join('')}</ul>
      ${errorCount > 20 ? `<p class="small-note">…and ${(errorCount - 20).toLocaleString()} more.</p>` : ''}
      <p class="small-note">Fix these in your spreadsheet, save it as CSV, and choose the file again. Row numbers match the rows in your spreadsheet (row 1 is the column names).</p>`;
    return;
  }

  impPlan = { rows: built.rows, skipExisting };
  const list = m => [...m.values()].slice(0, 5).map(b => `${escapeHTML(b.batch)} (${b.rows.toLocaleString()})`).join(', ') + (m.size > 5 ? `, and ${m.size - 5} more` : '');
  const sample = built.rows.slice(0, 3).map(r => `<tr><td>${escapeHTML(r.serial)}</td><td>${escapeHTML(r.batch)}</td><td>${escapeHTML(r.product)}</td><td>${escapeHTML(r.date)}</td></tr>`).join('');
  out.innerHTML = `
    <div class="claim-banner good">${toCreate === 0 ? 'Every row in your file already has a code.' : `Your file looks good. ${toCreate.toLocaleString()} new code${toCreate === 1 ? '' : 's'} will be created.`}</div>
    <div class="claim-details">
      ${[...warnings].slice(0, 5).map(w => `<div class="imp-warn">⚠ ${escapeHTML(w)}</div>`).join('')}
      ${newB.size ? `<div>New batches: ${list(newB)}</div>` : ''}
      ${oldB.size ? `<div>Existing batches: ${list(oldB)}</div>` : ''}
      ${alreadyThere ? `<div>${alreadyThere.toLocaleString()} row${alreadyThere === 1 ? ' already has' : 's already have'} a code. They are kept and included in your results file.</div>` : ''}
      <div>How your first rows will be read (check the dates):</div>
      <table class="imp-table"><thead><tr><th>Serial</th><th>Batch</th><th>Product</th><th>Date</th></tr></thead><tbody>${sample}</tbody></table>
    </div>
    <div class="alert-actions"><button class="btn" onclick="impRun()">${toCreate === 0 ? 'Get my codes file' : `Create ${toCreate.toLocaleString()} code${toCreate === 1 ? '' : 's'}`}</button></div>`;
}

/* ---------- step 3: import ---------- */
const impKey = (batch, serial) => String(batch).toLowerCase() + '|' + String(serial).toLowerCase();

async function impRun() {
  const plan = impPlan;
  if (!plan) return;
  const out = document.getElementById('impOut');
  impResults = new Map();
  let done = 0, created = 0, kept = 0, newBatches = 0;
  try {
    for (let i = 0; i < plan.rows.length; i += 500) {
      const chunk = plan.rows.slice(i, i + 500);
      out.innerHTML = `<p class="small-note">Creating codes… ${done.toLocaleString()} of ${plan.rows.length.toLocaleString()} done. Please keep this page open.</p>`;
      const r = await api('/company/import/commit', {
        method: 'POST',
        body: JSON.stringify({ rows: chunk.map(bare), skipExisting: plan.skipExisting })
      });
      r.created.concat(r.existing).forEach(c => impResults.set(impKey(c.batch, c.serial), c.code));
      created += r.created.length; kept += r.existing.length; newBatches += r.batchesCreated;
      done += chunk.length;
    }
  } catch (e) {
    if (e.status === 401) { setSession(null); renderCompanyView(); return; }
    out.innerHTML = `<div class="claim-banner bad">The import stopped after ${done.toLocaleString()} of ${plan.rows.length.toLocaleString()} rows.</div>
      <p class="error-text">${escapeHTML(e.message)}</p>
      <p class="small-note">Nothing is lost: choose the same file again and check it. Rows that already have codes are kept, so only the rest are created.</p>
      ${impResults.size ? '<div class="alert-actions"><button class="btn secondary" onclick="impDownload()">Download the codes created so far</button></div>' : ''}`;
    renderCompanyView();
    return;
  }
  impPlan = null;
  out.innerHTML = `<div class="claim-banner good">Done. ${created === 0 ? 'No new codes were needed' : `${created.toLocaleString()} code${created === 1 ? '' : 's'} created`}${newBatches ? ` in ${newBatches} new batch${newBatches === 1 ? '' : 'es'}` : ''}${kept ? `, ${kept.toLocaleString()} kept as they were` : ''}.</div>
    <p class="small-note">Download your file back with a <strong>Code</strong> and a <strong>QR link</strong> added to every row. Load it into your own system or send it to whoever prints the labels.</p>
    <div class="alert-actions"><button class="btn" onclick="impDownload()">Download codes (CSV)</button></div>`;
  renderCompanyView();
}

/* ---------- download: the company's own file, plus the codes ---------- */
function impCell(v) {
  let s = String(v === undefined || v === null ? '' : v);
  if (/^[=@\t\r]/.test(s) || /^[+-][^0-9.\s]/.test(s)) s = "'" + s; // stop spreadsheet formulas
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function impDownload() {
  if (!imp) return;
  const built = impBuildRows();
  const fixedBatch = document.getElementById('impBatchCol').value === '';
  const header = imp.headers.concat(fixedBatch ? ['Batch'] : [], ['Code', 'QR link']);
  const lines = [header.map(impCell).join(',')];
  const seen = new Set();
  built.rows.forEach(r => {
    const code = impResults.get(impKey(r.batch, r.serial)) || '';
    if (!code) return; // not created (should not happen after a full import)
    seen.add(r.n);
    const cells = imp.headers.map((_, i) => (r.cells[i] === undefined ? '' : r.cells[i]));
    const link = `${location.origin}/api/units/${encodeURIComponent(code)}/qr.png`;
    lines.push(cells.concat(fixedBatch ? [r.batch] : [], [code, link]).map(impCell).join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'codes-' + imp.fileName.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]/g, '_') + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
