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

describe('POST /assignments/generate-steps — AI-designed steps', () => {
  test('returns the steps the AI chose (count and kinds), not a fixed template', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({ taskSteps: [
      { type: 'tuning_in', label: 'Pizza share', instructions: 'Read and think.', provocation: 'You share a pizza...' },
      { type: 'problem_solving', label: 'Solve it', instructions: 'Solve.', problems: ['1/2 + 1/4 = ?', '3/4 of 8 = ?'] },
    ] }));
    const res = await request(app).post('/assignments/generate-steps').send({
      topic: 'Fractions', subject: 'Mathematics', grade: 'Grade 4', curriculum: 'CBSE',
    });
    expect(res.status).toBe(200);
    expect(res.body.stepTypes).toEqual(['tuning_in', 'problem_solving']);
    expect(res.body.steps[1].problems).toHaveLength(2);
    const prompt = mockGroqCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toMatch(/Decide the NUMBER of steps/);
    expect(prompt).toMatch(/Use "drawing" only if the learning outcome is genuinely visual/);
  });

  test('language assignments drop any drawing step and pass the target language', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({ taskSteps: [
      { type: 'drawing', label: 'Draw', instructions: 'Draw nature.' },
      { type: 'language_practice', label: 'लिखो', instructions: 'Write sentences.', sections: ['शब्द', 'वाक्य'] },
    ] }));
    const res = await request(app).post('/assignments/generate-steps').send({
      topic: 'प्रकृति', subject: 'Language Acquisition', grade: 'Grade 4', curriculum: 'CBSE', language: 'Hindi',
    });
    expect(res.status).toBe(200);
    expect(res.body.stepTypes).toEqual(['language_practice']);
    expect(mockGroqCreate.mock.calls[0][0].messages[0].content).toMatch(/Target language: Hindi/);
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

describe('POST /assignments/generate-step — one teacher-added step', () => {
  test('writes the step the teacher titled, keeping their title', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({ taskSteps: [{ type: 'drawing', label: 'Air flow diagram',
      instructions: 'Draw a cross-section of an aeroplane wing. Show faster air flow above the wing with longer arrows and slower air below, and label: high pressure, low pressure, lift, air flow.' }] }));
    const res = await request(app).post('/assignments/generate-step').send({
      type: 'drawing', label: 'Draw the air flow and pressure', topic: 'Air pressure', subject: 'Science', grade: 'Grade 8', curriculum: 'CBSE',
    });
    expect(res.status).toBe(200);
    expect(res.body.step.label).toBe('Draw the air flow and pressure');
    expect(res.body.step.instructions).toMatch(/label/i);
    expect(mockGroqCreate.mock.calls[0][0].messages[0].content).toMatch(/Draw the air flow and pressure/);
  });

  test('rejects a step type the subject cannot use', async () => {
    const res = await request(app).post('/assignments/generate-step').send({ type: 'drawing', topic: 'Family', subject: 'Language Acquisition' });
    expect(res.status).toBe(400);
  });
});
