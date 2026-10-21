/**
 * routes/quiz.js — quiz preview/normalize endpoints.
 *
 * Ported from ai-mentor/server/routes/quiz.js (2026-09-11, B05):
 * POST /render-preview and POST /normalize. Both are pure JSON-in,
 * deterministic transforms (autoDetectMCQ + the five table/chart/matching
 * normalizers, all copied into utils/quizHtmlRenderer.js — verified zero
 * external calls before porting) plus the already-present renderQuizHTML.
 *
 * Deliberately NOT ported here: recoverBarCharts (a Gemini vision call that
 * re-reads a bar-graph image when the LLM's extraction pass omitted the
 * structured chart data) — a worksheet needing it still renders, just with
 * the raw scanned image instead of an interactive chart, rather than
 * breaking. Scoped as a separate follow-up requiring its own
 * vision-dependent test strategy.
 */
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const supabase = require('../services/supabase');
const {
  renderQuizHTML, autoDetectMCQ, normalizeMatchingTasks, normalizeVennQuestions,
  normalizeRiddleTables, normalizeLetterGridTables, normalizeTables, normalizeCharts,
  TRANSLIT_LANG_CODES,
  TRANSLIT_ITC,
} = require('../utils/quizHtmlRenderer');
const { generateQuizFromImage, generateQuizFromPdf } = require('../services/quizVision');
const { publishJob } = require('../services/jobQueue');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Mirrors GET /branding/logos — same lookup already duplicated into
// routes/assignments.js for the same reason (no self HTTP call needed).
async function fetchBranding(school, curriculum) {
  try {
    const kinds = [];
    if (school)     kinds.push('school');
    if (curriculum) kinds.push('curriculum');
    if (kinds.length === 0) return { schoolLogoUrl: null, curriculumLogoUrl: null };
    const { data } = await supabase.from('branding_logos').select('kind, name, logo_url, updated_at').in('kind', kinds);
    data?.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const norm = s => String(s || '').trim().toLowerCase();
    const schoolLogoUrl     = (data || []).find(r => r.kind === 'school' && norm(r.name) === norm(school))?.logo_url || null;
    const curriculumLogoUrl = (data || []).find(r => r.kind === 'curriculum' && norm(r.name) === norm(curriculum))?.logo_url || null;
    return { schoolLogoUrl, curriculumLogoUrl };
  } catch {
    return { schoolLogoUrl: null, curriculumLogoUrl: null };
  }
}

// GET /quiz/providers → which AI providers currently work (cached 5 min;
// ?refresh=1 re-checks). The fastest way to see why worksheets convert as
// text-only: a dead/over-quota vision key shows here with its error.
router.get('/providers', async (req, res) => {
  try {
    const { checkProviders } = require('../services/worksheet/providers');
    res.json(await checkProviders({ force: req.query.refresh === '1' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /quiz/grade-answer { expected, student, question?, acceptableAnswers?, worksheetScript? }
// → { verdict: 'correct' | 'partial' | 'incorrect', reason }
// Called by the student worksheet page when its instant checks can't decide.
// Deterministic checks first: an answer in the wrong writing system (Tamil on
// a Telugu worksheet) is never "correct", whatever the model says.
router.post('/grade-answer', express.json({ limit: '64kb' }), async (req, res) => {
  const { dominantScript, requiredScript, isWrongScript, matchesAnyAnswer } = require('../utils/answerCheck');
  const { expected = '', student = '', question = '', acceptableAnswers = [], worksheetScript = '' } = req.body || {};
  const studentText = String(student).slice(0, 2000);
  if (!studentText.trim()) return res.status(400).json({ error: 'student answer required' });
  const keys = [expected, ...(Array.isArray(acceptableAnswers) ? acceptableAnswers : [])].map(String);
  if (isWrongScript(studentText, expected, worksheetScript)) {
    return res.json({ verdict: 'incorrect', reason: `Please write your answer in ${requiredScript(expected, worksheetScript)} script.` });
  }
  if (matchesAnyAnswer(studentText, keys)) return res.json({ verdict: 'correct', reason: '' });
  if (!String(expected).trim()) return res.json({ verdict: 'incorrect', reason: '' }); // nothing to judge against
  try {
    const { callGroqWithText } = require('../services/quizVision');
    const prompt = `You grade a primary-school student's answer. Judge MEANING, not spelling of minor words.
Rules:
- "correct": same meaning as the expected answer (a paraphrase or a shorter form that still answers the question is fine).
- "partial": partly right (one of two required parts, or the right idea with a factual slip).
- "incorrect": wrong, off-topic, empty of meaning, or in a different language than the expected answer. Expected answer language/script: ${dominantScript(expected) || 'any'}.
Return JSON: {"verdict":"correct|partial|incorrect","reason":"one short, kind sentence for the student, in the language of the expected answer"}.

Question: ${String(question).slice(0, 600)}
Expected answer: ${String(expected).slice(0, 1000)}
${keys.length > 1 ? `Also acceptable: ${keys.slice(1).join(' / ').slice(0, 600)}\n` : ''}Student answer: ${studentText}`;
    const raw = await callGroqWithText(prompt, { maxTokens: 800 });
    const parsed = JSON.parse(raw);
    const verdict = ['correct', 'partial', 'incorrect'].includes(parsed.verdict) ? parsed.verdict : 'incorrect';
    res.json({ verdict, reason: String(parsed.reason || '').slice(0, 300) });
  } catch (err) {
    console.warn('[quiz/grade-answer] grading failed:', err.message);
    res.status(503).json({ verdict: 'incorrect', reason: '', error: 'grading unavailable' });
  }
});

// GET /quiz/transliterate?text=namaste&lang=hi → { suggestions: ['नमस्ते', …] }
// Phonetic English → worksheet script for the student quiz IME (and the app's
// TransliterationInput). Proxies Google Input Tools, which blocks browser CORS.
// Never errors to the client: an empty list just means "type it yourself".
router.get('/transliterate', async (req, res) => {
  const text = String(req.query.text || '').trim().slice(0, 60);
  const lang = String(req.query.lang || '').trim().toLowerCase();
  if (!text || !TRANSLIT_LANG_CODES.includes(lang)) return res.json({ suggestions: [] });
  try {
    const url = `https://inputtools.google.com/request?text=${encodeURIComponent(text)}&itc=${TRANSLIT_ITC(lang)}&num=5&cp=0&cs=1&ie=utf-8&oe=utf-8&app=aivorah`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const data = await r.json();
    const suggestions = data?.[0] === 'SUCCESS' && Array.isArray(data[1]?.[0]?.[1]) ? data[1][0][1].slice(0, 5) : [];
    res.json({ suggestions });
  } catch (err) {
    console.warn('[quiz/transliterate] failed:', err.message);
    res.json({ suggestions: [] });
  }
});

router.post('/render-preview', async (req, res) => {
  try {
    const quiz = req.body.quiz || req.body;
    if (!quiz || !quiz.tasks) return res.status(400).json({ error: 'No quiz data provided' });
    autoDetectMCQ(quiz);
    const branding = await fetchBranding(quiz.school, quiz.curriculum);
    const html = renderQuizHTML(quiz, branding);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept quiz JSON, return it with the same structural normalization Preview
// applies (riddle/word-bank → table, grid → table, charts, matching) but as
// JSON, not HTML — lets the Edit Answers screen show the exact same shape.
router.post('/normalize', async (req, res) => {
  try {
    const quiz = req.body.quiz || req.body;
    if (!quiz || !quiz.tasks) return res.status(400).json({ error: 'No quiz data provided' });
    normalizeVennQuestions(quiz);
    normalizeCharts(quiz);
    normalizeRiddleTables(quiz);
    normalizeLetterGridTables(quiz);
    normalizeTables(quiz);
    normalizeMatchingTasks(quiz);
    res.json({ quiz });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /quiz/generate-image — Increment 1 of the AI extraction pipeline ──
// migration (see QUIZ_PIPELINE_MIGRATION.md). Single worksheet image → quiz
// JSON via Gemini vision ONLY: no OCR cross-validation, no diagram
// extraction/matching, no answer-verification pass, no multi-vendor fallback
// chain yet — each is a separate, tracked increment, not a permanent
// omission. Response shape is a strict subset of the monolith's
// ({ quiz } only) — callers must not assume validation/answerVerification
// are present until later increments land.
router.post('/generate-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });
    const { grade, subject, school, language } = req.body;
    const mime = req.file.mimetype || 'image/png';
    const quiz = await generateQuizFromImage(req.file.buffer, mime, { grade, subject, school, language });
    res.json({ quiz });
  } catch (err) {
    if (err.message === 'AI returned invalid JSON') {
      return res.status(500).json({ error: err.message, raw: err.raw });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── POST /quiz/generate — PDF (docx already converted upstream via
// docx-to-pdf) → quiz JSON, Gemini vision only. Same increment-1-level scope
// as /generate-image: no OCR cross-validation, no diagram extraction, no
// answer-verification, no multi-vendor fallback, no high-DPI page
// rasterization — sends the raw PDF to Gemini directly (Gemini 2.5 Flash
// reads multi-page PDFs natively). See QUIZ_PIPELINE_MIGRATION.md.
router.post('/generate', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
    const { grade, subject, school, structuredText, language } = req.body;
    const quiz = await generateQuizFromPdf(req.file.buffer, { grade, subject, school, structuredText, language });
    res.json({ quiz });
  } catch (err) {
    if (err.message === 'AI returned invalid JSON') {
      return res.status(500).json({ error: err.message, raw: err.raw });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── POST /quiz/generate-async — same as /generate, queued so the browser
// tab doesn't hold one connection open for the whole AI generation pipeline.
router.post('/generate-async', express.json({ limit: '10mb' }), async (req, res) => {
  const { fileBase64, mimeType, filename, grade, subject, school, structuredText, language } = req.body || {};
  if (!fileBase64) return res.status(400).json({ error: 'fileBase64 required' });
  try {
    const { jobId } = await publishJob('quiz_generate', {
      fileBase64, mimeType: mimeType || 'application/pdf', filename: filename || 'worksheet.pdf',
      grade, subject, school, structuredText, language,
    });
    res.json({ jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
