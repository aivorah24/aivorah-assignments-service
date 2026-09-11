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

describe('POST /quiz/generate-image — Qwen fallback when Gemini fails', () => {
  // Live-verified 2026-09-11: with the only available Gemini key depleted,
  // this fallback is what actually produces a real quiz right now. Gemini's
  // own retry/fast-fail behavior (geminiRetry) is covered separately in
  // quizVision's own concerns — these tests are about the fallback wiring:
  // does a Gemini failure of any kind actually hand off to Qwen, and is the
  // combined-failure case still a clean error, not a hang or a crash.
  let app;
  beforeAll(() => { app = require('../../index'); });
  beforeEach(() => mockGenerateContent.mockReset());

  test('a real daily-quota Gemini failure falls back to Qwen, which succeeds', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 Too Many Requests: daily quota exceeded'));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: 'Qwen Read This', tasks: [] }) } }] }),
    });

    const res = await request(app)
      .post('/quiz/generate-image')
      .attach('image', Buffer.from('fake-png-bytes'), { filename: 'worksheet.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.quiz.title).toBe('Qwen Read This');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://router.huggingface.co/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('a real Gemini failure with Qwen ALSO failing (e.g. HF router down) surfaces the Qwen error, not a hang', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 Too Many Requests: daily quota exceeded'));
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'Service Unavailable' });

    const res = await request(app)
      .post('/quiz/generate-image')
      .attach('image', Buffer.from('fake-png-bytes'), { filename: 'worksheet.png', contentType: 'image/png' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/HF router 503/);
  });
});
