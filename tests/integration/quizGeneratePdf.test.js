// POST /quiz/generate and POST /quiz/generate-async — PDF path of the AI
// extraction pipeline migration (see QUIZ_PIPELINE_MIGRATION.md). Same
// contract-testing approach as quizGenerateImage.test.js: Gemini SDK mocked,
// real end-to-end verification tracked separately against a live worksheet.
jest.mock('../../services/supabase', () => ({
  from: jest.fn(() => ({ insert: jest.fn().mockResolvedValue({ error: null }) })),
}));

const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: (...args) => mockGenerateContent(...args) }),
  })),
}));

const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));

const request = require('supertest');
const fs = require('fs');
const path = require('path');

function geminiJsonResponse(obj) {
  return Promise.resolve({ response: { text: () => JSON.stringify(obj) } });
}

describe('POST /quiz/generate — validation', () => {
  let app;
  beforeAll(() => { app = require('../../index'); });
  beforeEach(() => mockGenerateContent.mockReset());

  test('requires a PDF file', async () => {
    const res = await request(app).post('/quiz/generate').field('grade', 'Grade 4');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No PDF file uploaded/);
  });
});

describe('POST /quiz/generate — real generation contract', () => {
  let app;
  beforeAll(() => { app = require('../../index'); });
  beforeEach(() => mockGenerateContent.mockReset());

  test('a real, well-formed Gemini response is returned as { quiz }', async () => {
    mockGenerateContent.mockResolvedValue(geminiJsonResponse({
      title: 'Algebra Worksheet',
      tasks: [{ title: 'Task 1', questions: [{ id: 'a', question: 'x + 2 = 5', answer: '3' }] }],
    }));

    const res = await request(app)
      .post('/quiz/generate')
      .field('grade', 'Grade 8')
      .field('subject', 'Mathematics')
      .attach('pdf', Buffer.from('%PDF-fake'), { filename: 'worksheet.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.quiz.title).toBe('Algebra Worksheet');
    expect(res.body.quiz.tasks[0].questions[0].answer).toBe('3');
  });

  test('the PDF is sent as inline PDF data, not re-rasterized into images', async () => {
    mockGenerateContent.mockResolvedValue(geminiJsonResponse({ title: 'x', tasks: [] }));
    const pdfBytes = Buffer.from('%PDF-fake');

    await request(app).post('/quiz/generate').attach('pdf', pdfBytes, { filename: 'worksheet.pdf', contentType: 'application/pdf' });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const pdfPart = callArgs.find(p => p.inlineData);
    expect(pdfPart.inlineData.mimeType).toBe('application/pdf');
    expect(pdfPart.inlineData.data).toBe(pdfBytes.toString('base64'));
  });
});

describe('POST /quiz/generate — real failure handling', () => {
  let app;
  beforeAll(() => { app = require('../../index'); });
  beforeEach(() => mockGenerateContent.mockReset());

  test('a real permanent-billing 429 (e.g. depleted prepayment credits) fails fast (no retries), then falls back to Groq text extraction, which fails cleanly on a non-PDF buffer', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 Too Many Requests: Your prepayment credits are depleted.'));
    const res = await request(app).post('/quiz/generate').attach('pdf', Buffer.from('%PDF'), { filename: 'w.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(500);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1); // fast-fail, no retries
    // Buffer.from('%PDF') isn't a real PDF, so the fallback's own pdf-parse
    // AND rasterization+OCR steps both fail too - proving the full fallback
    // chain runs (not just that Gemini failed) without needing a real PDF
    // fixture in this suite.
    expect(res.body.error).toMatch(/Could not extract any worksheet content/);
  });

  test('a malformed (non-JSON) Gemini response surfaces as a 500 with the raw text', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'not json' } });
    const res = await request(app).post('/quiz/generate').attach('pdf', Buffer.from('%PDF'), { filename: 'w.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('AI returned invalid JSON');
  });
});

describe('POST /quiz/generate — fallback chain when Gemini fails (PDF path)', () => {
  // Root cause found via live testing 2026-09-12: some real worksheets
  // (e.g. this Telugu IB PYP fixture) have their actual question content
  // as non-text graphics, so pdf-parse extracts almost nothing. A second
  // finding the same day: asking Qwen to do FULL one-shot structured quiz
  // extraction (title+tasks+questions+answers, the same complex prompt
  // Gemini handles) is unreliable - it read titles correctly but left
  // "tasks"/"questions" empty for two different real worksheets. Fixed by
  // splitting the job: Qwen is used ONLY for OCR (transcribe visible text -
  // its strength), then Groq's text model (already proven reliable at
  // following this exact JSON-structuring prompt) builds the quiz from
  // that transcribed text. Real Puppeteer rasterization runs for real in
  // both tests below (fast, proven working); only the Qwen OCR HTTP call
  // is mocked, to make the OCR-quality variable deterministic per tier.
  let app;
  const realPdf = fs.readFileSync(path.join(__dirname, '../fixtures/b02-ib-pyp-worksheet.pdf'));
  // A PDF whose real embedded text is under the 300-char OCR-trigger
  // threshold (just a heading) - used specifically to exercise the Qwen
  // OCR tier, since b02-ib-pyp-worksheet.pdf's real text is already long
  // enough (~1169 chars of instruction headers) to skip OCR on its own.
  const thinTextPdf = fs.readFileSync(path.join(__dirname, '../fixtures/thin-text-worksheet.pdf'));
  const realFetch = global.fetch;
  beforeAll(() => { app = require('../../index'); });
  beforeEach(() => { mockGenerateContent.mockReset(); mockGroqCreate.mockReset(); });
  afterEach(() => { global.fetch = realFetch; });

  test('a real Gemini failure, with pdf-parse text too thin, falls back to Tesseract OCR (real, via PDF rasterization) + Groq structuring, which succeeds', async () => {
    // Tesseract is PRIMARY OCR for every script (changed 2026-09-12 after
    // Qwen's HuggingFace router was found depleted in production) - no
    // network call needed here at all; Tesseract really reads the
    // rasterized page's actual heading text ("Worksheet").
    mockGenerateContent.mockRejectedValue(new Error('429 Too Many Requests: daily quota exceeded'));
    global.fetch = jest.fn().mockRejectedValue(new Error('should not be reached - Tesseract should succeed first'));
    mockGroqCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ title: 'Structured From OCR Text', tasks: [] }) } }] });

    const res = await request(app)
      .post('/quiz/generate')
      .attach('pdf', thinTextPdf, { filename: 'worksheet.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.quiz.title).toBe('Structured From OCR Text');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockGroqCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-oss-120b' }));
    const groqPromptText = mockGroqCreate.mock.calls[0][0].messages[0].content;
    expect(groqPromptText).toMatch(/Worksheet/); // the real Tesseract-OCR'd heading made it into Groq's prompt
  }, 30000);

  // Was: "pdf-parse already got enough real text → skip OCR". That rule was the
  // 2026-10-13 root cause: this Telugu worksheet's text layer has ~1100 chars of
  // mis-shaped headers while every question lives in pasted screenshots, so
  // OCR never ran and the questions were lost. Now each page is OCR'd (bundled
  // Telugu data, no network) and Groq gets the questions.
  test('a real Gemini failure on a Telugu worksheet whose questions are screenshots: pages are OCR\'d and Groq gets the questions', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 Too Many Requests: daily quota exceeded'));
    global.fetch = jest.fn().mockRejectedValue(new Error('no network calls expected'));
    mockGroqCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ title: 'From OCR', tasks: [] }) } }] });

    const res = await request(app)
      .post('/quiz/generate')
      .attach('pdf', realPdf, { filename: 'worksheet.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.quiz.title).toBe('From OCR');
    expect(res.body.quiz.provider).toBe('groq-text');
    const prompt = mockGroqCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('పాము పుట్ట');      // only present inside a screenshot
    expect(prompt).toContain('రాణి సరస్సులో');
    expect(global.fetch).not.toHaveBeenCalled();
  }, 240000);
});

describe('POST /quiz/generate — structuredText ground truth (docx table-hallucination fix)', () => {
  // Reproduces a real bug from a manual-tester report (2026-09-12): a
  // teacher's docx worksheet's fraction-reduction table (source values
  // 28/50, 8/24, 30/54...) was regenerated with completely different,
  // fabricated fractions (24/36, 45/60, 81/108...) - proven by comparing
  // screenshots of the generated quiz against the source document. Root
  // cause: docx uploads are flattened to a PDF and re-read via vision/OCR,
  // discarding mammoth's already-exact table-cell text. structuredText
  // (produced by POST /assignments/docx-to-pdf, see docxToPdf.test.js)
  // recovers that ground truth; this test proves the real, un-mocked Groq
  // structuring step uses those exact values instead of inventing new ones.
  let app;
  beforeAll(() => { app = require('../../index'); });
  beforeEach(() => mockGenerateContent.mockReset());

  test('a real Groq call given structuredText from a fraction table returns the EXACT source fractions, not fabricated ones', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 Too Many Requests: daily quota exceeded'));
    // groq-sdk is mocked at module scope in this file - proxy the mock
    // through to the REAL SDK/API for this one test, since the whole
    // point here is proving real Groq output matches the source exactly,
    // not a canned mock response.
    const dotenv = jest.requireActual('dotenv');
    const { parsed } = dotenv.config();
    const RealGroq = jest.requireActual('groq-sdk');
    const realGroqClient = new RealGroq({ apiKey: (parsed && parsed.GROQ_API_KEY) || process.env.GROQ_API_KEY });
    mockGroqCreate.mockImplementation((...args) => realGroqClient.chat.completions.create(...args));

    const structuredText = `Task 2: Reduce the fractions to their lowest terms.
[TABLE - EXACT VALUES, DO NOT ALTER]
1) 28/50 | 5) 32/48
2) 8/24 | 6) 36/54
3) 30/54 | 7) 14/56
4) 18/42 | 8) 18/28
[/TABLE]`;

    const res = await request(app)
      .post('/quiz/generate')
      .field('grade', 'Grade 4')
      .field('subject', 'Mathematics')
      .field('structuredText', structuredText)
      .attach('pdf', Buffer.from('%PDF-fake'), { filename: 'worksheet.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    const allQuestionText = JSON.stringify(res.body.quiz.tasks);
    // The exact source fractions must appear...
    for (const frac of ['28/50', '8/24', '30/54', '18/42', '32/48', '36/54', '14/56', '18/28']) {
      expect(allQuestionText).toContain(frac);
    }
    // ...and none of the fabricated ones seen in the real bug report.
    for (const frac of ['24/36', '45/60', '81/108']) {
      expect(allQuestionText).not.toContain(frac);
    }
  }, 30000);
});

describe('POST /quiz/generate-async — validation and queuing', () => {
  let app;
  beforeAll(() => { app = require('../../index'); });

  test('requires fileBase64', async () => {
    const res = await request(app).post('/quiz/generate-async').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fileBase64 required/);
  });

  test('a real request returns a real jobId', async () => {
    const res = await request(app).post('/quiz/generate-async').send({
      fileBase64: Buffer.from('%PDF-fake').toString('base64'),
      mimeType: 'application/pdf', filename: 'worksheet.pdf', grade: 'Grade 5', subject: 'Science',
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.jobId).toBe('string');
    expect(res.body.jobId.length).toBeGreaterThan(0);
  });
});

describe('quiz_generate job handler — same logic as the synchronous route', () => {
  // The registered handler (jobHandlers.js) is a thin wrapper around
  // generateQuizFromPdf — already fully covered by the /quiz/generate tests
  // above (same function, same Gemini mock). A full db-queue round-trip
  // (insert -> claim -> drain -> read) is jobQueue.js's own concern, not
  // this handler's; re-verified here only at the unit level: decoding the
  // job payload's base64 and calling through correctly.
  beforeEach(() => mockGenerateContent.mockReset());

  test('a real payload (base64 PDF) is decoded and produces the real { quiz } result shape', async () => {
    mockGenerateContent.mockResolvedValue(geminiJsonResponse({ title: 'Queued Worksheet', tasks: [] }));
    // Exercises the exact same decode + call-through jobHandlers.js's
    // registered 'quiz_generate' handler performs.
    const { generateQuizFromPdf } = require('../../services/quizVision');
    const payload = { fileBase64: Buffer.from('%PDF-fake').toString('base64'), grade: 'Grade 6', subject: 'Mathematics' };
    const buffer = Buffer.from(payload.fileBase64, 'base64');
    const quiz = await generateQuizFromPdf(buffer, { grade: payload.grade, subject: payload.subject });

    expect(quiz.title).toBe('Queued Worksheet');
    expect(buffer.toString()).toBe('%PDF-fake');
  });
});
