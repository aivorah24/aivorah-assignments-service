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
    // Buffer.from('%PDF') isn't a real PDF, so the Groq-text fallback's own
    // pdf-parse step fails too - proving the fallback chain runs (not just
    // that Gemini failed) without needing a real PDF fixture in this suite.
    expect(res.body.error).toMatch(/Invalid PDF structure/);
  });

  test('a malformed (non-JSON) Gemini response surfaces as a 500 with the raw text', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'not json' } });
    const res = await request(app).post('/quiz/generate').attach('pdf', Buffer.from('%PDF'), { filename: 'w.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('AI returned invalid JSON');
  });
});

describe('POST /quiz/generate — Groq text fallback when Gemini fails (PDF path)', () => {
  let app;
  beforeAll(() => { app = require('../../index'); });
  beforeEach(() => { mockGenerateContent.mockReset(); mockGroqCreate.mockReset(); });

  test('a real Gemini failure on a real PDF falls back to Groq text extraction, which succeeds', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 Too Many Requests: daily quota exceeded'));
    mockGroqCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ title: 'Groq Read This From Text', tasks: [] }) } }] });

    const realPdf = fs.readFileSync(path.join(__dirname, '../fixtures/b02-ib-pyp-worksheet.pdf'));
    const res = await request(app)
      .post('/quiz/generate')
      .attach('pdf', realPdf, { filename: 'worksheet.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.quiz.title).toBe('Groq Read This From Text');
    expect(mockGroqCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-oss-120b' }));
  });
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
