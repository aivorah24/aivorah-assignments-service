// POST /assignments/generate-ibpyp - the teacher-facing "Generate CBSE/IB PYP
// Assignment" flow. Migrated off the monolith (ai-mentor/server) here after
// the monolith's copy 404'd with model_not_found (llama-3.3-70b-versatile
// decommissioned by Groq) and the frontend was still calling SERVER_URL
// (the monolith) instead of this already-existing microservice, per the
// standing rule: anything still on the monolith moves to its refactored
// microservice equivalent.

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

describe('POST /assignments/generate-ibpyp — validation', () => {
  test('requires a non-empty topic', async () => {
    const res = await request(app).post('/assignments/generate-ibpyp').send({ subject: 'Mathematics', grade: 'Grade 4' });
    expect(res.status).toBe(400);
  });
});

describe('POST /assignments/generate-ibpyp — success', () => {
  test('returns a real generated assignment with purpose, learningOutcomes and taskSteps', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({
      purpose: 'Understand fractions as parts of a whole.',
      learningOutcomes: ['Identify fractions', 'Compare fractions'],
      taskSteps: [
        { type: 'tuning_in', label: 'Pizza Sharing', instructions: 'Think about sharing.', provocation: 'You share a pizza with 3 friends.' },
        { type: 'problem_solving', label: 'Fraction Challenges', instructions: 'Solve the problems.', problems: ['1/2 + 1/4 = ?'] },
        { type: 'research_notes', label: 'Fractions Around Us', instructions: 'Find fractions at home.', sections: ['Where I Found Them', 'What They Mean'] },
        { type: 'math_reflection', label: 'Reflect', instructions: 'Reflect on your strategy.', reflectionPrompts: ['What was tricky?'] },
      ],
      wordBank: ['fraction', 'numerator', 'denominator'],
    }));

    const res = await request(app).post('/assignments/generate-ibpyp').send({
      topic: 'Fractions', subject: 'Mathematics', grade: 'Grade 4', curriculum: 'IB PYP',
    });

    expect(res.status).toBe(200);
    expect(res.body.purpose).toBeTruthy();
    expect(Array.isArray(res.body.learningOutcomes)).toBe(true);
    expect(Array.isArray(res.body.taskSteps)).toBe(true);
    // The AI decides how many steps and which kinds — kept as sent
    expect(res.body.taskSteps.map(t => t.type)).toEqual(['tuning_in', 'problem_solving', 'research_notes', 'math_reflection']);
    expect(mockGroqCreate.mock.calls[0][0].messages[0].content).not.toMatch(/Step types MUST be exactly/);
  });

  test('never sends the decommissioned model name to Groq', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({
      purpose: 'p', learningOutcomes: [],
      taskSteps: [{ label: 'a', instructions: 'a' }, { label: 'b', instructions: 'b' }, { label: 'c', instructions: 'c' }],
      wordBank: [],
    }));

    await request(app).post('/assignments/generate-ibpyp').send({
      topic: 'Plants', subject: 'Science', grade: 'Grade 3', curriculum: 'CBSE',
    });

    expect(mockGroqCreate).toHaveBeenCalled();
    const modelUsed = mockGroqCreate.mock.calls[0][0].model;
    expect(modelUsed).not.toBe('llama-3.3-70b-versatile');
  });
});
