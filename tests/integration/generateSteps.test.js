// POST /assignments/generate-steps - the teacher-facing scaffolded
// task-step wizard. Ported from the monolith's ai-mentor/server/routes/
// assignments.js (2026-09-11, B05). Self-contained - a single Groq call,
// same as ai-generate - so this test only needs to mock groq-sdk.

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

describe('POST /assignments/generate-steps — validation', () => {
  test('requires a non-empty topic', async () => {
    const res = await request(app).post('/assignments/generate-steps').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/topic required/);
  });
});

describe('POST /assignments/generate-steps — IB PYP subject-aware step types', () => {
  test('uses the Mathematics step-type triplet and returns all 3 real steps', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({
      tuning_in:        { label: 'Warm-up', instructions: 'Think about fractions.' },
      problem_solving:  { label: 'Solve it', instructions: 'Solve the fraction problem.' },
      math_reflection:  { label: 'Reflect', instructions: 'Explain your thinking.' },
    }));

    const res = await request(app).post('/assignments/generate-steps').send({
      topic: 'Fractions', subject: 'Mathematics', grade: 'Grade 4', curriculum: 'IB PYP',
    });

    expect(res.status).toBe(200);
    expect(res.body.steps.map(s => s.type)).toEqual(['tuning_in', 'problem_solving', 'math_reflection']);
    expect(res.body.steps[0].label).toBe('Warm-up');
  });

  test('non-IB curricula fall back to the generic brainstorm/drawing/structured_writing types', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({
      brainstorm:          { label: 'Brainstorm', instructions: 'List ideas.' },
      drawing:             { label: 'Draw it', instructions: 'Draw a diagram.' },
      structured_writing:  { label: 'Write', instructions: 'Write a paragraph.' },
    }));

    const res = await request(app).post('/assignments/generate-steps').send({
      topic: 'Water cycle', subject: 'Science', grade: 'Grade 4', curriculum: 'CBSE',
    });

    expect(res.status).toBe(200);
    expect(res.body.steps.map(s => s.type)).toEqual(['brainstorm', 'drawing', 'structured_writing']);
  });
});

describe('POST /assignments/generate-steps — real failure handling', () => {
  test('a real Groq exception surfaces as a 500, not a hang', async () => {
    mockGroqCreate.mockRejectedValue(new Error('503 service unavailable'));
    const res = await request(app).post('/assignments/generate-steps').send({ topic: 'Fractions' });
    expect(res.status).toBe(500);
  });

  test('a response missing all expected step keys is rejected rather than returning empty steps', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({ unrelated_key: { label: 'x', instructions: 'y' } }));
    const res = await request(app).post('/assignments/generate-steps').send({ topic: 'Fractions' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/invalid structure/);
  });
});

describe('POST /assignments/generate-steps — partial replies (first tap gave only "Brainstorm")', () => {
  test('leaves the reasoning model room to finish all 3 steps', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({
      brainstorm: { label: 'B', instructions: 'b' }, drawing: { label: 'D', instructions: 'd' }, structured_writing: { label: 'W', instructions: 'w' },
    }));
    await request(app).post('/assignments/generate-steps').send({ topic: 'Plants', curriculum: 'CBSE' });
    expect(mockGroqCreate.mock.calls[0][0].max_tokens).toBeGreaterThanOrEqual(2000);
  });

  test('a reply missing steps is retried once and the missing steps are filled from the retry', async () => {
    mockGroqCreate
      .mockResolvedValueOnce(groqJson({ brainstorm: { label: 'Ideas', instructions: 'List ideas.' } }))
      .mockResolvedValueOnce(groqJson({
        brainstorm: { label: 'Other ideas', instructions: 'x' },
        drawing: { label: 'Draw it', instructions: 'Draw a plant.' },
        structured_writing: { label: 'Write', instructions: 'Write about plants.' },
      }));

    const res = await request(app).post('/assignments/generate-steps').send({ topic: 'Plants', curriculum: 'CBSE' });

    expect(res.status).toBe(200);
    expect(mockGroqCreate).toHaveBeenCalledTimes(2);
    expect(res.body.steps.map(s => s.label)).toEqual(['Ideas', 'Draw it', 'Write']);
  });

  test('a truncated (unparseable) reply is retried instead of failing', async () => {
    mockGroqCreate
      .mockResolvedValueOnce(Promise.resolve({ choices: [{ message: { content: '{"brainstorm": {"label": "Ide' } }] }))
      .mockResolvedValueOnce(groqJson({
        brainstorm: { label: 'B', instructions: 'b' }, drawing: { label: 'D', instructions: 'd' }, structured_writing: { label: 'W', instructions: 'w' },
      }));

    const res = await request(app).post('/assignments/generate-steps').send({ topic: 'Plants', curriculum: 'CBSE' });

    expect(res.status).toBe(200);
    expect(res.body.steps).toHaveLength(3);
  });

  test('a complete first reply is not retried', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({
      brainstorm: { label: 'B', instructions: 'b' }, drawing: { label: 'D', instructions: 'd' }, structured_writing: { label: 'W', instructions: 'w' },
    }));
    await request(app).post('/assignments/generate-steps').send({ topic: 'Plants', curriculum: 'CBSE' });
    expect(mockGroqCreate).toHaveBeenCalledTimes(1);
  });

  test('still-missing steps come back with the expected stepTypes so the app can fill them', async () => {
    mockGroqCreate
      .mockResolvedValueOnce(groqJson({ brainstorm: { label: 'B', instructions: 'b' } }))
      .mockRejectedValueOnce(new Error('503'));

    const res = await request(app).post('/assignments/generate-steps').send({ topic: 'Plants', curriculum: 'CBSE' });

    expect(res.status).toBe(200);
    expect(res.body.steps.map(s => s.type)).toEqual(['brainstorm']);
    expect(res.body.stepTypes).toEqual(['brainstorm', 'drawing', 'structured_writing']);
  });
});
