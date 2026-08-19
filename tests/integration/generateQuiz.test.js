jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/embeddings', () => ({ embed: jest.fn().mockResolvedValue([]) }));
jest.mock('../../services/qdrant', () => ({ searchGrounding: jest.fn().mockResolvedValue({ chunks: [], source: null }) }));

const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));

const request = require('supertest');
const app = require('../../index');

function groqJson(obj) {
  return Promise.resolve({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

beforeEach(() => {
  mockGroqCreate.mockReset();
});

describe('POST /assignments/generate-quiz — validation', () => {
  test('requires a real subject or chapter', async () => {
    const res = await request(app).post('/assignments/generate-quiz').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /assignments/generate-quiz — success', () => {
  test('returns real generated MCQ questions from a real successful Groq response', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({
      questions: [{ id: 'q1', question: 'What is 2+2?', type: 'mcq', options: ['A. 3', 'B. 4', 'C. 5', 'D. 6'], correct: 'B' }],
    }));

    const res = await request(app).post('/assignments/generate-quiz').send({ subject: 'Mathematics', chapter: 'Addition', count: 1 });

    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(1);
    expect(res.body.questions[0].type).toBe('mcq');
  });

  test('converts real generated questions to fill_blank when quizType is fill_blank', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({
      questions: [{ id: 'q1', question: 'What is 2+2?', type: 'mcq', options: ['A. 3', 'B. 4', 'C. 5', 'D. 6'], correct: 'B' }],
    }));

    const res = await request(app).post('/assignments/generate-quiz').send({ subject: 'Mathematics', chapter: 'Addition', count: 1, quizType: 'fill_blank' });

    expect(res.body.questions[0].type).toBe('fill_blank');
  });
});

describe('POST /assignments/generate-quiz — Groq failure falls back to the real local question bank', () => {
  test('a real Groq exception on both models returns the real fallback quiz, not an error', async () => {
    mockGroqCreate.mockRejectedValue(new Error('Groq is down'));

    const res = await request(app).post('/assignments/generate-quiz').send({ subject: 'Mathematics', chapter: 'Fractions', count: 3 });

    expect(res.status).toBe(200);
    expect(res.body.fallback).toBe(true);
    expect(res.body.questions).toHaveLength(3);
  });

  test('a real malformed (non-JSON) Groq response falls back to the real question bank too', async () => {
    mockGroqCreate.mockResolvedValue(Promise.resolve({ choices: [{ message: { content: 'not valid json' } }] }));

    const res = await request(app).post('/assignments/generate-quiz').send({ subject: 'Mathematics', chapter: 'General', count: 2 });

    expect(res.status).toBe(200);
    expect(res.body.fallback).toBe(true);
  });
});
