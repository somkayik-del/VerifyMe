/* The administrator page: create company accounts and see who has one.
   The token is kept only in this page's memory, so closing the tab signs you out. */

let adminToken = null;

const esc = s => { const d = document.createElement('div'); d.textContent = String(s === undefined || s === null ? '' : s); return d.innerHTML; };
const escAttr = s => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const el = id => document.getElementById(id);

async function adminApi(path, options = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken || '', ...(options.headers || {}) }
  });
  let body = {};
  try { body = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function showError(id, text) {
  const e = el(id);
  e.textContent = text || '';
  e.style.display = text ? 'block' : 'none';
}

async function adminSignIn() {
  showError('adminError', '');
  adminToken = el('adminToken').value.trim();
  if (!adminToken) { showError('adminError', 'Enter the administrator token.'); return; }
  try {
    await adminApi('/admin/check');
    el('adminLogin').style.display = 'none';
    el('adminPanel').style.display = 'block';
    el('adminToken').value = '';
    loadCompanies();
  } catch (e) {
    adminToken = null;
    showError('adminError', e.status === 403 && /not been set up/.test(e.message) ? e.message
      : e.status === 403 ? 'That token is not correct.' : e.message);
  }
}

function adminSignOut() {
  adminToken = null;
  el('adminPanel').style.display = 'none';
  el('adminLogin').style.display = 'block';
  el('createdBox').style.display = 'none';
  el('createdBox').innerHTML = '';
}

async function loadCompanies() {
  try {
    const d = await adminApi('/admin/companies');
    if (!d.companies.length) { el('adminCompanies').innerHTML = '<p class="empty-note">No companies yet.</p>'; return; }
    el('adminCompanies').innerHTML = d.companies.map(c => `
      <div class="partner-row">
        <div>
          <div class="who">${esc(c.name)}</div>
          <div class="unit-meta">Created ${esc(new Date(c.createdAt).toLocaleDateString())} · ${c.batches} batch${c.batches === 1 ? '' : 'es'} · ${c.units.toLocaleString()} unit${c.units === 1 ? '' : 's'} · ${c.partners} partner${c.partners === 1 ? '' : 's'}</div>
        </div>
      </div>`).join('');
  } catch (e) {
    el('adminCompanies').innerHTML = `<p class="error-text">${esc(e.message)}</p>`;
  }
}

// A strong password without look-alike characters, made in the browser.
function generatePassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  for (const b of bytes) { if (b < limit) out += alphabet[b % alphabet.length]; }
  while (out.length < 14) { const x = new Uint8Array(1); crypto.getRandomValues(x); if (x[0] < limit) out += alphabet[x[0] % alphabet.length]; }
  el('newPassword').value = out;
}

async function createCompany() {
  showError('createError', '');
  const name = el('newName').value.trim();
  const password = el('newPassword').value;
  if (name.length < 2) { showError('createError', 'Enter the company name.'); return; }
  if (password.length < 8) { showError('createError', 'The password must be at least 8 characters. Use Generate for a strong one.'); return; }
  try {
    // the existing registration route; it now only accepts the administrator token
    await adminApi('/auth/register', { method: 'POST', body: JSON.stringify({ name, pin: password }) });
    const link = location.origin + '/company';
    const box = el('createdBox');
    box.style.display = 'block';
    box.innerHTML = `<strong>Account created for ${esc(name)}</strong>
      <p class="small-note" style="margin:6px 0;">Give the company these details. The password cannot be shown again.</p>
      <div class="claim-details">
        <div>Login address: <strong>${esc(link)}</strong></div>
        <div>Company name: <strong>${esc(name)}</strong></div>
        <div>Password: <strong class="mono">${esc(password)}</strong></div>
      </div>
      <div class="alert-actions"><button class="btn secondary sm" data-copy="${escAttr(`Login: ${link}\nCompany name: ${name}\nPassword: ${password}`)}">Copy these details</button></div>`;
    el('newName').value = ''; el('newPassword').value = '';
    loadCompanies();
  } catch (e) {
    if (e.status === 403) { adminSignOut(); showError('adminError', 'Your administrator token was not accepted. Sign in again.'); return; }
    showError('createError', e.message);
  }
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; }
  catch (x) { b.textContent = 'Select the text above and copy it'; }
});
el('adminToken').addEventListener('keydown', e => { if (e.key === 'Enter') adminSignIn(); });
