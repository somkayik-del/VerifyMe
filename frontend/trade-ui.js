/* Partners (managed by the company) and the Trade portal (used by distributors and retailers).
   Loaded after app.js, which provides api(), escapeHTML(), formatWhen(), getBestLocation() and friends. */

/* =============== Partners tab (company side) =============== */
let partnersCache = [];

function partnerErr(text) {
  const el = document.getElementById('partnerError');
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}

async function loadPartners() {
  try {
    partnersCache = (await api('/company/partners')).partners;
    renderPartners();
  } catch (e) {
    if (e.status === 401) { setSession(null); renderCompanyView(); return; }
    document.getElementById('partnersWrap').innerHTML = `<p class="error-text">Could not load partners: ${escapeHTML(e.message)}</p>`;
  }
}

function renderPartners() {
  const wrap = document.getElementById('partnersWrap');
  if (!partnersCache.length) {
    wrap.innerHTML = '<p class="empty-note">No partners yet. Add a distributor or retailer above.</p>';
    return;
  }
  wrap.innerHTML = partnersCache.map(p => `
    <div class="partner-row">
      <div>
        <div class="who">${escapeHTML(p.name)}
          <span class="status-pill ${p.active ? 'reviewed' : 'off'}">${p.active ? 'Active' : 'Switched off'}</span>
        </div>
        <div class="unit-meta">${p.role === 'retailer' ? 'Retailer' : 'Distributor'} ·
          ${p.events} scan${p.events === 1 ? '' : 's'} ·
          ${p.lastSeenAt ? 'last active ' + escapeHTML(formatWhen(p.lastSeenAt)) : 'has not logged in yet'}</div>
      </div>
      <div class="alert-actions" style="margin-top:0;">
        <button class="btn secondary sm" data-partner-act="reset" data-id="${escapeAttr(p.id)}">New access code</button>
        <button class="btn secondary sm" data-partner-act="toggle" data-id="${escapeAttr(p.id)}" data-active="${p.active ? '0' : '1'}">${p.active ? 'Switch off' : 'Switch on'}</button>
      </div>
    </div>`).join('');
}

function showAccessCode(name, code) {
  const box = document.getElementById('partnerCodeBox');
  box.style.display = 'block';
  box.innerHTML = `<strong>Access code for ${escapeHTML(name)}</strong>
    <div class="big">${escapeHTML(code)}</div>
    <div class="alert-actions"><button class="btn secondary sm" data-partner-act="copy" data-code="${escapeAttr(code)}">Copy code</button></div>
    <p class="small-note">Send this to the partner now. For safety it is shown only once. They log in under the “Trade portal” tab of this site.</p>`;
}

async function createPartner() {
  partnerErr('');
  try {
    const r = await api('/company/partners', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('partnerName').value,
        role: document.getElementById('partnerRole').value
      })
    });
    document.getElementById('partnerName').value = '';
    showAccessCode(r.partner.name, r.accessCode);
    await loadPartners();
  } catch (e) { partnerErr(e.message); }
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-partner-act]');
  if (!btn) return;
  const act = btn.dataset.partnerAct;
  try {
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(btn.dataset.code); btn.textContent = 'Copied'; }
      catch (x) { btn.textContent = 'Select the code and copy it'; }
    } else if (act === 'reset') {
      if (!window.confirm('Create a new access code? The old code stops working straight away.')) return;
      const r = await api(`/company/partners/${encodeURIComponent(btn.dataset.id)}/reset`, { method: 'POST' });
      showAccessCode(r.partner.name, r.accessCode);
      await loadPartners();
    } else if (act === 'toggle') {
      const active = btn.dataset.active === '1';
      if (!active && !window.confirm('Switch this partner off? They are logged out and cannot record products until you switch them on again.')) return;
      await api(`/company/partners/${encodeURIComponent(btn.dataset.id)}/active`, { method: 'POST', body: JSON.stringify({ active }) });
      await loadPartners();
    }
  } catch (err) { partnerErr(err.message); }
});

/* =============== Trade portal (distributors and retailers) =============== */
let tradeAction = null;

function tradeLoginError(text) {
  const el = document.getElementById('tradeLoginError');
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}

async function tradeLogin() {
  tradeLoginError('');
  try {
    const data = await api('/trade/login', {
      method: 'POST',
      body: JSON.stringify({ accessCode: document.getElementById('tradeCode').value })
    }, 'partner');
    setPartnerSession(data);
    document.getElementById('tradeCode').value = '';
    tradeAction = null;
    renderTradeView();
  } catch (e) { tradeLoginError(e.message); }
}

function tradeLogout() {
  setPartnerSession(null);
  tradeAction = null;
  renderTradeView();
}

function renderTradeView() {
  const authBox = document.getElementById('tradeAuth');
  const block = document.getElementById('tradeBlock');
  if (!partnerSession) {
    authBox.style.display = 'block';
    block.style.display = 'none';
    return;
  }
  authBox.style.display = 'none';
  block.style.display = 'block';
  const p = partnerSession.partner;
  document.getElementById('tradeName').textContent = p.name;
  document.getElementById('tradeMeta').textContent = `${p.role === 'retailer' ? 'Retailer' : 'Distributor'} for ${p.companyName}`;
  document.getElementById('tradeResult').style.display = 'none';
  renderTradeActions();
  loadTradeRecent();
}

function renderTradeActions() {
  const actions = partnerSession.partner.actions || [];
  if (!actions.some(a => a.id === tradeAction)) tradeAction = actions.length ? actions[0].id : null;
  document.getElementById('tradeActions').innerHTML = actions.map(a =>
    `<button type="button" data-trade-action="${escapeAttr(a.id)}" class="${a.id === tradeAction ? 'active' : ''}">${escapeHTML(a.label)}</button>`).join('');
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-trade-action]');
  if (!btn) return;
  tradeAction = btn.dataset.tradeAction;
  renderTradeActions();
});

function tradeActionLabel(id) {
  const a = ((partnerSession && partnerSession.partner.actions) || []).find(x => x.id === id);
  return a ? a.label : id;
}

async function loadTradeRecent() {
  const wrap = document.getElementById('tradeRecent');
  try {
    const data = await api('/trade/me', {}, 'partner');
    partnerSession.partner = data.partner;
    setPartnerSession(partnerSession);
    if (!data.recent.length) { wrap.innerHTML = '<p class="empty-note">Nothing recorded yet.</p>'; return; }
    wrap.innerHTML = data.recent.map(r =>
      `<div class="partner-row"><div><div class="who">${escapeHTML(tradeActionLabel(r.action))}: ${escapeHTML(r.productName)}</div>
       <div class="unit-meta">Serial ${escapeHTML(r.serialNumber)} · ${escapeHTML(formatWhen(r.at))}${r.outOfArea ? ' · ⚠ outside sales area' : ''}</div></div></div>`).join('');
  } catch (e) {
    if (e.status === 401) { tradeLogout(); tradeLoginError(e.message); return; }
    wrap.innerHTML = `<p class="error-text">${escapeHTML(e.message)}</p>`;
  }
}

function showTradeResult(html, kind) {
  const box = document.getElementById('tradeResult');
  box.className = 'trade-result' + (kind ? ' ' + kind : '');
  box.innerHTML = html;
  box.style.display = 'block';
}

function tradeLocationMessage(type, accuracy) {
  const m = {
    denied: 'Location access is blocked. Allow location for this site in your browser settings, then try again.',
    unsupported: "This browser can't share its location, so the product can't be recorded. Try a different browser or phone.",
    unavailable: "We couldn't get your location. Turn on Location, move near a window or outdoors, then try again.",
    timeout: "We couldn't get your location in time. Turn on Location, move near a window or outdoors, then try again.",
    inaccurate: `Your location isn't precise enough${accuracy ? ` (about ${Math.round(accuracy)} m)` : ''}. Move near a window or outdoors and try again.`
  };
  return m[type] || m.unavailable;
}

async function tradeRecord(rawCode) {
  const input = document.getElementById('tradeCodeInput');
  const code = (typeof rawCode === 'string' ? rawCode : input.value).trim().toUpperCase();
  if (!code) return;
  if (!tradeAction) { showTradeResult('Choose what you are recording first.', 'bad'); return; }
  input.value = code;

  showTradeResult('Getting your location…', '');
  let loc;
  try {
    loc = await getBestLocation();
  } catch (e) {
    showTradeResult(escapeHTML(tradeLocationMessage(e && e.type)), 'bad');
    return;
  }
  if (loc.accuracy > MAX_ACCURACY_M) {
    showTradeResult(escapeHTML(tradeLocationMessage('inaccurate', loc.accuracy)), 'bad');
    return;
  }

  try {
    const r = await api('/trade/scan', {
      method: 'POST',
      body: JSON.stringify({ code, action: tradeAction, lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy })
    }, 'partner');
    const head = r.duplicate
      ? 'Already recorded a moment ago.'
      : `Recorded: ${escapeHTML(tradeActionLabel(r.action))}`;
    showTradeResult(
      `<strong>${head}</strong><div>${escapeHTML(r.product.productName)} · serial ${escapeHTML(r.product.serialNumber)}</div>` +
      (r.warnings && r.warnings.length ? `<ul>${r.warnings.map(w => `<li>${escapeHTML(w)}</li>`).join('')}</ul>` : ''),
      r.warnings && r.warnings.length ? 'warn' : ''
    );
    input.value = '';
    loadTradeRecent();
  } catch (e) {
    if (e.status === 401) { tradeLogout(); tradeLoginError(e.message); return; }
    showTradeResult(escapeHTML(e.message), 'bad');
  }
}

document.getElementById('tradeCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') tradeRecord(); });
document.getElementById('tradeCode').addEventListener('keydown', e => { if (e.key === 'Enter') tradeLogin(); });
if (partnerSession) renderTradeView();
