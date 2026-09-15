// EXPERIMENTAL / TEST-ONLY — only mounted when POC_FALLBACK_ENABLED=true
// (see index.js). Runs the Gemini-independent fallback POC pipeline against
// an uploaded file and returns the full report as JSON. Does NOT write to
// the `assignments` table, does NOT call any existing production endpoint,
// and does NOT affect any existing generated quiz. Exists purely so the POC
// can also be exercised interactively (e.g. via curl/Postman) in addition
// to the batch script (scripts/poc/runFallbackPocBatch.js).
const express = require('express');
const multer = require('multer');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const { runPocOnDocument, runPocOnDocumentV2 } = require('../services/poc/fallbackPipelinePoc');
const fs = require('fs');
const os = require('os');
const path = require('path');

router.post('/run', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
  const tmpPath = path.join(os.tmpdir(), `poc_${Date.now()}_${req.file.originalname}`);
  fs.writeFileSync(tmpPath, req.file.buffer);
  try {
    const report = await runPocOnDocument(tmpPath, { subject: req.body.subject, grade: req.body.grade });
    res.json(report);
  } finally {
    fs.unlink(tmpPath, () => {});
  }
});

// v2: position/reading-order-primary visual association (see
// services/poc/fallbackPipelinePoc.js's associateVisualsToQuestionsV2 for
// the full rationale). Separate endpoint so v1 stays available unchanged
// for direct before/after comparison against the same documents.
router.post('/run-v2', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
  const tmpPath = path.join(os.tmpdir(), `poc_v2_${Date.now()}_${req.file.originalname}`);
  fs.writeFileSync(tmpPath, req.file.buffer);
  try {
    const report = await runPocOnDocumentV2(tmpPath, { subject: req.body.subject, grade: req.body.grade });
    res.json(report);
  } finally {
    fs.unlink(tmpPath, () => {});
  }
});

module.exports = router;
