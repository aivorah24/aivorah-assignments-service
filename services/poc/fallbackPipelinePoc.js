// ── EXPERIMENTAL / TEST-ONLY — Gemini-independent fallback POC ──────────
// Added 2026-09-15. Purpose: empirically determine whether a Gemini-free
// pipeline (open VLM + OCR + deterministic structuring) can produce
// sufficiently accurate Interactive HTML, BEFORE any production
// investment. This file is NOT wired into any production route, does not
// touch the `assignments` table, and does not modify existing generated
// quizzes. It deliberately reuses existing, already-tested utilities
// (extractPdfEmbeddedImages/hostExtractedImages/buildStage1Prompt/
// callGroqWithText from services/quizVision.js, renderQuizHTML from
// utils/quizHtmlRenderer.js, docxToPdf's mammoth conversion pattern from
// routes/assignments.js) rather than reimplementing them, per the explicit
// "use existing services/utilities wherever possible" instruction.
//
// Pipeline: PDF/DOCX/Image -> normalization -> per-page rasterization ->
// text extraction (pdf-parse / OCR) -> Qwen2.5-VL visual/bbox detection
// (per page) -> deterministic Stage-1 structuring via Groq (buildStage1Prompt,
// already grade-independent) -> visual-to-question association (text-overlap
// matching against Qwen's own reported nearest-question text, NOT a
// worksheet-specific rule) -> bbox crop + Cloudinary hosting -> grade
// attached post-hoc (Stage 2) -> existing renderQuizHTML.
//
// Model choice: originally Qwen2.5-VL-72B-Instruct (via the HuggingFace
// router) — same model already used (and previously live-verified working)
// by quizVision.js's callQwenVisionRaw. Live-verified 2026-09-15 that the
// account's HF_TOKEN has depleted its free monthly credits (HTTP 402 on
// every call, confirmed against a real document via the deployed POC
// route) — not a code problem, a real account-level quota exhaustion.
// Switched to Mistral's Pixtral vision model (api.mistral.ai directly, a
// different provider/API from the HF router) since MISTRAL_API_KEY already
// exists (in the monolith's .env) and Groq's own model list was checked
// live and currently has zero vision-capable models on this account —
// ruling out reusing an already-working key. Gemini was deliberately not
// substituted here since the entire point of this POC is to test a
// Gemini-INDEPENDENT path. If Qwen access is restored later, swapping the
// vision call back is a small, isolated change — not attempted silently.
const fs = require('fs');
const path = require('path');

const {
  extractPdfEmbeddedImages,
  hostExtractedImages,
  callGroqWithText,
  cleanLLMJson,
  normalizeQuestionFields,
  isVisuallyDependentQuestion,
  extractContentTokens,
  callOcrText,
} = require('../quizVision');
const { renderQuizHTML } = require('../../utils/quizHtmlRenderer');

// Self-contained Stage-1 prompt, deliberately NOT imported from
// quizVision.js's buildQuizVisionPrompt/buildStage1Prompt — this POC must
// stay isolated from in-flight production changes to that file (its
// current committed/deployed version still bakes grade into the prompt
// and still names the function buildQuizVisionPrompt; a still-uncommitted
// local rename exists but is deliberately NOT shipped as part of this POC
// push). No grade parameter, no hardcoded worksheet-specific example, per
// the same requirement given for the production fix.
function buildPocStage1Prompt({ subject } = {}) {
  return `You are a precise document-extraction system for an educational worksheet${subject ? ` in ${subject}` : ''}.

Read the document text below (already extracted from the source PDF/DOCX/image) and extract its content FAITHFULLY — do not adapt, simplify, or rewrite it for any grade level; that happens in a separate later step you are not performing here.

RULES:
1. Preserve the exact original wording of every question/instruction. Do not paraphrase.
2. Preserve the original ordering of tasks and questions.
3. Give each task a title (verbatim from the source if present) and a list of questions.
4. Each question needs: "id" (unique within its task), "type" ("numeric" | "mcq" | "text"), "question" (verbatim text), "answer" (short, literal, derived by solving/reasoning about the extracted content), "hint" (short clue), "solution" (step-by-step explanation).
5. If the text contains a marker like "[IMAGE: url=...]" or "[DETECTED IMAGES ...]", note that a visual existed near that point, but do NOT invent a description of what it shows.
6. Never invent content that isn't derivable from the text below. If a task/question cannot be completed from the given text alone, still include it with whatever real content exists, and leave "answer" as an empty string rather than guessing.

Return ONLY this JSON shape (no markdown, no explanation):
{
  "title": "worksheet title, verbatim",
  "subject": "${subject || ''}",
  "grade": "",
  "tasks": [
    { "title": "task title", "questions": [ { "id": "a", "type": "text", "question": "...", "answer": "...", "hint": "...", "solution": "..." } ] }
  ]
}`;
}

const QWEN_VISION_MODEL = 'Qwen/Qwen2.5-VL-72B-Instruct'; // kept for reference / future swap-back
const HF_TOKEN = process.env.HF_TOKEN;
const MISTRAL_VISION_MODEL = 'pixtral-12b-2409';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

// ── 1. Document normalization ─────────────────────────────────────────
async function normalizeDocument(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const { value: bodyHtml } = await mammoth.convertToHtml({ buffer });
    // Same image-hosting pattern as routes/assignments.js's hostEmbeddedImages,
    // duplicated here (not imported) so this POC has zero coupling to that
    // route file and can't accidentally be affected by a future change there.
    const cloudinary = require('cloudinary').v2;
    if (!cloudinary.config().cloud_name) {
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });
    }
    const dataUriPattern = /data:image\/[a-zA-Z]+;base64,[^"']+/g;
    const dataUris = [...new Set(bodyHtml.match(dataUriPattern) || [])];
    let hostedHtml = bodyHtml;
    const docxEmbeddedImageUrls = [];
    for (const dataUri of dataUris) {
      try {
        const uploadResult = await cloudinary.uploader.upload(dataUri, {
          folder: 'ai_mentor/poc_fallback_images',
          public_id: `poc_docx_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          resource_type: 'image',
        });
        hostedHtml = hostedHtml.split(dataUri).join(uploadResult.secure_url);
        docxEmbeddedImageUrls.push(uploadResult.secure_url);
      } catch { /* non-fatal per image, matches production pattern */ }
    }
    const { htmlToStructuredText } = require('../quizVision');
    const structuredText = htmlToStructuredText(hostedHtml);
    return { sourceType: 'docx', structuredText, pdfBuffer: null, docxEmbeddedImageUrls };
  }
  if (ext === '.pdf') {
    return { sourceType: 'pdf', structuredText: null, pdfBuffer: buffer, docxEmbeddedImageUrls: [] };
  }
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) {
    return { sourceType: 'image', structuredText: null, pdfBuffer: null, imageBuffer: buffer, imageMime: ext === '.png' ? 'image/png' : 'image/jpeg', docxEmbeddedImageUrls: [] };
  }
  throw new Error(`Unsupported file type: ${ext}`);
}

// ── 2. Per-page rasterization ─────────────────────────────────────────
// Deliberately separate from quizVision.js's rasterizePdfPagesToImage,
// which STITCHES pages into one combined canvas (loses page-boundary info
// — exactly the limitation this POC exists to test past). Self-contained
// (own puppeteer/pdfjs boilerplate) so the production function is never
// touched by this work.
// Also extracts each page's native text (pdfjs getTextContent, same
// context as rasterization — free, no second parse pass) alongside its
// image. This is what makes page-aware association possible at all: without
// per-page text, Stage 1 has no way to honestly report which page a
// question came from (see associateVisualsToQuestionsV2 below).
async function rasterizePdfPerPage(pdfBuffer, { maxPages = 8 } = {}) {
  const { launchBrowser } = require('../../utils/browser');
  const pdfjsSrc = fs.readFileSync(require.resolve('pdfjs-dist/build/pdf.js'), 'utf8');
  const pdfjsWorkerSrc = fs.readFileSync(require.resolve('pdfjs-dist/build/pdf.worker.js'), 'utf8');
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: pdfjsSrc });
    const base64 = pdfBuffer.toString('base64');
    const pages = await page.evaluate(async (b64, maxP, workerSrc) => {
      // eslint-disable-next-line no-undef
      const pdfjsLib = window.pdfjsLib;
      const workerBlob = new Blob([workerSrc], { type: 'application/javascript' });
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
      const raw = atob(b64);
      const data = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
      const doc = await pdfjsLib.getDocument({ data, disableWorker: true }).promise;
      const pageCount = Math.min(doc.numPages, maxP);
      const out = [];
      for (let i = 1; i <= pageCount; i++) {
        const pdfPage = await doc.getPage(i);
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        const textContent = await pdfPage.getTextContent();
        const text = textContent.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
        out.push({ dataUrl: canvas.toDataURL('image/png'), text });
      }
      return out;
    }, base64, maxPages, pdfjsWorkerSrc);
    return pages.map((p, i) => ({
      pageIndex: i + 1,
      buffer: Buffer.from(p.dataUrl.split(',')[1], 'base64'),
      mime: 'image/png',
      text: p.text,
    }));
  } finally {
    await browser.close();
  }
}

// ── 3. Text extraction ────────────────────────────────────────────────
async function extractText(pdfBuffer, structuredText, pageImages) {
  if (structuredText && structuredText.trim().length > 20) {
    return { text: structuredText.trim(), method: 'mammoth-structured' };
  }
  let text = '';
  let method = 'none';
  try {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(pdfBuffer);
    text = (parsed.text || '').trim();
    if (text) method = 'pdf-parse';
  } catch { /* fall through to OCR */ }
  if (text.length < 300 && pageImages && pageImages.length) {
    const ocrParts = [];
    for (const p of pageImages) {
      try {
        const t = await callOcrText(p.buffer, p.mime);
        ocrParts.push(t);
      } catch { /* per-page OCR is best-effort */ }
    }
    const ocrText = ocrParts.join('\n\n').trim();
    if (ocrText.length > text.length) { text = ocrText; method = 'ocr'; }
  }
  return { text, method };
}

// ── 4. Qwen-VL visual/bbox detection (per page) ───────────────────────
const BBOX_PROMPT = `You are analyzing one page of a worksheet document for a document-understanding system.

Identify EVERY distinct visual element on this page that is not plain paragraph text: diagrams, shapes, grids, angle drawings, tables-as-images, illustrations, charts, graphs, logos, or any other graphic. Do not include plain body text as a visual.

For EACH visual element, return:
- "visualId": a short unique string (e.g. "v1", "v2")
- "bbox": [ymin, xmin, ymax, xmax] normalized to a 0-1000 scale, where (0,0) is the top-left of this page and (1000,1000) is the bottom-right
- "type": one of "diagram" | "table" | "chart" | "illustration" | "logo" | "other"
- "description": a short (<12 words) factual description of what the visual actually shows — do not guess content you cannot see
- "nearestQuestionText": the exact text of the question/instruction this visual is closest to / most clearly associated with, copied verbatim from the page, or null if none

Return ONLY a JSON object: { "visuals": [ ... ] }. No markdown, no explanation.`;

async function detectVisualsOnPage(pageImage) {
  if (!MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MISTRAL_VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: `data:${pageImage.mime};base64,${pageImage.buffer.toString('base64')}` },
            { type: 'text', text: BBOX_PROMPT },
          ],
        }],
        max_tokens: 4096,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Mistral API ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const raw = json.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(cleanLLMJson(raw)); } catch { parsed = { visuals: [], parseError: raw.slice(0, 300) }; }
    return (parsed.visuals || []).map(v => ({ ...v, pageIndex: pageImage.pageIndex }));
  } finally {
    clearTimeout(timer);
  }
}

async function detectAllVisuals(pageImages) {
  const all = [];
  const errors = [];
  for (const p of pageImages) {
    try {
      const visuals = await detectVisualsOnPage(p);
      all.push(...visuals);
    } catch (e) {
      errors.push({ pageIndex: p.pageIndex, error: e.message });
    }
  }
  return { visuals: all, errors };
}

// ── 5. Crop + host detected visuals ───────────────────────────────────
function cropRegion(pageBuffer, bbox) {
  // Deferred require: Jimp v1's ESM/CJS interop needs the named export,
  // same pattern already used by extractPdfEmbeddedImages in quizVision.js.
  const { Jimp } = require('jimp');
  return Jimp.read(pageBuffer).then(img => {
    const [ymin, xmin, ymax, xmax] = bbox;
    const w = img.bitmap.width, h = img.bitmap.height;
    const x = Math.max(0, Math.floor((xmin / 1000) * w));
    const y = Math.max(0, Math.floor((ymin / 1000) * h));
    const cropW = Math.max(1, Math.min(w - x, Math.floor(((xmax - xmin) / 1000) * w)));
    const cropH = Math.max(1, Math.min(h - y, Math.floor(((ymax - ymin) / 1000) * h)));
    img.crop({ x, y, w: cropW, h: cropH });
    return img.getBuffer('image/png');
  });
}

async function cropAndHostVisuals(pageImages, visuals) {
  const pageByIndex = new Map(pageImages.map(p => [p.pageIndex, p]));
  const hosted = [];
  for (const v of visuals) {
    const page = pageByIndex.get(v.pageIndex);
    if (!page || !Array.isArray(v.bbox) || v.bbox.length !== 4) continue;
    try {
      const buffer = await cropRegion(page.buffer, v.bbox);
      const [{ url }] = await hostExtractedImages([{ buffer, mime: 'image/png', page: v.pageIndex }]);
      if (url) hosted.push({ ...v, imageUrl: url });
    } catch { /* per-visual crop/host is best-effort, matches extractPdfEmbeddedImages's own non-fatal pattern */ }
  }
  return hosted;
}

// Builds "[PAGE 1]\n<text>\n\n[PAGE 2]\n<text>..." from per-page text — a
// generic, document-agnostic structural marker (page numbers exist on
// every paginated document; this asserts nothing about content). Used so
// Stage 1 can honestly report which page each question came from, which
// v1 had no way to do at all (see structureStage1V2 below).
function buildPageTaggedText(pageTexts) {
  return pageTexts.map(p => `[PAGE ${p.pageIndex}]\n${p.text}`).join('\n\n');
}

// v2 Stage-1 prompt: adds "pageIndex" (which [PAGE n] block the question's
// text was found in) and "order" (a strictly increasing integer reflecting
// the sequence questions appear in, across the whole document) to each
// question. Both are structural/positional facts already present in the
// input via the [PAGE n] markers and the text's own ordering — the model
// is asked to REPORT them, not infer or guess anything new. Still no grade,
// still no hardcoded worksheet example, same as v1.
//
// SUPERSEDED 2026-09-15: a single combined call (decompose + tag page/order
// in one pass) was live-tested twice and consistently collapsed question
// decomposition from v1's 13 correct questions down to 6, even after adding
// an explicit anti-collapse rule (kept below for reference/history, not
// deleted, but no longer used by structureStage1V2 — see the two-call split
// immediately after this function).
function buildPocStage1PromptV2({ subject } = {}) {
  return `You are a precise document-extraction system for an educational worksheet${subject ? ` in ${subject}` : ''}.

The text below is tagged with "[PAGE n]" markers showing which page each part of the document appeared on. Read it and extract its content FAITHFULLY — do not adapt, simplify, or rewrite it for any grade level; that happens in a separate later step you are not performing here.

RULES:
1. Preserve the exact original wording of every question/instruction. Do not paraphrase.
2. Preserve the original ordering of tasks and questions.
3. Give each task a title (verbatim from the source if present) and a list of questions.
3b. NEVER collapse multiple distinct numbered/lettered items, blanks, or sub-parts under one task
    instruction into a single question object. If a task's instruction covers several separate items
    each requiring its own answer (e.g. "a) ... b) ... c) ... d) ..." or several distinct blanks/rows
    under one heading), emit ONE question object per item, each with its own "id" and its own
    "answer"/"hint"/"solution" — do not merge them. Count the actual distinct answerable items in the
    source for that task and make sure your output has that same count of question objects.
4. Each question needs: "id" (unique within its task), "type" ("numeric" | "mcq" | "text"), "question" (verbatim text), "answer" (short, literal, derived by solving/reasoning about the extracted content), "hint" (short clue), "solution" (step-by-step explanation), "pageIndex" (the page number from the "[PAGE n]" marker the question's text appeared under), "order" (an integer giving this question's position in reading order across the WHOLE document — 1 for the first question anywhere in the document, 2 for the second, and so on, strictly increasing, never repeated).
5. If the text contains a marker like "[IMAGE: url=...]" or "[DETECTED IMAGES ...]", note that a visual existed near that point, but do NOT invent a description of what it shows.
6. Never invent content that isn't derivable from the text below. If a task/question cannot be completed from the given text alone, still include it with whatever real content exists, and leave "answer" as an empty string rather than guessing.

Return ONLY this JSON shape (no markdown, no explanation):
{
  "title": "worksheet title, verbatim",
  "subject": "${subject || ''}",
  "grade": "",
  "tasks": [
    { "title": "task title", "questions": [ { "id": "a", "type": "text", "question": "...", "answer": "...", "hint": "...", "solution": "...", "pageIndex": 1, "order": 1 } ] }
  ]
}`;
}

// ── 6. Stage 1 structuring (self-contained buildPocStage1Prompt above —
// grade-independent, no hardcoded worksheet example) ────────────────────
async function structureStage1(text, { subject } = {}) {
  const prompt = buildPocStage1Prompt({ subject });
  const raw = await callGroqWithText(`${prompt}\n\nWORKSHEET TEXT:\n${text.slice(0, 12000)}`);
  let quiz;
  try {
    quiz = JSON.parse(cleanLLMJson(raw));
  } catch (e) {
    return { quiz: { title: '', tasks: [] }, parseError: e.message, raw };
  }
  return { quiz: normalizeQuestionFields(quiz), raw };
}

// Second, minimal call: classifies which page each ALREADY-EXTRACTED
// question came from. Runs only after decomposition is done, so it can't
// compete with/degrade it (the failure mode found in the single-call v2
// prompt above). "order" is NOT asked of the model at all — it's just the
// question's index in the traversal below, which v1's rule "Preserve the
// original ordering of tasks and questions" already guarantees is correct;
// computing it locally removes one more thing that could go wrong.
async function assignPageIndexes(quiz, pageTaggedText, { subject } = {}) {
  const flatQuestions = [];
  for (const task of quiz.tasks || []) {
    for (const q of task.questions || []) flatQuestions.push({ task, q });
  }
  if (!flatQuestions.length) return quiz;

  const numberedList = flatQuestions.map((entry, i) => `${i + 1}. [Task: ${entry.task.title}] ${entry.q.question}`).join('\n');
  const prompt = `You are given a numbered list of questions already extracted from a document, and the document's own text (tagged with "[PAGE n]" markers showing which page each part appeared on).

For EACH numbered question below, determine which page number its text actually appears on in the source. Do not re-extract, rephrase, or judge the questions — only classify their page.

NUMBERED QUESTIONS:
${numberedList}

SOURCE TEXT (page-tagged):
${pageTaggedText.slice(0, 12000)}

Return ONLY this JSON shape (no markdown, no explanation): { "pages": [ { "n": 1, "pageIndex": 1 }, { "n": 2, "pageIndex": 1 } ] } — one entry per numbered question above, "n" matching its number, "pageIndex" the page it was found on. If you genuinely cannot tell, use the page of the nearest question you are confident about.`;

  let pages = [];
  try {
    const raw = await callGroqWithText(prompt, { maxTokens: 4000 });
    const parsed = JSON.parse(cleanLLMJson(raw));
    pages = Array.isArray(parsed.pages) ? parsed.pages : [];
  } catch { /* fall through — every question defaults to page 1 below, non-fatal */ }

  const pageByN = new Map(pages.map(p => [p.n, p.pageIndex]));
  flatQuestions.forEach((entry, i) => {
    entry.q.pageIndex = Number.isFinite(pageByN.get(i + 1)) ? pageByN.get(i + 1) : 1;
    entry.q.order = i + 1; // deterministic, never asked of the model
  });
  return quiz;
}

// v2: v1's proven decomposition (structureStage1, unchanged) followed by
// the page-classification-only second call above — NOT the single combined
// call (buildPocStage1PromptV2/the old structureStage1V2 body), which was
// found to degrade question decomposition on live testing.
async function structureStage1V2(pageTaggedText, { subject } = {}) {
  const plainText = pageTaggedText.replace(/\[PAGE \d+\]\n?/g, '');
  const { quiz, parseError, raw } = await structureStage1(plainText, { subject });
  if (parseError) return { quiz, parseError, raw };
  await assignPageIndexes(quiz, pageTaggedText, { subject });
  return { quiz, raw };
}

// Retained for reference only — not called by runPocOnDocumentV2 anymore.
async function structureStage1V2SingleCall(pageTaggedText, { subject } = {}) {
  const prompt = buildPocStage1PromptV2({ subject });
  const raw = await callGroqWithText(`${prompt}\n\nWORKSHEET TEXT:\n${pageTaggedText.slice(0, 12000)}`);
  let quiz;
  try {
    quiz = JSON.parse(cleanLLMJson(raw));
  } catch (e) {
    return { quiz: { title: '', tasks: [] }, parseError: e.message, raw };
  }
  return { quiz: normalizeQuestionFields(quiz), raw };
}

// ── 7. Visual-to-question association ─────────────────────────────────
// Generic text-overlap match against Qwen's OWN reported nearestQuestionText
// — not a worksheet-specific rule, and not position/rank-based (deliberately
// avoiding the exact fuzzy-rank-matching mechanism this whole investigation
// found unverified/dead in the monolith). A visual with no matching question
// text, or a question that looks visually dependent (reusing
// isVisuallyDependentQuestion from quizVision.js) but matched no visual,
// is left unresolved rather than guessed — surfaced in the report as
// association gaps, not silently dropped or hallucinated onto the wrong
// question.
function associateVisualsToQuestions(quiz, hostedVisuals) {
  const associations = [];
  const unassociatedVisuals = [];
  for (const v of hostedVisuals) {
    const nearestTokens = new Set(extractContentTokens(v.nearestQuestionText || ''));
    let best = null, bestScore = 0;
    for (const task of quiz.tasks || []) {
      for (const q of task.questions || []) {
        if (q.imageUrl) continue; // already associated with an earlier visual
        const qTokens = extractContentTokens(q.question || '');
        const overlap = qTokens.filter(t => nearestTokens.has(t)).length;
        if (overlap > bestScore) { bestScore = overlap; best = { task, q }; }
      }
    }
    // Require at least 3 overlapping content tokens — a generic,
    // document-agnostic confidence floor (not tuned per document type).
    if (best && bestScore >= 3) {
      best.q.imageUrl = v.imageUrl;
      best.q.hasImage = true;
      associations.push({ visualId: v.visualId, pageIndex: v.pageIndex, questionId: best.q.id, taskTitle: best.task.title, matchScore: bestScore });
    } else {
      unassociatedVisuals.push({ visualId: v.visualId, pageIndex: v.pageIndex, description: v.description, imageUrl: v.imageUrl, reason: 'no question matched with sufficient text overlap' });
    }
  }
  const unresolvedVisualQuestions = [];
  for (const task of quiz.tasks || []) {
    for (const q of task.questions || []) {
      if (!q.imageUrl && isVisuallyDependentQuestion(q, task)) {
        q.visualUnderstandingRequired = true;
        unresolvedVisualQuestions.push({ taskTitle: task.title, questionId: q.id, question: q.question });
      }
    }
  }
  return { associations, unassociatedVisuals, unresolvedVisualQuestions };
}

// ── 7b. Visual-to-question association v2 — page + reading-order primary,
// text-overlap as a secondary confirmation signal only ──────────────────
// Root cause established by inspecting real v1 output (2026-09-15) against
// the original failing worksheet plus an 8-page reading document: v1's
// text-overlap-only approach cannot distinguish near-duplicate question
// phrasing (e.g. four "measure the angle..." questions differing only by
// id) — the token overlap is identical or near-identical across several
// candidates, so the "best" match is frequently arbitrary/wrong-threshold
// rather than genuinely confident. Stage 1 (v1) also had NO page or
// position field on questions at all, making genuine position-based
// matching structurally impossible before this change.
//
// v2 algorithm, per document:
//   1. HARD page filter — a visual is only ever considered against
//      questions Stage 1 reported on the SAME pageIndex. Never crosses
//      page boundaries, satisfying "preserve page boundaries."
//   2. Within a page, each question's "order" value is converted into a
//      synthetic 0-1000 vertical position via even distribution across
//      that page's question count (order-based reading-order proxy, since
//      Stage 1 doesn't return true per-question bounding boxes — only
//      Mistral's visuals have real bbox coordinates). This is a generic,
//      document-agnostic approximation, not a worksheet-specific rule.
//   3. A visual's own vertical center (mean of bbox ymin/ymax) is compared
//      against every same-page question's synthetic position. The nearest
//      question is the position candidate.
//   4. Text-overlap (same token-overlap check as v1) is computed
//      independently as a second candidate.
//   5. Confidence tiers:
//      - "position+text agree" (both point to the same question) → always
//        associate, highest confidence.
//      - "position-only, within a tight distance threshold (<=180/1000)
//        AND no other question is nearly as close (next-nearest is >=100
//        units farther)" → associate, medium confidence.
//      - Anything else (ambiguous, far, or position/text disagree with no
//        tiebreak) → LEFT UNASSOCIATED. Per explicit requirement: never
//        guess when confidence is insufficient.
//   6. Multiple visuals CAN associate to the same question (a question's
//      "imageUrls" becomes an array; "imageUrl" mirrors the first entry
//      for renderer compatibility) — a question is never skipped just
//      because it already has one image, satisfying "support multiple
//      visuals belonging to one question."
//   7. A question with zero associated visuals is simply left with no
//      image — satisfying "support questions with no visual." A visual
//      whose page has no reasonably-close question (e.g. a header logo
//      far above every question's synthetic position) naturally falls
//      outside the distance threshold and stays unresolved — satisfying
//      "support visuals between/above/below questions" without a
//      worksheet-specific rule about what a logo/header "looks like."
function associateVisualsToQuestionsV2(quiz, hostedVisuals) {
  const allQuestions = [];
  for (const task of quiz.tasks || []) {
    for (const q of task.questions || []) allQuestions.push({ task, q });
  }
  // Group by page, compute each question's synthetic position (even
  // distribution across its page's own question count, ordered by
  // "order" — falls back to array order if "order" is missing/non-numeric
  // on some questions, so a partially-compliant Stage 1 response degrades
  // gracefully rather than crashing this step).
  const byPage = new Map();
  for (const entry of allQuestions) {
    const pageIdx = Number.isFinite(entry.q.pageIndex) ? entry.q.pageIndex : 1;
    if (!byPage.has(pageIdx)) byPage.set(pageIdx, []);
    byPage.get(pageIdx).push(entry);
  }
  for (const [, entries] of byPage) {
    entries.sort((a, b) => (Number.isFinite(a.q.order) ? a.q.order : 0) - (Number.isFinite(b.q.order) ? b.q.order : 0));
    entries.forEach((entry, i) => {
      entry.syntheticY = ((i + 0.5) / entries.length) * 1000;
    });
  }

  const associations = [];
  const unassociatedVisuals = [];
  const POSITION_THRESHOLD = 180;
  const TIEBREAK_MARGIN = 100;

  for (const v of hostedVisuals) {
    const pageEntries = byPage.get(v.pageIndex) || [];
    if (!pageEntries.length || !Array.isArray(v.bbox) || v.bbox.length !== 4) {
      unassociatedVisuals.push({ visualId: v.visualId, pageIndex: v.pageIndex, description: v.description, imageUrl: v.imageUrl, reason: 'no questions on this page, or visual had no usable bbox' });
      continue;
    }
    const visualY = (v.bbox[0] + v.bbox[2]) / 2; // vertical center, 0-1000 scale

    // Position candidate: nearest + runner-up (for the tiebreak margin check).
    let nearest = null, nearestDist = Infinity, secondDist = Infinity;
    for (const entry of pageEntries) {
      const d = Math.abs(entry.syntheticY - visualY);
      if (d < nearestDist) { secondDist = nearestDist; nearestDist = d; nearest = entry; }
      else if (d < secondDist) { secondDist = d; }
    }

    // Text-overlap candidate (same mechanism as v1, used only as a
    // secondary confirmation signal here, not the primary decision).
    const nearestTokens = new Set(extractContentTokens(v.nearestQuestionText || ''));
    let textBest = null, textBestScore = 0;
    for (const entry of pageEntries) {
      const qTokens = extractContentTokens(entry.q.question || '');
      const overlap = qTokens.filter(t => nearestTokens.has(t)).length;
      if (overlap > textBestScore) { textBestScore = overlap; textBest = entry; }
    }

    let chosen = null, confidence = null;
    if (nearest && textBest && nearest.q === textBest.q && textBestScore >= 1) {
      chosen = nearest; confidence = 'position+text agree';
    } else if (nearest && nearestDist <= POSITION_THRESHOLD && (secondDist - nearestDist) >= TIEBREAK_MARGIN) {
      chosen = nearest; confidence = 'position-only, within threshold';
    }

    if (chosen) {
      if (!Array.isArray(chosen.q.imageUrls)) chosen.q.imageUrls = [];
      chosen.q.imageUrls.push(v.imageUrl);
      chosen.q.imageUrl = chosen.q.imageUrls[0]; // renderer compatibility (single-image field)
      chosen.q.hasImage = true;
      associations.push({
        visualId: v.visualId, pageIndex: v.pageIndex, questionId: chosen.q.id, taskTitle: chosen.task.title,
        confidence, positionDistance: Math.round(nearestDist), textOverlapScore: textBestScore,
      });
    } else {
      unassociatedVisuals.push({
        visualId: v.visualId, pageIndex: v.pageIndex, description: v.description, imageUrl: v.imageUrl,
        reason: 'no question on this page was close enough in reading order (and text overlap did not confirm one) to associate with sufficient confidence',
        nearestCandidateQuestionId: nearest ? nearest.q.id : null, nearestDistance: nearest ? Math.round(nearestDist) : null,
      });
    }
  }

  const unresolvedVisualQuestions = [];
  for (const task of quiz.tasks || []) {
    for (const q of task.questions || []) {
      if (!q.imageUrl && isVisuallyDependentQuestion(q, task)) {
        q.visualUnderstandingRequired = true;
        unresolvedVisualQuestions.push({ taskTitle: task.title, questionId: q.id, question: q.question });
      }
    }
  }
  return { associations, unassociatedVisuals, unresolvedVisualQuestions };
}

// ── 8. Stage 2 (pedagogy: grade attached post-hoc, same boundary as
// production's generateQuizFromPdf/generateQuizFromImage) ─────────────
function applyGradePostHoc(quiz, grade) {
  quiz.grade = quiz.grade || grade || '';
  return quiz;
}

// ── Orchestration ──────────────────────────────────────────────────────
async function runPocOnDocument(filePath, { subject, grade } = {}) {
  const filename = path.basename(filePath);
  const buffer = fs.readFileSync(filePath);
  const report = { file: filename, startedAt: new Date().toISOString() };
  try {
    const normalized = await normalizeDocument(buffer, filename);
    report.sourceType = normalized.sourceType;

    let pdfBuffer = normalized.pdfBuffer;
    if (normalized.sourceType === 'docx') {
      // docx has no page-image concept of its own for this POC — text
      // (with real embedded-image URLs already inline via mammoth) is
      // sufficient; visual detection for docx relies on the embedded
      // images mammoth already extracted, not on Qwen-VL page scanning.
      report.docxEmbeddedImageCount = normalized.docxEmbeddedImageUrls.length;
    }

    let pageImages = [];
    if (normalized.sourceType === 'pdf') {
      pageImages = await rasterizePdfPerPage(pdfBuffer);
    } else if (normalized.sourceType === 'image') {
      pageImages = [{ pageIndex: 1, buffer: normalized.imageBuffer, mime: normalized.imageMime }];
    }
    report.pageCount = pageImages.length || (normalized.sourceType === 'docx' ? null : 0);

    const { text: sourceText, method: textMethod } = normalized.sourceType === 'docx'
      ? { text: normalized.structuredText, method: 'mammoth-structured' }
      : await extractText(pdfBuffer, null, pageImages);
    report.extractedTextLength = sourceText.length;
    report.textExtractionMethod = textMethod;
    report.extractedTextPreview = sourceText.slice(0, 500);

    let embeddedImageCount = 0;
    if (normalized.sourceType === 'pdf') {
      try {
        const embedded = await extractPdfEmbeddedImages(pdfBuffer);
        embeddedImageCount = embedded.length;
      } catch { /* non-fatal, matches production */ }
    }
    report.embeddedRasterImageCount = embeddedImageCount;

    let visuals = [];
    let visualDetectionErrors = [];
    if (pageImages.length) {
      const detected = await detectAllVisuals(pageImages);
      visuals = detected.visuals;
      visualDetectionErrors = detected.errors;
    }
    report.qwenDetectedVisualCount = visuals.length;
    report.visualDetectionErrors = visualDetectionErrors;

    let hostedVisuals = [];
    if (visuals.length) {
      hostedVisuals = await cropAndHostVisuals(pageImages, visuals);
    }
    report.hostedVisualCount = hostedVisuals.length;

    const { quiz, parseError, raw } = await structureStage1(sourceText, { subject });
    if (parseError) {
      report.stage1ParseError = parseError;
      report.stage1RawPreview = String(raw || '').slice(0, 500);
    }

    const association = associateVisualsToQuestions(quiz, hostedVisuals);
    report.visualAssociations = association.associations;
    report.unassociatedVisuals = association.unassociatedVisuals;
    report.unresolvedVisualQuestions = association.unresolvedVisualQuestions;

    applyGradePostHoc(quiz, grade);

    const questionCount = (quiz.tasks || []).reduce((n, t) => n + (t.questions || []).length, 0);
    report.taskCount = (quiz.tasks || []).length;
    report.questionCount = questionCount;
    report.questions = (quiz.tasks || []).flatMap(t => (t.questions || []).map(q => ({
      taskTitle: t.title, id: q.id, question: q.question, hasImage: !!q.imageUrl, visualUnderstandingRequired: !!q.visualUnderstandingRequired,
    })));

    let html = null, htmlError = null;
    try {
      html = renderQuizHTML(quiz, {});
    } catch (e) {
      htmlError = e.message;
    }
    report.htmlGenerated = !!html;
    report.htmlError = htmlError;
    report.htmlLength = html ? html.length : 0;

    report.quiz = quiz;
    report.html = html;
    report.status = 'completed';
  } catch (e) {
    report.status = 'failed';
    report.error = e.message;
    report.stack = e.stack;
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

// v2 orchestration: same normalization/visual-detection/hosting as v1, but
// Stage 1 is fed page-tagged text and asked for pageIndex/order, and
// association uses associateVisualsToQuestionsV2 (position/reading-order
// primary) instead of v1's text-overlap-only associateVisualsToQuestions.
// Kept as a SEPARATE function (v1 untouched, still exported) specifically
// so the before/after comparison re-runs both against the same documents
// rather than overwriting the only implementation.
async function runPocOnDocumentV2(filePath, { subject, grade } = {}) {
  const filename = path.basename(filePath);
  const buffer = fs.readFileSync(filePath);
  const report = { file: filename, startedAt: new Date().toISOString(), pipelineVersion: 'v2-position-association' };
  try {
    const normalized = await normalizeDocument(buffer, filename);
    report.sourceType = normalized.sourceType;

    let pdfBuffer = normalized.pdfBuffer;
    if (normalized.sourceType === 'docx') {
      report.docxEmbeddedImageCount = normalized.docxEmbeddedImageUrls.length;
    }

    let pageImages = [];
    if (normalized.sourceType === 'pdf') {
      pageImages = await rasterizePdfPerPage(pdfBuffer);
    } else if (normalized.sourceType === 'image') {
      pageImages = [{ pageIndex: 1, buffer: normalized.imageBuffer, mime: normalized.imageMime, text: '' }];
    }
    report.pageCount = pageImages.length || (normalized.sourceType === 'docx' ? null : 0);

    // Page-tagged text for Stage 1. PDF: real per-page text from pdfjs
    // (falls back to per-page OCR if a page's native text is thin —
    // scanned/image-only pages). DOCX/image: no real page concept, so the
    // whole document is tagged as a single [PAGE 1] block — association
    // still works within that page, it just can't distinguish pages that
    // don't structurally exist for these formats.
    let pageTexts;
    if (normalized.sourceType === 'pdf') {
      pageTexts = [];
      for (const p of pageImages) {
        let text = p.text || '';
        if (text.length < 50) {
          try { text = await callOcrText(p.buffer, p.mime); } catch { /* keep thin text, non-fatal */ }
        }
        pageTexts.push({ pageIndex: p.pageIndex, text });
      }
    } else {
      const singleText = normalized.sourceType === 'docx' ? normalized.structuredText : '';
      pageTexts = [{ pageIndex: 1, text: singleText }];
    }
    const pageTaggedText = buildPageTaggedText(pageTexts);
    const combinedTextLength = pageTexts.reduce((n, p) => n + (p.text || '').length, 0);
    report.extractedTextLength = combinedTextLength;
    report.textExtractionMethod = normalized.sourceType === 'docx' ? 'mammoth-structured' : 'pdfjs-per-page(+ocr-if-thin)';
    report.extractedTextPreview = pageTaggedText.slice(0, 500);

    let embeddedImageCount = 0;
    if (normalized.sourceType === 'pdf') {
      try {
        const embedded = await extractPdfEmbeddedImages(pdfBuffer);
        embeddedImageCount = embedded.length;
      } catch { /* non-fatal, matches production */ }
    }
    report.embeddedRasterImageCount = embeddedImageCount;

    let visuals = [];
    let visualDetectionErrors = [];
    if (pageImages.length) {
      const detected = await detectAllVisuals(pageImages);
      visuals = detected.visuals;
      visualDetectionErrors = detected.errors;
    }
    report.qwenDetectedVisualCount = visuals.length;
    report.visualDetectionErrors = visualDetectionErrors;

    let hostedVisuals = [];
    if (visuals.length) {
      hostedVisuals = await cropAndHostVisuals(pageImages, visuals);
    }
    report.hostedVisualCount = hostedVisuals.length;

    const { quiz, parseError, raw } = await structureStage1V2(pageTaggedText, { subject });
    if (parseError) {
      report.stage1ParseError = parseError;
      report.stage1RawPreview = String(raw || '').slice(0, 500);
    }

    const association = associateVisualsToQuestionsV2(quiz, hostedVisuals);
    report.visualAssociations = association.associations;
    report.unassociatedVisuals = association.unassociatedVisuals;
    report.unresolvedVisualQuestions = association.unresolvedVisualQuestions;

    applyGradePostHoc(quiz, grade);

    const questionCount = (quiz.tasks || []).reduce((n, t) => n + (t.questions || []).length, 0);
    report.taskCount = (quiz.tasks || []).length;
    report.questionCount = questionCount;
    report.questions = (quiz.tasks || []).flatMap(t => (t.questions || []).map(q => ({
      taskTitle: t.title, id: q.id, question: q.question, pageIndex: q.pageIndex, order: q.order,
      hasImage: !!q.imageUrl, imageCount: Array.isArray(q.imageUrls) ? q.imageUrls.length : 0,
      visualUnderstandingRequired: !!q.visualUnderstandingRequired,
    })));

    let html = null, htmlError = null;
    try {
      html = renderQuizHTML(quiz, {});
    } catch (e) {
      htmlError = e.message;
    }
    report.htmlGenerated = !!html;
    report.htmlError = htmlError;
    report.htmlLength = html ? html.length : 0;

    report.quiz = quiz;
    report.html = html;
    report.status = 'completed';
  } catch (e) {
    report.status = 'failed';
    report.error = e.message;
    report.stack = e.stack;
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

module.exports = {
  normalizeDocument, rasterizePdfPerPage, extractText, detectVisualsOnPage, detectAllVisuals,
  cropAndHostVisuals, structureStage1, associateVisualsToQuestions, applyGradePostHoc,
  runPocOnDocument, QWEN_VISION_MODEL,
  buildPageTaggedText, structureStage1V2, associateVisualsToQuestionsV2, runPocOnDocumentV2,
};
