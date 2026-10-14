// GET /quiz/providers and POST /quiz/grade-answer.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const mockGemini = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({ getGenerativeModel: () => ({ generateContent: (...a) => mockGemini(...a) }) })),
}));
const mockGroq = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: (...a) => mockGroq(...a) } } })));

const request = require('supertest');
const app = require('../../index');
const groqReply = obj => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(obj) } }] });
const realFetch = global.fetch;

beforeEach(() => { mockGemini.mockReset(); mockGroq.mockReset(); });
afterEach(() => { global.fetch = realFetch; delete process.env.MISTRAL_API_KEY; });

describe('GET /quiz/providers', () => {
  test('reports a dead Gemini key and a working Mistral as "vision available", with the reason', async () => {
    process.env.GEMINI_API_KEY = 'test';
    process.env.GROQ_API_KEY = 'test';
    process.env.MISTRAL_API_KEY = 'test';
    mockGemini.mockRejectedValue(new Error('429 Too Many Requests: GenerateRequestsPerDay quota exceeded'));
    mockGroq.mockResolvedValue(groqReply({ ok: true }));
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}), text: async () => '' }));

    const res = await request(app).get('/quiz/providers?refresh=1');
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.providers.map(p => [p.provider, p]));
    expect(by.gemini.status).toBe('QUOTA_EXHAUSTED');
    expect(by.gemini.detail).toMatch(/PerDay/);
    expect(by.mistral.status).toBe('OK');
    expect(by.groq.status).toBe('OK');
    expect(res.body.visionAvailable).toBe(true);
  });

  test('no working vision provider is called out plainly', async () => {
    process.env.GEMINI_API_KEY = 'test';
    mockGemini.mockRejectedValue(new Error('403 API key not valid'));
    mockGroq.mockResolvedValue(groqReply({ ok: true }));
    const res = await request(app).get('/quiz/providers?refresh=1');
    expect(res.body.visionAvailable).toBe(false);
    expect(res.body.summary).toMatch(/No vision provider is working/);
    expect(res.body.providers.find(p => p.provider === 'mistral').status).toBe('DISABLED');
  });
});

describe('POST /quiz/grade-answer', () => {
  const grade = body => request(app).post('/quiz/grade-answer').send(body);

  test('a Tamil answer to a Telugu question is incorrect without asking the model', async () => {
    const res = await grade({ expected: 'తామర పూలు', student: 'வணக்கம்', worksheetScript: 'Telugu' });
    expect(res.body.verdict).toBe('incorrect');
    expect(res.body.reason).toMatch(/Telugu/);
    expect(mockGroq).not.toHaveBeenCalled();
  });

  test('an exact answer (any accepted wording, punctuation ignored) is correct without the model', async () => {
    const res = await grade({ expected: 'తామర పూలు', acceptableAnswers: ['తామర పువ్వులు'], student: 'తామర పువ్వులు.' });
    expect(res.body.verdict).toBe('correct');
    expect(mockGroq).not.toHaveBeenCalled();
  });

  test('otherwise the model judges meaning, told the expected script', async () => {
    mockGroq.mockResolvedValue(groqReply({ verdict: 'partial', reason: 'సరస్సు సరైనదే' }));
    const res = await grade({ expected: 'సరస్సు వద్దకు', student: 'సరస్సుకు', question: 'రాణి, తాత ఎక్కడికి వెళ్ళారు?' });
    expect(res.body).toEqual({ verdict: 'partial', reason: 'సరస్సు సరైనదే' });
    const prompt = mockGroq.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Expected answer language/script: Telugu');
    expect(prompt).toContain('Student answer: సరస్సుకు');
  });

  test('grading unavailable → 503 with an incorrect verdict, never a false "correct"', async () => {
    mockGroq.mockRejectedValue(new Error('network'));
    const res = await grade({ expected: 'photosynthesis', student: 'plants make food' });
    expect(res.status).toBe(503);
    expect(res.body.verdict).toBe('incorrect');
  });

  test('requires a student answer', async () => {
    expect((await grade({ expected: 'x' })).status).toBe(400);
  });
});

describe('Mistral vision request', () => {
  test('sends the prompt plus each page as an image, JSON mode, and falls through a retired model', async () => {
    process.env.MISTRAL_API_KEY = 'test';
    const { callMistralVision } = require('../../services/worksheet/providers');
    const calls = [];
    global.fetch = jest.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      if (calls.length === 1) return { ok: false, status: 404, text: async () => 'invalid model' };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"tasks":[]}' } }] }) };
    });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
    const raw = await callMistralVision([{ buffer: jpeg, mime: 'image/jpeg' }, { buffer: jpeg, mime: 'image/jpeg' }], 'PROMPT');
    expect(raw).toBe('{"tasks":[]}');
    expect(calls).toHaveLength(2);
    expect(calls[1].model).not.toBe(calls[0].model);
    expect(calls[1].response_format).toEqual({ type: 'json_object' });
    const content = calls[1].messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: 'PROMPT' });
    expect(content.filter(c => c.type === 'image_url')).toHaveLength(2);
  });
});
