// EXPERIMENTAL / TEST-ONLY — remote variant of runFallbackPocBatch.js.
// POSTs each document to the DEPLOYED /poc/fallback/run endpoint (Render
// has the HF_TOKEN/Cloudinary keys this POC needs; local .env does not),
// rather than running the pipeline in-process. Same output shape/location
// as the local batch runner. Never calls any production route — only the
// POC_FALLBACK_ENABLED-gated /poc/fallback/run.
// Run manually: node scripts/poc/runFallbackPocRemote.js "<dir>" [subject] [grade]
const fs = require('fs');
const path = require('path');

const ENDPOINT = process.env.POC_ENDPOINT || 'https://aivorah-assignments-service.onrender.com/poc/fallback/run';
const SUPPORTED_EXT = new Set(['.pdf', '.docx', '.png', '.jpg', '.jpeg', '.webp', '.bmp']);

async function runOne(filePath, subject, grade) {
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer]), path.basename(filePath));
  if (subject) form.append('subject', subject);
  if (grade) form.append('grade', grade);
  const res = await fetch(ENDPOINT, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function main() {
  const dir = process.argv[2];
  const subject = process.argv[3] || '';
  const grade = process.argv[4] || '';
  if (!dir) {
    console.error('Usage: node runFallbackPocRemote.js <directory> [subject] [grade]');
    process.exit(1);
  }
  const outDir = path.join(__dirname, '..', 'poc-output');
  fs.mkdirSync(outDir, { recursive: true });

  const files = fs.readdirSync(dir).filter(f => SUPPORTED_EXT.has(path.extname(f).toLowerCase()));
  console.log(`Found ${files.length} supported documents in ${dir}`);
  console.log(`Endpoint: ${ENDPOINT}`);

  const summary = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    console.log(`\n=== ${file} ===`);
    const started = Date.now();
    let report;
    try {
      report = await runOne(filePath, subject, grade);
    } catch (e) {
      report = { file, status: 'failed', error: e.message };
    }
    const elapsedMs = Date.now() - started;
    console.log(`status=${report.status} taskCount=${report.taskCount} questionCount=${report.questionCount} qwenVisuals=${report.qwenDetectedVisualCount} hostedVisuals=${report.hostedVisualCount} elapsed=${elapsedMs}ms`);
    if (report.status === 'failed') console.log(`  ERROR: ${report.error}`);

    const safeName = file.replace(/[^a-zA-Z0-9.\-]/g, '_');
    const { html, ...reportWithoutHtml } = report;
    fs.writeFileSync(path.join(outDir, `${safeName}.report.json`), JSON.stringify(reportWithoutHtml, null, 2));
    if (html) fs.writeFileSync(path.join(outDir, `${safeName}.html`), html);

    summary.push({
      file, status: report.status, error: report.error || null,
      sourceType: report.sourceType, textExtractionMethod: report.textExtractionMethod,
      taskCount: report.taskCount, questionCount: report.questionCount,
      qwenDetectedVisualCount: report.qwenDetectedVisualCount, hostedVisualCount: report.hostedVisualCount,
      associatedCount: report.visualAssociations ? report.visualAssociations.length : 0,
      unassociatedVisualCount: report.unassociatedVisuals ? report.unassociatedVisuals.length : 0,
      unresolvedVisualQuestionCount: report.unresolvedVisualQuestions ? report.unresolvedVisualQuestions.length : 0,
      htmlGenerated: report.htmlGenerated, elapsedMs,
    });
  }

  fs.writeFileSync(path.join(outDir, '_summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nDone. Reports written to ${outDir}`);
}

main().catch(e => { console.error('BATCH RUN FAILED:', e); process.exit(1); });
