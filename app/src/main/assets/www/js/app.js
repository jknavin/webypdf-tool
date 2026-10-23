/* WebyPDF – app shell: router, home, tool screen, results, install, theme */
import {
  $, h, svgIcon, fmtBytes, toast, downloadBlob, friendlyError, openPdf, renderToCanvas, releaseCanvas,
} from './core.js';
import { TOOLS, CATS } from './tools.js';

const app = $('#app');
const byId = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
let current = null; // active tool session (for cleanup)
const home = { q: '', cat: 'all' };

const ICONS = {
  back: svgIcon('<path d="m15 18-6-6 6-6"/>', 20),
  up: svgIcon('<path d="m6 15 6-6 6 6"/>', 16),
  down: svgIcon('<path d="m6 9 6 6 6-6"/>', 16),
  x: svgIcon('<path d="M6 6l12 12M18 6 6 18"/>', 16),
  upload: svgIcon('<path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>', 30),
  download: svgIcon('<path d="M12 4v12m0 0-4-4m4 4 4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>', 18),
  share: svgIcon('<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.6M8.2 13.2l7.6 4.6"/>', 18),
  zip: svgIcon('<path d="M5 3h9l5 5v13H5z"/><path d="M11 3v2m2 2v2m-2 2v2m2 2v2"/>', 18),
  copy: svgIcon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>', 18),
  check: svgIcon('<path d="m5 12 5 5 9-10"/>', 34, 'stroke-width="3"'),
  moon: svgIcon('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>', 20),
  sun: svgIcon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>', 20),
  lock: svgIcon('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 16),
  bolt: svgIcon('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', 16),
  wifi: svgIcon('<path d="M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01"/>', 16),
  free: svgIcon('<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/>', 16),
};

/* ------------------------------------------------------------------ *
 *  Router
 * ------------------------------------------------------------------ */
function teardown() {
  if (current) { try { current.destroy(); } catch { /* ignore */ } current = null; }
}
function route() {
  teardown();
  const m = location.hash.match(/^#\/([\w-]+)/);
  const t = m && byId[m[1]];
  app.replaceChildren();
  if (t) { document.title = `${t.name} – WebyPDF`; openTool(t); } else { document.title = 'WebyPDF – Free All-in-One PDF Tools'; renderHome(); }
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);

/* ------------------------------------------------------------------ *
 *  Home
 * ------------------------------------------------------------------ */
function renderHome() {
  const grid = h('div', { class: 'grid', role: 'list' });
  const empty = h('p', { class: 'empty glass', hidden: true }, 'No tools match your search. Try “merge”, “compress” or “sign”.');

  const draw = () => {
    const q = home.q.trim().toLowerCase();
    let n = 0;
    grid.replaceChildren(...TOOLS.filter((t) => (home.cat === 'all' || t.cat === home.cat) && (!q || `${t.name} ${t.desc} ${t.cat}`.toLowerCase().includes(q))).map((t) => {
      n++;
      return h('a', { class: 'card tool glass', role: 'listitem', href: `#/${t.id}`, style: { '--g1': t.g[0], '--g2': t.g[1] } },
        h('span', { class: 'tile', html: t.icon }),
        h('span', { class: 'tname' }, t.name),
        h('span', { class: 'tdesc' }, t.desc));
    }));
    empty.hidden = n > 0;
  };

  const search = h('input', { type: 'search', placeholder: `Search ${TOOLS.length} PDF tools…`, value: home.q, 'aria-label': 'Search tools', autocomplete: 'off' });
  search.addEventListener('input', () => { home.q = search.value; draw(); });

  const chips = h('div', { class: 'chips', role: 'tablist', 'aria-label': 'Tool categories' }, CATS.map(([k, label]) => {
    const b = h('button', { type: 'button', role: 'tab', class: 'chip' + (home.cat === k ? ' on' : ''), onClick: () => { home.cat = k; chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); b.classList.add('on'); draw(); } }, label);
    return b;
  }));

  app.append(
    h('section', { class: 'hero' },
      h('p', { class: 'eyebrow' }, 'Free · Private · Works offline'),
      h('h1', {}, 'Every PDF tool you need,', h('br'), h('span', { class: 'grad' }, 'right in your browser')),
      h('p', { class: 'sub' }, 'Merge, split, compress, sign, convert and more. Your files never leave your device — nothing is uploaded, ever.'),
      h('ul', { class: 'badges' },
        h('li', { class: 'glass', html: `${ICONS.lock}<span>100% private</span>` }),
        h('li', { class: 'glass', html: `${ICONS.bolt}<span>Instant & unlimited</span>` }),
        h('li', { class: 'glass', html: `${ICONS.wifi}<span>Installable, works offline</span>` }),
        h('li', { class: 'glass', html: `${ICONS.free}<span>No sign-up</span>` }))),
    h('div', { class: 'searchbar glass' }, h('span', { class: 'sicon', html: svgIcon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 20) }), search),
    chips, grid, empty);
  draw();
}

/* ------------------------------------------------------------------ *
 *  Tool screen
 * ------------------------------------------------------------------ */
function matchesKind(kind, f) {
  if (kind === 'pdf') return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  if (kind === 'image') return f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|svg|heic)$/i.test(f.name);
  return true;
}
const ACCEPT = { pdf: '.pdf,application/pdf', image: 'image/*', text: '' };
let seq = 0;

function openTool(tool) {
  const ctx = {
    files: [], opts: {}, state: {},
    bytes: async (f) => new Uint8Array(await f.file.arrayBuffer()),
    progress: (p, label) => { bar.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`; if (label) plabel.textContent = label; },
  };
  let viewToken = 0;
  let busy = false;

  /* --- header --- */
  const head = h('div', { class: 'toolhead' },
    h('a', { class: 'back btn glass', href: '#/', 'aria-label': 'Back to all tools', html: ICONS.back }),
    h('span', { class: 'tile big', html: tool.icon, style: { '--g1': tool.g[0], '--g2': tool.g[1] } }),
    h('div', {}, h('h2', {}, tool.name), h('p', {}, tool.desc)));

  /* --- dropzone --- */
  const input = h('input', { type: 'file', accept: ACCEPT[tool.kind] || '', multiple: !!tool.multi, hidden: true });
  const noun = tool.kind === 'image' ? 'images' : 'PDF';
  const drop = h('div', { class: 'drop glass', tabindex: 0, role: 'button', 'aria-label': `Choose ${noun} ${tool.multi ? 'files' : 'file'}` },
    h('span', { class: 'dicon', html: ICONS.upload }),
    h('strong', {}, tool.multi ? `Drop ${noun === 'PDF' ? 'PDFs' : 'images'} here or tap to browse` : 'Drop your PDF here or tap to browse'),
    h('span', { class: 'hint' }, tool.multi ? 'You can add several files' : 'Processed on your device — never uploaded'),
    h('span', { class: 'btn primary' }, tool.multi ? 'Choose files' : 'Choose file'),
    input);
  drop.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });

  const listHost = h('div', { class: 'files' });
  const viewHost = h('div', { class: 'view' });
  const optHost = h('div');
  const bar = h('i');
  const plabel = h('span', {}, 'Working…');
  const progress = h('div', { class: 'progresswrap glass', hidden: true }, h('div', { class: 'ptext' }, plabel), h('div', { class: 'progress' }, bar));
  const resultHost = h('div');
  const runBtn = h('button', { type: 'button', class: 'btn primary lg', onClick: run }, tool.cta || 'Process');
  const actionbar = h('div', { class: 'actionbar glass' + (tool.flowBar ? ' flow' : '') }, runBtn);

  /* --- options --- */
  if (tool.fields && tool.fields.length) {
    const rows = tool.fields.map((f) => {
      ctx.opts[f.id] = f.value;
      let control;
      const set = (v) => { ctx.opts[f.id] = v; syncVisibility(); };
      if (f.type === 'select') {
        control = h('select', { onChange: (e) => set(e.target.value) }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)));
      } else if (f.type === 'checkbox') {
        const cb = h('input', { type: 'checkbox', checked: !!f.value, onChange: (e) => set(e.target.checked) });
        return { f, el: h('label', { class: 'check wide' }, cb, h('span', {}, f.label)) };
      } else if (f.type === 'range') {
        const out = h('output', {}, `${f.value}${f.unit || ''}`);
        control = h('div', { class: 'rangewrap' }, h('input', { type: 'range', min: f.min, max: f.max, value: f.value, onInput: (e) => { out.textContent = `${e.target.value}${f.unit || ''}`; set(+e.target.value); } }), out);
      } else if (f.type === 'color') {
        control = h('input', { type: 'color', value: f.value, onInput: (e) => set(e.target.value) });
      } else {
        const attrs = { type: f.type === 'number' ? 'number' : 'text', value: f.value, placeholder: f.placeholder || '', autocomplete: 'off', onInput: (e) => set(f.type === 'number' ? (e.target.value === '' ? '' : +e.target.value) : e.target.value) };
        if (f.type === 'number') Object.assign(attrs, { min: f.min, max: f.max, inputMode: 'decimal' });
        if (f.maxLength) attrs.maxLength = f.maxLength;
        control = h('input', attrs);
      }
      return { f, el: h('label', { class: 'field' }, h('span', { class: 'lbl' }, f.label), control, f.hint ? h('span', { class: 'hint' }, f.hint) : null) };
    });
    const syncVisibility = () => rows.forEach(({ f, el }) => { el.hidden = f.showIf ? !f.showIf(ctx.opts) : false; });
    optHost.append(h('div', { class: 'panel glass' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Options')), h('div', { class: 'fields' }, rows.map((r) => r.el))));
    syncVisibility();
  }

  /* --- file handling --- */
  function addFiles(list) {
    if (busy) return;
    const ok = list.filter((f) => matchesKind(tool.kind, f));
    const skipped = list.length - ok.length;
    if (skipped) toast(`Skipped ${skipped} file${skipped > 1 ? 's' : ''} — ${tool.kind === 'pdf' ? 'only PDF files are accepted here' : 'only image files are accepted here'}`, 'warn');
    if (!ok.length) return;
    if (ok.some((f) => f.size > 250 * 1024 * 1024)) toast('Very large file — this may be slow on phones.', 'warn');
    resultHost.replaceChildren();
    const make = (file) => ({ id: ++seq, file, name: file.name, size: file.size, url: tool.kind === 'image' ? URL.createObjectURL(file) : null });
    if (tool.multi) ctx.files.push(...ok.map(make));
    else { clearFiles(); ctx.files = [make(ok[0])]; }
    renderFiles();
    if (!tool.multi) mountView();
    if (tool.multi && ctx.files.length) setTimeout(() => actionbar.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 80);
  }
  function clearFiles() {
    ctx.files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
    ctx.files = [];
    if (ctx.state.cleanup) { try { ctx.state.cleanup(); } catch { /* ignore */ } }
    ctx.state = {};
    viewHost.replaceChildren();
  }
  function renderFiles() {
    const has = ctx.files.length > 0;
    listHost.replaceChildren(...ctx.files.map((f, i) => {
      const thumb = f.url ? h('img', { class: 'fthumb', src: f.url, alt: '' }) : h('span', { class: 'fthumb pdf' }, 'PDF');
      const btn = (icon, label, fn, dis) => h('button', { type: 'button', class: 'mini', 'aria-label': label, title: label, disabled: dis, onClick: fn, html: icon });
      return h('div', { class: 'file glass' }, thumb,
        h('div', { class: 'fmeta' }, h('span', { class: 'fname' }, f.name), h('span', { class: 'fsize' }, fmtBytes(f.size))),
        h('div', { class: 'fctl' },
          tool.ordered && ctx.files.length > 1 ? [
            btn(ICONS.up, 'Move up', () => { [ctx.files[i - 1], ctx.files[i]] = [ctx.files[i], ctx.files[i - 1]]; renderFiles(); }, i === 0),
            btn(ICONS.down, 'Move down', () => { [ctx.files[i + 1], ctx.files[i]] = [ctx.files[i], ctx.files[i + 1]]; renderFiles(); }, i === ctx.files.length - 1),
          ] : null,
          btn(ICONS.x, 'Remove', () => {
            if (f.url) URL.revokeObjectURL(f.url);
            ctx.files.splice(i, 1);
            if (!tool.multi) { clearFiles(); }
            renderFiles();
            resultHost.replaceChildren();
          })));
    }));
    if (tool.multi) {
      const need = tool.min || 1;
      listHost.append(...(ctx.files.length && ctx.files.length < need ? [h('p', { class: 'hint center' }, `Add at least ${need} files.`)] : []));
      if (has) listHost.append(h('button', { type: 'button', class: 'btn sm addmore', onClick: () => input.click() }, '+ Add more files'));
    }
    drop.hidden = tool.multi ? false : has;
    if (tool.multi) drop.classList.toggle('compact', has);
    actionbar.hidden = tool.noFiles ? false : !has;
    optHost.hidden = tool.noFiles ? false : !has;
  }
  async function mountView() {
    if (!tool.view) return;
    const token = ++viewToken;
    try {
      await tool.view(viewHost, ctx);
    } catch (e) {
      if (token !== viewToken) return;
      viewHost.replaceChildren(h('div', { class: 'panel glass error' }, h('strong', {}, 'Couldn’t open this PDF'), h('p', {}, friendlyError(e)), h('button', { type: 'button', class: 'btn sm', onClick: () => { clearFiles(); renderFiles(); } }, 'Choose another file')));
      actionbar.hidden = true;
      console.error(e);
    }
  }

  /* --- run --- */
  async function run() {
    if (busy) return;
    const need = tool.noFiles ? 0 : (tool.min || 1);
    if (ctx.files.length < need) { toast(`Add at least ${need} file${need > 1 ? 's' : ''} first`, 'warn'); return; }
    busy = true;
    resultHost.replaceChildren();
    runBtn.disabled = true; runBtn.classList.add('busy');
    progress.hidden = false; ctx.progress(0.02, 'Starting…');
    try {
      const res = await tool.run(ctx);
      ctx.progress(1, 'Done');
      await showResult(res);
    } catch (e) {
      console.error(e);
      const msg = friendlyError(e);
      resultHost.replaceChildren(h('div', { class: 'panel glass error', role: 'alert' }, h('strong', {}, 'That didn’t work'), h('p', {}, msg)));
      toast(msg.length > 90 ? 'Something went wrong — see details below' : msg, 'error', 5000);
      resultHost.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      busy = false; runBtn.disabled = false; runBtn.classList.remove('busy');
      setTimeout(() => { progress.hidden = true; bar.style.width = '0'; }, 400);
    }
  }

  async function showResult(res) {
    const { files, note, text } = res;
    const rows = files.map((f) => h('div', { class: 'file glass' },
      h('span', { class: 'fthumb pdf ' + (/\.pdf$/i.test(f.name) ? '' : 'alt') }, (f.name.split('.').pop() || '').slice(0, 4).toUpperCase()),
      h('div', { class: 'fmeta' }, h('span', { class: 'fname' }, f.name), h('span', { class: 'fsize' }, fmtBytes(f.blob.size))),
      h('button', { type: 'button', class: 'btn primary sm', onClick: () => downloadBlob(f.blob, f.name), html: `${ICONS.download}<span>Download</span>` })));

    const actions = h('div', { class: 'toolbar center' });
    if (files.length > 1) {
      actions.append(h('button', { type: 'button', class: 'btn primary', html: `${ICONS.zip}<span>Download all (.zip)</span>`, onClick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try {
          const zip = new JSZip();
          const used = new Set();
          for (const f of files) { let n = f.name, k = 1; while (used.has(n)) n = f.name.replace(/(\.[^.]+)?$/, `-${++k}$1`); used.add(n); zip.file(n, f.blob); }
          downloadBlob(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), `webypdf-${tool.id}.zip`);
        } catch (err) { toast(friendlyError(err), 'error'); } finally { b.disabled = false; }
      } }));
    }
    try {
      const shareFiles = files.map((f) => new File([f.blob], f.name, { type: f.blob.type }));
      if (navigator.canShare && navigator.canShare({ files: shareFiles }) && files.length <= 10) {
        actions.append(h('button', { type: 'button', class: 'btn', html: `${ICONS.share}<span>Share</span>`, onClick: () => navigator.share({ files: shareFiles }).catch(() => {}) }));
      }
    } catch { /* sharing unsupported */ }
    actions.append(h('button', { type: 'button', class: 'btn', onClick: reset }, 'Start over'));

    const preview = h('div', { class: 'previewwrap' });
    const card = h('div', { class: 'panel glass success', role: 'status' },
      h('div', { class: 'okrow' }, h('span', { class: 'okicon', html: ICONS.check }), h('div', {}, h('h3', {}, files.length > 1 ? `${files.length} files ready` : 'Your file is ready'), note ? h('p', { class: 'note' }, note) : null)),
      preview,
      files.length > 12 ? h('details', {}, h('summary', {}, `Show all ${files.length} files`), h('div', { class: 'files' }, rows)) : h('div', { class: 'files' }, rows),
      text ? textBox(text) : null,
      actions);
    resultHost.replaceChildren(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // small first-page preview for PDF outputs
    const first = files.find((f) => /\.pdf$/i.test(f.name));
    if (first && first.blob.size < 120 * 1024 * 1024) {
      try {
        const pdf = await openPdf(new Uint8Array(await first.blob.arrayBuffer()));
        const page = await pdf.getPage(1);
        const v1 = page.getViewport({ scale: 1 });
        const c = await renderToCanvas(page, Math.min(1.2, 360 / v1.width));
        c.className = 'preview'; c.setAttribute('aria-label', 'First page preview');
        preview.append(c);
        pdf.destroy();
      } catch { /* preview is optional */ }
    }
    if (files.some((f) => f.name.endsWith('.jpg') || f.name.endsWith('.png'))) {
      const imgs = files.slice(0, 3);
      preview.classList.add('multi');
      imgs.forEach((f) => preview.append(h('img', { class: 'preview', src: URL.createObjectURL(f.blob), alt: '', onLoad: (e) => setTimeout(() => URL.revokeObjectURL(e.target.src), 5000) })));
    }
  }

  function textBox(text) {
    const ta = h('textarea', { readOnly: true, rows: 9, value: text.length > 60000 ? `${text.slice(0, 60000)}\n\n… (preview truncated — download the file for the full text)` : text });
    return h('div', { class: 'textout' }, ta, h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'btn sm', html: `${ICONS.copy}<span>Copy text</span>`, onClick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'ok'); } catch { ta.select(); document.execCommand('copy'); toast('Copied', 'ok'); } } })));
  }

  function reset() {
    clearFiles();
    resultHost.replaceChildren();
    renderFiles();
    if (tool.noFiles) mountView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* --- assemble --- */
  app.append(h('section', { class: 'toolpage' }, head, tool.noFiles ? null : drop, listHost, viewHost, optHost, progress, resultHost, actionbar));
  renderFiles();
  if (tool.noFiles) { optHost.hidden = false; actionbar.hidden = false; mountView(); }

  current = { destroy: () => { viewToken++; clearFiles(); } };
}

/* ------------------------------------------------------------------ *
 *  Theme + install + service worker
 * ------------------------------------------------------------------ */
const themeBtn = $('#themeBtn');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  themeBtn.innerHTML = t === 'dark' ? ICONS.sun : ICONS.moon;
  themeBtn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  const m = $('meta[name="theme-color"]'); if (m) m.content = t === 'dark' ? '#150d3a' : '#efe9ff';
}
applyTheme(document.documentElement.dataset.theme || 'dark');
themeBtn.addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(t);
  try { localStorage.setItem('webypdf-theme', t); } catch { /* ignore */ }
});

const installBtn = $('#installBtn');
const installDlg = $('#installDlg');
let deferredPrompt = null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (!standalone) {
  if (isIOS) installBtn.hidden = false;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installBtn.hidden = false; });
}
installBtn.addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice.catch(() => ({}));
    deferredPrompt = null;
    if (outcome === 'accepted') installBtn.hidden = true;
  } else if (installDlg && installDlg.showModal) installDlg.showModal();
});
addEventListener('appinstalled', () => { installBtn.hidden = true; toast('WebyPDF installed — find it on your home screen or app list', 'ok', 5000); });
installDlg && installDlg.addEventListener('click', (e) => { if (e.target === installDlg || e.target.closest('[data-close]')) installDlg.close(); });

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !window.WebyAndroid) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('A new version of WebyPDF is ready — reload to update', 'ok', 8000);
        });
      });
    }).catch(() => {});
  });
}

route();
