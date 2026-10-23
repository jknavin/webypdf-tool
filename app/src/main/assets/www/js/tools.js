/* WebyPDF – tool definitions. Everything runs locally in the browser. */
import {
  svgIcon, baseName, pdfBlob, sleep, pad, loadDoc, openPdf, safeScale, renderToCanvas,
  canvasToBlob, releaseCanvas, toGray, pageGeom, parseRanges, flatRange, friendlyError, fmtBytes,
} from './core.js';
import { pagesSelectView, organizeView, textView, metadataView, signView } from './views.js';

const { PDFDocument, degrees, rgb, StandardFonts } = PDFLib;

export const CATS = [
  ['all', 'All tools'], ['organize', 'Organize'], ['convert', 'Convert'], ['edit', 'Edit'], ['optimize', 'Optimize'],
];

const brand = (d) => { d.setProducer('WebyPDF'); d.setCreator('WebyPDF'); };
const save = (doc) => doc.save({ useObjectStreams: true });
const ext = (blob, name) => ({ name, blob });

/* -------- shared helpers -------- */
async function getDoc(ctx, f = ctx.files[0]) { return loadDoc(await ctx.bytes(f), f.name); }

function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '#000000');
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0, 0, 0);
}

async function rasterize(ctx, file, { dpi, quality, gray }) {
  const pdf = await openPdf(await ctx.bytes(file), file.name);
  const out = await PDFDocument.create();
  brand(out);
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      ctx.progress((i - 1) / pdf.numPages, `Page ${i} of ${pdf.numPages}`);
      const page = await pdf.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const canvas = await renderToCanvas(page, safeScale(v1, dpi / 72));
      if (gray) toGray(canvas);
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      releaseCanvas(canvas);
      const img = await out.embedJpg(await blob.arrayBuffer());
      const p = out.addPage([v1.width, v1.height]);
      p.drawImage(img, { x: 0, y: 0, width: v1.width, height: v1.height });
      page.cleanup();
      await sleep(0);
    }
  } finally { pdf.destroy(); }
  ctx.progress(0.97, 'Saving…');
  return save(out);
}

/** decode any browser-readable image -> {canvas, hasAlpha} (EXIF-rotated, size-capped) */
async function decodeImage(file, maxSide = 4096) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error(`${file.name}: this image format is not supported by your browser`); }
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  const hasAlpha = /png|webp|gif|avif|svg/i.test(file.type);
  return { canvas: c, hasAlpha };
}

/** wrap text on a canvas 2d context */
function wrapCanvasLines(x, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { lines.push(''); continue; }
    let line = '';
    const tokens = para.split(/(\s+)/);
    for (let tok of tokens) {
      if (!tok) continue;
      const test = line + tok;
      if (x.measureText(test).width <= maxW || !line.trim()) {
        if (x.measureText(test).width > maxW) { // very long unbroken token: split by characters
          for (const ch of tok) {
            if (x.measureText(line + ch).width > maxW && line) { lines.push(line); line = ''; }
            line += ch;
          }
        } else line = test;
      } else { lines.push(line.trimEnd()); line = tok.trimStart(); }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008], a5: [419.53, 595.28] };

/* ================================================================== *
 *  TOOLS
 * ================================================================== */
export const TOOLS = [
  /* ---------------- ORGANIZE ---------------- */
  {
    id: 'merge', name: 'Merge PDF', cat: 'organize', g: ['#8b5cf6', '#ec4899'], cta: 'Merge PDFs',
    desc: 'Combine several PDFs into one file, in the order you choose.',
    icon: svgIcon('<rect x="3" y="3" width="8" height="9" rx="2"/><rect x="13" y="3" width="8" height="9" rx="2"/><path d="M12 14v7m0 0-3-3m3 3 3-3"/>'),
    kind: 'pdf', multi: true, min: 2, ordered: true,
    async run(ctx) {
      const out = await PDFDocument.create();
      brand(out);
      let n = 0;
      for (const [i, f] of ctx.files.entries()) {
        ctx.progress(i / ctx.files.length, `Adding ${f.name}`);
        const src = await getDoc(ctx, f);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
        n += pages.length;
        await sleep(0);
      }
      ctx.progress(0.96, 'Saving…');
      return { files: [ext(pdfBlob(await save(out)), 'merged.pdf')], note: `${ctx.files.length} files combined · ${n} pages` };
    },
  },
  {
    id: 'split', name: 'Split PDF', cat: 'organize', g: ['#06b6d4', '#3b82f6'], cta: 'Split PDF',
    desc: 'Cut a PDF into separate files by page ranges or fixed sizes.',
    icon: svgIcon('<path d="M6 3h9l4 4v14H6z"/><path d="M12 3v18" stroke-dasharray="2.5 2.5"/>'),
    kind: 'pdf',
    fields: [
      { id: 'mode', type: 'select', label: 'Split by', value: 'ranges', options: [['ranges', 'Custom ranges'], ['every', 'Every N pages'], ['each', 'Every page (one file each)']] },
      { id: 'ranges', type: 'text', label: 'Page ranges (each comma-separated part becomes a file)', value: '1-3, 4-6', hint: 'Example: 1-3, 5, 8-', showIf: (o) => o.mode === 'ranges' },
      { id: 'n', type: 'number', label: 'Pages per file', value: 5, min: 1, max: 1000, showIf: (o) => o.mode === 'every' },
    ],
    async run(ctx) {
      const f = ctx.files[0];
      const src = await getDoc(ctx);
      const total = src.getPageCount();
      let groups;
      if (ctx.opts.mode === 'each') groups = src.getPageIndices().map((i) => [i]);
      else if (ctx.opts.mode === 'every') {
        const n = Math.max(1, Math.floor(+ctx.opts.n || 1));
        groups = [];
        for (let i = 0; i < total; i += n) groups.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k));
      } else groups = parseRanges(ctx.opts.ranges, total);
      const files = [];
      const base = baseName(f.name);
      for (const [gi, idx] of groups.entries()) {
        ctx.progress(gi / groups.length, `Creating file ${gi + 1} of ${groups.length}`);
        const out = await PDFDocument.create();
        brand(out);
        (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
        const label = idx.length === 1 ? `page-${pad(idx[0] + 1, 2)}` : `pages-${idx[0] + 1}-${idx[idx.length - 1] + 1}`;
        files.push(ext(pdfBlob(await save(out)), `${base}_${label}.pdf`));
        await sleep(0);
      }
      return { files, note: `${total} pages split into ${files.length} file${files.length > 1 ? 's' : ''}` };
    },
  },
  {
    id: 'extract', name: 'Extract Pages', cat: 'organize', g: ['#f59e0b', '#ef4444'], cta: 'Extract selected pages',
    desc: 'Pick the pages you want and save them as a new PDF.',
    icon: svgIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 15h6m0 0-2.4-2.4M15 15l-2.4 2.4"/>'),
    kind: 'pdf',
    view: (host, ctx) => pagesSelectView(host, ctx, { verb: 'extract' }),
    async run(ctx) {
      const keep = [...ctx.state.sel].sort((a, b) => a - b);
      if (!keep.length) throw new Error('Select at least one page to extract');
      const src = await getDoc(ctx);
      const out = await PDFDocument.create();
      brand(out);
      (await out.copyPages(src, keep)).forEach((p) => out.addPage(p));
      return { files: [ext(pdfBlob(await save(out)), `${baseName(ctx.files[0].name)}_extracted.pdf`)], note: `${keep.length} of ${src.getPageCount()} pages extracted` };
    },
  },
  {
    id: 'remove', name: 'Remove Pages', cat: 'organize', g: ['#ef4444', '#f97316'], cta: 'Remove selected pages',
    desc: 'Delete unwanted pages from your PDF in a couple of taps.',
    icon: svgIcon('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>'),
    kind: 'pdf',
    view: (host, ctx) => pagesSelectView(host, ctx, { verb: 'remove' }),
    async run(ctx) {
      const src = await getDoc(ctx);
      const total = src.getPageCount();
      const drop = ctx.state.sel;
      if (!drop.size) throw new Error('Select at least one page to remove');
      const keep = src.getPageIndices().filter((i) => !drop.has(i));
      if (!keep.length) throw new Error('You cannot remove every page');
      const out = await PDFDocument.create();
      brand(out);
      (await out.copyPages(src, keep)).forEach((p) => out.addPage(p));
      return { files: [ext(pdfBlob(await save(out)), `${baseName(ctx.files[0].name)}_trimmed.pdf`)], note: `${drop.size} page${drop.size > 1 ? 's' : ''} removed · ${keep.length} of ${total} remain` };
    },
  },
  {
    id: 'organize', name: 'Organize Pages', cat: 'organize', g: ['#10b981', '#06b6d4'], cta: 'Save new page order',
    desc: 'Reorder, rotate, duplicate, delete or add blank pages visually.',
    icon: svgIcon('<rect x="3" y="3" width="7.5" height="7.5" rx="1.8"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.8"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.8"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.8"/>'),
    kind: 'pdf',
    view: organizeView,
    async run(ctx) {
      const items = ctx.state.items;
      if (!items || !items.length) throw new Error('Your document has no pages left');
      const src = await getDoc(ctx);
      const out = await PDFDocument.create();
      brand(out);
      const first = src.getPage(0).getSize();
      for (const [i, it] of items.entries()) {
        if (i % 10 === 0) ctx.progress(i / items.length, `Building page ${i + 1} of ${items.length}`);
        if (it.src < 0) { out.addPage([first.width, first.height]); continue; }
        const [p] = await out.copyPages(src, [it.src]);
        if (it.rot) p.setRotation(degrees((p.getRotation().angle + it.rot) % 360));
        out.addPage(p);
      }
      return { files: [ext(pdfBlob(await save(out)), `${baseName(ctx.files[0].name)}_organized.pdf`)], note: `${items.length} pages in your new order` };
    },
  },
  {
    id: 'rotate', name: 'Rotate PDF', cat: 'organize', g: ['#3b82f6', '#8b5cf6'], cta: 'Rotate pages',
    desc: 'Turn all pages, odd/even pages or a custom range.',
    icon: svgIcon('<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v5h-5"/>'),
    kind: 'pdf',
    fields: [
      { id: 'angle', type: 'select', label: 'Rotate', value: '90', options: [['90', '90° clockwise'], ['180', '180°'], ['270', '90° counter-clockwise']] },
      { id: 'which', type: 'select', label: 'Pages', value: 'all', options: [['all', 'All pages'], ['odd', 'Odd pages'], ['even', 'Even pages'], ['range', 'Custom range']] },
      { id: 'range', type: 'text', label: 'Page range', value: '1-3', hint: 'Example: 1-3, 7', showIf: (o) => o.which === 'range' },
    ],
    async run(ctx) {
      const doc = await getDoc(ctx);
      const total = doc.getPageCount();
      let idx = doc.getPageIndices();
      if (ctx.opts.which === 'odd') idx = idx.filter((i) => i % 2 === 0);
      else if (ctx.opts.which === 'even') idx = idx.filter((i) => i % 2 === 1);
      else if (ctx.opts.which === 'range') idx = flatRange(ctx.opts.range, total);
      const a = +ctx.opts.angle;
      new Set(idx).forEach((i) => { const p = doc.getPage(i); p.setRotation(degrees((p.getRotation().angle + a) % 360)); });
      return { files: [ext(pdfBlob(await save(doc)), `${baseName(ctx.files[0].name)}_rotated.pdf`)], note: `${new Set(idx).size} of ${total} pages rotated` };
    },
  },
  {
    id: 'crop', name: 'Crop PDF', cat: 'organize', g: ['#ec4899', '#f59e0b'], cta: 'Crop pages',
    desc: 'Trim white margins from every page by a set amount.',
    icon: svgIcon('<path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14"/>'),
    kind: 'pdf',
    fields: [
      { id: 'top', type: 'number', label: 'Top (mm)', value: 10, min: 0, max: 200 },
      { id: 'bottom', type: 'number', label: 'Bottom (mm)', value: 10, min: 0, max: 200 },
      { id: 'left', type: 'number', label: 'Left (mm)', value: 10, min: 0, max: 200 },
      { id: 'right', type: 'number', label: 'Right (mm)', value: 10, min: 0, max: 200 },
    ],
    async run(ctx) {
      const doc = await getDoc(ctx);
      const mm = 72 / 25.4;
      const m = { t: +ctx.opts.top * mm, r: +ctx.opts.right * mm, b: +ctx.opts.bottom * mm, l: +ctx.opts.left * mm };
      for (const p of doc.getPages()) {
        const box = p.getCropBox();
        const R = ((p.getRotation().angle % 360) + 360) % 360;
        // visual margins -> unrotated margins
        const u = R === 0 ? { t: m.t, r: m.r, b: m.b, l: m.l }
          : R === 90 ? { t: m.r, r: m.b, b: m.l, l: m.t }
            : R === 180 ? { t: m.b, r: m.l, b: m.t, l: m.r }
              : { t: m.l, r: m.t, b: m.r, l: m.b };
        const w = box.width - u.l - u.r, hh = box.height - u.t - u.b;
        if (w < 20 || hh < 20) throw new Error('Those margins are larger than the page. Use smaller values.');
        const x = box.x + u.l, y = box.y + u.b;
        p.setMediaBox(x, y, w, hh);
        p.setCropBox(x, y, w, hh);
      }
      return { files: [ext(pdfBlob(await save(doc)), `${baseName(ctx.files[0].name)}_cropped.pdf`)], note: `${doc.getPageCount()} pages cropped` };
    },
  },

  /* ---------------- OPTIMIZE ---------------- */
  {
    id: 'compress', name: 'Compress PDF', cat: 'optimize', g: ['#22c55e', '#06b6d4'], cta: 'Compress PDF',
    desc: 'Shrink big PDFs for email and uploads. Choose how strong.',
    icon: svgIcon('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
    kind: 'pdf',
    fields: [
      { id: 'level', type: 'select', label: 'Compression level', value: 'balanced', options: [['lossless', 'Light — keeps text selectable (small gain)'], ['high', 'High quality images'], ['balanced', 'Balanced (recommended)'], ['max', 'Maximum — smallest file']], hint: 'Balanced/Maximum turn pages into images, so text can no longer be selected or searched.' },
    ],
    async run(ctx) {
      const f = ctx.files[0];
      const preset = { high: { dpi: 150, quality: 0.8 }, balanced: { dpi: 110, quality: 0.66 }, max: { dpi: 76, quality: 0.5 } }[ctx.opts.level];
      let bytes;
      if (!preset) {
        ctx.progress(0.2, 'Optimizing structure…');
        const doc = await getDoc(ctx);
        bytes = await save(doc);
      } else bytes = await rasterize(ctx, f, { ...preset, gray: false });
      let note, out = bytes;
      if (bytes.length >= f.size) {
        note = 'This PDF is already well optimized — compressing it further would make it larger, so no gain here.';
        out = new Uint8Array(await f.file.arrayBuffer());
      } else note = `${fmtBytes(f.size)} → ${fmtBytes(bytes.length)} · saved ${Math.round((1 - bytes.length / f.size) * 100)}%`;
      return { files: [ext(pdfBlob(out), `${baseName(f.name)}_compressed.pdf`)], note };
    },
  },
  {
    id: 'grayscale', name: 'PDF to Grayscale', cat: 'optimize', g: ['#64748b', '#0f172a'], cta: 'Convert to grayscale',
    desc: 'Make colour PDFs black & white to save ink and space.',
    icon: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
    kind: 'pdf',
    fields: [
      { id: 'dpi', type: 'select', label: 'Quality', value: '130', options: [['96', 'Small file (96 DPI)'], ['130', 'Balanced (130 DPI)'], ['180', 'Sharp (180 DPI)']] },
    ],
    async run(ctx) {
      const f = ctx.files[0];
      const bytes = await rasterize(ctx, f, { dpi: +ctx.opts.dpi, quality: 0.78, gray: true });
      return { files: [ext(pdfBlob(bytes), `${baseName(f.name)}_grayscale.pdf`)], note: `Result ${fmtBytes(bytes.length)} · pages are flattened to images` };
    },
  },

  /* ---------------- CONVERT ---------------- */
  {
    id: 'images-to-pdf', name: 'Images to PDF', cat: 'convert', g: ['#f97316', '#ec4899'], cta: 'Create PDF',
    desc: 'Turn JPG, PNG, WebP and other photos into one PDF.',
    icon: svgIcon('<path d="M5 3h9l5 5v13H5z"/><circle cx="10" cy="12" r="1.5"/><path d="m19 18-4-4-7 7"/>'),
    kind: 'image', multi: true, min: 1, ordered: true,
    fields: [
      { id: 'size', type: 'select', label: 'Page size', value: 'a4', options: [['fit', 'Same as image'], ['a4', 'A4'], ['letter', 'US Letter'], ['a5', 'A5']] },
      { id: 'orient', type: 'select', label: 'Orientation', value: 'auto', options: [['auto', 'Auto (match image)'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], showIf: (o) => o.size !== 'fit' },
      { id: 'margin', type: 'select', label: 'Margin', value: '18', options: [['0', 'None'], ['18', 'Small'], ['36', 'Medium'], ['56', 'Large']], showIf: (o) => o.size !== 'fit' },
      { id: 'quality', type: 'select', label: 'Photo quality', value: '0.9', options: [['0.95', 'Best'], ['0.9', 'High'], ['0.75', 'Smaller file']] },
    ],
    async run(ctx) {
      const out = await PDFDocument.create();
      brand(out);
      const q = +ctx.opts.quality;
      for (const [i, f] of ctx.files.entries()) {
        ctx.progress(i / ctx.files.length, `Image ${i + 1} of ${ctx.files.length}`);
        const { canvas, hasAlpha } = await decodeImage(f.file);
        const usePng = hasAlpha && /png|gif|webp|avif|svg/i.test(f.file.type);
        const blob = await canvasToBlob(canvas, usePng ? 'image/png' : 'image/jpeg', q);
        const iw = canvas.width, ih = canvas.height;
        releaseCanvas(canvas);
        const img = usePng ? await out.embedPng(await blob.arrayBuffer()) : await out.embedJpg(await blob.arrayBuffer());
        let pw, ph, m = 0;
        if (ctx.opts.size === 'fit') {
          const s = Math.min(0.75, 1600 / Math.max(iw, ih)); // px -> pt at 96 dpi, capped
          pw = iw * s; ph = ih * s;
        } else {
          [pw, ph] = PAGE_SIZES[ctx.opts.size];
          const land = ctx.opts.orient === 'landscape' || (ctx.opts.orient === 'auto' && iw > ih);
          if (land) [pw, ph] = [ph, pw];
          m = +ctx.opts.margin;
        }
        const page = out.addPage([pw, ph]);
        const k = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih);
        const dw = iw * k, dh = ih * k;
        page.drawImage(img, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
        await sleep(0);
      }
      ctx.progress(0.97, 'Saving…');
      return { files: [ext(pdfBlob(await save(out)), 'images.pdf')], note: `${ctx.files.length} image${ctx.files.length > 1 ? 's' : ''} → ${ctx.files.length} page${ctx.files.length > 1 ? 's' : ''}` };
    },
  },
  {
    id: 'pdf-to-images', name: 'PDF to Images', cat: 'convert', g: ['#a855f7', '#6366f1'], cta: 'Convert to images',
    desc: 'Save every page as a sharp JPG or PNG image.',
    icon: svgIcon('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.8"/><path d="m21 15-4.5-4.5L8 21"/>'),
    kind: 'pdf',
    fields: [
      { id: 'fmt', type: 'select', label: 'Format', value: 'jpeg', options: [['jpeg', 'JPG (smaller)'], ['png', 'PNG (lossless)']] },
      { id: 'dpi', type: 'select', label: 'Resolution', value: '150', options: [['96', 'Screen (96 DPI)'], ['150', 'Good (150 DPI)'], ['220', 'High (220 DPI)'], ['300', 'Print (300 DPI)']] },
      { id: 'pages', type: 'text', label: 'Pages (leave empty for all)', value: '', placeholder: 'All pages', hint: 'Example: 1-3, 5' },
    ],
    async run(ctx) {
      const f = ctx.files[0];
      const pdf = await openPdf(await ctx.bytes(f), f.name);
      const files = [];
      try {
        const total = pdf.numPages;
        const list = (ctx.opts.pages || '').trim() ? [...new Set(flatRange(ctx.opts.pages, total))].sort((a, b) => a - b) : Array.from({ length: total }, (_, i) => i);
        const type = ctx.opts.fmt === 'png' ? 'image/png' : 'image/jpeg';
        const e = ctx.opts.fmt === 'png' ? 'png' : 'jpg';
        for (const [k, i] of list.entries()) {
          ctx.progress(k / list.length, `Page ${i + 1} (${k + 1} of ${list.length})`);
          const page = await pdf.getPage(i + 1);
          const v1 = page.getViewport({ scale: 1 });
          const canvas = await renderToCanvas(page, safeScale(v1, +ctx.opts.dpi / 72));
          const blob = await canvasToBlob(canvas, type, 0.92);
          releaseCanvas(canvas);
          files.push(ext(blob, `${baseName(f.name)}_page-${pad(i + 1, String(total).length > 2 ? 3 : 2)}.${e}`));
          page.cleanup();
          await sleep(0);
        }
      } finally { pdf.destroy(); }
      return { files, note: `${files.length} image${files.length > 1 ? 's' : ''} created` };
    },
  },
  {
    id: 'pdf-to-text', name: 'PDF to Text', cat: 'convert', g: ['#14b8a6', '#22c55e'], cta: 'Extract text',
    desc: 'Pull all selectable text out of a PDF into a .txt file.',
    icon: svgIcon('<path d="M4 6h16M4 10h16M4 14h10M4 18h13"/>'),
    kind: 'pdf',
    fields: [{ id: 'seps', type: 'checkbox', label: 'Mark page breaks (— Page 2 —)', value: false }],
    async run(ctx) {
      const f = ctx.files[0];
      const pdf = await openPdf(await ctx.bytes(f), f.name);
      let all = '';
      try {
        for (let i = 1; i <= pdf.numPages; i++) {
          ctx.progress((i - 1) / pdf.numPages, `Reading page ${i} of ${pdf.numPages}`);
          const page = await pdf.getPage(i);
          const tc = await page.getTextContent();
          let s = '', lastY = null, lastEnd = 0;
          for (const it of tc.items) {
            if (!('str' in it)) continue;
            const y = it.transform[5], x = it.transform[4], hgt = it.height || 10;
            if (lastY !== null && Math.abs(y - lastY) > hgt * 0.6) s += '\n';
            else if (lastY !== null && x - lastEnd > hgt * 0.25 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' ';
            s += it.str;
            if (it.hasEOL) s += '\n';
            lastY = y; lastEnd = x + (it.width || 0);
          }
          if (ctx.opts.seps && i > 1) all += `\n\n— Page ${i} —\n\n`;
          else if (i > 1) all += '\n\n';
          all += s.replace(/\n{3,}/g, '\n\n').trim();
          page.cleanup();
          await sleep(0);
        }
      } finally { pdf.destroy(); }
      const clean = all.trim();
      const note = clean.length < 5
        ? 'No selectable text found. This looks like a scanned PDF (OCR is not available yet).'
        : `${clean.split(/\s+/).length.toLocaleString()} words extracted`;
      return { files: [ext(new Blob([clean], { type: 'text/plain;charset=utf-8' }), `${baseName(f.name)}.txt`)], note, text: clean };
    },
  },
  {
    id: 'text-to-pdf', name: 'Text to PDF', cat: 'convert', g: ['#0ea5e9', '#6366f1'], cta: 'Create PDF',
    desc: 'Write or paste text and turn it into a tidy PDF. Any language.',
    icon: svgIcon('<path d="M5 5h14M12 5v14M9 19h6"/>'),
    kind: 'text', noFiles: true,
    view: (host, ctx) => textView(host, ctx),
    fields: [
      { id: 'font', type: 'select', label: 'Font', value: 'sans', options: [['sans', 'Sans-serif'], ['serif', 'Serif'], ['mono', 'Monospace']] },
      { id: 'size', type: 'number', label: 'Font size (pt)', value: 12, min: 7, max: 40 },
      { id: 'page', type: 'select', label: 'Page size', value: 'a4', options: [['a4', 'A4'], ['letter', 'US Letter'], ['legal', 'US Legal'], ['a5', 'A5']] },
      { id: 'margin', type: 'select', label: 'Margins', value: '56', options: [['36', 'Narrow'], ['56', 'Normal'], ['80', 'Wide']] },
    ],
    async run(ctx) {
      const text = (ctx.state.text || '').replace(/\r/g, '').replace(/\t/g, '    ');
      if (!text.trim()) throw new Error('Type or paste some text first');
      const [pw, ph] = PAGE_SIZES[ctx.opts.page];
      const m = +ctx.opts.margin;
      const size = Math.min(40, Math.max(7, +ctx.opts.size || 12));
      const lh = size * 1.45;
      const out = await PDFDocument.create();
      brand(out);
      const std = { sans: StandardFonts.Helvetica, serif: StandardFonts.TimesRoman, mono: StandardFonts.Courier }[ctx.opts.font];
      const font = await out.embedFont(std);
      let latinOk = true;
      for (const ch of new Set(text.replace(/\n/g, ''))) { try { font.widthOfTextAtSize(ch, 10); } catch { latinOk = false; break; } }
      let pages = 0;
      if (latinOk) {
        const maxW = pw - 2 * m;
        const wrap = (para) => {
          if (!para) return [''];
          const lines = []; let line = '';
          for (const word of para.split(/( +)/)) {
            const t = line + word;
            if (font.widthOfTextAtSize(t, size) <= maxW) { line = t; continue; }
            if (line.trim()) { lines.push(line.trimEnd()); line = word.trimStart(); }
            else line = word;
            while (font.widthOfTextAtSize(line, size) > maxW) { // break very long words
              let k = line.length; while (k > 1 && font.widthOfTextAtSize(line.slice(0, k), size) > maxW) k--;
              lines.push(line.slice(0, k)); line = line.slice(k);
            }
          }
          lines.push(line.trimEnd());
          return lines;
        };
        let page = out.addPage([pw, ph]); pages = 1;
        let y = ph - m - size;
        for (const para of text.split('\n')) {
          for (const line of wrap(para)) {
            if (y < m) { page = out.addPage([pw, ph]); pages++; y = ph - m - size; }
            if (line) page.drawText(line, { x: m, y, size, font, color: rgb(0.07, 0.07, 0.1) });
            y -= lh;
          }
        }
      } else {
        // special characters (Tamil, Hindi, Arabic, emoji…): let the browser shape the text, embed as crisp images
        const S = 2.5;
        const fam = { sans: 'system-ui,"Noto Sans","Segoe UI",Roboto,Arial,sans-serif', serif: 'Georgia,"Noto Serif","Times New Roman",serif', mono: '"Courier New",ui-monospace,monospace' }[ctx.opts.font];
        const probe = document.createElement('canvas').getContext('2d');
        probe.font = `${size * S}px ${fam}`;
        const lines = wrapCanvasLines(probe, text, (pw - 2 * m) * S);
        const perPage = Math.max(1, Math.floor((ph - 2 * m) / lh));
        for (let s = 0; s < lines.length; s += perPage) {
          ctx.progress(s / lines.length, `Page ${pages + 1}`);
          const c = document.createElement('canvas');
          c.width = Math.round(pw * S); c.height = Math.round(ph * S);
          const x = c.getContext('2d');
          x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
          x.fillStyle = '#111827'; x.font = `${size * S}px ${fam}`; x.textBaseline = 'alphabetic';
          lines.slice(s, s + perPage).forEach((ln, i) => x.fillText(ln, m * S, (m + size + i * lh) * S));
          const blob = await canvasToBlob(c, 'image/png');
          releaseCanvas(c);
          const img = await out.embedPng(await blob.arrayBuffer());
          out.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
          pages++;
          await sleep(0);
        }
      }
      return {
        files: [ext(pdfBlob(await save(out)), 'text.pdf')],
        note: `${pages} page${pages > 1 ? 's' : ''} created` + (latinOk ? '' : ' · special characters detected, so text is stored as images (not selectable)'),
      };
    },
  },

  /* ---------------- EDIT ---------------- */
  {
    id: 'page-numbers', name: 'Add Page Numbers', cat: 'edit', g: ['#6366f1', '#06b6d4'], cta: 'Add page numbers',
    desc: 'Stamp neat page numbers anywhere on every page.',
    icon: svgIcon('<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>'),
    kind: 'pdf',
    fields: [
      { id: 'pos', type: 'select', label: 'Position', value: 'bc', options: [['bc', 'Bottom center'], ['br', 'Bottom right'], ['bl', 'Bottom left'], ['tc', 'Top center'], ['tr', 'Top right'], ['tl', 'Top left']] },
      { id: 'fmt', type: 'select', label: 'Format', value: '{n}', options: [['{n}', '1, 2, 3'], ['Page {n}', 'Page 1'], ['{n} / {total}', '1 / 10'], ['Page {n} of {total}', 'Page 1 of 10'], ['- {n} -', '- 1 -']] },
      { id: 'start', type: 'number', label: 'Start numbering at', value: 1, min: 0, max: 9999 },
      { id: 'from', type: 'number', label: 'Begin on page', value: 1, min: 1, max: 9999 },
      { id: 'size', type: 'number', label: 'Font size (pt)', value: 11, min: 6, max: 36 },
      { id: 'color', type: 'color', label: 'Colour', value: '#374151' },
    ],
    async run(ctx) {
      const doc = await getDoc(ctx);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const total = doc.getPageCount();
      const size = +ctx.opts.size, from = Math.max(1, +ctx.opts.from || 1), start = +ctx.opts.start || 0;
      const color = hexToRgb(ctx.opts.color);
      const mg = 28;
      doc.getPages().forEach((p, i) => {
        if (i + 1 < from) return;
        const n = start + (i + 1 - from);
        const label = ctx.opts.fmt.replace('{n}', n).replace('{total}', start + total - from);
        const w = font.widthOfTextAtSize(label, size);
        const g = pageGeom(p);
        const vx = ctx.opts.pos[1] === 'c' ? (g.W - w) / 2 : ctx.opts.pos[1] === 'r' ? g.W - mg - w : mg;
        const vy = ctx.opts.pos[0] === 'b' ? mg : g.H - mg - size;
        const t = g.place(vx, vy, 0);
        p.drawText(label, { x: t.x, y: t.y, size, font, color, rotate: degrees(t.angle) });
      });
      return { files: [ext(pdfBlob(await save(doc)), `${baseName(ctx.files[0].name)}_numbered.pdf`)], note: `Numbers added to ${total - from + 1} pages` };
    },
  },
  {
    id: 'watermark', name: 'Add Watermark', cat: 'edit', g: ['#d946ef', '#8b5cf6'], cta: 'Add watermark',
    desc: 'Stamp text like CONFIDENTIAL or your name across pages.',
    icon: svgIcon('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
    kind: 'pdf',
    fields: [
      { id: 'text', type: 'text', label: 'Watermark text', value: 'CONFIDENTIAL', maxLength: 60 },
      { id: 'color', type: 'color', label: 'Colour', value: '#e11d48' },
      { id: 'opacity', type: 'range', label: 'Opacity', value: 25, min: 5, max: 90, unit: '%' },
      { id: 'angle', type: 'range', label: 'Rotation', value: 45, min: 0, max: 90, unit: '°' },
      { id: 'size', type: 'range', label: 'Size (width of page)', value: 65, min: 15, max: 95, unit: '%' },
      { id: 'tile', type: 'checkbox', label: 'Repeat across the page (tiled)', value: false },
    ],
    async run(ctx) {
      const label = (ctx.opts.text || '').trim();
      if (!label) throw new Error('Enter the watermark text');
      const doc = await getDoc(ctx);
      // draw the text with the browser so any language works
      const c = document.createElement('canvas');
      const x = c.getContext('2d');
      const font = '800 160px system-ui,"Segoe UI","Noto Sans",Arial,sans-serif';
      x.font = font;
      c.width = Math.ceil(x.measureText(label).width) + 60; c.height = 260;
      x.font = font; x.fillStyle = ctx.opts.color; x.textBaseline = 'middle'; x.textAlign = 'center';
      x.fillText(label, c.width / 2, c.height / 2 + 6);
      const img = await doc.embedPng(await (await canvasToBlob(c, 'image/png')).arrayBuffer());
      const ratio = c.height / c.width;
      const opacity = +ctx.opts.opacity / 100;
      const a = (+ctx.opts.angle * Math.PI) / 180;
      const pages = doc.getPages();
      pages.forEach((p, i) => {
        if (i % 5 === 0) ctx.progress(i / pages.length, `Page ${i + 1} of ${pages.length}`);
        const g = pageGeom(p);
        const stamp = (cx, cy, w) => {
          const hh = w * ratio;
          const ax = cx - ((w / 2) * Math.cos(a) - (hh / 2) * Math.sin(a));
          const ay = cy - ((w / 2) * Math.sin(a) + (hh / 2) * Math.cos(a));
          const t = g.place(ax, ay, +ctx.opts.angle);
          p.drawImage(img, { x: t.x, y: t.y, width: w, height: hh, rotate: degrees(t.angle), opacity });
        };
        if (ctx.opts.tile) {
          const w = g.W * Math.min(0.5, +ctx.opts.size / 100 * 0.6);
          const stepX = w * 1.25, stepY = w * ratio * 2.4;
          let row = 0;
          for (let cy = -g.H * 0.2; cy < g.H * 1.2; cy += stepY, row++) {
            for (let cx = -g.W * 0.2 + (row % 2 ? stepX / 2 : 0); cx < g.W * 1.2; cx += stepX) stamp(cx, cy, w);
          }
        } else stamp(g.W / 2, g.H / 2, g.W * (+ctx.opts.size / 100));
      });
      return { files: [ext(pdfBlob(await save(doc)), `${baseName(ctx.files[0].name)}_watermarked.pdf`)], note: `Watermark added to ${pages.length} page${pages.length > 1 ? 's' : ''}` };
    },
  },
  {
    id: 'sign', name: 'Sign PDF', cat: 'edit', g: ['#f43f5e', '#f59e0b'], cta: 'Sign and download',
    desc: 'Draw, type or upload your signature and place it on the page.',
    icon: svgIcon('<path d="M3 21l4-1L19 8a2.8 2.8 0 0 0-4-4L3 16z"/><path d="M14 6l4 4"/>'),
    kind: 'pdf', flowBar: true,
    view: signView,
    async run(ctx) {
      const st = ctx.state;
      if (!st.sig) throw new Error('Create a signature first (draw, type or upload)');
      const doc = await getDoc(ctx);
      const png = await canvasToBlob(st.sig, 'image/png');
      const img = await doc.embedPng(await png.arrayBuffer());
      const aspect = st.sig.height / st.sig.width;
      const pages = doc.getPages();
      const targets = st.applyTo === 'all' ? pages.map((_, i) => i) : st.applyTo === 'first' ? [0] : st.applyTo === 'last' ? [pages.length - 1] : [st.page - 1];
      for (const i of targets) {
        const p = pages[i];
        const g = pageGeom(p);
        const w = g.W * st.pos.w, hh = w * aspect;
        const cx = st.pos.x * g.W, cy = (1 - st.pos.y) * g.H;
        const t = g.place(cx - w / 2, cy - hh / 2, 0);
        p.drawImage(img, { x: t.x, y: t.y, width: w, height: hh, rotate: degrees(t.angle) });
      }
      return { files: [ext(pdfBlob(await save(doc)), `${baseName(ctx.files[0].name)}_signed.pdf`)], note: `Signature added to ${targets.length} page${targets.length > 1 ? 's' : ''}` };
    },
  },
  {
    id: 'metadata', name: 'Edit Properties', cat: 'edit', g: ['#84cc16', '#14b8a6'], cta: 'Save properties',
    desc: 'View and change title, author, subject and keywords.',
    icon: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>'),
    kind: 'pdf',
    view: metadataView,
    async run(ctx) {
      const doc = await getDoc(ctx);
      const { meta, clear } = ctx.state;
      const v = (k) => (clear ? '' : (meta[k] || ''));
      doc.setTitle(v('title')); doc.setAuthor(v('author')); doc.setSubject(v('subject'));
      doc.setKeywords(clear ? [] : (meta.keywords || '').split(',').map((s) => s.trim()).filter(Boolean));
      doc.setCreator(v('creator')); doc.setProducer(v('producer'));
      doc.setModificationDate(new Date());
      return { files: [ext(pdfBlob(await save(doc)), `${baseName(ctx.files[0].name)}_properties.pdf`)], note: clear ? 'All properties cleared' : 'Document properties updated' };
    },
  },
];

export { friendlyError };
