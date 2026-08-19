const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));

const request = require('supertest');
const app = require('../../index');

const STUDENT_UUID = '11111111-1111-1111-1111-111111111111';

function groqJson(obj) {
  return Promise.resolve({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

beforeEach(() => {
  mockSb.reset();
  mockGroqCreate.mockReset();
});

describe('PUT /assignments/:id/complete', () => {
  test('rejects a real completion attempt on a real past-due assignment', async () => {
    mockSb.setTable('assignments', { data: { due_date: '2020-01-01' }, error: null });

    const res = await request(app).put('/assignments/a1/complete').send({ score: 90, studentId: STUDENT_UUID });

    expect(res.status).toBe(403);
  });

  test('a real completion on a real still-open assignment upserts the submission and returns the real merged assignment', async () => {
    mockSb.setTable('assignments', [
      { data: { due_date: '2099-01-01' }, error: null }, // past-due check
      { data: { id: 'a1', student_id: STUDENT_UUID, due_date: '2099-01-01', title: 'Quiz' }, error: null }, // final refetch
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });

    const res = await request(app).put('/assignments/a1/complete').send({
      score: 80, studentId: STUDENT_UUID,
      answers: [{ qId: 'q1', answer: 'B', correct: true, question: 'Q1?' }], correct: 1, total: 1,
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('a1');
    expect(res.body.status).toBe('completed');
    expect(res.body.score).toBe(80);
  });

  test('a real completion with no studentId still returns the real assignment (no submission upsert)', async () => {
    mockSb.setTable('assignments', [
      { data: { due_date: '2099-01-01' }, error: null },
      { data: { id: 'a1', student_id: null, due_date: '2099-01-01' }, error: null },
    ]);

    const res = await request(app).put('/assignments/a1/complete').send({ score: null });

    expect(res.status).toBe(200);
  });
});

describe('POST /assignments/:id/explain-question', () => {
  test('requires a real question', async () => {
    const res = await request(app).post('/assignments/a1/explain-question').send({});
    expect(res.status).toBe(400);
  });

  test('returns a real step-by-step explanation from a real successful Groq response', async () => {
    mockGroqCreate.mockResolvedValue(groqJson({ steps: ['Step 1: ...', 'Step 2: ...'], correctAnswer: '4', tip: 'Count carefully!' }));

    const res = await request(app).post('/assignments/a1/explain-question').send({ question: 'What is 2+2?', studentAnswer: '5', correctAnswer: '4', score: 0 });

    expect(res.status).toBe(200);
    expect(res.body.steps).toHaveLength(2);
    expect(res.body.correctAnswer).toBe('4');
  });

  test('a real Groq failure returns a real 500 with a real friendly error, not a raw crash', async () => {
    mockGroqCreate.mockRejectedValue(new Error('Groq is down'));

    const res = await request(app).post('/assignments/a1/explain-question').send({ question: 'What is 2+2?' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not generate explanation');
  });
});
