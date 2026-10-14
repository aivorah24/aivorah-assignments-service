// One pdfjs pass over a PDF: per page, the text-layer lines and the embedded
// pictures, both with positions (top-left origin, PDF points at scale 1), so
// pictures can be placed next to the text they belong to.
//
// pdfjs (not pdf-lib) because real worksheets are often encrypted
// (permissions-only), keep images inside Form XObjects, or use PNG predictors /
// SMask alpha / ICC colour — pdfjs decodes all of these.
const crypto = require('crypto');

const DEFAULTS = { maxPages: 12, minDimension: 40, maxImages: 40, maxSide: 1600 };

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function toRgba(img, pdfjs) {
  const { width, height, kind, data } = img;
  if (kind === pdfjs.ImageKind.RGBA_32BPP) return { rgba: Buffer.from(data.buffer, data.byteOffset, width * height * 4), opaque: false };
  const out = Buffer.alloc(width * height * 4);
  if (kind === pdfjs.ImageKind.RGB_24BPP) {
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      out[i * 4] = data[j]; out[i * 4 + 1] = data[j + 1]; out[i * 4 + 2] = data[j + 2]; out[i * 4 + 3] = 255;
    }
    return { rgba: out, opaque: true };
  }
  if (kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const o = (y * width + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
      }
    }
    return { rgba: out, opaque: true };
  }
  return null;
}

// Text items → reading lines (items sharing a baseline, left to right).
function itemsToLines(items, viewport) {
  const pts = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const [x, y] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
    const h = Math.max(1, Math.hypot(it.transform[2], it.transform[3]) || it.height || 8);
    pts.push({ str: it.str, x, y, h, w: it.width || 0 });
  }
  pts.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const p of pts) {
    const line = lines.find(l => Math.abs(l.baseline - p.y) <= Math.max(l.h, p.h) * 0.45);
    if (line) { line.parts.push(p); line.h = Math.max(line.h, p.h); } else lines.push({ baseline: p.y, h: p.h, parts: [p] });
  }
  return lines.map((l) => {
    l.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let end = null;
    for (const p of l.parts) {
      // Word exports drop real spaces; a wide gap is a table/column break.
      if (end !== null && p.x - end > l.h * 2.5) text += '   |   ';
      else if (end !== null && p.x - end > l.h * 0.1 && !/\s$/.test(text)) text += ' ';
      text += p.str;
      end = p.x + p.w;
    }
    const x = l.parts[0].x;
    return { text: text.replace(/\s+/g, ' ').trim(), x, y: l.baseline - l.h, w: Math.max(1, end - x), h: l.h };
  }).filter(l => l.text).sort((a, b) => a.y - b.y || a.x - b.x);
}

async function readPdfLayout(pdfBuffer, opts = {}) {
  const { maxPages, minDimension, maxImages, maxSide } = { ...DEFAULTS, ...opts };
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const { Jimp } = require('jimp');
  const { pngBuffer } = require('./pngImage');
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer), isEvalSupported: false, disableFontFace: true, verbosity: 0,
    }).promise;
  } catch (err) {
    if (err && /Invalid PDF|password/i.test(String(err.message || err.name))) return { numPages: 0, pages: [] };
    throw err;
  }
  const pages = [];
  const seen = new Set();
  let imageCount = 0;
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const pageArea = viewport.width * viewport.height || 1;
      const content = await page.getTextContent();
      const lines = itemsToLines(content.items, viewport);
      const images = [];
      const ops = await page.getOperatorList();
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      for (let i = 0; i < ops.fnArray.length && imageCount < maxImages; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === pdfjs.OPS.save) { stack.push(ctm); continue; }
        if (fn === pdfjs.OPS.restore) { ctm = stack.pop() || ctm; continue; }
        if (fn === pdfjs.OPS.transform) { ctm = mul(ctm, args); continue; }
        if (fn === pdfjs.OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args[0])) ctm = mul(ctm, args[0]); continue; }
        if (fn === pdfjs.OPS.paintFormXObjectEnd) { ctm = stack.pop() || ctm; continue; }
        if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintImageXObjectRepeat) continue;
        try {
          const objId = args[0];
          const store = objId.startsWith('g_') ? page.commonObjs : page.objs;
          const img = await new Promise((resolve) => store.get(objId, resolve));
          if (!img || !img.data || img.width < minDimension || img.height < minDimension) continue;
          // The image fills the unit square in CTM space; map its corners to the viewport.
          const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => viewport.convertToViewportPoint(
            ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]));
          const xs = corners.map(c => c[0]); const ys = corners.map(c => c[1]);
          const bbox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
          const conv = toRgba(img, pdfjs);
          if (!conv) continue;
          const hash = crypto.createHash('sha1').update(conv.rgba).digest('hex');
          const repeat = seen.has(hash); // same logo/picture repeated on every page
          seen.add(hash);
          const jimg = new Jimp({ data: conv.rgba, width: img.width, height: img.height });
          if (Math.max(img.width, img.height) > maxSide) jimg.scaleToFit({ w: maxSide, h: maxSide });
          // Large opaque photos as JPEG keeps uploads light; anything with alpha stays PNG.
          const large = jimg.bitmap.width * jimg.bitmap.height > 250000;
          const mime = conv.opaque && large ? 'image/jpeg' : 'image/png';
          const buffer = await jimg.getBuffer(mime, mime === 'image/jpeg' ? { quality: 85 } : undefined);
          // Small pictures carry small labels ("5m"): an upscaled copy for OCR.
          let ocrBuffer = buffer;
          const side = Math.max(jimg.bitmap.width, jimg.bitmap.height);
          if (side < 900) ocrBuffer = pngBuffer(jimg.clone().scale(Math.min(3, 900 / side)));
          images.push({
            buffer, ocrBuffer, mime, width: jimg.bitmap.width, height: jimg.bitmap.height, page: p, hash, repeat,
            bbox, areaRatio: (bbox.w * bbox.h) / pageArea,
          });
          imageCount++;
        } catch { /* one bad image must not abort the rest */ }
      }
      pages.push({ page: p, width: viewport.width, height: viewport.height, lines, images });
      page.cleanup();
    }
    return { numPages: doc.numPages, pages };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

module.exports = { readPdfLayout, itemsToLines };
