// POST /quiz/generate-image — Increment 1 of the AI extraction pipeline
// migration (see QUIZ_PIPELINE_MIGRATION.md). This suite covers the route's
// request/response CONTRACT (validation, upstream-error mapping) with the
// real Gemini SDK call mocked — a live call needs a real API key/quota and
// takes 30-90s, unsuitable for the committed CI suite. The real end-to-end
// verification against an actual worksheet image is tracked separately in
// QUIZ_PIPELINE_MIGRATION.md's verification log, run manually against the
// live deployed service.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

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

function geminiJsonResponse(obj) {
  return Promise.resolve({ response: { text: () => JSON.stringify(obj) } });
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('POST /quiz/generate-image — validation', () => {
  let app;
  beforeAll(() => { app = require('../../index'); });
  beforeEach(() => mockGenerateContent.mockReset());

  test('requires an image file', async () => {
    const res = await request(app).post('/quiz/generate-image').field('grade', 'Grade 4');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No image file uploaded/);
  });
});

describe('POST /quiz/generate-image — real generation contract', () => {
  let app;
  beforeAll(() => { app = require('../../index'); });
  beforeEach(() => mockGenerateContent.mockReset());

  test('a real, well-formed Gemini response is returned as { quiz }', async () => {
    mockGenerateContent.mockResolvedValue(geminiJsonResponse({
      title: 'Fractions Worksheet',
      subject: 'Mathematics',
      grade: 'Grade 4',
      tasks: [{
        title: 'Task 1',
        questions: [{ id: 'a', type: 'numeric', question: '1/2 + 1/4 = ?', answer: '3/4', hint: 'common denominator', solution: '2/4 + 1/4 = 3/4', hasImage: false }],
      }],
    }));

    const res = await request(app)
      .post('/quiz/generate-image')
      .field('grade', 'Grade 4')
      .field('subject', 'Mathematics')
      .attach('image', Buffer.from('fake-png-bytes'), { filename: 'worksheet.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.quiz.title).toBe('Fractions Worksheet');
    expect(res.body.quiz.tasks).toHaveLength(1);
    expect(res.body.quiz.tasks[0].questions[0].answer).toBe('3/4');
  });

  test('a real prompt was sent with the requested grade/subject and vision image data', async () => {
    mockGenerateContent.mockResolvedValue(geminiJsonResponse({ title: 'x', tasks: [] }));

    await request(app)
      .post('/quiz/generate-image')
      .field('grade', 'Grade 7')
      .field('subject', 'Science')
      .attach('image', Buffer.from('fake-png-bytes'), { filename: 'worksheet.png', contentType: 'image/png' });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const promptPart = callArgs.find(p => p.text);
    const imagePart = callArgs.find(p => p.inlineData);
    expect(promptPart.text).toContain('Grade 7');
    expect(promptPart.text).toContain('Science');
    expect(imagePart.inlineData.mimeType).toBe('image/png');
    expect(imagePart.inlineData.data).toBe(Buffer.from('fake-png-bytes').toString('base64'));
  });
});

describe('POST /quiz/generate-image — real failure handling', () => {
  let app;
  beforeAll(() => { app = require('../../index'); });
  beforeEach(() => mockGenerateContent.mockReset());

  test('a malformed (non-JSON) Gemini response surfaces as a 500 with the raw text, not a crash', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'not valid json at all' } });
    const res = await request(app)
      .post('/quiz/generate-image')
      .attach('image', Buffer.from('fake-png-bytes'), { filename: 'worksheet.png', contentType: 'image/png' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('AI returned invalid JSON');
    expect(res.body.raw).toBe('not valid json at all');
  });
});

describe('POST /quiz/generate-image — OCR + Groq-structuring fallback when Gemini fails', () => {
  // Was: Qwen did full one-shot structuring on Gemini failure. Found
  // unreliable 2026-09-12 (empty tasks/questions on real worksheets) and
  // unable to handle non-Latin scripts (Qwen hallucinated Telugu text
  // entirely) - replaced with OCR (see callOcrText in quizVision.js) +
  // Groq structuring, same as the PDF fallback. Tesseract became PRIMARY
  // for every script (English included) later the same day, after live
  // testing found Qwen's HuggingFace router itself depleted in
  // production ("monthly included credits" exhausted) - an availability
  // failure on top of the earlier Telugu accuracy problem. A real (if
  // tiny) PNG is required here since the OCR step validates the image is
  // decodable before calling Tesseract at all - a hard-learned
  // requirement: tesseract.js can crash the whole Node process on truly
  // undecodable input (verified live), so garbage bytes are now rejected
  // safely up front rather than reaching Tesseract.
  const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let app;
  const realFetch = global.fetch;
  beforeAll(() => { app = require('../../index'); });
  beforeEach(() => { mockGenerateContent.mockReset(); mockGroqCreate.mockReset(); });
  afterEach(() => { global.fetch = realFetch; });

  test('a real daily-quota Gemini failure falls back to OCR (Tesseract, real - no Qwen/network needed) + Groq structuring, which succeeds', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 Too Many Requests: daily quota exceeded'));
    global.fetch = jest.fn().mockRejectedValue(new Error('should not be reached - Tesseract should succeed first'));
    mockGroqCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ title: 'Structured From OCR Text', tasks: [] }) } }] });

    const res = await request(app)
      .post('/quiz/generate-image')
      .attach('image', TINY_PNG, { filename: 'worksheet.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.quiz.title).toBe('Structured From OCR Text');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockGroqCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-oss-120b' }));
  }, 30000);

  test('when Tesseract itself fails on a given image, falls back to Qwen for OCR, then Groq structuring', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 Too Many Requests: daily quota exceeded'));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Task 1: Solve.\na) 2 + 2 = ___' } }] }),
    });
    mockGroqCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ title: 'Structured From Qwen Fallback', tasks: [] }) } }] });

    // A garbage (non-decodable) buffer makes Tesseract throw via the
    // format guard, exercising the fallback-to-Qwen path.
    const res = await request(app)
      .post('/quiz/generate-image')
      .attach('image', Buffer.from('not a real image at all'), { filename: 'worksheet.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.quiz.title).toBe('Structured From Qwen Fallback');
    expect(global.fetch).toHaveBeenCalledWith('https://router.huggingface.co/v1/chat/completions', expect.objectContaining({ method: 'POST' }));
  }, 30000);

  test('when BOTH Tesseract and Qwen fail, surfaces a clean error, not a hang or a crash', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 Too Many Requests: daily quota exceeded'));
    global.fetch = jest.fn().mockRejectedValue(new Error('HF router down'));

    const res = await request(app)
      .post('/quiz/generate-image')
      .attach('image', Buffer.from('not a real image at all'), { filename: 'worksheet.png', contentType: 'image/png' });

    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe('string');
  }, 30000);
});
