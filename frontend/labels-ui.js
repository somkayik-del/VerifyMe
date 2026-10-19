/* Labels and QR images for a whole batch. Runs entirely in the company's browser (the design is
   never uploaded anywhere). The server only supplies each unit's QR squares.
     - without a design: a QR for every unit, as one PDF or a ZIP of images
     - with the company's design: the QR (and its code) placed on that design for every unit
   Loaded after app.js. */

const QUIET = 4;               // white border around a QR, in squares (the QR standard asks for 4)
const PREVIEW_PX = 480;        // width of the on-screen preview
const BLANK = { w: 1000, h: 1200 }; // the label shape when there is no design (QR plus room for the code)

const lbl = {
  batchId: null, batchName: '', total: 0, first: null,
  design: null,                // { img, w, h, name } when the company uploaded a design
  x: 0.05, y: 0.04, size: 0.9, // QR box position (top-left) and width, as fractions of the label width/height
  widthMm: 60, caption: true, busy: false
};

/* ---------- open / close ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-label-batch]');
  if (b) openLabels(b.dataset.labelBatch, b.dataset.labelName);
});

async function openLabels(batchId, batchName) {
  Object.assign(lbl, { batchId, batchName, design: null, first: null, total: 0, caption: true, widthMm: 60 });
  setBlankDefaults();
  document.getElementById('lblTitle').textContent = 'Batch ' + batchName;
  document.getElementById('lblFile').value = '';
  document.getElementById('lblCaption').checked = true;
  document.getElementById('lblFormat').value = 'pdf';
  lblStatus('');
  document.getElementById('labelModal').classList.add('open');
  try {
    const d = await api(`/batches/${encodeURIComponent(batchId)}/qr-data?offset=0&limit=1`);
    lbl.total = d.total;
    lbl.first = d.units[0] || null;
    document.getElementById('lblIntro').textContent = d.total
      ? `${d.total.toLocaleString()} unit${d.total === 1 ? '' : 's'} in this batch. Each gets its own QR code. Upload your product design to place the QR on it, or skip that for plain QR labels.`
      : 'This batch has no units yet. Create some codes first.';
  } catch (e) {
    if (e.status === 401) { closeLabels(); setSession(null); renderCompanyView(); return; }
    lblStatus(e.message, false);
  }
  syncControls();
  paintPreview();
}

function closeLabels() {
  document.getElementById('labelModal').classList.remove('open');
}

function setBlankDefaults() { lbl.x = 0.05; lbl.y = 0.04; lbl.size = 0.9; }
function setDesignDefaults() { lbl.x = 0.05; lbl.y = 0.05; lbl.size = 0.3; }
const dims = () => (lbl.design ? { w: lbl.design.w, h: lbl.design.h } : BLANK);

function lblStatus(text, ok) {
  const el = document.getElementById('lblStatus');
  el.textContent = text;
  el.className = 'status-line' + (ok === true ? ' ok-text' : ok === false ? ' error-text' : '');
}

/* ---------- the design ---------- */
document.getElementById('lblFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { lblStatus('Please choose a PNG, JPG or WebP image. (Export your design from your design program as one of these.)', false); e.target.value = ''; return; }
  if (f.size > 40 * 1024 * 1024) { lblStatus('That image is larger than 40 MB. Please export a smaller one.', false); e.target.value = ''; return; }
  try {
    const url = URL.createObjectURL(f);
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    lbl.design = { img, w: img.naturalWidth, h: img.naturalHeight, name: f.name };
    setDesignDefaults();
    lblStatus('', null);
    syncControls();
    paintPreview();
  } catch (err) { lblStatus('That image could not be read. Try exporting it again.', false); e.target.value = ''; }
});

function removeDesign() {
  lbl.design = null;
  setBlankDefaults();
  document.getElementById('lblFile').value = '';
  syncControls();
  paintPreview();
}

/* ---------- controls ---------- */
function syncControls() {
  document.getElementById('lblRemove').style.display = lbl.design ? '' : 'none';
  document.getElementById('lblSize').value = Math.round(lbl.size * 100);
  document.getElementById('lblWidth').value = lbl.widthMm;
  document.getElementById('lblCaption').checked = lbl.caption;
  document.getElementById('lblHint').textContent = lbl.design
    ? 'Drag on the picture to move the QR code. Use the size slider to make it bigger or smaller.'
    : 'No design chosen: each label is just a QR code with its code underneath.';
  const d = dims();
  const boxMm = lbl.size * lbl.widthMm;
  const heightMm = lbl.widthMm * d.h / d.w;
  document.getElementById('lblSizeText').textContent = `${Math.round(lbl.size * 100)}% of the width`;
  document.getElementById('lblPhysical').innerHTML =
    `Label: ${lbl.widthMm} × ${heightMm.toFixed(1)} mm. QR code about ${boxMm.toFixed(1)} mm wide.` +
    (boxMm < 15 ? ' <strong class="error-text">That is small: QR codes under about 15 mm can be hard to scan. 20 mm or more is best.</strong>' : '');
}

document.getElementById('lblSize').addEventListener('input', e => { lbl.size = Number(e.target.value) / 100; syncControls(); paintPreview(); });
document.getElementById('lblWidth').addEventListener('input', e => { lbl.widthMm = Math.max(10, Math.min(1000, Number(e.target.value) || 60)); syncControls(); });
document.getElementById('lblCaption').addEventListener('change', e => { lbl.caption = e.target.checked; paintPreview(); });

// Drag the QR on the preview.
(function enableDrag() {
  const cv = document.getElementById('lblCanvas');
  let dragging = false;
  const move = ev => {
    const r = cv.getBoundingClientRect();
    const d = dims();
    const relX = (ev.clientX - r.left) / r.width;
    const relY = (ev.clientY - r.top) / r.height;
    lbl.x = relX - lbl.size / 2;
    lbl.y = relY - (lbl.size * d.w / d.h) / 2;
    paintPreview();
  };
  cv.addEventListener('pointerdown', ev => { if (!lbl.first) return; dragging = true; cv.setPointerCapture(ev.pointerId); move(ev); });
  cv.addEventListener('pointermove', ev => { if (dragging) move(ev); });
  cv.addEventListener('pointerup', () => { dragging = false; });
})();

/* ---------- QR squares and layout ---------- */
function unpack(u) {
  const bin = atob(u.bits);
  const bits = new Uint8Array(u.n * u.n);
  for (let i = 0; i < bits.length; i++) bits[i] = (bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
  return bits;
}

// Horizontal runs of dark squares: fewer, bigger rectangles to draw.
function runsOf(bits, n) {
  const runs = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!bits[r * n + c]) { c++; continue; }
      let e = c;
      while (e < n && bits[r * n + e]) e++;
      runs.push([r, c, e - c]);
      c = e;
    }
  }
  return runs;
}

// Where everything goes, in the label's own pixels (W by H). Used by the preview, the PNGs and the PDF.
function layoutFor(W, H, n, codeLen, whole) {
  let box = lbl.size * W;
  let mod = box / (n + 2 * QUIET);
  if (whole) { mod = Math.max(1, Math.floor(mod)); box = mod * (n + 2 * QUIET); } // whole pixels: crisp edges in images
  const capFs = lbl.caption ? Math.min(box * 0.96 / (0.6 * Math.max(codeLen, 8)), box * 0.09) : 0;
  const capH = lbl.caption ? capFs * 1.7 : 0;
  const x0 = Math.max(0, Math.min(lbl.x * W, W - box));
  const y0 = Math.max(0, Math.min(lbl.y * H, H - box - capH));
  return { box, mod, capFs, capH, x0, y0, qx: x0 + QUIET * mod, qy: y0 + QUIET * mod, capY: y0 + box };
}

function paintLabel(ctx, W, H, u, bits, designImg, whole) {
  const L = layoutFor(W, H, u.n, u.code.length, whole);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  if (designImg) ctx.drawImage(designImg, 0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.fillRect(L.x0, L.y0, L.box, L.box + L.capH);
  ctx.fillStyle = '#000';
  for (const [r, c, len] of runsOf(bits, u.n)) ctx.fillRect(L.qx + c * L.mod, L.qy + r * L.mod, len * L.mod, L.mod + (whole ? 0 : 0.6));
  if (lbl.caption) {
    let fs = L.capFs;
    ctx.font = `bold ${fs}px "Courier New", Courier, monospace`;
    const wide = ctx.measureText(u.code).width;
    if (wide > L.box * 0.96) { fs *= L.box * 0.96 / wide; ctx.font = `bold ${fs}px "Courier New", Courier, monospace`; }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000';
    ctx.fillText(u.code, L.x0 + L.box / 2, L.capY + L.capH * 0.68);
  }
}

function paintPreview() {
  const cv = document.getElementById('lblCanvas');
  const d = dims();
  const scale = (PREVIEW_PX * 2) / d.w;            // drawn at double size so it looks sharp
  cv.width = Math.round(d.w * scale);
  cv.height = Math.round(d.h * scale);
  cv.style.width = PREVIEW_PX + 'px';
  cv.style.height = Math.round(PREVIEW_PX * d.h / d.w) + 'px';
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.scale(scale, scale);
  if (lbl.first) paintLabel(ctx, d.w, d.h, lbl.first, unpack(lbl.first), lbl.design && lbl.design.img, false);
  else { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, d.w, d.h); if (lbl.design) ctx.drawImage(lbl.design.img, 0, 0, d.w, d.h); }
  ctx.restore();
  cv.style.border = '1px solid rgba(128,128,128,.5)';
}

/* ---------- ZIP (no compression: PNGs are already compressed) ---------- */
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint16(8, 0, true); head.setUint16(10, dosTime, true); head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true); head.setUint32(18, f.data.length, true); head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
    parts.push(new Uint8Array(head.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, f.data.length, true); cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  let cdSize = 0;
  central.forEach(c => { cdSize += c.length; });
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/* ---------- PDF: the design once, plus each unit's QR drawn as sharp vector squares ---------- */
const pdfText = s => String(s).replace(/[\\()]/g, m => '\\' + m);
const n3 = v => (Math.round(v * 1000) / 1000).toString();

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function designJpeg() {
  const d = lbl.design;
  const cap = 5000;
  const k = Math.min(1, cap / Math.max(d.w, d.h));
  const cv = document.createElement('canvas');
  cv.width = Math.round(d.w * k); cv.height = Math.round(d.h * k);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);   // see-through parts become white
  ctx.drawImage(d.img, 0, 0, cv.width, cv.height);
  const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.95));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height };
}

async function buildPdf(units, progress) {
  const enc = new TextEncoder();
  const d = dims();
  const Wpt = lbl.widthMm * 72 / 25.4;
  const Hpt = Wpt * d.h / d.w;
  const s = Wpt / d.w;                                 // label pixels -> PDF points
  const img = lbl.design ? await designJpeg() : null;

  const chunks = [];
  const offsets = [];
  let size = 0;
  const push = piece => { const b = typeof piece === 'string' ? enc.encode(piece) : piece; chunks.push(b); size += b.length; };
  const startObj = n => { offsets[n] = size; push(`${n} 0 obj\n`); };

  push('%PDF-1.4\n'); push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
  const firstPage = img ? 5 : 4;
  const kids = units.map((_, i) => `${firstPage + i * 2} 0 R`).join(' ');
  startObj(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  startObj(2); push(`<< /Type /Pages /Kids [${kids}] /Count ${units.length} >>\nendobj\n`);
  startObj(3); push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>\nendobj\n');
  if (img) {
    startObj(4);
    push(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`);
    push(img.bytes); push('\nendstream\nendobj\n');
  }
  const resources = `<< ${img ? '/XObject << /Im0 4 0 R >> ' : ''}/Font << /F1 3 0 R >> >>`;

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const bits = unpack(u);
    const L = layoutFor(d.w, d.h, u.n, u.code.length, false);
    const e = 0.03 * L.mod * s;                         // a hair of overlap so no seams show between squares
    let c = '';
    if (img) c += `q ${n3(Wpt)} 0 0 ${n3(Hpt)} 0 0 cm /Im0 Do Q\n`;
    c += `1 1 1 rg ${n3(L.x0 * s)} ${n3(Hpt - (L.y0 + L.box + L.capH) * s)} ${n3(L.box * s)} ${n3((L.box + L.capH) * s)} re f\n0 g\n`;
    for (const [r, col, len] of runsOf(bits, u.n)) {
      c += `${n3((L.qx + col * L.mod) * s - e)} ${n3(Hpt - (L.qy + (r + 1) * L.mod) * s - e)} ${n3(len * L.mod * s + 2 * e)} ${n3(L.mod * s + 2 * e)} re\n`;
    }
    c += 'f\n';
    if (lbl.caption) {
      const fs = Math.min(L.capFs, (L.box * 0.96) / (0.6 * u.code.length)) * s;   // Courier is 0.6 em wide per character
      const tw = 0.6 * fs * u.code.length;
      c += `BT /F1 ${n3(fs)} Tf ${n3((L.x0 + L.box / 2) * s - tw / 2)} ${n3(Hpt - (L.capY + L.capH * 0.68) * s)} Td (${pdfText(u.code)}) Tj ET\n`;
    }
    const raw = enc.encode(c);
    const packed = await deflate(raw);
    const page = firstPage + i * 2, content = page + 1;
    startObj(page);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n3(Wpt)} ${n3(Hpt)}] /Resources ${resources} /Contents ${content} 0 R >>\nendobj\n`);
    startObj(content);
    push(`<< /Length ${(packed || raw).length}${packed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`);
    push(packed || raw); push('\nendstream\nendobj\n');
    if (i % 25 === 0) progress(i + 1, units.length);
  }

  const total = firstPage + units.length * 2;
  const xref = size;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) table += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  push(table);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

/* ---------- images ---------- */
async function pngFor(u, W, H, designImg) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  paintLabel(cv.getContext('2d'), W, H, u, unpack(u), designImg, true);
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- go ---------- */
async function createLabels() {
  if (lbl.busy) return;
  if (!lbl.total) { lblStatus('This batch has no units yet. Create some codes first.', false); return; }
  lbl.busy = true;
  document.getElementById('lblGo').disabled = true;
  const safeBatch = String(lbl.batchName).replace(/[^A-Za-z0-9._-]/g, '_');
  const format = document.getElementById('lblFormat').value;
  try {
    const d = dims();
    // images get a sensible size: the design's own size (at most 3000 px on the long side)
    const k = Math.min(1, 3000 / Math.max(d.w, d.h));
    const W = Math.round(d.w * k), H = Math.round(d.h * k);
    const partSize = lbl.design ? 150 : 500;
    const designImg = lbl.design && lbl.design.img;

    let all = [], files = [], part = 0, made = 0;
    const flush = async last => {
      if (!files.length) return;
      part++;
      const one = last && part === 1;
      lblStatus(`Packing images${one ? '' : ' (part ' + part + ')'}…`);
      saveBlob(makeZip(files), one ? `labels-${safeBatch}.zip` : `labels-${safeBatch}-part${part}.zip`);
      files = [];
      await new Promise(r => setTimeout(r, 400));          // give the browser a moment between downloads
    };

    for (let offset = 0; offset < lbl.total; offset += 500) {
      lblStatus(`Getting QR codes… ${Math.min(offset, lbl.total).toLocaleString()} of ${lbl.total.toLocaleString()}`);
      const data = await api(`/batches/${encodeURIComponent(lbl.batchId)}/qr-data?offset=${offset}&limit=500`);
      if (format === 'pdf') { all = all.concat(data.units); continue; }
      for (const u of data.units) {
        files.push({ name: `${String(u.serial).replace(/[^A-Za-z0-9._-]/g, '_')}.png`, data: await pngFor(u, W, H, designImg) });
        made++;
        if (made % 10 === 0) lblStatus(`Making images… ${made.toLocaleString()} of ${lbl.total.toLocaleString()}`);
        if (files.length >= partSize) await flush(false);
      }
    }

    if (format === 'pdf') {
      const blob = await buildPdf(all, (i, n) => lblStatus(`Building the PDF… ${i.toLocaleString()} of ${n.toLocaleString()} labels`));
      saveBlob(blob, `labels-${safeBatch}.pdf`);
      lblStatus(`Done. ${all.length.toLocaleString()} label${all.length === 1 ? '' : 's'} in one PDF (${(blob.size / 1048576).toFixed(1)} MB), one per page at ${lbl.widthMm} mm wide.`, true);
    } else {
      await flush(true);
      lblStatus(`Done. ${made.toLocaleString()} image${made === 1 ? '' : 's'} downloaded${part > 1 ? ' in ' + part + ' ZIP files' : ''}.`, true);
    }
  } catch (e) {
    if (e && e.status === 401) { closeLabels(); setSession(null); renderCompanyView(); }
    else lblStatus('Something went wrong: ' + ((e && e.message) || e), false);
  } finally {
    lbl.busy = false;
    document.getElementById('lblGo').disabled = false;
  }
}
