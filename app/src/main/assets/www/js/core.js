/* WebyPDF – core helpers (DOM, files, pdf.js, geometry, ranges) */

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export const pad = (n, w = 3) => String(n).padStart(w, '0');

/** tiny hyperscript helper: h('div', {class:'x', onClick:fn}, child, child) */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'for') el.htmlFor = v;
    else if (k in el && !k.includes('-')) {
      try { el[k] = v; } catch { el.setAttribute(k, v); }
    } else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function svgIcon(inner, size = 22, extra = '') {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${inner}</svg>`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 2);
  return `${n.toFixed(n < 10 ? 2 : 1)} ${u[i]}`;
}

export const baseName = (name) => name.replace(/\.[^.]+$/, '');
export const pdfBlob = (bytes) => new Blob([bytes], { type: 'application/pdf' });

/* ---------- toasts ---------- */
export function toast(msg, kind = 'info', ms = 3600) {
  const host = $('#toasts');
  if (!host) return;
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, ms);
}

/* ---------- downloads ---------- */
/* Inside the Android app (WebView) blob downloads are not supported, so the native
   side exposes window.WebyAndroid and we stream the file to it in base64 chunks. */
async function saveViaAndroid(blob, name) {
  const B = window.WebyAndroid;
  const id = B.begin(name, blob.type || 'application/octet-stream');
  if (!id) throw new Error('Could not create the file on your device. Check storage permission and free space.');
  try {
    const STEP = 3 * 512 * 1024; // multiple of 3 so each base64 chunk is independent
    for (let o = 0; o < blob.size; o += STEP) {
      const buf = new Uint8Array(await blob.slice(o, o + STEP).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      if (!B.chunk(id, btoa(bin))) throw new Error('Writing the file failed. Is your storage full?');
    }
  } catch (e) { try { B.abort(id); } catch { /* ignore */ } throw e; }
  const where = B.end(id);
  if (!where) throw new Error('Saving the file failed');
  return where;
}

export function downloadBlob(blob, name) {
  if (window.WebyAndroid) {
    saveViaAndroid(blob, name)
      .then((where) => toast(`Saved to ${where}`, 'ok', 5000))
      .catch((e) => toast(String((e && e.message) || e), 'error', 6000));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---------- errors ---------- */
export function friendlyError(e) {
  const m = String((e && e.message) || e || 'Something went wrong');
  if (e && (e.name === 'EncryptedPDFError' || e.name === 'PasswordException' || /encrypt|password/i.test(m))) {
    return 'This PDF is password-protected or encrypted. Open it in a PDF viewer, enter the password, then use Print → Save as PDF to make an unprotected copy.';
  }
  if (/invalid pdf|no pdf header|failed to parse|InvalidPDFException|Missing PDF|Invalid XRef|xref/i.test(m)) {
    return 'This file does not look like a valid PDF, or it is damaged.';
  }
  return m;
}

/* ---------- pdf-lib ---------- */
export async function loadDoc(bytes, name = '') {
  try {
    return await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    throw new Error((name ? `${name}: ` : '') + friendlyError(e));
  }
}

/* ---------- pdf.js (lazy, ESM) ---------- */
let pdfjsPromise;
export function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
      return m;
    });
  }
  return pdfjsPromise;
}

export async function openPdf(bytes, name = '') {
  const pdfjs = await loadPdfJs();
  const base = new URL('../vendor/pdfjs/', import.meta.url).href;
  const task = pdfjs.getDocument({
    data: bytes.slice(0),
    isEvalSupported: false,
    wasmUrl: base + 'wasm/',
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
  });
  try {
    const pdf = await task.promise;
    pdf.destroy = () => task.destroy().catch(() => {});
    return pdf;
  } catch (e) {
    task.destroy().catch(() => {});
    throw new Error((name ? `${name}: ` : '') + friendlyError(e));
  }
}

/** keep canvases under mobile-safe pixel limits */
export function safeScale(viewport1, wanted, maxPixels = 14e6) {
  const px = viewport1.width * viewport1.height * wanted * wanted;
  return px > maxPixels ? wanted * Math.sqrt(maxPixels / px) : wanted;
}

export async function renderToCanvas(page, scale, bg = '#ffffff') {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  return canvas;
}

export function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), type, quality));
}

export function releaseCanvas(c) { c.width = 0; c.height = 0; }

export function toGray(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
}

/* ---------- page geometry: place things in *visual* coordinates ----------
   Visual coords: origin bottom-left of the page as displayed (after /Rotate). */
export function pageGeom(page) {
  const box = page.getCropBox();
  const R = ((page.getRotation().angle % 360) + 360) % 360;
  const w0 = box.width, h0 = box.height;
  const W = R % 180 ? h0 : w0;
  const H = R % 180 ? w0 : h0;
  function place(vx, vy, vAngle = 0) {
    let x, y;
    if (R === 0) { x = vx; y = vy; }
    else if (R === 90) { x = w0 - vy; y = vx; }
    else if (R === 180) { x = w0 - vx; y = h0 - vy; }
    else { x = vy; y = h0 - vx; }
    return { x: x + box.x, y: y + box.y, angle: vAngle + R };
  }
  return { W, H, R, place };
}

/* ---------- ranges ---------- */
/** "1-3, 5, 8-" -> [[0,1,2],[4],[7..n-1]] (one array per comma part) */
export function parseRanges(str, total) {
  const parts = String(str || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Enter at least one page or range, for example 1-3, 5');
  const out = [];
  for (const p of parts) {
    const m = p.toLowerCase().replace(/last/g, String(total)).match(/^(\d*)\s*(?:[-–]\s*(\d*))?$/);
    if (!m || (m[1] === '' && (m[2] === undefined || m[2] === ''))) throw new Error(`“${p}” is not a valid page or range`);
    const hasDash = /[-–]/.test(p);
    let a = m[1] === '' ? 1 : parseInt(m[1], 10);
    let b = hasDash ? (m[2] === '' || m[2] === undefined ? total : parseInt(m[2], 10)) : a;
    if (a < 1 || b < 1 || a > total || b > total) throw new Error(`“${p}” is outside this document (1–${total})`);
    const idx = [];
    if (a <= b) for (let i = a; i <= b; i++) idx.push(i - 1);
    else for (let i = a; i >= b; i--) idx.push(i - 1);
    out.push(idx);
  }
  return out;
}
export const flatRange = (str, total) => parseRanges(str, total).flat();

export function toRangeString(indices) {
  const s = [...indices].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${s[i] + 1}-${s[j] + 1}` : `${s[i] + 1}`);
    i = j + 1;
  }
  return parts.join(', ');
}

export async function readText(file) { return await file.text(); }

/* concurrency limiter */
export function limiter(n = 2) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}
