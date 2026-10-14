#!/usr/bin/env node
// Accuracy check for worksheet → interactive quiz conversion, over a folder of
// real worksheets, in every upload format a teacher uses:
//   - the file itself (PDF / Word),
//   - a phone-photo version of each page (rotated, compressed, softened) —
//     what an image upload looks like,
// and reports, per worksheet and format, how much of the worksheet reached the
// transcript the AI is given (stage 1, no AI) and — with --ai and provider
// keys set — how much reached the quiz (stage 2).
//
//   node scripts/worksheetEval.js <file-or-folder>... [--out <dir>] [--ai] [--no-photo]
//
// Reference text: a .docx's own text, or a PDF's text layer when it is clean
// Latin text. For scanned / Indic PDFs (no usable text layer) the PDF run is
// the reference, so the photo score shows what an image upload loses.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eval';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'eval';
const fs = require('fs');
const path = require('path');
const { buildDocumentModel } = require('../services/worksheet/documentModel');

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// Headings a worksheet uses for its tasks (English sheets; Indic sheets are
// scored on text recall only).
const HEADING_RE = /^\s*(?:task\s*\d+|activity\s*\d+|exercise\s*\d+|question\s*\d+|enrichment(?:\s+task)?|part\s+[a-z0-9]+)\b/gim;

const words = text => new Set(String(text || '').normalize('NFC').toLowerCase()
  .split(/[^\p{L}\p{M}\p{N}]+/u).filter(w => w.length >= 2));

// Share of the reference's words present in the transcript.
function recall(reference, transcript) {
  const ref = words(reference);
  if (!ref.size) return null;
  const got = words(transcript);
  let hit = 0;
  for (const w of ref) if (got.has(w)) hit++;
  return hit / ref.size;
}

const headings = text => [...new Set((String(text || '').match(HEADING_RE) || []).map(h => h.trim().toLowerCase().replace(/\s+/g, ' ')))];
const pct = x => (x == null ? '  n/a' : `${Math.round(x * 100)}%`.padStart(5));

// Clean Latin text layer = usable reference (same test the document model uses).
function usableTextLayer(text) {
  const letters = (text.match(/\p{L}/gu) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return letters > 200 && latin / letters > 0.9 && !/�/.test(text);
}

// A page render made to look like a phone photo of the printed sheet.
async function photoOf(pngBuffer) {
  const { jimpFromPng } = require('../services/worksheet/pngImage');
  const img = jimpFromPng(pngBuffer);
  if (img.bitmap.width > 1500) img.resize({ w: 1500 });
  img.rotate({ deg: 1.5, mode: true });
  img.blur(1);
  // Uneven light: darker towards the bottom-right.
  const { width, height, data } = img.bitmap;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = 1 - 0.18 * ((x / width + y / height) / 2);
      const o = (y * width + x) * 4;
      data[o] *= k; data[o + 1] *= k; data[o + 2] *= k;
    }
  }
  return img.getBuffer('image/jpeg', { quality: 65 });
}

async function loadSource(file) {
  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const reference = (await mammoth.extractRawText({ buffer })).value;
    const { docxToPdf } = require('../routes/assignments');
    const { pdfBuf, structuredText } = await docxToPdf(buffer);
    return { kind: 'docx', reference, pdf: pdfBuf, input: { buffer: pdfBuf, mime: 'application/pdf', structuredText } };
  }
  if (ext === '.pdf') {
    let layer = '';
    try { layer = (await require('pdf-parse')(buffer)).text || ''; } catch { /* encrypted/broken */ }
    return { kind: 'pdf', reference: usableTextLayer(layer) ? layer : null, pdf: buffer, input: { buffer, mime: 'application/pdf' } };
  }
  const mime = `image/${ext.slice(1).replace('jpg', 'jpeg')}`;
  return { kind: 'image', reference: null, pdf: null, input: { buffer, mime } };
}

const noHosting = async imgs => imgs.map(() => ({}));

async function runModel(input) {
  const started = Date.now();
  const doc = await buildDocumentModel({ ...input, hostImages: noHosting });
  return { doc, ms: Date.now() - started };
}

// Stage 2: the real generation, scored against the worksheet's own headings.
async function runAi(input, expectedHeadings) {
  const { generateQuizFromDocument } = require('../services/quizVision');
  const started = Date.now();
  const result = await generateQuizFromDocument({ ...input });
  const quiz = result.quiz || result;
  const tasks = quiz.tasks || [];
  const questions = tasks.flatMap(t => t.questions || []);
  const report = quiz.conversionReport || result.conversionReport || { items: [] };
  const quizHeadings = headings(tasks.map(t => t.title).join('\n'));
  return {
    provider: result.provider || quiz.provider || '?',
    ms: Date.now() - started,
    tasks: tasks.length,
    taskRecall: expectedHeadings.length ? expectedHeadings.filter(h => quizHeadings.includes(h)).length / expectedHeadings.length : null,
    questions: questions.length,
    answerKeyed: questions.length ? questions.filter(q => q.answer != null && String(q.answer).trim() !== '').length / questions.length : null,
    pictures: questions.filter(q => q.imageUrl).length,
    review: (report.items || []).filter(i => i.status !== 'PRESERVED').map(i => `${i.title || i.taskTitle}: ${i.status}${i.reason ? ` (${i.reason.slice(0, 80)})` : ''}`),
  };
}

function rowFor(name, format, reference, doc, ms, extra = {}) {
  const expected = headings(reference || '');
  const found = headings(doc.text);
  return {
    worksheet: name, format,
    textRecall: reference ? recall(reference, doc.text) : null,
    headingsExpected: expected.length,
    headingsFound: expected.filter(h => found.includes(h)).length,
    pictures: doc.pictures.length,
    blanks: (doc.text.match(/_{3,}/g) || []).length,
    ocr: (doc.diagnostics.ocrLangs || []).join('+'),
    pages: (doc.diagnostics.pages || []).map(p => `${p.source}${p.ocrConfidence != null ? `@${p.ocrConfidence}` : ''}`).join(' '),
    ms, chars: doc.text.length, warnings: doc.diagnostics.warnings || [], ...extra,
  };
}

(async () => {
  const args = process.argv.slice(2);
  const flag = (f) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
  const withAi = flag('--ai');
  const withPhoto = !flag('--no-photo');
  const files = args.flatMap(a => (fs.statSync(a).isDirectory()
    ? fs.readdirSync(a).filter(f => /\.(pdf|docx|png|jpe?g|webp)$/i.test(f)).sort().map(f => path.join(a, f)) : [a]));
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const rows = [];

  for (const file of files) {
    const name = path.basename(file).replace(/^[0-9a-f]{8}-Toddle-[0-9a-f-]{36}-/, '');
    try {
      const src = await loadSource(file);
      const base = await runModel(src.input);
      const reference = src.reference || null;
      const expectedHeadings = headings(reference || base.doc.text);
      const extra = withAi ? { ai: await runAi(src.input, expectedHeadings).catch(e => ({ error: e.message })) } : {};
      rows.push(rowFor(name, src.kind, reference, base.doc, base.ms, extra));
      if (outDir) fs.writeFileSync(path.join(outDir, `${name}.${src.kind}.txt`), base.doc.text);

      // Same worksheet uploaded as phone photos, one image per page (as the app sends them).
      if (withPhoto && base.doc.pageImages.length) {
        const photoRef = reference || base.doc.text;
        let text = ''; let pictures = 0; let blanks = 0; let ms = 0; const pages = []; const ocr = new Set(); const warnings = [];
        const aiParts = [];
        for (const page of base.doc.pageImages) {
          const jpg = await photoOf(page.buffer);
          if (outDir) fs.writeFileSync(path.join(outDir, `${name}.photo-p${page.page}.jpg`), jpg);
          const run = await runModel({ buffer: jpg, mime: 'image/jpeg' });
          text += `\n${run.doc.text}`; pictures += run.doc.pictures.length; blanks += (run.doc.text.match(/_{3,}/g) || []).length; ms += run.ms;
          (run.doc.diagnostics.ocrLangs || []).forEach(l => ocr.add(l));
          pages.push(...(run.doc.diagnostics.pages || []).map(p => `${p.source}${p.ocrConfidence != null ? `@${p.ocrConfidence}` : ''}`));
          warnings.push(...(run.doc.diagnostics.warnings || []));
          if (withAi) aiParts.push(await runAi({ buffer: jpg, mime: 'image/jpeg' }, []).catch(e => ({ error: e.message })));
        }
        const found = headings(text);
        rows.push({
          worksheet: name, format: 'photo',
          textRecall: recall(photoRef, text),
          headingsExpected: expectedHeadings.length,
          headingsFound: expectedHeadings.filter(h => found.includes(h)).length,
          pictures, blanks, ocr: [...ocr].join('+'), pages: pages.join(' '), ms, chars: text.length, warnings,
          ...(withAi ? { ai: aiParts } : {}),
        });
        if (outDir) fs.writeFileSync(path.join(outDir, `${name}.photo.txt`), text);
      }
    } catch (err) {
      rows.push({ worksheet: name, format: path.extname(file).slice(1), error: err.message });
    }
    const r = rows.filter(x => x.worksheet === name);
    for (const x of r) {
      console.log(x.error
        ? `${x.worksheet.slice(0, 58).padEnd(58)} ${String(x.format).padEnd(5)} ERROR ${x.error}`
        : `${x.worksheet.slice(0, 58).padEnd(58)} ${x.format.padEnd(5)} text ${pct(x.textRecall)}  tasks ${x.headingsFound}/${x.headingsExpected}  pics ${String(x.pictures).padStart(2)}  blanks ${String(x.blanks).padStart(3)}  ${x.ocr || '-'}  ${(x.ms / 1000).toFixed(0)}s`);
    }
  }

  if (outDir) fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(rows, null, 2));
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
