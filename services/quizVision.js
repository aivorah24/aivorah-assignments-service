// ── Core Gemini vision quiz generation ───────────────────────────────────
// Increment 1 of the worksheet AI-extraction pipeline migration (see
// QUIZ_PIPELINE_MIGRATION.md) — ported from ai-mentor/server/routes/quiz.js
// (2026-09-11). Deliberately minimal: single image in, quiz JSON out, no
// OCR cross-validation, no diagram matching, no answer-verification pass,
// no multi-vendor fallback chain yet — each is a separate, explicitly
// tracked increment, not a permanent omission.
const { GoogleGenerativeAI } = require('@google/generative-ai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const GEMINI_VISION_TIMEOUT_MS = parseInt(process.env.GEMINI_VISION_TIMEOUT_MS || '75000', 10);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT:${label}:${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Retry wrapper: exponential backoff on Gemini 429 (rate limit) / 503 (overloaded).
async function geminiRetry(fn, { tries = 6, base = 2500 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e && e.message) || e);
      const is429 = /429|too many requests|quota|resource_exhausted|rate.?limit/i.test(msg);
      const is503 = /503|overloaded|unavailable/i.test(msg);
      lastErr = e;
      // A permanent-billing 429 (daily quota, OR the account itself has no
      // funds/credits left) can't recover by waiting — retrying just holds
      // the request open until a proxy timeout kills it instead of returning
      // a real error. Verified live: a "prepayment credits are depleted" 429
      // isn't a daily-quota message but is exactly as unrecoverable, and the
      // narrower daily-only check let it retry for ~88s before failing.
      if (is429 && /PerDay|per.?day|daily|prepayment|credits?\s+(are\s+)?depleted|billing|insufficient.?(funds|balance)/i.test(msg)) throw e;
      if ((!is429 && !is503) || i === tries - 1) throw e;
      const suggested = msg.match(/retry.?after[^\d]*(\d+)/i) || msg.match(/retryDelay["\s:]+(\d+)/i);
      const wait = suggested ? parseInt(suggested[1], 10) * 1000
        : base * Math.pow(2, i) + Math.floor(Math.random() * 600);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function geminiGenerate(model, content) {
  const result = await geminiRetry(() => model.generateContent(content));
  return result.response.text();
}

function geminiImageParts(imageBuffers) {
  return imageBuffers.map(({ buffer, mime }) => ({
    inlineData: { mimeType: mime || 'image/png', data: buffer.toString('base64') },
  }));
}

// Gemini 2.5 Flash reads PDFs natively (multi-page) via inlineData, same as
// an image part. High-DPI per-page rasterization (what the monolith does as
// an accuracy enhancement on top of this) is a separate, later increment —
// sending the raw PDF directly is what the monolith itself falls back to
// when rasterization isn't available, so this is a real, working path, not
// a stub.
function geminiPdfPart(pdfBuffer) {
  return { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } };
}

function buildQuizVisionPrompt({ grade, subject, school } = {}) {
  return `You are an expert quiz generator for ${grade || 'IB PYP Grade 4'} ${subject || 'Mathematics'}.

STEP 1: CAREFULLY examine the worksheet image(s). Read EVERY number, word, symbol, shape, table, and layout element.

⚠️ ACCURACY IS THE #1 PRIORITY. NEVER guess, approximate, or invent a number. Every number in your output MUST be a number you can actually SEE printed on the worksheet. If you output a problem like "100 + 233" when the worksheet actually shows "326 + 419", that is a CRITICAL FAILURE. Read each digit individually.

⚠️ VERTICAL / COLUMN ARITHMETIC (READ THIS CAREFULLY — this is where most mistakes happen):
Many math worksheets show addition/subtraction as a VERTICAL STACK, not inline. For example:
     326                317
   + 419              - 258
   ─────              ─────
This means "326 + 419" and "317 - 258". To read a vertical stack correctly:
  1. Read the TOP number completely, digit by digit, left to right (e.g. 3-2-6 = 326).
  2. Read the operator on the left (+ or −).
  3. Read the BOTTOM number completely, digit by digit (e.g. 4-1-9 = 419).
  4. The problem is "TOP operator BOTTOM" (e.g. "326 + 419").
Do NOT swap digits, drop digits, or invent a smaller/rounder number. "628" is NOT "68" or "600". Read all THREE digits. If the worksheet has 9 stacked problems, you MUST output those 9 problems with their EXACT numbers — count them and match.

STEP 2: For each task/section in the worksheet, extract:
- The exact title/heading
- Every single question with exact numbers
- Any diagrams, tables, or visual elements
- The operation being performed (+, -, ×, ÷)

STEP 3: Generate quiz JSON that is a PERFECT REPLICA of the worksheet.

RULES:
1. Each Task from the worksheet = one task in JSON. Keep EXACT task title and instructions.
2. Label questions EXACTLY as worksheet does (a, b, c, d, e — NOT q1, q2).
2b. NEVER collapse multiple numbered/lettered items under one instruction into a single
    question. If one instruction covers several sentences/blanks/rows (e.g. "d1) ... d2) ...
    d3) ... d4) ..." or 4 separate sentences each needing its own circled word and blank),
    emit ONE question per item, each with its own id (d1, d2, d3, d4) and its own answer/
    hint/solution — never merge them into a single answer field. Count the actual items in
    the worksheet and make sure your output has that same count of questions for that task.
3. Use the EXACT SAME NUMBERS from the worksheet. Do NOT substitute different numbers.
4. Every question MUST have a correct "answer" field. YOU MUST SOLVE each problem. Think step by step, compute the answer, and write the final result. NEVER write "Not provided in the text" or "N/A" — you are the solver, not just an extractor.
4b. Keep "answer" SHORT — the literal, direct response a student would type in the blank (e.g. "football", "12 cm", "rugby and badminton"). NEVER pack your full working/narrative into "answer" (e.g. do NOT write "20, closer to football" or "Current votes for rugby = 10, so doubled = 20..." as the answer) — that full reasoning belongs ONLY in "solution". A bloated "answer" field makes correct short student responses get marked wrong.
5. Pay careful attention to UNITS.
6. Every question MUST have a "solution" field with a clear step-by-step explanation. NEVER write "Not provided" — work through the problem and explain how to get the answer.
7. Every question MUST have a "hint" field — a short clue that guides the student without giving the full answer. NEVER leave hint empty or omit it.
8. DIAGRAM/IMAGE HANDLING (CRITICAL — read carefully):
   a) If MULTIPLE questions in a task ALL reference the SAME shared diagram/picture (e.g. a picture of objects where Q1-Q4 all ask about the same picture, or a set of weighing scales where all questions refer to the same image), then:
      - Set "sharedImage": true on the TASK object (not on individual questions)
      - Set "sharedImageDescription": description of the shared diagram
      - Set "sharedImagePosition": position on the page ("top-center", "middle-center", etc.)
      - Set "hasImage": false on ALL individual questions (the image belongs to the task, not to any single question)
      Example: A picture showing a book, bench, and foot — with Q1 "The book is ___ foot", Q2 "The bench is ___ feet", Q3 "The book is ___ than the bench" — ALL reference the SAME picture. Use sharedImage on the task.
   b) If a question has its OWN UNIQUE diagram that no other question uses, set "hasImage": true on that question with:
      - "diagramDescription": short description (e.g. "L-shaped polygon with sides 5m, 6m, 8m, 3m")
      - "diagramPosition": approximate position on the page: "top-left", "top-right", "top-center", "middle-left", "middle-right", "middle-center", "bottom-left", "bottom-right", "bottom-center"
   c) For text-only questions with no diagram, set "hasImage": false.
   These fields are used by the server to match cropped images to the correct questions. Getting this wrong causes images to appear on the wrong questions.
   d) If a task/section has an ILLUSTRATION or DECORATIVE IMAGE (e.g. a cartoon character, animal picture, beehive, tree diagram, branching arrows) that provides context but is not a per-question diagram, treat it as a sharedImage on the task:
      - Set "sharedImage": true, "sharedImageDescription": description, "sharedImagePosition": position
      This ensures ALL visual elements from the worksheet are preserved, not just math diagrams.
   e) ⚠️ TRANSCRIBE DATA THAT LIVES INSIDE A PICTURE INTO THE QUESTION TEXT. If the numbers, digits,
      letters, or values a student needs to answer are printed INSIDE an image (e.g. digit/number
      cards "3 5 2 4 1 0", a set of number tiles, dominoes, dice faces, price tags, a clock face),
      you MUST copy those exact values into the "question" text (e.g. "Using the digits 3, 5, 2, 4,
      1, 0 (each once), make two 3-digit numbers…"). The picture may not always render, so the
      question must be fully answerable from its text ALONE. Still set "hasImage"/"sharedImage" so
      the picture is also preserved — but NEVER leave the essential values only inside the image.
9. Do NOT generate SVG, HTML diagrams, or diagramHTML. The server handles all image rendering separately.
10. For questions that reference a graph/chart/image: READ the visual data from the image to compute the answer. For example, if a bar graph shows football=16, tennis=8 and the Y-axis goes 0,2,4,6... then the scale is 2.
11. MATCH-THE-FOLLOWING TASKS (e.g. "match the word to the picture", "match the following", "జతపరచండి"): emit ONE question per item to match. Set "type": "mcq" and "options": an array of ALL candidate words/phrases from the matching column (the full pool — the SAME list for every question in that task, in a different order per question), and "answer": the correct word for that item. Do NOT emit matching items as free-text fill-in questions — the student must pick from the pool, not type it.
12. COUNT THE ANSWER SPACES. If a task provides N blank lines / boxes / spaces for the student to write answers (e.g. 6 blank lines next to a letters table), generate EXACTLY N questions — one per blank line. Count the physical blank lines in the image before writing the questions. Never collapse them into fewer questions.

LAYOUT EXTRACTION (CRITICAL — replicate the worksheet's visual layout):
- Look at how questions are arranged: single column, two columns side-by-side, grid, etc.
- For each task, include a "layout" object describing the visual arrangement.
- "layout.type": "single-column" (one column of questions), "two-column" (two side-by-side columns like conversion tables), "grid" (grid of cells), "list" (numbered list)
- "layout.columns": number of columns (1 or 2 typically)
- "layout.columnGroups": array of column groups, each with "questionIds" listing which questions belong to that column (in order, top to bottom)
- If a column group has a diagram/image above its questions, set "hasDiagram": true on that group
- Questions in column 0 are LEFT side, column 1 are RIGHT side
- CRITICAL ID RULE: Every question in a task MUST have a globally unique "id" (e.g. "a", "b", "c", "d", "e" for the left column, and "f", "g", "h", "i", "j" for the right column). Never reuse the same "id" within a task, even if the worksheet repeats question labels (like two columns both labeled 'a', 'b', 'c').

Return this EXACT JSON structure:
{
  "title": "worksheet title",
  "subject": "${subject || 'Mathematics'}",
  "grade": "${grade || 'PYP 4'}",
  "school": "${school || ''}",
  "purpose": "the Purpose/objective line stated on the worksheet, verbatim (empty string if none)",
  "learningOutcomes": ["each Learning Outcome bullet point, exactly as written on the worksheet"],
  "concepts": [{ "term": "name", "definition": "short child-friendly definition", "unit": "unit" }],
  "tasks": [
    {
      "tier": "<section label exactly as printed, e.g. 'Must Do' — or '' if none>",
      "title": "Task 1: exact title from worksheet",
      "sourcePage": 1,
      "layout": {
        "type": "two-column",
        "columns": 2,
        "columnGroups": [
          { "hasDiagram": true, "questionIds": ["a","b","c","d","e"] },
          { "hasDiagram": true, "questionIds": ["f","g","h","i","j"] }
        ]
      },
      "questions": [
        { "id": "a", "type": "numeric", "question": "4 kg = ___ gm", "unit": "gm", "answer": 4000, "hint": "1 kg = 1000 gm", "solution": "4 × 1000 = 4000 gm", "hasImage": false },
        { "id": "f", "type": "numeric", "question": "5 l = ___ ml", "unit": "ml", "answer": 5000, "hint": "1 l = 1000 ml", "solution": "5 × 1000 = 5000 ml", "hasImage": false }
      ]
    },
    {
      "tier": "<this task's own section label, exactly as printed>",
      "title": "Task 3: Observe the picture and fill in the blanks",
      "sourcePage": 2,
      "sharedImage": true,
      "sharedImageDescription": "Picture showing a book, a bench, and a foot as measurement unit",
      "sharedImagePosition": "top-center",
      "layout": { "type": "single-column", "columns": 1 },
      "questions": [
        { "id": "a", "type": "numeric", "question": "The length of the book is ___ foot.", "unit": "foot", "answer": 1, "hasImage": false },
        { "id": "b", "type": "numeric", "question": "The length of the bench is ___ feet.", "unit": "feet", "answer": 4, "hasImage": false }
      ]
    }
  ]
}`;
}

// Ported verbatim from the monolith — strips markdown fences, slices to the
// outermost JSON object (fallback engines sometimes wrap the JSON in prose),
// quotes bare fraction answers, and strips // comments a model occasionally emits.
function cleanLLMJson(raw) {
  let s = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  s = s.replace(/"answer":\s*(\d+\/\d+)/g, '"answer": "$1"');
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    out += c;
  }
  return out;
}

// ── Gemini Vision — primary engine (free, excellent accuracy) ────────────────
async function callGeminiVision(parts, { grade, subject, school } = {}) {
  if (!genAI) throw new Error('GEMINI_API_KEY not configured');
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    // temperature: 0 — a pure reading task, not a creative one; without this
    // Gemini defaults to ~1.0 and gives a different "guess" run to run.
    generationConfig: { responseMimeType: 'application/json', temperature: 0 }
  });
  const prompt = buildQuizVisionPrompt({ grade, subject, school });
  return geminiGenerate(model, [...parts, { text: prompt }]);
}

// ── Qwen 2.5-VL-72B Vision (via HuggingFace router) — fallback when Gemini
// fails ─────────────────────────────────────────────────────────────────
// Live-verified 2026-09-11: this key/model responds successfully right now,
// unlike the only available Gemini key (depleted). Image-only for now (no
// PDF support — HF's chat-completions API takes image_url data URIs, not a
// native PDF part like Gemini's inlineData); PDF generation stays
// Gemini-only until page rasterization is added (see
// QUIZ_PIPELINE_MIGRATION.md).
const HF_TOKEN = process.env.HF_TOKEN;
const QWEN_VISION_MODEL = 'Qwen/Qwen2.5-VL-72B-Instruct';
async function callQwenVision(imageBuffer, mime, { grade, subject, school } = {}) {
  if (!HF_TOKEN) throw new Error('HF_TOKEN not configured');
  const prompt = buildQuizVisionPrompt({ grade, subject, school });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: QWEN_VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mime || 'image/png'};base64,${imageBuffer.toString('base64')}` } },
            { type: 'text', text: prompt },
          ],
        }],
        max_tokens: 8192,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HF router ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return json.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

function parseQuizResponse(raw) {
  try {
    return JSON.parse(cleanLLMJson(raw));
  } catch {
    const err = new Error('AI returned invalid JSON');
    err.raw = raw;
    throw err;
  }
}

// Increment 1 (+ Qwen fallback, added 2026-09-11): single image → quiz
// JSON. Gemini first; if it throws for ANY reason (including the currently
// depleted key), falls back to Qwen — live-verified working right now. No
// OCR cross-validation, no diagram matching, no answer-verification pass
// yet — see QUIZ_PIPELINE_MIGRATION.md for what's still pending.
async function generateQuizFromImage(imageBuffer, mime, { grade, subject, school } = {}) {
  const parts = geminiImageParts([{ buffer: imageBuffer, mime }]);
  let raw;
  try {
    raw = await withTimeout(callGeminiVision(parts, { grade, subject, school }), GEMINI_VISION_TIMEOUT_MS, 'gemini-vision');
  } catch (geminiErr) {
    raw = await callQwenVision(imageBuffer, mime, { grade, subject, school });
  }
  return parseQuizResponse(raw);
}

// Increment 8 (partial — PDF path only, no high-DPI page rasterization yet):
// a PDF (or a docx already converted to PDF upstream via docx-to-pdf) → quiz
// JSON, same Gemini-only path as generateQuizFromImage. Powers both the sync
// /quiz/generate route and the queued /quiz/generate-async job.
async function generateQuizFromPdf(pdfBuffer, { grade, subject, school } = {}) {
  const parts = [geminiPdfPart(pdfBuffer)];
  const raw = await withTimeout(callGeminiVision(parts, { grade, subject, school }), GEMINI_VISION_TIMEOUT_MS, 'gemini-vision');
  return parseQuizResponse(raw);
}

module.exports = {
  generateQuizFromImage, generateQuizFromPdf, callGeminiVision, callQwenVision, buildQuizVisionPrompt, cleanLLMJson,
  geminiImageParts, geminiPdfPart, geminiRetry, geminiGenerate, withTimeout, GEMINI_VISION_TIMEOUT_MS,
};
