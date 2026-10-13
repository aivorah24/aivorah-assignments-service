// Ported from ai-mentor/server/services/jobHandlers.js — 'worksheet_extract'
// and 'quiz_generate' (2026-09-11, quiz AI-pipeline migration — see
// QUIZ_PIPELINE_MIGRATION.md); syllabus_extract stays on the monolith,
// out of scope for this migration.
const { registerHandler } = require('./jobQueue');

// Real worksheet-extraction job — lets a teacher fire off several worksheet
// uploads back-to-back without each browser tab blocking on a synchronous
// AI call. Reuses the exact same extraction function as the synchronous
// /assignments/extract-questions endpoint.
registerHandler('worksheet_extract', async (payload) => {
  const { extractWorksheetContent } = require('../routes/assignments');
  return extractWorksheetContent(payload.fileList, { fileName: payload.fileName });
});

// Real quiz-generation job — reuses the exact same Gemini-vision function as
// the synchronous POST /quiz/generate, so the queued path can never drift
// from what the synchronous endpoint does.
registerHandler('quiz_generate', async (payload) => {
  const { generateQuizFromDocument } = require('./quizVision');
  const buffer = Buffer.from(payload.fileBase64, 'base64');
  const quiz = await generateQuizFromDocument({
    buffer, mime: payload.mimeType || 'application/pdf',
    grade: payload.grade, subject: payload.subject, school: payload.school,
    structuredText: payload.structuredText, language: payload.language,
  });
  return { quiz };
});

module.exports = {};
