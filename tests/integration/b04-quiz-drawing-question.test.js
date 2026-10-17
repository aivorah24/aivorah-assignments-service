// B04 Phase 2 — drawing/photo QUESTIONS inside a quiz-type assignment
// (Upload Worksheet -> Interactive Quiz path, QuizModal.tsx), the REAL live
// endpoint POST /assignments/:id/submit, quizAnswers branch. Reuses the
// exact same shared helpers (uploadSubmissionEvidence, gradeVisionSubmission)
// as the scaffolded stepAnswers drawing/photo branch (see
// b04-drawing-evidence.test.js) — not a second grading implementation.
//
// Covers the three confirmed gaps for this path:
// 1. normalizeQuizQuestion() previously dropped type:'drawing'/'photo'
//    questions entirely (fell into the generic MCQ branch, which requires
//    4 options) - same dead-code trap B03 found for short_answer.
// 2. The skip-check only looked at text (studentAns) - a real image-only
//    answer with no text was always marked "skipped".
// 3. Existing MCQ/fill_blank/short_answer behavior must be completely
//    unaffected by adding the new branch.
const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));

// Image grading goes to Gemini; route it through the same mock queue so call order is unchanged.
process.env.GEMINI_API_KEY = 'test-key';
const mockGeminiGenerate = jest.fn(async (parts) => {
  const r = await mockGroqCreate({ gemini: true, parts });
  return { response: { text: () => r.choices[0].message.content } };
});
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: (...args) => mockGeminiGenerate(...args) }),
  })),
}));

const mockCloudinaryUpload = jest.fn();
jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(), uploader: { upload: (...args) => mockCloudinaryUpload(...args) } },
}));

const request = require('supertest');
const app = require('../../index');
const { normalizeQuizQuestion } = require('../../routes/assignments');

const STUDENT_UUID = '11111111-1111-1111-1111-111111111111';

function groqJson(obj) {
  return Promise.resolve({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

function baseAssignmentRow(overrides = {}) {
  return {
    id: 'a1', title: 'Draw Your Farm', subject: 'Visual Arts', chapter: '', grade: 'Grade 3',
    curriculum: 'IB PYP', due_date: '2099-01-01', created_by_id: null, created_by_role: 'teacher',
    questions: [], quiz_questions: [], task_steps: [], success_criteria: [], document_urls: [],
    ...overrides,
  };
}

const DRAWING_Q = { id: 'q1', question: 'Draw your farm and label three things on it.', type: 'drawing', options: [], correct: '' };
const MCQ_Q = { id: 'q2', question: 'What is 2+2?', type: 'mcq', options: ['Three', 'Four', 'Five', 'Six'], correct: 'Four' };
const FILL_Q = { id: 'q3', question: 'The capital of France is ___.', type: 'fill_blank', options: [], correct: 'Paris' };

beforeEach(() => {
  mockSb.reset();
  mockGroqCreate.mockReset();
  mockCloudinaryUpload.mockReset();
});

describe('normalizeQuizQuestion() — drawing/photo pass-through', () => {
  test('THE ORIGINAL GAP: a drawing question used to be silently dropped (no 4 options -> null)', () => {
    // Documents the gap directly against the exported function - no options
    // are ever provided for a drawing question, so before the explicit
    // pass-through case this fell into the MCQ branch and returned null.
    const result = normalizeQuizQuestion({ question: 'Draw your farm.', type: 'drawing' }, 0);
    expect(result).not.toBeNull();
  });

  test('a drawing question survives normalization with type preserved and no options required', () => {
    const result = normalizeQuizQuestion({ question: 'Draw your farm.', type: 'drawing' }, 0);
    expect(result.type).toBe('drawing');
    expect(result.options).toEqual([]);
  });

  test('a photo question survives normalization the same way', () => {
    const result = normalizeQuizQuestion({ question: 'Photo your model volcano.', type: 'photo' }, 0);
    expect(result.type).toBe('photo');
  });

  test('REGRESSION: a real MCQ question still normalizes exactly as before', () => {
    const result = normalizeQuizQuestion({ question: 'What is 2+2?', type: 'mcq', options: ['Three', 'Four', 'Five', 'Six'], correct: 'Four' }, 0);
    expect(result).toMatchObject({ type: 'mcq', correct: 'Four' });
    expect(result.options).toHaveLength(4);
  });

  test('REGRESSION: a real fill_blank question still normalizes exactly as before', () => {
    const result = normalizeQuizQuestion({ question: 'The capital of France is ___.', type: 'fill_blank', correct: 'Paris' }, 0);
    expect(result).toMatchObject({ type: 'fill_blank', correct: 'Paris' });
  });
});

describe('POST /assignments/:id/submit — quiz drawing/photo question (real endpoint)', () => {
  test('THE ORIGINAL GAP: a drawing answer (image, no text) was always marked skipped before the fix', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [DRAWING_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [DRAWING_Q] }), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/evidence/farm1.jpg' });
    mockGroqCreate.mockResolvedValueOnce(groqJson({ answered: true, score: 80, studentAnswer: 'A farm with rows of crops and animals.', correct: true, comment: 'Great farm!', teacherNote: '' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      // No `answer` text at all - only the image, exactly like a real drawing submission.
      quizAnswers: [{ drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.perQuestion[0].answered).toBe(true);
    expect(res.body.perQuestion[0].comment).not.toBe('You skipped this question.');
  });

  test('a real drawing submission is uploaded to Cloudinary and graded via the vision model, evidenceUrl attached', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [DRAWING_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [DRAWING_Q] }), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/evidence/farm2.jpg' });
    mockGroqCreate.mockResolvedValueOnce(groqJson({ answered: true, score: 85, studentAnswer: 'A detailed farm drawing.', correct: true, comment: 'Wonderful!', teacherNote: 'Clear labels.' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      quizAnswers: [{ drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' }],
    });

    expect(res.status).toBe(200);
    expect(mockCloudinaryUpload).toHaveBeenCalledWith(
      expect.stringContaining('data:image/png;base64,'),
      expect.objectContaining({ folder: 'aivorah/submission_evidence' }),
    );
    expect(res.body.perQuestion[0]).toMatchObject({ score: 85, correct: true, evidenceUrl: 'https://res.cloudinary.com/evidence/farm2.jpg' });
  });

  test('a Cloudinary upload failure does not block grading — evidenceUrl is null but the question still grades', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [DRAWING_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [DRAWING_Q] }), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockCloudinaryUpload.mockRejectedValue(new Error('quota exceeded'));
    mockGroqCreate.mockResolvedValueOnce(groqJson({ answered: true, score: 70, studentAnswer: 'A farm.', correct: true, comment: 'Nice!', teacherNote: '' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      quizAnswers: [{ drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.perQuestion[0].score).toBe(70);
    expect(res.body.perQuestion[0].evidenceUrl).toBeNull();
  });

  test('THE ORIGINAL GAP: an AI grading failure on a drawing question must not silently become a fake score', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [DRAWING_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [DRAWING_Q] }), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/evidence/farm3.jpg' });
    mockGroqCreate.mockResolvedValueOnce(Promise.resolve({ choices: [{ message: { content: 'not valid json {{{' } }] }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      quizAnswers: [{ drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' }],
    });

    expect(res.status).toBe(200);
    const q = res.body.perQuestion[0];
    expect(q.needsReview).toBe(true);
    expect(q.score).toBeNull();
    expect(q.evidenceUrl).toBe('https://res.cloudinary.com/evidence/farm3.jpg');
  });

  test('a needsReview drawing question is excluded from the overall quiz score average, not folded in as 0', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ quiz_questions: [DRAWING_Q, MCQ_Q] }), error: null },
      { data: baseAssignmentRow({ quiz_questions: [DRAWING_Q, MCQ_Q] }), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://x/e.jpg' });
    // Drawing question's AI response fails to parse -> needsReview. MCQ answered correctly -> 100.
    mockGroqCreate.mockResolvedValueOnce(Promise.resolve({ choices: [{ message: { content: 'not valid json {{{' } }] }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      quizAnswers: [
        { drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' },
        { answer: 'Four' },
      ],
    });

    expect(res.status).toBe(200);
    // If the needsReview question were folded in as 0, the average would be
    // 50 (100+0)/2. Excluding it, the average of the ONE real score is 100.
    expect(res.body.score).toBe(100);
  });

  describe('REGRESSION: existing quiz question types are unaffected', () => {
    test('a real correct MCQ answer still scores 100 exactly as before', async () => {
      mockSb.setTable('assignments', [
        { data: baseAssignmentRow({ quiz_questions: [MCQ_Q] }), error: null },
        { data: baseAssignmentRow({ quiz_questions: [MCQ_Q] }), error: null },
      ]);
      mockSb.setTable('assignment_submissions', { data: {}, error: null });
      mockGroqCreate.mockResolvedValue(groqJson({ text: 'Great job!' }));

      const res = await request(app).post('/assignments/a1/submit').send({
        studentId: STUDENT_UUID, quizAnswers: [{ answer: 'Four' }],
      });

      expect(res.body.score).toBe(100);
      expect(res.body.perQuestion[0].correct).toBe(true);
      expect(mockCloudinaryUpload).not.toHaveBeenCalled();
    });

    test('a real correct fill_blank answer on attempt 1 still scores 100 exactly as before', async () => {
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

    test('a real skipped (non-drawing) question still scores 0 and is marked unanswered, not needing review', async () => {
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
});
