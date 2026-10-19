/* Same-origin backend — the server serves this file, so relative paths work
   whether you're on localhost or a real deployed domain. */
const API_BASE = '/api';

/* ---------- session ---------- */
let session = null; // { token, company: { id, name } }
try {
  const saved = localStorage.getItem('pa_session');
  if (saved) session = JSON.parse(saved);
} catch (e) {}

function setSession(data) {
  session = data;
  try {
    if (session) localStorage.setItem('pa_session', JSON.stringify(session));
    else localStorage.removeItem('pa_session');
  } catch (e) {}
  updateTabs();
}

// The company portal is not advertised to shoppers. Its tab only shows on the company's own
// address (/company) or while a company is logged in. The real protection is the login itself.
const ON_COMPANY_PATH = location.pathname.replace(/\/+$/, '').toLowerCase() === '/company';
function companyTabVisible() { return ON_COMPANY_PATH || !!session; }
function updateTabs() {
  const btn = document.getElementById('tabCompanyBtn');
  if (!btn) return;
  btn.style.display = companyTabVisible() ? '' : 'none';
  if (!companyTabVisible() && document.getElementById('view-company').classList.contains('active')) showView('verify');
}

// The distributor / retailer portal keeps its own login, separate from the company's.
let partnerSession = null; // { token, partner: { name, role, companyName, actions } }
try {
  const savedPartner = localStorage.getItem('pa_partner');
  if (savedPartner) partnerSession = JSON.parse(savedPartner);
} catch (e) {}

function setPartnerSession(data) {
  partnerSession = data;
  try {
    if (partnerSession) localStorage.setItem('pa_partner', JSON.stringify(partnerSession));
    else localStorage.removeItem('pa_partner');
  } catch (e) {}
}

// who: 'company' (default) or 'partner' (the Trade portal)
async function api(path, options = {}, who = 'company') {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const active = who === 'partner' ? partnerSession : session;
  if (active && active.token) headers.Authorization = 'Bearer ' + active.token;

  const res = await fetch(API_BASE + path, { ...options, headers });
  let body = {};
  try { body = await res.json(); } catch (e) {}

  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/* ---------- small helpers ---------- */
function escapeHTML(str) {
  const d = document.createElement('div');
  d.textContent = String(str === undefined || str === null ? '' : str);
  return d.innerHTML;
}
// For values placed inside HTML attributes (quotes must be escaped too).
function escapeAttr(str) {
  return escapeHTML(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatWhen(ms) { return new Date(ms).toLocaleString(); }

/* ---------- view / tab switching ---------- */
function showView(name) {
  if (name === 'company' && !companyTabVisible()) name = 'verify';
  for (const n of ['verify', 'company', 'trade']) {
    const cap = n[0].toUpperCase() + n.slice(1);
    document.getElementById('view-' + n).classList.toggle('active', n === name);
    document.getElementById('tab' + cap + 'Btn').classList.toggle('active', n === name);
  }
  if (name === 'company') renderCompanyView();
  if (name === 'trade') renderTradeView();
}
async function doLogin() {
  const name = document.getElementById('loginName').value.trim();
  const pin = document.getElementById('loginPin').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';

  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ name, pin }) });
    setSession(data);
    renderCompanyView();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

function doLogout() {
  setSession(null);
  batchesCache = []; unitsCache = {}; openBatchId = null; alertsCache = []; diversionsCache = []; salesAreaCache = {};
  renderCompanyView();
}

/* ---------- company dashboard state ---------- */
let batchesCache = [];
let openBatchId = null;
let unitsCache = {}; // batchId -> units[]
let alertsCache = [];
let diversionsCache = [];
let salesAreaCache = {}; // batchId -> { label, lat, lng, radiusKm } | null

function showDashTab(name) {
  for (const n of ['batches', 'alerts', 'partners', 'analytics', 'settings']) {
    const cap = n[0].toUpperCase() + n.slice(1);
    document.getElementById('dashPanel' + cap).style.display = n === name ? 'block' : 'none';
    document.getElementById('dashTab' + cap).classList.toggle('active', n === name);
  }
  if (name === 'alerts') loadAlerts(true);
  if (name === 'partners') loadPartners();
  if (name === 'analytics') loadAnalytics();
  if (name === 'settings') { loadSettings(); loadApiKeys(); }
}

async function renderCompanyView() {
  const authBlock = document.getElementById('authBlock');
  const dashBlock = document.getElementById('dashBlock');

  if (!session) {
    authBlock.style.display = 'block';
    dashBlock.style.display = 'none';
    return;
  }
  authBlock.style.display = 'none';
  dashBlock.style.display = 'block';
  document.getElementById('dashCompanyName').textContent = session.company.name;

  try {
    const data = await api('/batches');
    batchesCache = data.batches;
  } catch (e) {
    if (e.status === 401) { setSession(null); renderCompanyView(); return; }
    document.getElementById('batchListWrap').innerHTML = `<p class="error-text">Could not load batches: ${escapeHTML(e.message)}</p>`;
    return;
  }

  const totalUnits = batchesCache.reduce((sum, b) => sum + b.unitCount, 0);
  document.getElementById('dashCompanyMeta').textContent =
    `${batchesCache.length} batch${batchesCache.length === 1 ? '' : 'es'} · ${totalUnits} unit${totalUnits === 1 ? '' : 's'} registered`;

  await renderBatchList();
  refreshAlertBadge();
}

async function renderBatchList() {
  const wrap = document.getElementById('batchListWrap');
  if (batchesCache.length === 0) {
    wrap.innerHTML = '<p class="empty-note">No batches registered yet — add one above.</p>';
    return;
  }

  let html = '<table class="ledger"><thead><tr><th>Product</th><th>Batch #</th><th>Mfg. date</th><th>Units</th></tr></thead><tbody>';
  for (const b of batchesCache) {
    const flaggedInBatch = (unitsCache[b.id] || []).filter(u => u.flag.status === 'open' || u.flag.status === 'confirmed').length;
    html += `<tr class="batch-row" onclick="toggleBatch('${b.id}')">
      <td>${escapeHTML(b.productName)}</td>
      <td class="mono">${escapeHTML(b.batchNumber)}</td>
      <td>${escapeHTML(b.manufacturingDate)}</td>
      <td>${b.unitCount}${flaggedInBatch > 0 ? ` <span class="flag-badge">⚠ ${flaggedInBatch}</span>` : ''}</td>
    </tr>
    <tr><td colspan="4" style="padding:0;border:none;">
      <div class="units-panel ${openBatchId === b.id ? 'open' : ''}" id="unitsPanel-${b.id}">
        ${openBatchId === b.id ? renderUnitsPanelInner(b) : ''}
      </div>
    </td></tr>`;
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

async function toggleBatch(batchId) {
  openBatchId = (openBatchId === batchId) ? null : batchId;
  if (openBatchId && !unitsCache[openBatchId]) {
    await loadUnits(openBatchId);
  }
  if (openBatchId && salesAreaCache[openBatchId] === undefined) {
    await loadSalesArea(openBatchId);
  }
  await renderBatchList();
}

async function loadUnits(batchId) {
  try {
    const data = await api(`/batches/${batchId}/units`);
    unitsCache[batchId] = data.units;
  } catch (e) {
    unitsCache[batchId] = [];
  }
}

// "12 Oct 2026, 3:41 PM · 6.52410, 3.37920 (open map)" or "Not scanned yet"
function formatLastScan(u) {
  if (!u.lastVerifiedAt) return 'Not scanned yet';
  const when = formatWhen(u.lastVerifiedAt);
  if (u.lastLat == null || u.lastLng == null) return escapeHTML(when);
  const lat = Number(u.lastLat).toFixed(5);
  const lng = Number(u.lastLng).toFixed(5);
  return `${escapeHTML(when)} · <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener">${lat}, ${lng} (open map)</a>`;
}

function statusPill(status) {
  if (status === 'open') return '<span class="status-pill open">⚠ Possible duplicate</span>';
  if (status === 'confirmed') return '<span class="status-pill confirmed">✕ Confirmed copy</span>';
  if (status === 'reviewed') return '<span class="status-pill reviewed">✓ Reviewed</span>';
  return '';
}

function reviewButtons(code, status) {
  const c = escapeAttr(code);
  if (status === 'open') {
    return `<div class="unit-actions">
      <button class="btn secondary sm" data-act="cleared" data-code="${c}">False alarm</button>
      <button class="btn sm" data-act="confirmed" data-code="${c}">Confirm it's a copy</button>
    </div>`;
  }
  if (status === 'confirmed') {
    return `<div class="unit-actions"><button class="btn secondary sm" data-act="cleared" data-code="${c}">Remove confirmation</button></div>`;
  }
  return '';
}

function renderUnitsPanelInner(batch) {
  const units = unitsCache[batch.id] || [];
  let inner = batchToolsHtml(batch) + `
    <div class="row2" style="margin-bottom:10px;">
      <div>
        <label class="field-label">Add one serial number</label>
        <div style="display:flex; gap:8px;">
          <input type="text" id="serialInput-${batch.id}" placeholder="0001">
          <button class="btn secondary" onclick="addSingleUnit('${batch.id}')">Add</button>
        </div>
      </div>
      <div>
        <label class="field-label">Or generate a range</label>
        <div style="display:flex; gap:6px;">
          <input type="text" id="bulkPrefix-${batch.id}" placeholder="SN-" style="width:60px;">
          <input type="text" id="bulkStart-${batch.id}" placeholder="1" style="width:50px;">
          <input type="text" id="bulkCount-${batch.id}" placeholder="count" style="width:60px;">
          <button class="btn secondary" onclick="addBulkUnits('${batch.id}')">Generate</button>
        </div>
      </div>
    </div>
    <p class="error-text" id="unitError-${batch.id}" style="display:none;"></p>
  `;
  if (units.length === 0) {
    inner += '<p class="empty-note">No units registered in this batch yet.</p>';
  } else {
    inner += units.map(u => {
      const f = u.flag || {};
      const qr = `${API_BASE}/units/${encodeURIComponent(u.code)}/qr.png`;
      return `
      <div class="unit-card">
        <div class="qr-thumb"><img src="${qr}" alt="QR for ${escapeAttr(u.code)}"></div>
        <div style="flex:1; min-width:0;">
          <div class="unit-code">${escapeHTML(u.code)} ${statusPill(f.status)}</div>
          <div class="unit-meta">Serial ${escapeHTML(u.serialNumber)} · checked ${u.verifyCount} time${u.verifyCount === 1 ? '' : 's'}</div>
          <div class="unit-meta">Last scanned: ${formatLastScan(u)}</div>
          ${custodyLine(u.custody)}
          ${f.status === 'open' && f.reasons.length ? `<div class="unit-meta">${escapeHTML(f.reasons.join('; '))}</div>` : ''}
          ${f.note ? `<div class="unit-meta">Note: ${escapeHTML(f.note)}</div>` : ''}
          ${reviewButtons(u.code, f.status)}
          <div class="unit-actions"><button class="btn secondary sm" data-act="trail" data-code="${escapeAttr(u.code)}">Journey</button></div>
          <div class="trail-box"></div>
        </div>
        <a class="btn ghost" href="${qr}" download="${escapeAttr(u.code)}.png">Download</a>
      </div>`;
    }).join('');
  }
  return inner;
}

async function addSingleUnit(batchId) {
  const input = document.getElementById('serialInput-' + batchId);
  const errEl = document.getElementById('unitError-' + batchId);
  errEl.style.display = 'none';
  try {
    await api(`/batches/${batchId}/units`, { method: 'POST', body: JSON.stringify({ serialNumber: input.value }) });
    input.value = '';
    await loadUnits(batchId);
    await refreshBatchCounts();
    await renderBatchList();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

async function addBulkUnits(batchId) {
  const prefix = document.getElementById('bulkPrefix-' + batchId).value.trim();
  const start = document.getElementById('bulkStart-' + batchId).value.trim();
  const count = document.getElementById('bulkCount-' + batchId).value.trim();
  const errEl = document.getElementById('unitError-' + batchId);
  errEl.style.display = 'none';
  try {
    await api(`/batches/${batchId}/units`, { method: 'POST', body: JSON.stringify({ prefix, start, count }) });
    await loadUnits(batchId);
    await refreshBatchCounts();
    await renderBatchList();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

async function refreshBatchCounts() {
  try {
    const data = await api('/batches');
    batchesCache = data.batches;
  } catch (e) {}
}

/* ---------- batch creation ---------- */
async function createBatch() {
  const productName = document.getElementById('batchProduct').value.trim();
  const batchNumber = document.getElementById('batchNumber').value.trim();
  const manufacturingDate = document.getElementById('batchDate').value;
  const errEl = document.getElementById('batchError');
  errEl.style.display = 'none';

  try {
    await api('/batches', { method: 'POST', body: JSON.stringify({ productName, batchNumber, manufacturingDate }) });
    document.getElementById('batchProduct').value = '';
    document.getElementById('batchNumber').value = '';
    document.getElementById('batchDate').value = '';
    await renderCompanyView();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

/* ---------- alerts ---------- */
function setAlertBadge(count) {
  const el = document.getElementById('alertCount');
  el.textContent = count;
  el.style.display = count > 0 ? 'inline-block' : 'none';
}

function openAlertCount() {
  return alertsCache.filter(a => a.status === 'open').length + diversionsCache.length;
}

async function refreshAlertBadge() {
  try {
    const data = await api('/company/alerts');
    alertsCache = data.alerts;
    diversionsCache = data.diversions || [];
    setAlertBadge(openAlertCount());
  } catch (e) {}
}

async function loadAlerts(markRead) {
  const wrap = document.getElementById('alertsWrap');
  try {
    const data = await api('/company/alerts');
    alertsCache = data.alerts;
    diversionsCache = data.diversions || [];
    setAlertBadge(openAlertCount());
    renderAlerts();
    if (markRead && data.unread > 0) api('/company/alerts/read', { method: 'POST' }).catch(() => {});
  } catch (e) {
    if (e.status === 401) { setSession(null); renderCompanyView(); return; }
    wrap.innerHTML = `<p class="error-text">Could not load alerts: ${escapeHTML(e.message)}</p>`;
  }
}

function mapLink(lat, lng, text) {
  if (lat == null || lng == null) return '';
  return `<a href="https://www.google.com/maps?q=${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}" target="_blank" rel="noopener">${text}</a>`;
}

function renderAlerts() {
  const wrap = document.getElementById('alertsWrap');
  if (alertsCache.length === 0 && diversionsCache.length === 0) {
    wrap.innerHTML = '<p class="empty-note">No alerts. Codes that look copied, or products shipped outside their sales area, will appear here.</p>';
    return;
  }
  let html = '';

  if (alertsCache.length) {
    html += '<h4 class="an-sub">Possible duplicates</h4>';
    html += alertsCache.map(a => {
      const last = a.lastVerifiedAt
        ? `${escapeHTML(formatWhen(a.lastVerifiedAt))}${a.lastLat != null ? ' · ' + mapLink(a.lastLat, a.lastLng, 'open map') : ''}`
        : 'Not scanned yet';
      const evidence = `<button class="btn secondary sm" data-act="evidence" data-code="${escapeAttr(a.code)}">Download evidence</button>`;
      const actions = reviewButtons(a.code, a.status).replace('unit-actions', 'alert-actions').replace(/<\/div>\s*$/, evidence + '</div>');
      return `<div class="alert-card ${a.status === 'confirmed' ? 'confirmed' : ''}">
        <h4>${escapeHTML(a.productName)} · serial ${escapeHTML(a.serialNumber)} ${statusPill(a.status)}</h4>
        <div class="alert-code">${escapeHTML(a.code)}</div>
        ${a.status === 'open' && a.reasons.length ? `<ul>${a.reasons.map(r => `<li>${escapeHTML(r)}</li>`).join('')}</ul>` : ''}
        <div class="unit-meta">Batch ${escapeHTML(a.batchNumber)} · checked ${a.verifyCount} time${a.verifyCount === 1 ? '' : 's'}</div>
        <div class="unit-meta">Last scanned: ${last}</div>
        ${a.flaggedAt ? `<div class="unit-meta">Flagged: ${escapeHTML(formatWhen(a.flaggedAt))}</div>` : ''}
        ${a.note ? `<div class="unit-meta">Note: ${escapeHTML(a.note)}</div>` : ''}
        ${actions}
      </div>`;
    }).join('');
  }

  if (diversionsCache.length) {
    html += '<h4 class="an-sub">Shipped outside the sales area</h4>';
    html += diversionsCache.map(d => `<div class="alert-card">
      <h4>${escapeHTML(d.productName)} · serial ${escapeHTML(d.serialNumber)} <span class="status-pill open">Out of area</span></h4>
      <div class="alert-code">${escapeHTML(d.code)}</div>
      <ul><li>${escapeHTML(d.partner)} (${escapeHTML(d.role)}) recorded “${escapeHTML(ACTION_TEXT[d.action] || d.action)}”${d.kmOutside != null ? `, about ${d.kmOutside} km outside ${escapeHTML(d.areaLabel || 'the sales area')}` : ''}</li></ul>
      <div class="unit-meta">Batch ${escapeHTML(d.batchNumber)} · ${escapeHTML(formatWhen(d.at))} ${mapLink(d.lat, d.lng, '· open map')}</div>
      <div class="alert-actions">
        <button class="btn secondary sm" data-act="dismiss" data-id="${escapeAttr(d.id)}">Dismiss</button>
        <button class="btn secondary sm" data-act="evidence" data-code="${escapeAttr(d.code)}">Download evidence</button>
      </div>
    </div>`).join('');
  }
  wrap.innerHTML = html;
}

async function dismissDiversion(id) {
  try {
    await api(`/custody/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
    await loadAlerts(false);
  } catch (e) { alert(e.message); }
}

async function reviewUnit(code, outcome) {
  const question = outcome === 'confirmed'
    ? 'Confirm this code was copied? Shoppers who check it will be told not to trust the product.'
    : 'Mark this as cleared? The flag is removed, and only newer scans count from now on.';
  if (!window.confirm(question)) return;
  const note = window.prompt('Add a note (optional):', '');
  if (note === null) return;
  try {
    await api(`/units/${encodeURIComponent(code)}/review`, { method: 'POST', body: JSON.stringify({ outcome, note }) });
    unitsCache = {};
    if (openBatchId) await loadUnits(openBatchId);
    await loadAlerts(false);
    await renderBatchList();
  } catch (e) {
    alert(e.message);
  }
}

// One listener handles every action button (alerts, batch panels, downloads).
document.addEventListener('click', e => {
  const csv = e.target.closest('[data-csv]');
  if (csv) { downloadFile(csv.dataset.csv, csv.dataset.file || 'export.csv'); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'cleared' || act === 'confirmed') reviewUnit(btn.dataset.code, act);
  else if (act === 'trail') toggleTrail(btn);
  else if (act === 'evidence') downloadFile(`/units/${encodeURIComponent(btn.dataset.code)}/evidence.csv`, `evidence-${btn.dataset.code}.csv`);
  else if (act === 'dismiss') dismissDiversion(btn.dataset.id);
});

/* ---------- settings ---------- */
function showSettingsStatus(text, ok) {
  const el = document.getElementById('setStatus');
  el.textContent = text;
  el.className = 'status-line' + (ok ? ' ok-text' : '');
  if (ok === false) el.className = 'status-line error-text';
}

function fillSettings(s) {
  document.getElementById('setAlertEmail').value = s.alertEmail || '';
  document.getElementById('setWebhookUrl').value = s.webhookUrl || '';
  document.getElementById('setWebhookSecret').value = s.webhookSecret || '';
  document.getElementById('setSecretField').style.display = s.webhookSecret ? 'block' : 'none';
  document.getElementById('setEmailNote').textContent = s.emailConfigured
    ? ''
    : 'Email sending is not switched on for this server yet, so alerts will only appear in the dashboard and webhook.';
}

async function loadSettings() {
  showSettingsStatus('', null);
  try {
    fillSettings(await api('/company/settings'));
  } catch (e) {
    if (e.status === 401) { setSession(null); renderCompanyView(); return; }
    showSettingsStatus('Could not load settings: ' + e.message, false);
  }
}

async function saveSettings() {
  showSettingsStatus('Saving…', null);
  try {
    const s = await api('/company/settings', {
      method: 'PUT',
      body: JSON.stringify({
        alertEmail: document.getElementById('setAlertEmail').value.trim(),
        webhookUrl: document.getElementById('setWebhookUrl').value.trim()
      })
    });
    fillSettings(s);
    showSettingsStatus('Saved.', true);
  } catch (e) {
    showSettingsStatus(e.message, false);
  }
}

function describeResult(label, r) {
  if (!r) return `${label}: no result`;
  if (r.status === 'sent') return `${label}: sent`;
  if (r.status === 'skipped') return `${label}: not used (${r.detail})`;
  return `${label}: failed (${r.detail})`;
}

async function sendTestAlert() {
  showSettingsStatus('Sending a test alert…', null);
  try {
    const r = await api('/company/settings/test', { method: 'POST' });
    showSettingsStatus(describeResult('Email', r.email) + '\n' + describeResult('Webhook', r.webhook), true);
  } catch (e) {
    showSettingsStatus(e.message, false);
  }
}

/* ---------- device ID ---------- */
// A random ID created once per browser and remembered. It lets the server tell
// "the same phone scanning again" apart from "different phones". It holds no
// personal information. Clearing browser data creates a new one.
let memoryDeviceId = null;

function randomId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function getDeviceId() {
  try {
    let id = localStorage.getItem('pa_device_id');
    if (!id) { id = randomId(); localStorage.setItem('pa_device_id', id); }
    return id;
  } catch (e) {
    if (!memoryDeviceId) memoryDeviceId = randomId();
    return memoryDeviceId;
  }
}

/* ---------- location (required to verify) ---------- */
const GOOD_ACCURACY_M = 100;    // stop waiting as soon as a reading is this precise
const MAX_ACCURACY_M = 1000;    // refuse readings worse than this (keep equal to the server)
const LOCATION_WAIT_MS = 8000;  // wait up to this long for a good reading

// Asks the phone for its most precise location, waiting briefly for GPS to settle.
// Resolves { lat, lng, accuracy } or rejects { type: 'denied' | 'unsupported' | 'unavailable' | 'timeout' }.
function getBestLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject({ type: 'unsupported' }); return; }

    let best = null;
    let finished = false;
    let watchId = null;
    let timer = null;

    function finish(err) {
      if (finished) return;
      finished = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      clearTimeout(timer);
      if (best) resolve(best);
      else reject(err || { type: 'timeout' });
    }

    watchId = navigator.geolocation.watchPosition(
      pos => {
        const c = pos.coords;
        if (!best || c.accuracy < best.accuracy) {
          best = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy };
        }
        if (best.accuracy <= GOOD_ACCURACY_M) finish();
      },
      err => finish({ type: err.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
    timer = setTimeout(() => finish({ type: 'timeout' }), LOCATION_WAIT_MS);
  });
}

function showLocationProblem(type, accuracy) {
  const messages = {
    denied: 'Location access is blocked. To verify a product, allow location for this site (tap the lock or settings icon next to the web address, then Permissions → Location → Allow), then try again.',
    unsupported: "This browser or device can't share its location, so the product can't be verified. Try a different browser or phone.",
    unavailable: "We couldn't get your location. Make sure Location is turned on for your phone, move near a window or outdoors, then try again.",
    timeout: "We couldn't get your location in time. Make sure Location is turned on, move near a window or outdoors, then try again.",
    inaccurate: `Your location isn't precise enough${accuracy ? ` (about ${Math.round(accuracy)} m)` : ''}. Move near a window or outdoors and try again.`
  };
  document.getElementById('sealStage').className = 'seal-stage notfound';
  document.getElementById('sealRing').textContent = '✕';
  document.getElementById('sealHeadline').textContent = 'Location needed';
  document.getElementById('sealSub').textContent = messages[type] || messages.unavailable;
  document.getElementById('sealDetails').style.display = 'none';
  document.getElementById('scanWarning').style.display = 'none';
}

/* ---------- consumer verification ---------- */
async function verifyCode(rawCode) {
  const input = document.getElementById('codeInput');
  const code = (rawCode !== undefined ? rawCode : input.value).trim().toUpperCase();
  if (!code) return;
  input.value = code;

  const stage = document.getElementById('sealStage');
  const ring = document.getElementById('sealRing');
  const headline = document.getElementById('sealHeadline');
  const sub = document.getElementById('sealSub');
  const details = document.getElementById('sealDetails');
  const warning = document.getElementById('scanWarning');

  stage.className = 'seal-stage idle';
  ring.textContent = '…';
  headline.textContent = 'Checking…';
  sub.textContent = 'Getting your location…';
  details.style.display = 'none';
  warning.style.display = 'none';

  // Location is mandatory: no location, no verification.
  let loc;
  try {
    loc = await getBestLocation();
  } catch (e) {
    showLocationProblem(e && e.type);
    return;
  }
  if (loc.accuracy > MAX_ACCURACY_M) {
    showLocationProblem('inaccurate', loc.accuracy);
    return;
  }
  sub.textContent = '';

  let data;
  try {
    data = await api('/verify', {
      method: 'POST',
      body: JSON.stringify({
        code,
        lat: loc.lat,
        lng: loc.lng,
        accuracy: loc.accuracy,
        deviceId: getDeviceId()
      })
    });
  } catch (e) {
    stage.className = 'seal-stage notfound';
    ring.textContent = '✕';
    headline.textContent = 'Could not check';
    sub.textContent = e.message;
    return;
  }

  if (!data.found) {
    stage.className = 'seal-stage notfound';
    ring.textContent = '✕';
    headline.textContent = 'Not found';
    sub.textContent = "This code isn't on record. Treat this product with caution.";
    return;
  }

  const { product, previousScanAt } = data;
  const status = data.status || 'genuine'; // 'genuine' | 'unusual' | 'confirmed'
  const reasons = data.reasons || [];

  if (status === 'confirmed') {
    stage.className = 'seal-stage notfound';
    ring.textContent = '✕';
    headline.textContent = 'Do not trust this product';
    sub.textContent = `${product.companyName} has confirmed that this code was copied onto other products.`;
  } else if (status === 'unusual') {
    stage.className = 'seal-stage flagged';
    ring.textContent = '!';
    headline.textContent = 'Genuine code — unusual activity';
    sub.textContent = `Registered by ${product.companyName}.`;
  } else {
    stage.className = 'seal-stage genuine';
    ring.textContent = '✓';
    headline.textContent = 'Genuine';
    sub.textContent = `Registered by ${product.companyName}.`;
  }

  details.style.display = 'grid';
  details.innerHTML = `
    <dt>Product</dt><dd>${escapeHTML(product.productName)}</dd>
    <dt>Company</dt><dd>${escapeHTML(product.companyName)}</dd>
    <dt>Batch</dt><dd>${escapeHTML(product.batchNumber)}</dd>
    <dt>Manufactured</dt><dd>${escapeHTML(product.manufacturingDate)}</dd>
    <dt>Serial</dt><dd>${escapeHTML(product.serialNumber)}</dd>
    <dt>Previous check</dt><dd>${previousScanAt ? escapeHTML(formatWhen(previousScanAt)) : 'First time checked'}</dd>
    ${journeyHtml(data.journey)}
  `;

  if (status === 'unusual') {
    warning.style.display = 'block';
    warning.textContent = `This code is genuine, but its recent activity looks unusual: ${reasons.join('; ') || 'it was checked in ways that are not normal'}. This can happen when the same code has been copied onto more than one physical product.`;
  } else {
    warning.style.display = 'none';
  }
}

/* ---------- camera scanning ---------- */
let camStream = null;
let camRAF = null;
let cameraMode = 'verify'; // 'verify' (shoppers) or 'trade' (distributors and retailers)

async function openCamera(mode) {
  cameraMode = mode === 'trade' ? 'trade' : 'verify';
  const modal = document.getElementById('camModal');
  modal.classList.add('open');
  const video = document.getElementById('camVideo');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = camStream;
    await video.play();
    scanLoop();
  } catch (e) {
    closeCamera();
    alert('Could not access the camera. You can still type the code manually.');
  }
}

function closeCamera() {
  document.getElementById('camModal').classList.remove('open');
  if (camRAF) cancelAnimationFrame(camRAF);
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
}

// Works whether the QR holds a bare code or a link like https://site/?code=XXXX
function extractCode(text) {
  try {
    const url = new URL(text);
    const fromQuery = url.searchParams.get('code');
    if (fromQuery) return fromQuery;
    const lastPart = url.pathname.split('/').filter(Boolean).pop();
    if (lastPart) return decodeURIComponent(lastPart);
  } catch (e) {}
  return text;
}

function scanLoop() {
  const video = document.getElementById('camVideo');
  const canvas = document.getElementById('camCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (typeof jsQR === 'undefined') {
    closeCamera();
    alert('The QR reading library failed to load. Check your internet connection and refresh the page.');
    return;
  }

  function tick() {
    if (!camStream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(imageData.data, imageData.width, imageData.height);
      if (result && result.data) {
        closeCamera();
        if (cameraMode === 'trade') { tradeRecord(extractCode(result.data)); return; }
        showView('verify');
        verifyCode(extractCode(result.data));
        return;
      }
    }
    camRAF = requestAnimationFrame(tick);
  }
  camRAF = requestAnimationFrame(tick);
}

/* ---------- supply chain, sales area, downloads ---------- */
// How each step reads: "Received by Lagos Distributors".
const ACTION_TEXT = { received: 'Received by', shipped: 'Shipped on by', stocked: 'Put on shelf by', sold: 'Sold by' };

function journeyHtml(journey) {
  if (!journey || !journey.length) return '';
  const lines = journey.map(j =>
    `${escapeHTML(ACTION_TEXT[j.action] || j.action)} ${escapeHTML(j.partner)} (${escapeHTML(j.role)}), ${escapeHTML(new Date(j.at).toLocaleDateString())}`);
  return `<dt>Journey</dt><dd>${lines.join('<br>')}</dd>`;
}

function custodyLine(c) {
  if (!c) return '';
  return `<div class="unit-meta">Journey: ${escapeHTML(ACTION_TEXT[c.action] || c.action)} ${escapeHTML(c.partner)} · ${escapeHTML(formatWhen(c.at))}${c.outOfArea ? ' ⚠ outside sales area' : ''}</div>`;
}

async function toggleTrail(btn) {
  const box = btn.closest('.unit-card').querySelector('.trail-box');
  if (box.innerHTML) { box.innerHTML = ''; return; }
  box.textContent = 'Loading…';
  try {
    const data = await api(`/units/${encodeURIComponent(btn.dataset.code)}/custody`);
    if (!data.events.length) { box.textContent = 'No distributor or retailer has recorded this product yet.'; return; }
    box.innerHTML = data.events.map(ev =>
      `<div>${escapeHTML(ACTION_TEXT[ev.action] || ev.action)} ${escapeHTML(ev.partner)} (${escapeHTML(ev.role)}) · ${escapeHTML(formatWhen(ev.at))} ${mapLink(ev.lat, ev.lng, '· map')}${ev.outOfArea ? ' ⚠ outside sales area' : ''}</div>`).join('');
  } catch (e) { box.textContent = e.message; }
}

function areaText(a) {
  if (!a) return 'Not set: shipments from any location are accepted.';
  return `Currently: ${a.label ? a.label + ' · ' : ''}${a.radiusKm} km around ${Number(a.lat).toFixed(4)}, ${Number(a.lng).toFixed(4)}`;
}

async function loadSalesArea(batchId) {
  try { salesAreaCache[batchId] = (await api(`/batches/${batchId}/sales-area`)).area; }
  catch (e) { salesAreaCache[batchId] = null; }
}

function batchToolsHtml(batch) {
  const a = salesAreaCache[batch.id];
  const id = batch.id;
  return `<div class="batch-tools">
    <div class="alert-actions">
      <button class="btn secondary sm" data-csv="/export/units.csv?batchId=${encodeURIComponent(id)}" data-file="codes-${escapeAttr(batch.batchNumber)}.csv">Download codes (CSV)</button>
      <button class="btn secondary sm" data-label-batch="${escapeAttr(id)}" data-label-name="${escapeAttr(batch.batchNumber)}">Labels and QR images</button>
    </div>
    <label class="field-label" style="margin-top:12px;">Sales area (optional)</label>
    <p class="small-note">Distributors and retailers who record this batch outside the area raise an out-of-area alert.</p>
    <p class="small-note" id="areaNow-${id}">${escapeHTML(areaText(a))}</p>
    <div class="row2">
      <div><input type="text" id="areaLabel-${id}" placeholder="Name, e.g. Lagos and Ogun" value="${a ? escapeAttr(a.label) : ''}"></div>
      <div><input type="number" id="areaRadius-${id}" placeholder="Radius (km)" min="1" max="5000" value="${a ? a.radiusKm : 50}"></div>
    </div>
    <div class="row2">
      <div><input type="text" id="areaLat-${id}" placeholder="Centre latitude" value="${a ? a.lat : ''}"></div>
      <div><input type="text" id="areaLng-${id}" placeholder="Centre longitude" value="${a ? a.lng : ''}"></div>
    </div>
    <div class="alert-actions">
      <button class="btn secondary sm" onclick="useMyLocationForArea('${id}')">Use my location</button>
      <button class="btn sm" onclick="saveSalesArea('${id}')">Save area</button>
      <button class="btn secondary sm" onclick="clearSalesArea('${id}')">Clear</button>
    </div>
    <p class="status-line" id="areaStatus-${id}"></p>
  </div>`;
}

function areaStatus(id, text, ok) {
  const el = document.getElementById('areaStatus-' + id);
  if (!el) return;
  el.textContent = text;
  el.className = 'status-line' + (ok === true ? ' ok-text' : ok === false ? ' error-text' : '');
}

async function useMyLocationForArea(id) {
  areaStatus(id, 'Getting your location…');
  try {
    const loc = await getBestLocation();
    document.getElementById('areaLat-' + id).value = loc.lat.toFixed(5);
    document.getElementById('areaLng-' + id).value = loc.lng.toFixed(5);
    areaStatus(id, 'Location filled in. Set a radius and press Save area.', true);
  } catch (e) {
    areaStatus(id, 'Could not get your location. Type the latitude and longitude instead.', false);
  }
}

async function saveSalesArea(id) {
  try {
    const r = await api(`/batches/${id}/sales-area`, {
      method: 'PUT',
      body: JSON.stringify({
        label: document.getElementById('areaLabel-' + id).value,
        lat: document.getElementById('areaLat-' + id).value,
        lng: document.getElementById('areaLng-' + id).value,
        radiusKm: document.getElementById('areaRadius-' + id).value
      })
    });
    salesAreaCache[id] = r.area;
    document.getElementById('areaNow-' + id).textContent = areaText(r.area);
    areaStatus(id, 'Saved.', true);
  } catch (e) { areaStatus(id, e.message, false); }
}

async function clearSalesArea(id) {
  try {
    await api(`/batches/${id}/sales-area`, { method: 'PUT', body: JSON.stringify({ clear: true }) });
    salesAreaCache[id] = null;
    document.getElementById('areaNow-' + id).textContent = areaText(null);
    document.getElementById('areaLabel-' + id).value = '';
    document.getElementById('areaLat-' + id).value = '';
    document.getElementById('areaLng-' + id).value = '';
    areaStatus(id, 'Sales area removed.', true);
  } catch (e) { areaStatus(id, e.message, false); }
}

// Downloads a file the server only gives to a logged-in company.
async function downloadFile(path, filename) {
  try {
    const res = await fetch(API_BASE + path, { headers: { Authorization: 'Bearer ' + (session && session.token) } });
    if (!res.ok) {
      let msg = 'The download failed.';
      try { msg = (await res.json()).error || msg; } catch (e) {}
      alert(msg);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(filename).replace(/[^A-Za-z0-9._-]/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('The download failed. Check your connection and try again.');
  }
}

/* ---------- init ---------- */
document.getElementById('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') verifyCode(); });
if (session) renderCompanyView();
updateTabs();
if (ON_COMPANY_PATH) showView('company');

// If someone scanned the QR with their phone's normal camera app, the link
// opens this page with ?code=... in the address, so verify it straight away.
const scannedCode = new URLSearchParams(location.search).get('code');
if (scannedCode) verifyCode(scannedCode);
