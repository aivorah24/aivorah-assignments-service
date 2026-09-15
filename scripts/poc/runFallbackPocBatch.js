// EXPERIMENTAL / TEST-ONLY — batch runner for the Gemini-independent
// fallback POC (services/poc/fallbackPipelinePoc.js). Reads every document
// in a given directory, runs it through the POC pipeline, and writes one
// JSON report + one standalone HTML file per document into scripts/poc-output/.
// Never touches the `assignments` table, never calls a production route.
// Run manually: node scripts/poc/runFallbackPocBatch.js "<dir>" [subject] [grade]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runPocOnDocument } = require('../../services/poc/fallbackPipelinePoc');

const SUPPORTED_EXT = new Set(['.pdf', '.docx', '.png', '.jpg', '.jpeg', '.webp', '.bmp']);

async function main() {
  const dir = process.argv[2];
  const subject = process.argv[3] || '';
  const grade = process.argv[4] || '';
  if (!dir) {
    console.error('Usage: node runFallbackPocBatch.js <directory> [subject] [grade]');
    process.exit(1);
  }
  const outDir = path.join(__dirname, '..', 'poc-output');
  fs.mkdirSync(outDir, { recursive: true });

  const files = fs.readdirSync(dir).filter(f => SUPPORTED_EXT.has(path.extname(f).toLowerCase()));
  console.log(`Found ${files.length} supported documents in ${dir}`);

  const summary = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    console.log(`\n=== ${file} ===`);
    const started = Date.now();
    const report = await runPocOnDocument(filePath, { subject, grade });
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
