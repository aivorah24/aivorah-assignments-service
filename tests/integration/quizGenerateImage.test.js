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

  test('a real daily-quota-exhausted error fails fast (no retry) and surfaces as a 500 with its message', async () => {
    // geminiRetry's fast-fail path (real behavior ported from the monolith,
    // not mocked away): a 429 mentioning "daily" quota can't recover within
    // a retry window, so it skips the exponential-backoff retries entirely.
    // A generic 429 (e.g. real-world "prepayment credits depleted", which
    // doesn't mention "daily") instead retries for real elapsed minutes -
    // exercised here via the fast path so this test stays fast and
    // deterministic; the retry behavior itself lives in geminiRetry, not
    // re-tested per caller.
    mockGenerateContent.mockRejectedValue(new Error('429 Too Many Requests: daily quota exceeded'));
    const res = await request(app)
      .post('/quiz/generate-image')
      .attach('image', Buffer.from('fake-png-bytes'), { filename: 'worksheet.png', contentType: 'image/png' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/daily quota/);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1); // fast-fail, no retries
  });

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
