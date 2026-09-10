// Ported from ai-mentor/server/routes/jobs.js — same job queue contract
// (services/jobQueue.js, DB-driven by default, zero extra infra needed).
const express = require('express');
const router  = express.Router();
const { runWorkerOnce, getJob, DRIVER } = require('../services/jobQueue');

// ── POST /jobs/process ──────────────────────────────────────────────
// Drain pending jobs (db driver). Point a Cloud Scheduler cron at this every
// minute. Protect with a shared secret so only your cron can trigger it:
// set JOBS_PROCESS_SECRET and send it as the `x-jobs-secret` header (or ?secret=).
router.post('/process', express.json(), async (req, res) => {
  const secret = process.env.JOBS_PROCESS_SECRET;
  if (secret) {
    const provided = req.get('x-jobs-secret') || req.query.secret;
    if (provided !== secret) return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const limit = Math.min(parseInt(req.body?.limit ?? req.query.limit) || 5, 50);
    const result = await runWorkerOnce(limit);
    res.json({ ok: true, driver: DRIVER, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /jobs/:id ───────────────────────────────────────────────────
// Job status for the client to poll ("processing… → ready").
router.get('/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({
    jobId:     job.id,
    type:      job.type,
    status:    job.status,
    result:    job.result ?? null,
    error:     job.error ?? null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  });
});

module.exports = router;
