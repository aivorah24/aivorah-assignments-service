// Worksheet document model — the provider-agnostic first stage of quiz
// generation. Whatever the upload (Word-exported PDF, scan, InDesign book,
// photo, docx), it produces ONE reading-order transcript per page with:
//   - the best available text for every line (PDF text layer when it can be
//     trusted, page OCR otherwise, plus OCR of text that only exists inside
//     pasted screenshots),
//   - every real picture hosted and placed INLINE as [IMAGE: url=...] at its
//     position (a picture beside a word stays on that word's row, so matching
//     tasks keep their pairs),
//   - page images for vision models.
// Every AI provider (vision or text-only) is then given this transcript as
// ground truth, so a worksheet converts the same way whichever provider is up.
const { readPdfLayout } = require('./pdfLayout');
const { rasterizePdfPages } = require('./rasterize');
const ocr = require('./ocrEngine');

const INDIC_OR_RTL = /[ऀ-෿؀-ۿ]/;
const COMBINING_MARK = /\p{M}/u;

// A PDF text layer is trusted only when it is real, ordered Latin text.
// Word/Office exports of Indic scripts routinely lose glyph shaping (vowel
// signs split from consonants, ం → ిం), and a few odd fonts map to the
// Private Use Area — those pages are read by OCR instead.
function assessTextLayer(lines) {
  const text = lines.map(l => l.text).join('\n');
  const letters = (text.match(/\p{L}/gu) || []).length;
  const tokens = text.split(/\s+/).filter(Boolean);
  const orphanMarks = tokens.filter(t => COMBINING_MARK.test(t[0])).length;
  const pua = (text.match(/[-�]/g) || []).length;
  const indic = INDIC_OR_RTL.test(text);
  const reliable = letters >= 20 && !indic && pua / Math.max(1, letters) < 0.02
    && orphanMarks / Math.max(1, tokens.length) < 0.05;
  return { letters, indic, pua, orphanMarks, reliable, scripts: ocr.scriptsInText(text) };
}

const normalizeForMatch = s => String(s || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Dotted/underscored answer lines → one clear blank.
function cleanLine(text) {
  return String(text || '')
    .replace(/[.…·•_]{4,}|(?:\.\s){4,}\.?|_{2,}/g, ' ____ ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Drops OCR noise from dotted answer lines ("TTT", "eee", "UR RR"): in a line
// written in an Indic/Arabic script, short low-confidence Latin/symbol tokens
// are noise; in a Latin line only near-zero-confidence tokens are dropped.
// Indic words are always kept — Tesseract scores correct ones low too.
function ocrLineText(line) {
  if (!line.words || !line.words.length || line.confidence >= 90) return line.text;
  const indicLine = INDIC_OR_RTL.test(line.text);
  return line.words.filter((w) => {
    if (INDIC_OR_RTL.test(w.text) || /\p{N}/u.test(w.text)) return true;
    if (/^[.…·_\-]{3,}/.test(w.text)) return true; // dotted answer line → becomes ____
    if (indicLine) return w.confidence >= 75 && /\p{L}{2,}/u.test(w.text);
    return w.confidence >= 30;
  }).map(w => w.text).join(' ');
}

function tokensOf(text) {
  return normalizeForMatch(text).split(' ').filter(t => t.length >= 3);
}

// A "corpus" is trusted text with spacing removed: PDF text layers often
// lose inter-word spaces ("datahandlingto"), so coverage is checked by
// substring, not by whole-token equality.
function makeCorpus(text) {
  return normalizeForMatch(text).replace(/ /g, '');
}

// Is this OCR line already present in the trusted text?
function coveredBy(line, corpus) {
  const toks = tokensOf(line);
  if (!toks.length) return true;
  const hit = toks.filter(t => corpus.includes(t)).length;
  return hit / toks.length >= 0.6;
}

// Share of a line's box that lies inside b (a line running across several
// columns only partly belongs to a picture it passes over).
function overlapRatio(l, b) {
  const w = Math.max(0, Math.min(l.x + l.w, b.x + b.w) - Math.max(l.x, b.x));
  const h = Math.max(0, Math.min(l.y + l.h, b.y + b.h) - Math.max(l.y, b.y));
  return (w * h) / Math.max(1, l.w * l.h);
}

// Logo / header strip / thin rule — not worksheet content.
function isDecorative(img, page) {
  const { bbox } = img;
  if (img.repeat) return true;
  if (img.areaRatio < 0.003) return true;
  const aspect = Math.max(bbox.w / Math.max(1, bbox.h), bbox.h / Math.max(1, bbox.w));
  if (aspect > 9) return true;
  const inHeader = bbox.y + bbox.h < page.height * 0.13 && bbox.h < page.height * 0.1 && bbox.w < page.width * 0.45;
  return inHeader;
}

// How much of an image is text, from the page OCR lines inside it.
function textStats(img, ocrLines) {
  const { w, h } = img.bbox;
  let letters = 0;
  let inkArea = 0;
  let longLines = 0;
  for (const l of ocrLines) {
    if (overlapRatio(l, img.bbox) < 0.7 || l.confidence < 55) continue;
    const n = (l.text.match(/\p{L}/gu) || []).length;
    letters += n;
    inkArea += l.w * l.h;
    if (n >= 10) longLines++;
  }
  return { letters, longLines, coverage: inkArea / Math.max(1, w * h) };
}

// 'text'    — a pasted screenshot of text: its content is in the OCR
//             transcript, so it is not shown again as a picture;
// 'mixed'   — text plus illustration (a riddle with its picture): keep both;
// 'picture' — a diagram/photo, possibly with short labels ("5m", "Football").
function classifyImage(img, ocrLines) {
  const st = textStats(img, ocrLines);
  // A page-sized image is a scan of the page itself: read it, never show it.
  if (img.areaRatio > SCAN_AREA) return { kind: 'scan', ...st };
  const hasText = st.letters >= 20 && ((st.longLines >= 2 && st.coverage > 0.08) || (st.longLines >= 1 && st.coverage > 0.2));
  if (!hasText) return { kind: 'picture', ...st };
  return { kind: st.coverage >= TEXT_ONLY_COVERAGE ? 'text' : 'mixed', ...st };
}
const TEXT_ONLY_COVERAGE = 0.2;
const SCAN_AREA = 0.6;

function isTextImage(img, ocrLines) {
  return classifyImage(img, ocrLines).kind === 'text';
}

// Rows: items that overlap vertically AND sit side by side share a row,
// left→right — table cells, picture|word matching pairs, columns. Items that
// overlap horizontally are stacked, so they start a new row.
function composeRows(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const cy = it.y + it.h / 2;
    const row = rows.find(r => ((cy >= r.top && cy <= r.bottom) || (r.cy >= it.y && r.cy <= it.y + it.h))
      && !r.items.some(o => it.x < o.x + o.w && o.x < it.x + it.w));
    if (row) {
      row.items.push(it);
      row.top = Math.min(row.top, it.y); row.bottom = Math.max(row.bottom, it.y + it.h);
    } else {
      rows.push({ top: it.y, bottom: it.y + it.h, cy, items: [it] });
    }
  }
  return rows.map(r => r.items.sort((a, b) => a.x - b.x).map(i => i.text).filter(Boolean).join('   |   '));
}

const MAX_PICTURES_TO_READ = 30;

function labelWords(res) {
  return res.lines.flatMap(l => (l.words || []).filter(w => /[\p{L}\p{N}]/u.test(w.text)
    && w.confidence >= (INDIC_OR_RTL.test(w.text) ? 30 : 60)));
}

const boxOf = w => ({ x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0 });

// Stacked fractions ("28" above "50") are printed as two separate numbers:
// pair a number with the one directly below it into "28/50". Without this a
// text-only model sees "28 50 8 24 …" and guesses the fractions.
function pairFractions(words) {
  const items = words.map(w => ({ text: w.text, box: boxOf(w) }));
  const isNum = t => /^\d+$/.test(t);
  const used = new Set();
  const out = [];
  const byTop = items.map((it, i) => i).sort((a, b) => items[a].box.y - items[b].box.y);
  for (const i of byTop) {
    if (used.has(i)) continue;
    const a = items[i];
    if (isNum(a.text)) {
      let best = -1; let bestGap = Infinity;
      items.forEach((b, j) => {
        if (j === i || used.has(j) || !isNum(b.text)) return;
        const gap = b.box.y - (a.box.y + a.box.h);
        const cxA = a.box.x + a.box.w / 2; const cxB = b.box.x + b.box.w / 2;
        if (b.box.y > a.box.y + a.box.h * 0.5 && gap < a.box.h * 1.6 && Math.abs(cxA - cxB) < Math.max(a.box.w, b.box.w) * 0.8 && gap < bestGap) {
          best = j; bestGap = gap;
        }
      });
      if (best >= 0) {
        const b = items[best];
        used.add(i); used.add(best);
        out.push({ text: `${a.text}/${b.text}`, box: { x: Math.min(a.box.x, b.box.x), y: a.box.y, w: Math.max(a.box.w, b.box.w), h: b.box.y + b.box.h - a.box.y } });
        continue;
      }
    }
    used.add(i);
    out.push(a);
  }
  return out;
}

// Reading order: rows by vertical centre, left to right; rows joined with " ; ".
function readingOrder(tokens) {
  const rows = [];
  for (const t of [...tokens].sort((a, b) => (a.box.y + a.box.h / 2) - (b.box.y + b.box.h / 2))) {
    const cy = t.box.y + t.box.h / 2;
    const row = rows.find(r => Math.abs(r.cy - cy) < Math.max(r.h, t.box.h) * 0.6);
    if (row) row.items.push(t); else rows.push({ cy, h: t.box.h, items: [t] });
  }
  return rows.map(r => r.items.sort((a, b) => a.box.x - b.box.x).map(t => t.text).join(' ')).join(' ; ');
}

const overlaps = (a, b) => {
  const A = boxOf(a); const B = boxOf(b);
  const w = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
  const h = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
  return w * h > 0.3 * Math.min(A.w * A.h, B.w * B.h);
};

// All words in one image region (PNG/JPEG), multi-pass: as-is; photos masked
// out (sparse) for regions mixing photos with printed words; digits only —
// sparse at 1× then block mode at 2× (finds lone digits like the "8" of a
// stacked 8/24). A confident number replaces an overlapping non-number guess.
async function readRegionWords(src, langs) {
  const { jimpFromPng, isDecodable, maskPhotos, pngBuffer } = require('./pngImage');
  const words = labelWords(await ocr.ocrImage(src, langs));
  if (!isDecodable(src)) return words;
  const isNumber = w => /^\d+$/.test(w.text);
  const merge = (extra) => {
    for (const w of extra) {
      const i = words.findIndex(o => overlaps(o, w));
      if (i < 0) words.push(w);
      else if (isNumber(w) && !isNumber(words[i]) && !/\p{L}{2,}/u.test(words[i].text)) words[i] = w;
    }
  };
  const j = jimpFromPng(src);
  const masked = maskPhotos(j);
  if (masked > 0.1 && masked < 0.75) merge(labelWords(await ocr.ocrImage(pngBuffer(j), langs, { sparse: true })));
  merge(labelWords(await ocr.ocrImage(src, ['eng'], { digits: true, sparse: true })));
  const big = jimpFromPng(src);
  if (Math.max(big.bitmap.width, big.bitmap.height) <= 1800) {
    big.scale(2);
    const res = await ocr.ocrImage(pngBuffer(big), ['eng'], { digits: true });
    merge(labelWords(res).map(w => ({ ...w, bbox: { x0: w.bbox.x0 / 2, y0: w.bbox.y0 / 2, x1: w.bbox.x1 / 2, y1: w.bbox.y1 / 2 } })));
  }
  return words;
}

// Words printed inside a picture, in reading order with stacked fractions
// rebuilt. A table drawn as a picture is read cell by cell (grid lines and
// neighbouring cells confuse OCR) and keeps its rows: "a | b | c ; d | e | f".
async function readPictureLabels(img, langs) {
  const { jimpFromPng, isDecodable, findGridCells, pngBuffer } = require('./pngImage');
  const src = img.ocrBuffer || img.buffer;
  const cells = isDecodable(src) ? findGridCells(jimpFromPng(src)) : null;
  if (cells && cells.length <= MAX_TABLE_CELLS) {
    const rows = new Map();
    for (const c of cells) {
      const crop = jimpFromPng(src).crop({ x: c.x + 2, y: c.y + 2, w: Math.max(4, c.w - 4), h: Math.max(4, c.h - 4) });
      const text = readingOrder(pairFractions(await readRegionWords(pngBuffer(crop), langs)));
      if (!rows.has(c.row)) rows.set(c.row, []);
      rows.get(c.row).push(text || '—');
    }
    return [...rows.values()].map(r => r.join(' | ')).join(' ; ').slice(0, 800);
  }
  return readingOrder(pairFractions(await readRegionWords(src, langs))).slice(0, 500);
}
const MAX_TABLE_CELLS = 30;

async function safe(label, fn, fallback) {
  try { return await fn(); } catch (err) {
    console.warn(`[documentModel] ${label} failed:`, err.message);
    return fallback;
  }
}

/**
 * @param {object} input
 * @param {Buffer} input.buffer        PDF or image bytes
 * @param {string} input.mime          'application/pdf' | 'image/*'
 * @param {string} [input.structuredText]  exact text from the original docx (mammoth)
 * @param {string[]} [input.hints]     language/subject hints ("Telugu", "te", "Language Acquisition-Hindi")
 * @param {(imgs: object[]) => Promise<{url?: string}[]>} [input.hostImages]  uploads pictures, same order
 */
async function buildDocumentModel({ buffer, mime, structuredText = '', hints = [], hostImages, maxPages = 12, ocrEnabled = true } = {}) {
  const started = Date.now();
  const isPdf = /pdf/i.test(mime || '') || buffer.slice(0, 5).toString('latin1') === '%PDF-';
  const diagnostics = { kind: isPdf ? (structuredText ? 'docx' : 'pdf') : 'image', pages: [], warnings: [] };

  // ── Gather raw signals ────────────────────────────────────────────────
  let layout = { numPages: 1, pages: [] };
  let rasters = [];
  if (isPdf) {
    layout = await safe('pdf layout', () => readPdfLayout(buffer, { maxPages }), layout);
    // Unparseable/empty PDF: nothing to render or read.
    if (ocrEnabled && layout.pages.length) rasters = await safe('rasterize', () => rasterizePdfPages(buffer, { maxPages }), []);
    if (layout.numPages > maxPages) diagnostics.warnings.push(`Only the first ${maxPages} of ${layout.numPages} pages were read.`);
  } else if (ocr.isDecodableImage(buffer)) {
    rasters = [{ page: 1, buffer, width: 0, height: 0, scale: 1 }];
    layout.pages = [{ page: 1, width: 0, height: 0, lines: [], images: [] }];
  }
  const pageCount = Math.max(layout.pages.length, rasters.length);

  // ── Which scripts/languages to OCR ───────────────────────────────────
  const scripts = new Set([
    ...ocr.scriptsInText(layout.pages.map(p => p.lines.map(l => l.text).join(' ')).join(' ')),
    ...ocr.scriptsInText(structuredText),
    ...ocr.scriptsFromHints(hints),
  ]);
  const hasTextLayer = layout.pages.some(p => p.lines.length > 0) || !!structuredText;
  if (ocrEnabled && rasters.length && !scripts.size && !hasTextLayer) {
    // Nothing tells us the language (scan/photo): ask Tesseract's script detector.
    const detected = await safe('script detection', () => ocr.detectScript(rasters[0].buffer), null);
    if (detected && detected !== 'Latin') scripts.add(detected);
  }
  const langs = ocr.langsForScripts([...scripts]);
  diagnostics.scripts = [...scripts];
  diagnostics.ocrLangs = langs;

  const docxCorpus = makeCorpus(structuredText);
  const pages = [];
  const pictures = [];

  for (let i = 0; i < pageCount; i++) {
    const lp = layout.pages[i] || { page: i + 1, width: 0, height: 0, lines: [], images: [] };
    const raster = rasters[i];
    const assessment = assessTextLayer(lp.lines);
    const contentImages = lp.images.filter(img => !isDecorative(img, lp));
    const decorativeImages = lp.images.filter(img => isDecorative(img, lp));
    // OCR whenever the text layer can't be trusted or text may hide in pictures.
    const needOcr = ocrEnabled && raster && (!assessment.reliable || contentImages.length > 0 || structuredText);
    let ocrResult = null;
    if (needOcr) ocrResult = await safe(`ocr page ${lp.page}`, () => ocr.ocrImage(raster.buffer, langs), null);

    // Raster px → layout points (images have no layout: use raster space directly).
    const k = raster && lp.width ? lp.width / raster.width : 1;
    const ocrLines = (ocrResult ? ocrResult.lines : []).map(l => ({
      text: cleanLine(ocrLineText(l)), confidence: l.confidence, origin: 'ocr',
      x: l.bbox.x0 * k, y: l.bbox.y0 * k, w: (l.bbox.x1 - l.bbox.x0) * k, h: (l.bbox.y1 - l.bbox.y0) * k,
    })).filter(l => l.text && l.confidence >= 35)
      // Text inside logos/header art is branding, not worksheet content.
      .filter(l => !decorativeImages.some(img => overlapRatio(l, img.bbox) >= 0.7));

    let source;
    let textItems;
    if (structuredText) {
      // docx: the original document's text is exact; add only what OCR found
      // inside screenshots/pictures that the docx text doesn't contain.
      source = 'docx+ocr';
      textItems = ocrLines.filter(l => !coveredBy(l.text, docxCorpus)).map(l => ({ ...l, kind: 'text' }));
    } else if (assessment.reliable) {
      const layerCorpus = makeCorpus(lp.lines.map(l => l.text).join(' '));
      const extra = ocrLines.filter(l => !coveredBy(l.text, layerCorpus));
      source = extra.length ? 'text-layer+ocr' : 'text-layer';
      textItems = [
        ...lp.lines.map(l => ({ ...l, text: cleanLine(l.text), kind: 'text' })),
        ...extra.map(l => ({ ...l, kind: 'text' })),
      ];
    } else if (ocrLines.length) {
      source = 'ocr';
      textItems = ocrLines.map(l => ({ ...l, kind: 'text' }));
    } else {
      // No OCR available (rasterizer/OCR down): keep the imperfect layer rather than nothing.
      source = lp.lines.length ? 'text-layer-unverified' : 'none';
      textItems = lp.lines.map(l => ({ ...l, text: cleanLine(l.text), kind: 'text' }));
    }

    const decisions = contentImages.map(img => (ocrLines.length ? classifyImage(img, ocrLines)
      : { kind: img.areaRatio > SCAN_AREA ? 'scan' : 'picture' }));
    const pagePictures = contentImages.filter((img, k) => decisions[k].kind === 'picture' || decisions[k].kind === 'mixed');
    const labelPictures = contentImages.filter((img, k) => decisions[k].kind === 'picture');
    // Labels inside a picture are read from the picture itself (sharper than the
    // page render) and attached to its marker, not left as loose lines.
    textItems = textItems.filter(t => t.origin !== 'ocr' || !labelPictures.some(img => overlapRatio(t, img.bbox) >= 0.7));
    contentImages.forEach((img, k) => { img.kind = decisions[k].kind; });
    for (const img of pagePictures) pictures.push(img);
    pages.push({ page: lp.page, width: lp.width, height: lp.height, source, assessment, ocrConfidence: ocrResult ? ocrResult.confidence : null, textItems, pagePictures, raster });
    diagnostics.pages.push({
      page: lp.page, source, textLayerReliable: assessment.reliable, textLayerScripts: assessment.scripts,
      ocrConfidence: ocrResult ? ocrResult.confidence : null, lines: textItems.length,
      images: lp.images.length, pictures: pagePictures.length,
      textImages: contentImages.length - pagePictures.length,
      decorative: lp.images.length - contentImages.length,
      imageDecisions: decisions.map((d, k) => ({
        kind: d.kind, letters: d.letters, longLines: d.longLines,
        coverage: d.coverage != null ? Number(d.coverage.toFixed(2)) : undefined,
        areaRatio: Number(contentImages[k].areaRatio.toFixed(3)),
      })),
    });
  }

  // ── Read labels inside pictures (axis values, "5m", names under photos) ──
  if (ocrEnabled && pictures.length <= MAX_PICTURES_TO_READ) {
    for (const img of pictures) {
      if (img.kind === 'picture') img.labels = await safe('picture labels', () => readPictureLabels(img, langs), '');
    }
  }

  // ── Host pictures, then place them inline ─────────────────────────────
  // The transcript refers to pictures by short ids (img://p1-3): models copy
  // them reliably, and quizVision resolves them to the hosted url — or to an
  // inline image when hosting isn't configured — after generation.
  let hosted = [];
  if (pictures.length && hostImages) hosted = await safe('host pictures', () => hostImages(pictures), []);
  pictures.forEach((img, idx) => {
    img.id = `img://p${img.page}-${idx + 1}`;
    img.url = hosted[idx] && hosted[idx].url ? hosted[idx].url : null;
  });

  const pageTexts = pages.map((p) => {
    const items = [
      ...p.textItems,
      ...p.pagePictures.map(img => ({ kind: 'image', x: img.bbox.x, y: img.bbox.y, w: img.bbox.w, h: img.bbox.h, text: `[IMAGE: url=${img.id}]` + (img.labels ? ` (text in picture: ${img.labels})` : '') })),
    ];
    const rows = composeRows(items);
    return `--- Page ${p.page} ---\n${rows.join('\n')}`;
  });

  let text;
  if (structuredText) {
    const extra = pageTexts.map(t => t.replace(/^--- Page \d+ ---\n?/, '')).join('\n').trim();
    text = structuredText.trim() + (extra ? `\n\n[TEXT READ FROM PICTURES/SCREENSHOTS IN THE DOCUMENT (OCR) — part of the worksheet content]\n${extra}` : '');
  } else {
    text = pageTexts.join('\n\n');
  }

  diagnostics.pictures = pictures.length;
  diagnostics.hostedPictures = pictures.filter(p => p.url).length;
  diagnostics.chars = text.length;
  diagnostics.ms = Date.now() - started;
  await ocr.terminateWorkers();

  // Positions of every text row, so a quiz task can be traced back to its
  // region of the page (see regionCrops.js).
  const anchors = pages.flatMap(p => p.textItems.map(t => ({ page: p.page, y: t.y, h: t.h, text: t.text })));
  const pageSizes = pages.map(p => ({ page: p.page, width: p.width, height: p.height }));

  return {
    text,
    anchors,
    pageSizes,
    scripts: [...scripts],
    pictures: pictures.map(p => ({
      id: p.id, url: p.url, page: p.page, bbox: p.bbox, width: p.width, height: p.height,
      labels: p.labels || '', buffer: p.buffer, mime: p.mime,
    })),
    pageImages: rasters.map(r => ({ page: r.page, buffer: r.buffer, mime: 'image/png' })),
    diagnostics,
  };
}

module.exports = { buildDocumentModel, pairFractions, readingOrder, assessTextLayer, cleanLine, composeRows, classifyImage, isTextImage, isDecorative, coveredBy, makeCorpus, tokensOf };
