/* WebyPDF – interactive tool views (page pickers, organizer, signature, text, metadata) */
import {
  h, svgIcon, fmtBytes, openPdf, renderToCanvas, releaseCanvas, toast, loadDoc,
  limiter, parseRanges, toRangeString, friendlyError, canvasToBlob,
} from './core.js';

const I = {
  left: svgIcon('<path d="m15 18-6-6 6-6"/>', 16),
  right: svgIcon('<path d="m9 18 6-6-6-6"/>', 16),
  rot: svgIcon('<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v5h-5"/>', 16),
  dup: svgIcon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>', 16),
  trash: svgIcon('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>', 16),
  plus: svgIcon('<path d="M12 5v14M5 12h14"/>', 16),
  check: svgIcon('<path d="m5 12 5 5 9-10"/>', 18, 'stroke-width="3"'),
};
const ico = (k) => h('span', { class: 'ico', html: I[k] });

/* ------------------------------------------------------------------ *
 *  Thumbnails engine (lazy, cached)
 * ------------------------------------------------------------------ */
function thumbEngine(pdf) {
  const cache = new Map();
  const pending = new Map();
  const run = limiter(2);
  function get(idx) {
    if (cache.has(idx)) return Promise.resolve(cache.get(idx));
    if (pending.has(idx)) return pending.get(idx);
    const p = run(async () => {
      const page = await pdf.getPage(idx + 1);
      const v1 = page.getViewport({ scale: 1 });
      const s = Math.min(210 / v1.width, 290 / v1.height);
      const c = await renderToCanvas(page, s);
      const url = c.toDataURL('image/jpeg', 0.74);
      releaseCanvas(c);
      page.cleanup();
      cache.set(idx, url);
      return url;
    }).catch(() => null).finally(() => pending.delete(idx));
    pending.set(idx, p);
    return p;
  }
  return { get, cache };
}

function lazyThumbs(host, engine) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const img = e.target.querySelector('img');
      const idx = Number(e.target.dataset.src);
      if (idx >= 0 && img && !img.src) engine.get(idx).then((u) => { if (u) img.src = u; });
    }
  }, { rootMargin: '500px' });
  return (cell) => io.observe(cell);
}

function cleanupHook(ctx, fn) {
  const prev = ctx.state.cleanup;
  ctx.state.cleanup = () => { try { prev && prev(); } finally { fn(); } };
}

async function openForView(host, ctx) {
  host.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spin' }), 'Reading your PDF…'));
  const f = ctx.files[0];
  const bytes = await ctx.bytes(f);
  const pdf = await openPdf(bytes, f.name);
  cleanupHook(ctx, () => pdf.destroy());
  return pdf;
}

/* ------------------------------------------------------------------ *
 *  Page picker (Extract / Remove)
 * ------------------------------------------------------------------ */
export async function pagesSelectView(host, ctx, { verb }) {
  const pdf = await openForView(host, ctx);
  const total = pdf.numPages;
  const engine = thumbEngine(pdf);
  const observe = lazyThumbs(host, engine);
  const sel = new Set();
  ctx.state.total = total;
  ctx.state.sel = sel;

  const input = h('input', { type: 'text', placeholder: 'e.g. 1-3, 5, 8-10', inputMode: 'text', autocomplete: 'off', 'aria-label': 'Pages' });
  const count = h('span', { class: 'chip-count' });
  const grid = h('div', { class: 'pgrid' });
  const cells = [];

  const refresh = (fromInput = false) => {
    cells.forEach((c, i) => c.classList.toggle('sel', sel.has(i)));
    count.textContent = `${sel.size} of ${total} selected`;
    if (!fromInput) input.value = toRangeString(sel);
  };
  const setAll = (fn) => { sel.clear(); for (let i = 0; i < total; i++) if (fn(i)) sel.add(i); refresh(); };

  input.addEventListener('input', () => {
    try {
      const idx = input.value.trim() ? parseRanges(input.value, total).flat() : [];
      sel.clear(); idx.forEach((i) => sel.add(i));
      input.classList.remove('bad');
      refresh(true);
    } catch { input.classList.add('bad'); }
  });

  for (let i = 0; i < total; i++) {
    const cell = h('button', { type: 'button', class: 'pcell', 'data-src': i, 'aria-label': `Page ${i + 1}`, onClick: () => { sel.has(i) ? sel.delete(i) : sel.add(i); refresh(); } },
      h('div', { class: 'pthumb' }, h('img', { alt: '', draggable: false })),
      h('span', { class: 'pnum' }, i + 1),
      h('span', { class: 'pcheck', html: I.check }));
    cells.push(cell);
    grid.append(cell);
    observe(cell);
  }

  host.replaceChildren(
    h('div', { class: 'panel glass' },
      h('div', { class: 'panel-head' }, h('h3', {}, `Choose pages to ${verb}`), count),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn sm', type: 'button', onClick: () => setAll(() => true) }, 'All'),
        h('button', { class: 'btn sm', type: 'button', onClick: () => setAll(() => false) }, 'None'),
        h('button', { class: 'btn sm', type: 'button', onClick: () => setAll((i) => !sel.has(i)) }, 'Invert'),
        h('button', { class: 'btn sm', type: 'button', onClick: () => setAll((i) => i % 2 === 0) }, 'Odd'),
        h('button', { class: 'btn sm', type: 'button', onClick: () => setAll((i) => i % 2 === 1) }, 'Even')),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Or type page numbers'), input),
      grid));
  refresh();
}

/* ------------------------------------------------------------------ *
 *  Organizer (reorder / rotate / delete / duplicate / blank)
 * ------------------------------------------------------------------ */
export async function organizeView(host, ctx) {
  const pdf = await openForView(host, ctx);
  const total = pdf.numPages;
  const engine = thumbEngine(pdf);
  const observe = lazyThumbs(host, engine);
  let uid = 0;
  const items = Array.from({ length: total }, (_, i) => ({ id: ++uid, src: i, rot: 0 }));
  ctx.state.items = items;
  const count = h('span', { class: 'chip-count' });
  const grid = h('div', { class: 'pgrid org' });
  let dragId = null;

  function move(id, dir) {
    const i = items.findIndex((x) => x.id === id);
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    render();
  }

  function render() {
    count.textContent = `${items.length} page${items.length === 1 ? '' : 's'}`;
    grid.replaceChildren();
    items.forEach((it, pos) => {
      const img = h('img', { alt: '', draggable: false });
      const cached = it.src >= 0 ? engine.cache.get(it.src) : null;
      if (cached) img.src = cached;
      const thumb = h('div', { class: 'pthumb' + (it.src < 0 ? ' blank' : '') }, img, it.src < 0 ? h('span', { class: 'blanklbl' }, 'Blank') : null);
      img.style.transform = `rotate(${it.rot}deg) scale(${it.rot % 180 ? 0.75 : 1})`;
      const btn = (cls, icon, label, fn) => h('button', { type: 'button', class: `mini ${cls}`, 'aria-label': label, title: label, onClick: (e) => { e.stopPropagation(); fn(); } }, ico(icon));
      const cell = h('div', {
        class: 'pcell static', 'data-src': it.src, draggable: true,
        onDragstart: (e) => { dragId = it.id; cell.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(it.id)); } catch { /* ignore */ } },
        onDragend: () => { dragId = null; cell.classList.remove('dragging'); },
        onDragover: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
        onDrop: (e) => {
          e.preventDefault();
          if (dragId == null || dragId === it.id) return;
          const from = items.findIndex((x) => x.id === dragId);
          const [m] = items.splice(from, 1);
          items.splice(items.findIndex((x) => x.id === it.id) + (from < pos ? 1 : 0), 0, m);
          render();
        },
      },
      thumb,
      h('span', { class: 'pnum' }, pos + 1),
      h('div', { class: 'pctl' },
        btn('', 'left', 'Move earlier', () => move(it.id, -1)),
        btn('', 'right', 'Move later', () => move(it.id, 1)),
        btn('', 'rot', 'Rotate 90°', () => { it.rot = (it.rot + 90) % 360; render(); }),
        btn('', 'dup', 'Duplicate', () => { items.splice(pos + 1, 0, { id: ++uid, src: it.src, rot: it.rot }); render(); }),
        btn('danger', 'trash', 'Delete', () => { items.splice(pos, 1); render(); })));
      grid.append(cell);
      if (!cached && it.src >= 0) observe(cell);
    });
  }

  host.replaceChildren(
    h('div', { class: 'panel glass' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Arrange your pages'), count),
      h('p', { class: 'hint' }, 'Drag to reorder on desktop, or use the arrow buttons. Rotate, duplicate or delete any page.'),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn sm', type: 'button', onClick: () => { items.reverse(); render(); } }, 'Reverse order'),
        h('button', { class: 'btn sm', type: 'button', onClick: () => { items.forEach((x) => { x.rot = (x.rot + 90) % 360; }); render(); } }, 'Rotate all'),
        h('button', { class: 'btn sm', type: 'button', onClick: () => { items.push({ id: ++uid, src: -1, rot: 0 }); render(); } }, ico('plus'), 'Add blank page'),
        h('button', { class: 'btn sm', type: 'button', onClick: () => { items.length = 0; for (let i = 0; i < total; i++) items.push({ id: ++uid, src: i, rot: 0 }); render(); } }, 'Reset')),
      grid));
  render();
}

/* ------------------------------------------------------------------ *
 *  Text → PDF input
 * ------------------------------------------------------------------ */
export function textView(host, ctx) {
  const ta = h('textarea', { rows: 12, placeholder: 'Type or paste your text here…', spellcheck: true, 'aria-label': 'Text to convert' });
  const stat = h('span', { class: 'hint' }, '0 characters');
  ta.addEventListener('input', () => { ctx.state.text = ta.value; stat.textContent = `${ta.value.length.toLocaleString()} characters`; });
  ctx.state.text = '';
  const file = h('input', { type: 'file', accept: '.txt,.md,.csv,.log,.json,text/plain', hidden: true });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    ta.value = await f.text();
    ta.dispatchEvent(new Event('input'));
    file.value = '';
  });
  host.replaceChildren(h('div', { class: 'panel glass' },
    h('div', { class: 'panel-head' }, h('h3', {}, 'Your text'), stat),
    ta,
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn sm', type: 'button', onClick: () => file.click() }, 'Import .txt / .md file'),
      h('button', { class: 'btn sm', type: 'button', onClick: () => { ta.value = ''; ta.dispatchEvent(new Event('input')); } }, 'Clear'),
      file)));
}

/* ------------------------------------------------------------------ *
 *  Metadata editor
 * ------------------------------------------------------------------ */
export async function metadataView(host, ctx) {
  host.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spin' }), 'Reading document info…'));
  const f = ctx.files[0];
  const doc = await loadDoc(await ctx.bytes(f), f.name);
  const fields = {
    title: doc.getTitle() || '', author: doc.getAuthor() || '', subject: doc.getSubject() || '',
    keywords: doc.getKeywords() || '', creator: doc.getCreator() || '', producer: doc.getProducer() || '',
  };
  ctx.state.meta = { ...fields };
  ctx.state.clear = false;
  const input = (key, label) => {
    const el = h('input', { type: 'text', value: fields[key], autocomplete: 'off' });
    el.addEventListener('input', () => { ctx.state.meta[key] = el.value; });
    return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), el);
  };
  const clear = h('input', { type: 'checkbox' });
  clear.addEventListener('change', () => { ctx.state.clear = clear.checked; box.classList.toggle('dim', clear.checked); });
  const box = h('div', { class: 'fields' },
    input('title', 'Title'), input('author', 'Author'), input('subject', 'Subject'),
    input('keywords', 'Keywords (comma separated)'), input('creator', 'Creator app'), input('producer', 'Producer'));
  host.replaceChildren(h('div', { class: 'panel glass' },
    h('div', { class: 'panel-head' }, h('h3', {}, 'Document properties'), h('span', { class: 'chip-count' }, `${doc.getPageCount()} pages · ${fmtBytes(f.size)}`)),
    box,
    h('label', { class: 'check' }, clear, h('span', {}, 'Remove all properties instead (title, author, keywords…)'))));
}

/* ------------------------------------------------------------------ *
 *  Sign PDF
 * ------------------------------------------------------------------ */
function trimCanvas(src) {
  const ctx = src.getContext('2d');
  const { width: w, height: hgt } = src;
  const d = ctx.getImageData(0, 0, w, hgt).data;
  let x0 = w, y0 = hgt, x1 = -1, y1 = -1;
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return null;
  const m = 8;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(hgt - 1, y1 + m);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

const SIG_FONTS = [
  ['Classic script', '"Snell Roundhand","Segoe Script","Brush Script MT","Lucida Handwriting",cursive'],
  ['Casual hand', '"Bradley Hand","Segoe Print","Comic Sans MS","Chalkboard SE",cursive'],
  ['Elegant serif', 'Georgia,"Times New Roman",serif'],
];
const SIG_COLORS = [['Ink black', '#111827'], ['Royal blue', '#1d4ed8'], ['Deep red', '#b91c1c']];

export async function signView(host, ctx) {
  const pdf = await openForView(host, ctx);
  const total = pdf.numPages;
  const st = ctx.state;
  st.sig = null;
  st.pos = { x: 0.7, y: 0.85, w: 0.3 };
  st.page = 1;
  st.applyTo = 'current';
  st.total = total;
  let color = SIG_COLORS[0][1];

  /* ---- signature maker ---- */
  const pad = h('canvas', { width: 760, height: 260, class: 'sigpad', 'aria-label': 'Draw your signature here' });
  const g = pad.getContext('2d');
  g.lineCap = 'round'; g.lineJoin = 'round';
  let drawing = false, last = null;
  const pt = (e) => { const r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; };
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault(); pad.setPointerCapture(e.pointerId); drawing = true; last = pt(e);
    g.fillStyle = color; g.beginPath(); g.arc(last.x, last.y, 2.8, 0, 7); g.fill();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pt(e);
    g.strokeStyle = color; g.lineWidth = 5.5;
    g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(p.x, p.y); g.stroke(); last = p;
  });
  const end = () => { if (!drawing) return; drawing = false; commit(pad); };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);

  const typed = h('input', { type: 'text', placeholder: 'Type your name', maxLength: 40, autocomplete: 'off' });
  const fontSel = h('select', {}, SIG_FONTS.map(([l, v], i) => h('option', { value: i }, l)));
  function renderTyped() {
    const txt = typed.value.trim();
    if (!txt) return;
    const c = document.createElement('canvas');
    const x = c.getContext('2d');
    const fam = SIG_FONTS[+fontSel.value][1];
    x.font = `italic 110px ${fam}`;
    c.width = Math.ceil(x.measureText(txt).width) + 60; c.height = 190;
    x.font = `italic 110px ${fam}`; x.fillStyle = color; x.textBaseline = 'middle';
    x.fillText(txt, 30, 98);
    commit(c);
  }
  typed.addEventListener('input', renderTyped);
  fontSel.addEventListener('change', renderTyped);

  const upFile = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const whiteOff = h('input', { type: 'checkbox', checked: true });
  async function renderUpload() {
    const f = upFile.files[0];
    if (!f) return;
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    const k = Math.min(1, 900 / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0, c.width, c.height);
    if (whiteOff.checked) {
      const im = x.getImageData(0, 0, c.width, c.height); const d = im.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
        if (lum > 235) d[i + 3] = 0; else if (lum > 170) d[i + 3] = Math.round(d[i + 3] * (235 - lum) / 65);
      }
      x.putImageData(im, 0, 0);
    }
    commit(c);
  }
  upFile.addEventListener('change', renderUpload);
  whiteOff.addEventListener('change', renderUpload);

  const sigImg = h('img', { class: 'sigimg', alt: 'Your signature', draggable: false, hidden: true });
  function commit(canvas) {
    const t = trimCanvas(canvas);
    if (!t) { st.sig = null; sigImg.hidden = true; return; }
    st.sig = t;
    sigImg.src = t.toDataURL('image/png');
    sigImg.hidden = false;
    status.textContent = 'Signature ready — drag it into place on the page below.';
    status.classList.add('ok');
    layout();
  }

  const panes = {
    draw: h('div', { class: 'pane' },
      pad,
      h('div', { class: 'toolbar' },
        h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Ink colour' }, SIG_COLORS.map(([n, c], i) =>
          h('button', { type: 'button', class: 'swatch' + (i === 0 ? ' on' : ''), style: { background: c }, 'aria-label': n, title: n, onClick: (e) => { color = c; [...e.currentTarget.parentNode.children].forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }))),
        h('button', { type: 'button', class: 'btn sm', onClick: () => { g.clearRect(0, 0, pad.width, pad.height); st.sig = null; sigImg.hidden = true; status.textContent = 'Draw, type or upload a signature.'; status.classList.remove('ok'); } }, 'Clear'))),
    type: h('div', { class: 'pane', hidden: true }, h('div', { class: 'fields' }, h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Name'), typed), h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Style'), fontSel)), h('p', { class: 'hint' }, 'Ink colour follows the swatch picked on the Draw tab.')),
    upload: h('div', { class: 'pane', hidden: true }, h('button', { type: 'button', class: 'btn', onClick: () => upFile.click() }, 'Choose a signature photo'), upFile, h('label', { class: 'check' }, whiteOff, h('span', {}, 'Make white background transparent'))),
  };
  const tabBtns = {};
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload']].map(([k, l]) => {
    const b = h('button', { type: 'button', role: 'tab', class: 'tab' + (k === 'draw' ? ' on' : ''), onClick: () => { Object.entries(panes).forEach(([kk, p]) => { p.hidden = kk !== k; tabBtns[kk].classList.toggle('on', kk === k); }); } }, l);
    tabBtns[k] = b;
    return b;
  }));
  const status = h('p', { class: 'hint' }, 'Draw, type or upload a signature.');

  /* ---- placement stage ---- */
  const stageCanvas = h('canvas', { class: 'stagecanvas' });
  const stage = h('div', { class: 'stage' }, stageCanvas, sigImg);
  const pageLbl = h('span', { class: 'pagelbl' });
  let rendering = 0;
  async function showPage(n) {
    st.page = Math.min(Math.max(1, n), total);
    pageLbl.textContent = `Page ${st.page} / ${total}`;
    const token = ++rendering;
    const page = await pdf.getPage(st.page);
    const v1 = page.getViewport({ scale: 1 });
    const c = await renderToCanvas(page, Math.min(2, 760 / v1.width));
    if (token !== rendering) { releaseCanvas(c); return; }
    stageCanvas.width = c.width; stageCanvas.height = c.height;
    stageCanvas.getContext('2d').drawImage(c, 0, 0);
    releaseCanvas(c);
    stage.style.aspectRatio = `${stageCanvas.width} / ${stageCanvas.height}`;
    layout();
  }
  function layout() {
    sigImg.style.left = `${st.pos.x * 100}%`;
    sigImg.style.top = `${st.pos.y * 100}%`;
    sigImg.style.width = `${st.pos.w * 100}%`;
  }
  let dragging = null;
  sigImg.addEventListener('pointerdown', (e) => { e.preventDefault(); sigImg.setPointerCapture(e.pointerId); dragging = true; sigImg.classList.add('drag'); });
  sigImg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = stage.getBoundingClientRect();
    st.pos.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    st.pos.y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    layout();
  });
  const stop = () => { dragging = false; sigImg.classList.remove('drag'); };
  sigImg.addEventListener('pointerup', stop);
  sigImg.addEventListener('pointercancel', stop);

  const size = h('input', { type: 'range', min: 8, max: 70, value: Math.round(st.pos.w * 100), 'aria-label': 'Signature size' });
  size.addEventListener('input', () => { st.pos.w = size.value / 100; layout(); });
  const applySel = h('select', {}, [['current', 'This page only'], ['all', 'Every page'], ['first', 'First page'], ['last', 'Last page']].map(([v, l]) => h('option', { value: v }, l)));
  applySel.addEventListener('change', () => { st.applyTo = applySel.value; });

  host.replaceChildren(
    h('div', { class: 'panel glass' },
      h('div', { class: 'panel-head' }, h('h3', {}, '1 · Create your signature')),
      tabs, panes.draw, panes.type, panes.upload, status),
    h('div', { class: 'panel glass' },
      h('div', { class: 'panel-head' }, h('h3', {}, '2 · Place it on the page')),
      h('div', { class: 'toolbar between' },
        h('button', { type: 'button', class: 'btn sm', onClick: () => showPage(st.page - 1), 'aria-label': 'Previous page' }, ico('left')),
        pageLbl,
        h('button', { type: 'button', class: 'btn sm', onClick: () => showPage(st.page + 1), 'aria-label': 'Next page' }, ico('right'))),
      stage,
      h('div', { class: 'fields' },
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Signature size'), size),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Apply to'), applySel))));
  cleanupHook(ctx, () => { rendering++; });
  await showPage(1);
}

export { friendlyError, canvasToBlob, toast };
