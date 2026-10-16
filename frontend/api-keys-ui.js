/* Settings: API keys for a company's own systems (ERP, online shop). Loaded after app.js. */

const fmtDay = ms => new Date(ms).toLocaleDateString();

function keyError(text) {
  const el = document.getElementById('keyError');
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}

async function loadApiKeys() {
  fillApiDocs();
  try {
    const d = await api('/company/api-keys');
    const wrap = document.getElementById('keysWrap');
    if (!d.keys.length) { wrap.innerHTML = '<p class="empty-note">No API keys yet.</p>'; return; }
    wrap.innerHTML = d.keys.map(k => `
      <div class="key-row">
        <div>
          <div class="who">${escapeHTML(k.label)} ${k.revoked ? '<span class="status-pill off">Revoked</span>' : '<span class="status-pill reviewed">Active</span>'}</div>
          <div class="unit-meta"><span class="mono">${escapeHTML(k.prefix)}…</span> · created ${escapeHTML(fmtDay(k.createdAt))} · ${k.lastUsedAt ? 'last used ' + escapeHTML(formatWhen(k.lastUsedAt)) : 'never used'}</div>
        </div>
        ${k.revoked ? '' : `<button class="btn secondary sm" data-key-act="revoke" data-id="${escapeAttr(k.id)}">Revoke</button>`}
      </div>`).join('');
  } catch (e) {
    if (e.status === 401) { setSession(null); renderCompanyView(); return; }
    document.getElementById('keysWrap').innerHTML = `<p class="error-text">${escapeHTML(e.message)}</p>`;
  }
}

async function createApiKey() {
  keyError('');
  try {
    const r = await api('/company/api-keys', { method: 'POST', body: JSON.stringify({ label: document.getElementById('keyLabel').value }) });
    document.getElementById('keyLabel').value = '';
    const box = document.getElementById('keyReveal');
    box.style.display = 'block';
    box.innerHTML = `<strong>Your new key for “${escapeHTML(r.record.label)}”</strong>
      <div class="big" style="font-size:1rem;">${escapeHTML(r.key)}</div>
      <div class="alert-actions"><button class="btn secondary sm" data-key-act="copy" data-key="${escapeAttr(r.key)}">Copy key</button></div>
      <p class="small-note">Copy it now. For safety it is shown only once. If you lose it, revoke it and create another.</p>`;
    loadApiKeys();
  } catch (e) { keyError(e.message); }
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-key-act]');
  if (!btn) return;
  if (btn.dataset.keyAct === 'copy') {
    try { await navigator.clipboard.writeText(btn.dataset.key); btn.textContent = 'Copied'; }
    catch (x) { btn.textContent = 'Select the key and copy it'; }
  } else if (btn.dataset.keyAct === 'revoke') {
    if (!window.confirm('Revoke this key? Any system using it stops working straight away.')) return;
    try { await api(`/company/api-keys/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' }); loadApiKeys(); }
    catch (err) { keyError(err.message); }
  }
});

function fillApiDocs() {
  const o = location.origin;
  document.getElementById('apiDocs').innerHTML = `
    <p class="small-note">Send your key in the <code>X-API-Key</code> header. Never put it in a web address or in a public website. Limit: 120 requests a minute per key.</p>
    <p class="small-note"><strong>Check a code</strong> (does not count as a shopper check):</p>
    <pre class="doc-pre">curl -H "X-API-Key: YOUR_KEY" ${escapeHTML(o)}/api/v1/units/THE-CODE</pre>
    <p class="small-note"><strong>Create a batch</strong>:</p>
    <pre class="doc-pre">curl -X POST -H "X-API-Key: YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"productName":"Peak Milk 900g","batchNumber":"B-2026-07","manufacturingDate":"2026-07-01"}' \\
  ${escapeHTML(o)}/api/v1/batches</pre>
    <p class="small-note"><strong>Create codes</strong> (up to 500 at a time):</p>
    <pre class="doc-pre">curl -X POST -H "X-API-Key: YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"serials":["0001","0002","0003"]}' \\
  ${escapeHTML(o)}/api/v1/batches/BATCH_ID/units

# or a numbered range:  {"prefix":"SN-","start":1,"count":100}</pre>
    <p class="small-note"><strong>List</strong> batches and codes:</p>
    <pre class="doc-pre">GET ${escapeHTML(o)}/api/v1/batches
GET ${escapeHTML(o)}/api/v1/batches/BATCH_ID/units?limit=100&amp;offset=0</pre>
    <p class="small-note"><strong>Webhook events</strong> (set the address under Alert settings): <code>unit.flagged</code>, <code>unit.out_of_area</code> and <code>test</code>. Each arrives as JSON with an <code>X-Authenticator-Signature</code> header.</p>`;
}
