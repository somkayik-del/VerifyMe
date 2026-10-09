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
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (session && session.token) headers.Authorization = 'Bearer ' + session.token;

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

/* ---------- view / tab switching ---------- */
function showView(name) {
  document.getElementById('view-verify').classList.toggle('active', name === 'verify');
  document.getElementById('view-company').classList.toggle('active', name === 'company');
  document.getElementById('tabVerifyBtn').classList.toggle('active', name === 'verify');
  document.getElementById('tabCompanyBtn').classList.toggle('active', name === 'company');
  if (name === 'company') renderCompanyView();
}
function showAuthTab(name) {
  document.getElementById('authTabLogin').classList.toggle('active', name === 'login');
  document.getElementById('authTabRegister').classList.toggle('active', name === 'register');
  document.getElementById('authPanelLogin').classList.toggle('active', name === 'login');
  document.getElementById('authPanelRegister').classList.toggle('active', name === 'register');
}

/* ---------- auth ---------- */
async function doRegister() {
  const name = document.getElementById('regName').value.trim();
  const pin = document.getElementById('regPin').value.trim();
  const errEl = document.getElementById('regError');
  errEl.style.display = 'none';

  try {
    const data = await api('/auth/register', { method: 'POST', body: JSON.stringify({ name, pin }) });
    setSession(data);
    renderCompanyView();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

async function doLogin() {
  const name = document.getElementById('loginName').value.trim();
  const pin = document.getElementById('loginPin').value.trim();
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
  renderCompanyView();
}

/* ---------- company dashboard state ---------- */
let batchesCache = [];
let openBatchId = null;
let unitsCache = {}; // batchId -> units[]

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
}

async function renderBatchList() {
  const wrap = document.getElementById('batchListWrap');
  if (batchesCache.length === 0) {
    wrap.innerHTML = '<p class="empty-note">No batches registered yet — add one above.</p>';
    return;
  }

  let html = '<table class="ledger"><thead><tr><th>Product</th><th>Batch #</th><th>Mfg. date</th><th>Units</th></tr></thead><tbody>';
  for (const b of batchesCache) {
    const flaggedInBatch = (unitsCache[b.id] || []).filter(u => u.flags.geoJump).length;
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
  const when = new Date(u.lastVerifiedAt).toLocaleString();
  if (u.lastLat == null || u.lastLng == null) return escapeHTML(when);
  const lat = Number(u.lastLat).toFixed(5);
  const lng = Number(u.lastLng).toFixed(5);
  return `${escapeHTML(when)} · <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener">${lat}, ${lng} (open map)</a>`;
}

function renderUnitsPanelInner(batch) {
  const units = unitsCache[batch.id] || [];
  let inner = `
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
      const flagged = u.flags.geoJump;
      return `
      <div class="unit-card">
        <div class="qr-thumb"><img src="${API_BASE}/units/${encodeURIComponent(u.code)}/qr.png" alt="QR for ${escapeHTML(u.code)}"></div>
        <div style="flex:1; min-width:0;">
          <div class="unit-code">${escapeHTML(u.code)} ${flagged ? '<span class="flag-badge">⚠ Possible duplicate</span>' : ''}</div>
          <div class="unit-meta">Serial ${escapeHTML(u.serialNumber)} · checked ${u.verifyCount} time${u.verifyCount === 1 ? '' : 's'}</div>
          <div class="unit-meta">Last scanned: ${formatLastScan(u)}</div>
          ${flagged && u.flags.geoJumpDetail ? `<div class="unit-meta">${escapeHTML(u.flags.geoJumpDetail)}</div>` : ''}
        </div>
        <a class="btn ghost" href="${API_BASE}/units/${encodeURIComponent(u.code)}/qr.png" download="${u.code}.png">Download</a>
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

function escapeHTML(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
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

  const { product, verifyCount, flags, previousScanAt } = data;
  const isSuspicious = flags.geoJump;

  stage.className = 'seal-stage ' + (isSuspicious ? 'flagged' : 'genuine');
  ring.textContent = isSuspicious ? '!' : '✓';
  headline.textContent = isSuspicious ? 'Genuine code — unusual activity' : 'Genuine';
  sub.textContent = `Registered by ${product.companyName}.`;
  details.style.display = 'grid';
  details.innerHTML = `
    <dt>Product</dt><dd>${escapeHTML(product.productName)}</dd>
    <dt>Company</dt><dd>${escapeHTML(product.companyName)}</dd>
    <dt>Batch</dt><dd>${escapeHTML(product.batchNumber)}</dd>
    <dt>Manufactured</dt><dd>${escapeHTML(product.manufacturingDate)}</dd>
    <dt>Serial</dt><dd>${escapeHTML(product.serialNumber)}</dd>
    <dt>Checked</dt><dd>${verifyCount} time${verifyCount === 1 ? '' : 's'}</dd>
    <dt>Previous check</dt><dd>${previousScanAt ? escapeHTML(new Date(previousScanAt).toLocaleString()) : 'First time checked'}</dd>
  `;

  if (isSuspicious) {
    warning.style.display = 'block';
    warning.textContent = `This code is genuine, but its recent activity looks unusual: ${flags.geoJumpDetail || 'it was scanned from far-apart places by several devices'}. This can happen when the same code has been copied onto more than one physical product.`;
  } else {
    warning.style.display = 'none';
  }
}

/* ---------- camera scanning ---------- */
let camStream = null;
let camRAF = null;

async function openCamera() {
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
        showView('verify');
        verifyCode(extractCode(result.data));
        return;
      }
    }
    camRAF = requestAnimationFrame(tick);
  }
  camRAF = requestAnimationFrame(tick);
}

/* ---------- init ---------- */
document.getElementById('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') verifyCode(); });
if (session) renderCompanyView();

// If someone scanned the QR with their phone's normal camera app, the link
// opens this page with ?code=... in the address, so verify it straight away.
const scannedCode = new URLSearchParams(location.search).get('code');
if (scannedCode) verifyCode(scannedCode);
