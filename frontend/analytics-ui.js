/* The Analytics tab: totals, a chart, a map, busiest areas, the impact estimate and exports. */

const fmt = n => new Intl.NumberFormat().format(n);

async function loadAnalytics() {
  const days = Number(document.getElementById('anDays').value) || 30;
  document.getElementById('exScans').dataset.csv = `/export/scans.csv?days=${days}`;
  document.getElementById('exCustody').dataset.csv = `/export/custody.csv?days=${days}`;
  try {
    const tz = -new Date().getTimezoneOffset(); // minutes east of UTC
    const d = await api(`/analytics/summary?days=${days}&tzOffset=${tz}`);
    renderStats(d.totals);
    renderChart(d.byDay);
    renderHotspots(d.hotspots);
    renderRoi(d.roi);
    renderMap(d.points);
  } catch (e) {
    if (e.status === 401) { setSession(null); renderCompanyView(); return; }
    document.getElementById('anStats').innerHTML = `<p class="error-text">Could not load analytics: ${escapeHTML(e.message)}</p>`;
  }
}

function renderStats(t) {
  const cards = [
    ['Codes registered', t.units],
    ['Shopper checks', t.scans],
    ['Different devices', t.devices],
    ['Flagged now', t.open, t.open > 0],
    ['Confirmed copies', t.confirmed, t.confirmed > 0],
    ['Out-of-area alerts', t.diversionsOpen, t.diversionsOpen > 0],
    ['Partner scans', t.tradeEvents],
    ['Active partners', t.partners]
  ];
  document.getElementById('anStats').innerHTML = cards.map(([label, value, warn]) =>
    `<div class="stat ${warn ? 'warn' : ''}"><div class="n">${fmt(value)}</div><div class="l">${escapeHTML(label)}</div></div>`).join('');
}

function renderChart(byDay) {
  const W = 700, H = 170, padX = 28, padTop = 14, padBottom = 26;
  const max = Math.max(1, ...byDay.map(d => d.scans));
  const bw = (W - padX * 2) / byDay.length;
  const plotH = H - padTop - padBottom;
  const bars = byDay.map((d, i) => {
    const h = (d.scans / max) * plotH;
    const fh = (d.flagged / max) * plotH;
    const x = padX + i * bw + 1;
    const w = Math.max(1, bw - 2);
    return `<g><title>${escapeHTML(d.date)}: ${d.scans} check${d.scans === 1 ? '' : 's'}${d.flagged ? `, ${d.flagged} on flagged codes` : ''}</title>
      <rect x="${x.toFixed(1)}" y="${(H - padBottom - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="currentColor" opacity=".55"/>
      ${fh > 0 ? `<rect x="${x.toFixed(1)}" y="${(H - padBottom - fh).toFixed(1)}" width="${w.toFixed(1)}" height="${fh.toFixed(1)}" fill="#b3261e"/>` : ''}</g>`;
  }).join('');
  document.getElementById('anChart').innerHTML =
    `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Shopper checks per day">
      <text x="${padX}" y="10" font-size="11" fill="currentColor" opacity=".7">Most in one day: ${max}</text>
      ${bars}
      <line x1="${padX}" y1="${H - padBottom}" x2="${W - padX}" y2="${H - padBottom}" stroke="currentColor" opacity=".4"/>
      <text x="${padX}" y="${H - 8}" font-size="11" fill="currentColor" opacity=".7">${escapeHTML(byDay[0].date)}</text>
      <text x="${W - padX}" y="${H - 8}" font-size="11" text-anchor="end" fill="currentColor" opacity=".7">${escapeHTML(byDay[byDay.length - 1].date)}</text>
    </svg>
    <p class="small-note"><span style="color:#b3261e;">■</span> checks on codes that are flagged or confirmed as copies</p>`;
}

function renderHotspots(list) {
  const el = document.getElementById('anHotspots');
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<h4 class="an-sub">Busiest areas (about 1 km squares)</h4>' + list.map(h => `
    <div class="hot-row">
      <div>${mapLink(h.lat, h.lng, `${Number(h.lat).toFixed(2)}, ${Number(h.lng).toFixed(2)}`)}</div>
      <div>${fmt(h.scans)} check${h.scans === 1 ? '' : 's'} · ${fmt(h.devices)} device${h.devices === 1 ? '' : 's'}${h.flaggedScans ? ` · <strong style="color:#b3261e;">${fmt(h.flaggedScans)} on flagged codes</strong>` : ''}</div>
    </div>`).join('');
}

/* ----- map: Leaflet if it loads, otherwise a simple plot that always works ----- */
let leafletPromise = null;
let leafletMap = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(true);
  if (leafletPromise) return leafletPromise;
  const sources = [
    ['https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js', 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css'],
    ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css']
  ];
  leafletPromise = new Promise(resolve => {
    let i = 0, done = false;
    const finish = ok => { if (!done) { done = true; if (!ok) leafletPromise = null; resolve(ok); } };
    const next = () => {
      if (i >= sources.length) return finish(false);
      const [js, css] = sources[i++];
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = css;
      document.head.appendChild(link);
      const script = document.createElement('script');
      script.src = js;
      script.onload = () => finish(!!window.L);
      script.onerror = next;
      document.head.appendChild(script);
    };
    next();
    setTimeout(() => finish(!!window.L), 8000);
  });
  return leafletPromise;
}

function plotFallback(points) {
  const W = 700, H = 340, pad = 24;
  const lats = points.map(p => p[0]), lngs = points.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos(midLat * Math.PI / 180) || 1;
  const spanX = Math.max((maxLng - minLng) * kx, 0.01), spanY = Math.max(maxLat - minLat, 0.01);
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const cx = (minLng + maxLng) / 2, cy = (minLat + maxLat) / 2;
  const dots = points.map(([la, ln, flagged]) => {
    const x = W / 2 + (ln - cx) * kx * scale;
    const y = H / 2 - (la - cy) * scale;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${flagged ? 5 : 4}" fill="${flagged ? '#b3261e' : '#1f5fbf'}" opacity=".7"/>`;
  }).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Plot of where products were checked"
      style="background:rgba(128,128,128,.08);">${dots}
      <text x="8" y="${H - 8}" font-size="11" fill="currentColor" opacity=".7">North is up. Positions are relative; the map background could not be loaded.</text></svg>`;
}

async function renderMap(points) {
  const box = document.getElementById('anMap');
  const note = document.getElementById('anMapNote');
  if (!points.length) {
    box.style.display = 'none';
    note.textContent = 'No checks in this period yet.';
    return;
  }
  box.style.display = 'block';
  note.textContent = `${fmt(points.length)} recent check${points.length === 1 ? '' : 's'} shown. Red = codes that are flagged or confirmed as copies.`;

  if (leafletMap) { leafletMap.remove(); leafletMap = null; }
  box.innerHTML = '';

  const ok = await loadLeaflet();
  if (!ok) { box.innerHTML = plotFallback(points); return; }

  leafletMap = L.map(box);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(leafletMap);
  const group = L.featureGroup();
  points.forEach(([la, ln, flagged]) => {
    L.circleMarker([la, ln], {
      radius: flagged ? 7 : 5, color: flagged ? '#b3261e' : '#1f5fbf', weight: 1, fillOpacity: .6
    }).addTo(group);
  });
  group.addTo(leafletMap);
  const b = group.getBounds();
  if (points.length === 1 || !b.isValid()) leafletMap.setView([points[0][0], points[0][1]], 14);
  else leafletMap.fitBounds(b.pad(0.15), { maxZoom: 15 });
  setTimeout(() => leafletMap && leafletMap.invalidateSize(), 50);
}

/* ----- impact estimate ----- */
function renderRoi(roi) {
  const i = roi.inputs;
  document.getElementById('roiCurrency').value = i.currency || 'NGN';
  document.getElementById('roiPrice').value = i.price == null ? '' : i.price;
  document.getElementById('roiFake').value = i.fakeUnitsPerCode;
  document.getElementById('roiSub').value = i.substitutionPct;
  document.getElementById('roiCost').value = i.monthlyCost == null ? '' : i.monthlyCost;

  const el = document.getElementById('roiResult');
  if (!roi.result) {
    el.innerHTML = '<p class="small-note">Enter your average selling price and save to see an estimate.</p>';
    return;
  }
  const c = i.currency || 'NGN';
  const r = roi.result;
  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="n">${fmt(roi.confirmedInPeriod)}</div><div class="l">Copies you confirmed in this period</div></div>
      <div class="stat"><div class="n">${escapeHTML(c)} ${fmt(r.revenueProtected)}</div><div class="l">Estimated sales protected</div></div>
      ${r.cost !== null ? `<div class="stat"><div class="n">${escapeHTML(c)} ${fmt(r.cost)}</div><div class="l">Software cost for this period</div></div>` : ''}
      ${r.roiPct !== null ? `<div class="stat"><div class="n">${fmt(r.roiPct)}%</div><div class="l">Estimated return</div></div>` : ''}
    </div>
    <p class="small-note">
      How it is worked out: ${fmt(roi.confirmedInPeriod)} confirmed cop${roi.confirmedInPeriod === 1 ? 'y' : 'ies'}
      × ${fmt(i.fakeUnitsPerCode)} fake products each × ${escapeHTML(c)} ${fmt(i.price)} × ${fmt(i.substitutionPct)}% who would have bought the real one.
      Only codes you confirmed as copies count. This is an estimate, not a measurement.
    </p>`;
}

async function saveRoi() {
  const status = document.getElementById('roiStatus');
  status.className = 'status-line';
  status.textContent = 'Saving…';
  try {
    await api('/company/roi', {
      method: 'PUT',
      body: JSON.stringify({
        currency: document.getElementById('roiCurrency').value,
        price: document.getElementById('roiPrice').value,
        fakeUnitsPerCode: document.getElementById('roiFake').value,
        substitutionPct: document.getElementById('roiSub').value,
        monthlyCost: document.getElementById('roiCost').value
      })
    });
    status.className = 'status-line ok-text';
    status.textContent = 'Saved.';
    loadAnalytics();
  } catch (e) {
    status.className = 'status-line error-text';
    status.textContent = e.message;
  }
}
