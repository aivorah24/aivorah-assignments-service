// Ported from ai-mentor/server/services/jobHandlers.js — only the
// 'worksheet_extract' handler this service actually needs (extraction is
// the only queued job type migrated here; quiz_generate/syllabus_extract
// stay on the monolith for now, out of scope for this migration).
const { registerHandler } = require('./jobQueue');

// Real worksheet-extraction job — lets a teacher fire off several worksheet
// uploads back-to-back without each browser tab blocking on a synchronous
// AI call. Reuses the exact same extraction function as the synchronous
// /assignments/extract-questions endpoint.
registerHandler('worksheet_extract', async (payload) => {
  const { extractWorksheetContent } = require('../routes/assignments');
  return extractWorksheetContent(payload.fileList);
});

module.exports = {};
