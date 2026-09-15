// POST /assignments/ai-generate - the parent-facing "describe what your
// child needs to practice" flow. Ported from the monolith's
// ai-mentor/server/routes/assignments.js as part of assignments-service
// owning the Assignment domain. Unlike /generate-quiz, this route makes no
// Qdrant/embeddings call - it's a single system-prompt-driven Groq call -
// so this test only needs to mock groq-sdk.

const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const request = require('supertest');
const app = require('../../index');

function groqJson(obj) {
  return Promise.resolve({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

beforeEach(() => {
  mockGroqCreate.mockReset();
});

describe('POST /assignments/ai-generate — validation', () => {
  test('requires a non-empty prompt', async () => {
    const res = await request(app).post('/assignments/ai-generate').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /assignments/ai-generate — quiz generation (default)', () => {
  test('normalizes real generated MCQ questions into quizQuestions + questions', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({
      title: 'Multiplication Practice',
      chapter: 'Multiplication',
      type: 'quiz',
      note: 'You can do this!',
      questions: [
        { question: 'What is 3 x 4?', options: ['10', '12', '7', '16'], correct: '12' },
      ],
    }));

    const res = await request(app).post('/assignments/ai-generate').send({
      prompt: 'Give 3 multiplication word problems for Grade 4.',
      subject: 'Mathematics', grade: 'Grade 4', curriculum: 'IB PYP', count: 3, type: 'quiz',
    });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('quiz');
    expect(res.body.title).toBe('Multiplication Practice');
    expect(res.body.quizQuestions).toHaveLength(1);
    expect(res.body.quizQuestions[0].question).toBe('What is 3 x 4?');
    expect(res.body.questions).toEqual(['What is 3 x 4?']);
  });

  test('the real model call uses the current, non-decommissioned Groq model', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({ type: 'quiz', questions: [] }));

    await request(app).post('/assignments/ai-generate').send({ prompt: 'anything', type: 'quiz' });

    expect(mockGroqCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-oss-120b' }));
  });

  // Regression: this call was the one place in the file NOT using Groq's JSON
  // mode (every other AI-generation call site does), relying instead on a
  // fragile manual fence-strip that breaks the moment the model adds any
  // preamble text - real, intermittent "AI returned invalid JSON" failures.
  test('the real model call requests JSON mode, matching every other AI-generation call site in this service', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({ type: 'quiz', questions: [] }));

    await request(app).post('/assignments/ai-generate').send({ prompt: 'anything', type: 'quiz' });

    expect(mockGroqCreate).toHaveBeenCalledWith(expect.objectContaining({
      response_format: { type: 'json_object' },
    }));
  });
});

describe('POST /assignments/ai-generate — plain assignment (type: assignment)', () => {
  test('returns plain-text questions, no quizQuestions', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({
      title: 'Plant Observation',
      chapter: 'Plants',
      type: 'assignment',
      note: 'Have fun outside!',
      questions: ['Write one observation about plants.'],
    }));

    const res = await request(app).post('/assignments/ai-generate').send({
      prompt: 'One question about observing plants.',
      subject: 'Science', grade: 'Grade 3', curriculum: 'IB PYP', count: 1, type: 'assignment',
    });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('assignment');
    expect(res.body.questions).toEqual(['Write one observation about plants.']);
    expect(res.body.quizQuestions).toEqual([]);
  });
});

describe('POST /assignments/ai-generate — real failure handling', () => {
  test('a real Groq exception (e.g. decommissioned/invalid model) surfaces as a 500, not a hang', async () => {
    mockGroqCreate.mockRejectedValue(new Error('404 model_not_found'));

    const res = await request(app).post('/assignments/ai-generate').send({ prompt: 'anything' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Groq AI generation failed');
  });

  test('malformed (non-JSON) model output surfaces as a 500 with the raw text, not a crash', async () => {
    mockGroqCreate.mockResolvedValue(Promise.resolve({ choices: [{ message: { content: 'not json at all' } }] }));

    const res = await request(app).post('/assignments/ai-generate').send({ prompt: 'anything' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('AI returned invalid JSON');
  });
});
