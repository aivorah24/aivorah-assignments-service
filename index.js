require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-assignments-service' }));

app.use('/assignments', require('./routes/assignments'));
app.use('/curriculum', require('./routes/curriculum'));
app.use('/jobs', require('./routes/jobs'));
app.use('/quiz', require('./routes/quiz'));

// EXPERIMENTAL / TEST-ONLY — Gemini-independent fallback POC (see
// services/poc/fallbackPipelinePoc.js). Never mounted unless explicitly
// enabled; does not replace or touch any production route above.
if (process.env.POC_FALLBACK_ENABLED === 'true') {
  app.use('/poc/fallback', require('./routes/pocFallback'));
}

require('./services/jobHandlers'); // register the worksheet_extract handler

const PORT = process.env.PORT || 3015;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah Assignments service running on http://localhost:${PORT}`);
  });
  // Local drain loop (db driver) — see ai-mentor/server/index.js's own copy
  // of this for the full rationale: without this, a job enqueued via
  // extract-questions-async would sit "pending" forever with nothing
  // draining it locally.
  const { runWorkerOnce } = require('./services/jobQueue');
  setInterval(() => {
    runWorkerOnce(5).catch(err => console.error('[jobQueue] drain tick failed:', err.message));
  }, 4000);
}

module.exports = app;
