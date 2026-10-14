#!/usr/bin/env node
// Runs the worksheet document model (text layer + OCR + pictures, no AI) on
// local files and prints what each page was read from. Use it to check a
// worksheet that converts badly before blaming the AI step.
//   node scripts/worksheetDiagnostics.js <file-or-folder>... [--out <dir>]
// Pictures are not uploaded; markers show their ids ([IMAGE: url=img://pN-K]).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'diagnostics';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'diagnostics';
const fs = require('fs');
const path = require('path');
const { buildDocumentModel } = require('../services/worksheet/documentModel');

async function loadInput(file) {
  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') {
    const { docxToPdf } = require('../routes/assignments');
    const { pdfBuf, structuredText } = await docxToPdf(buffer);
    return { buffer: pdfBuf, mime: 'application/pdf', structuredText };
  }
  return { buffer, mime: ext === '.pdf' ? 'application/pdf' : `image/${ext.slice(1).replace('jpg', 'jpeg')}` };
}

(async () => {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
  const files = args.flatMap(a => (fs.statSync(a).isDirectory()
    ? fs.readdirSync(a).filter(f => /\.(pdf|docx|png|jpe?g|webp)$/i.test(f)).map(f => path.join(a, f)) : [a]));
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    const input = await loadInput(file);
    const model = await buildDocumentModel({
      ...input,
      hostImages: async imgs => imgs.map((img, k) => ({ url: `local://p${img.page}-i${k + 1}` })),
    });
    const d = model.diagnostics;
    console.log(`\n== ${path.basename(file)}  kind=${d.kind} scripts=${d.scripts.join(',') || '-'} ocr=${d.ocrLangs.join('+')} pictures=${d.pictures} chars=${d.chars} ${d.ms}ms`);
    for (const p of d.pages) {
      console.log(`   p${p.page}: ${p.source.padEnd(22)} ocrConf=${p.ocrConfidence ?? '-'} lines=${p.lines} images=${p.images} pictures=${p.pictures} textImages=${p.textImages} decorative=${p.decorative}`);
    }
    d.warnings.forEach(w => console.log(`   ! ${w}`));
    if (outDir) {
      fs.writeFileSync(path.join(outDir, `${path.basename(file)}.txt`), model.text);
      model.pageImages.forEach(pi => fs.writeFileSync(path.join(outDir, `${path.basename(file)}.p${pi.page}.png`), pi.buffer));
    }
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
