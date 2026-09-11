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
const supabase = require('../services/supabase');
const {
  renderQuizHTML, autoDetectMCQ, normalizeMatchingTasks, normalizeVennQuestions,
  normalizeRiddleTables, normalizeLetterGridTables, normalizeTables, normalizeCharts,
} = require('../utils/quizHtmlRenderer');

// Mirrors GET /branding/logos — same lookup already duplicated into
// routes/assignments.js for the same reason (no self HTTP call needed).
async function fetchBranding(school, curriculum) {
  try {
    const kinds = [];
    if (school)     kinds.push('school');
    if (curriculum) kinds.push('curriculum');
    if (kinds.length === 0) return { schoolLogoUrl: null, curriculumLogoUrl: null };
    const { data } = await supabase.from('branding_logos').select('kind, name, logo_url').in('kind', kinds);
    const norm = s => String(s || '').trim().toLowerCase();
    const schoolLogoUrl     = (data || []).find(r => r.kind === 'school' && norm(r.name) === norm(school))?.logo_url || null;
    const curriculumLogoUrl = (data || []).find(r => r.kind === 'curriculum' && norm(r.name) === norm(curriculum))?.logo_url || null;
    return { schoolLogoUrl, curriculumLogoUrl };
  } catch {
    return { schoolLogoUrl: null, curriculumLogoUrl: null };
  }
}

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

module.exports = router;
