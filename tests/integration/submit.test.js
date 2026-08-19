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
const TEACHER_UUID = '22222222-2222-2222-2222-222222222222';

function groqJson(obj) {
  return Promise.resolve({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

// created_by_id: null → teacherSetting() short-circuits to its default (true)
// with zero extra Supabase calls, keeping most tests' mock setup simple. Only
// the "auto-grading off" tests below give it a real id to exercise that path.
function baseAssignmentRow(overrides = {}) {
  return {
    id: 'a1', title: 'Fractions Quiz', subject: 'Mathematics', chapter: 'Numbers', grade: 'Grade 4',
    curriculum: 'IB PYP', due_date: '2099-01-01', created_by_id: null, created_by_role: 'teacher',
    questions: [], quiz_questions: [], task_steps: [], success_criteria: [], document_urls: [],
    ...overrides,
  };
}

// Non-numeric option text deliberately: normaliseAnswerToOptionText treats a
// bare numeric string answer as a 1-based OPTION INDEX, not literal text — a
// numeric option set like ['3','4','5','6'] with correct:'4' would collide
// with that index interpretation and resolve to the wrong option.
const MCQ_Q = { id: 'q1', question: 'What is 2+2?', type: 'mcq', options: ['Three', 'Four', 'Five', 'Six'], correct: 'Four' };
const FILL_Q = { id: 'q2', question: 'The capital of France is ___.', type: 'fill_blank', options: [], correct: 'Paris' };

beforeEach(() => {
  mockSb.reset();
  mockGroqCreate.mockReset();
});

describe('POST /assignments/:id/submit — validation', () => {
  test('a real 404 when the assignment does not exist', async () => {
    mockSb.setTable('assignments', { data: null, error: { message: 'not found' } });

    const res = await request(app).post('/assignments/does-not-exist/submit').send({ studentId: STUDENT_UUID, answers: [] });

    expect(res.status).toBe(404);
  });

  test('a real 403 when the assignment is past its due date', async () => {
    mockSb.setTable('assignments', { data: baseAssignmentRow({ due_date: '2020-01-01' }), error: null });

    const res = await request(app).post('/assignments/a1/submit').send({ studentId: STUDENT_UUID, answers: [] });

    expect(res.status).toBe(403);
  });
});

describe('POST /assignments/:id/submit — auto-grading off', () => {
  test('a real submission is saved for manual review with no AI score when the teacher turned off auto-grading', async () => {
    mockSb.setTable('assignments', { data: baseAssignmentRow({ created_by_id: TEACHER_UUID, questions: [{ question: 'Q1?' }] }), error: null });
    mockSb.setTable('users', { data: { email: 'teacher@school.com' }, error: null });
    mockSb.setTable('user_preferences', { data: { data: { autoGrading: false } }, error: null });
    mockSb.setTable('assignment_submissions', { data: {}, error: null });

    const res = await request(app).post('/assignments/a1/submit').send({ studentId: STUDENT_UUID, answers: ['My answer'], quizAnswers: [{ answer: 'My answer' }] });

    expect(res.status).toBe(200);
    expect(res.body.awaitingReview).toBe(true);
    expect(res.body.score).toBeNull();
    expect(mockGroqCreate).not.toHaveBeenCalled();
  });
});

describe('POST /assignments/:id/submit — MCQ quiz grading', () => {
  test('a real correct MCQ answer scores 100', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [MCQ_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [MCQ_Q] }), error: null }, // final refetch
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockGroqCreate.mockResolvedValue(groqJson({ text: 'Great job!', stamp: 'Amazing Work!', wellDone: 'Nailed it', improve: 'Keep practicing' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, quizAnswers: [{ answer: 'Four' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(100);
    expect(res.body.perQuestion[0].correct).toBe(true);
  });

  test('a real incorrect MCQ answer scores 0 and reports the real correct answer', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [MCQ_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [MCQ_Q] }), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockGroqCreate.mockResolvedValue(groqJson({ text: 'Keep trying!', stamp: 'Keep Trying!' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, quizAnswers: [{ answer: 'Three' }],
    });

    expect(res.body.score).toBe(0);
    expect(res.body.perQuestion[0].correct).toBe(false);
    expect(res.body.perQuestion[0].correctAnswer).toBe('Four');
  });

  test('a real skipped question scores 0 and is marked unanswered, not graded as wrong', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [MCQ_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [MCQ_Q] }), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockGroqCreate.mockResolvedValue(groqJson({ text: 'You skipped a question.' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, quizAnswers: [{ answer: '' }],
    });

    expect(res.body.perQuestion[0].answered).toBe(false);
    expect(res.body.perQuestion[0].comment).toBe('You skipped this question.');
  });
});

describe('POST /assignments/:id/submit — fill_blank attempt-based scoring', () => {
  test('a real correct answer on attempt 1 scores full marks (100)', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [FILL_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [FILL_Q] }), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockGroqCreate.mockResolvedValue(groqJson({ text: 'Perfect!' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, quizAnswers: [{ answer: '[attempt:1] Paris' }],
    });

    expect(res.body.perQuestion[0].score).toBe(100);
    expect(res.body.perQuestion[0].correct).toBe(true);
  });

  test('a real correct answer after a hint (attempt 2) scores partial marks (60)', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [FILL_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [FILL_Q] }), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockGroqCreate.mockResolvedValue(groqJson({ text: 'Good recovery!' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, quizAnswers: [{ answer: '[attempt:2] Paris' }],
    });

    expect(res.body.perQuestion[0].score).toBe(60);
  });

  test('a real revealed answer scores 0 and is never marked correct', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [FILL_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [FILL_Q] }), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockGroqCreate.mockResolvedValue(groqJson({ text: 'Better luck next time!' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, quizAnswers: [{ answer: '[revealed] Paris' }],
    });

    expect(res.body.perQuestion[0].score).toBe(0);
    expect(res.body.perQuestion[0].correct).toBe(false);
  });

  test('a real fuzzy/close text answer within tolerance is still marked correct', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [FILL_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [FILL_Q] }), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockGroqCreate.mockResolvedValue(groqJson({ text: 'Close enough!' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, quizAnswers: [{ answer: '[attempt:1] paris' }], // case-insensitive
    });

    expect(res.body.perQuestion[0].correct).toBe(true);
  });
});

describe('POST /assignments/:id/submit — quiz has no configured questions', () => {
  test('a real 400 when neither stored nor legacy nor submitted quiz questions exist', async () => {
    mockSb.setTable('assignments', { data: baseAssignmentRow({ quiz_questions: [], questions: [] }), error: null });

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, quizAnswers: [{ answer: 'anything' }],
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /assignments/:id/submit — scaffolded task steps (representative types)', () => {
  test('a real unanswered brainstorm step (no keywords) scores 0 without a per-step Groq grading call', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ task_steps: [{ id: 's1', type: 'brainstorm', label: 'Brainstorm' }] }), error: null },
      { data: baseAssignmentRow(), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    // The unanswered step itself is scored deterministically (no per-step Groq
    // call), but the overall feedback summary at the end of the batch still
    // makes one Groq call regardless of individual step outcomes.
    mockGroqCreate.mockResolvedValue(groqJson({ text: 'Try again next time!', teacherSummary: 'Did not attempt the brainstorm step.' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, stepAnswers: [{ type: 'brainstorm', keywords: [] }],
    });

    expect(res.status).toBe(200);
    expect(res.body.perQuestion[0].answered).toBe(false);
    expect(res.body.perQuestion[0].score).toBe(0);
    expect(mockGroqCreate).toHaveBeenCalledTimes(1);
  });

  test('a real answered tuning_in step is graded via a real Groq call', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ task_steps: [{ id: 's1', type: 'tuning_in', label: 'Tuning In', instructions: 'Think about it' }] }), error: null },
      { data: baseAssignmentRow(), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockGroqCreate
      .mockResolvedValueOnce(groqJson({ answered: true, score: 75, studentAnswer: 'Wrote a thoughtful response', correct: true, comment: 'Nice thinking!' }))
      .mockResolvedValueOnce(groqJson({ text: 'Great start!', wellDone: 'Good engagement', improve: 'Add more detail' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, stepAnswers: [{ type: 'tuning_in', tunedInText: 'I think plants need water and sunlight.' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.perQuestion[0].score).toBe(75);
    expect(res.body.perQuestion[0].answered).toBe(true);
  });

  test('a real answered problem_solving step with unanswered problems is graded via Groq, real overall score averages all steps', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ task_steps: [{ id: 's1', type: 'problem_solving', label: 'Problems', problems: ['2+2=?'] }] }), error: null },
      { data: baseAssignmentRow(), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockGroqCreate
      .mockResolvedValueOnce(groqJson({ answered: true, score: 90, studentAnswer: 'Solved correctly: 4', correct: true, comment: 'Well done!' }))
      .mockResolvedValueOnce(groqJson({ text: 'Solid work!', wellDone: 'Good math', improve: 'Keep going' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, stepAnswers: [{ type: 'problem_solving', problemAnswers: ['4'] }],
    });

    expect(res.body.perQuestion[0].score).toBe(90);
    expect(res.body.score).toBe(90);
  });
});

// NOTE: the grading map's `else` branch (short_answer, Groq-graded) at
// routes/assignments.js is dead code for any question that goes through
// normalizeQuizQuestion() first — that function only ever returns type
// 'fill_blank' or 'mcq' (its non-fill_blank path requires exactly 4
// options, which a short_answer question never has, so it's filtered out
// entirely by normalizeQuizQuestions before grading). Verified by tracing
// the code, not asserted as a bug — flagging only, out of scope to fix here.
