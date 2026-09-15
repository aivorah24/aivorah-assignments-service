// EXPERIMENTAL / TEST-ONLY — retries only the documents that failed in the
// first full batch run (Cloudflare 429 rate-limiting / a couple of 502-503s
// from a large file overloading the free-tier instance), with spacing
// between requests this time.
const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://aivorah-assignments-service.onrender.com/poc/fallback/run';
const dir = 'C:\\Users\\Asus\\Desktop\\Aivorah Documents\\Assignment Picture';
const outDir = path.join(__dirname, '..', 'poc-output');

const failedFiles = [
  "Toddle-67751615-1e09-45f7-a38f-ea76817d6d24-PYP-2 HLE-2  maha pranaksharaalu, dirgham aksharaalu, padaalu  1 (1).pdf",
  "Toddle-7350f488-5306-4f73-9485-1b79d586a503-LHLE 30 - PYP 4.docx",
  "Toddle-79c9cf94-b904-4f95-b7f9-e28bfa64ce3b-Vocabulary Building 28 - PYP 4 (1).docx",
  "Toddle-79c9cf94-b904-4f95-b7f9-e28bfa64ce3b-Vocabulary Building 28 - PYP 4.docx",
  "Toddle-89f88573-565f-4e45-8bde-0dd4d163518f-LHLE-19.pdf",
  "Toddle-8d6af58a-a488-46a7-93fb-f0a5ec0611cc-PYP4 -MHLE-32.pdf",
  "Toddle-baa43257-012c-49e8-b4d1-c267b2333f96-Vocabulary Building 29 - PYP 4.docx",
  "Toddle-c0b2c531-b382-4272-90ac-77df87287b76-Charlotte's Web - Choiceboard.pdf",
  "Toddle-c9a3ed4a-264e-476b-9f74-ea76343e35d2-Ch 4 Dory_LHLE.pdf",
  "Toddle-d572241a-312e-4936-85d8-300a7586defb-raz_ls35_nosenseofstyle_clr 1.pdf",
  "Toddle-f8df9a72-92c2-4541-80b3-abcbbddf8be1-PYP4 -MHLE-35 .docx",
  "Toddle-ff3b8e1c-46f2-45f3-aa0f-25ba65150446-raz_lv29_supplyanddemand_clr 4.pdf",
  // Ch 4_ Dory Fantasmagory 2.pdf (9.5MB) deliberately excluded — its 502
  // (21s then hard fail) looks like it overloaded the free-tier instance's
  // memory, likely triggering the cascade of 503s/429s that followed it in
  // the first run. Reported as a known size-limit finding, not retried
  // blindly against the same instance.
];

async function runOne(filePath) {
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer]), path.basename(filePath));
  const res = await fetch(ENDPOINT, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function main() {
  for (const file of failedFiles) {
    const filePath = path.join(dir, file);
    console.log(`\n=== RETRY: ${file} ===`);
    let report;
    try {
      report = await runOne(filePath);
      console.log(`status=${report.status} taskCount=${report.taskCount} questionCount=${report.questionCount} qwenVisuals=${report.qwenDetectedVisualCount} hostedVisuals=${report.hostedVisualCount}`);
    } catch (e) {
      report = { file, status: 'failed', error: e.message };
      console.log(`status=failed ERROR: ${e.message}`);
    }
    const safeName = file.replace(/[^a-zA-Z0-9.\-]/g, '_');
    const { html, ...reportWithoutHtml } = report;
    fs.writeFileSync(path.join(outDir, `${safeName}.report.json`), JSON.stringify(reportWithoutHtml, null, 2));
    if (html) fs.writeFileSync(path.join(outDir, `${safeName}.html`), html);
    // Space out requests — the first run's rapid-fire sequence appears to
    // have triggered Cloudflare/Render rate-limiting partway through.
    await new Promise(r => setTimeout(r, 20000));
  }
  console.log('\nRetry pass done.');
}

main().catch(e => { console.error('RETRY FAILED:', e); process.exit(1); });
