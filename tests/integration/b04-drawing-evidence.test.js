// B04 (Phase 1) — the two confirmed gaps on the scaffolded drawing/photo
// grading path, POST /assignments/:id/submit (the REAL live endpoint —
// confirmed via frontend call-site audit: ScaffoldedModal.tsx submits
// stepAnswers to ASSIGNMENTS_SERVER_URL, this microservice, not the
// monolith's own duplicate copy of this same code):
//
// 1. The student's original drawing/photo was used only in-memory for the
//    vision-grading call, then discarded - never persisted anywhere. A
//    teacher had no way to see what was actually submitted after grading.
// 2. A grading exception (bad AI response, parse error, API failure)
//    silently defaulted to score:50 - indistinguishable from a real
//    AI-assigned 50%, so a failed grading attempt looked like a real score.
//
// Fix: upload the evidence to Cloudinary before grading and attach
// `evidenceUrl` to every drawing/photo perQuestion entry (success or
// failure); replace the silent score:50 fallback with an explicit
// `needsReview: true, score: null` state, excluded from the score average.
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

const mockMistralVision = jest.fn();
jest.mock('../../services/worksheet/providers', () => ({
  ...jest.requireActual('../../services/worksheet/providers'),
  callMistralVision: (...args) => mockMistralVision(...args),
}));

const mockCloudinaryUpload = jest.fn();
jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(), uploader: { upload: (...args) => mockCloudinaryUpload(...args) } },
}));

const request = require('supertest');
const app = require('../../index');

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

beforeEach(() => {
  mockSb.reset();
  mockGroqCreate.mockReset();
  mockGeminiGenerate.mockClear();
  mockMistralVision.mockReset();
  mockCloudinaryUpload.mockReset();
});

describe('B04 Phase 1 — drawing/photo evidence persistence (real endpoint: assignments-service)', () => {
  test('a real drawing submission is uploaded to Cloudinary BEFORE grading, and evidenceUrl is returned', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ task_steps: [{ type: 'drawing', label: 'Draw your farm' }] }), error: null },
      { data: baseAssignmentRow(), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/evidence/farm123.jpg' });
    mockGroqCreate
      .mockResolvedValueOnce(groqJson({ answered: true, score: 75, studentAnswer: 'A farm with rows of crops.', correct: true, comment: 'Great farm drawing!', teacherNote: 'Clear rows of crops drawn.' }))
      .mockResolvedValueOnce(groqJson({ text: 'Great job!', wellDone: 'Nice drawing', improve: 'Add more detail' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      stepAnswers: [{ type: 'drawing', drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' }],
    });

    expect(res.status).toBe(200);
    expect(mockCloudinaryUpload).toHaveBeenCalledWith(
      expect.stringContaining('data:image/png;base64,'),
      expect.objectContaining({ folder: 'aivorah/submission_evidence' }),
    );
    expect(res.body.perQuestion[0]).toMatchObject({ score: 75, evidenceUrl: 'https://res.cloudinary.com/evidence/farm123.jpg' });
  });

  test('a Cloudinary upload failure does not block grading — evidenceUrl is null but the step still grades normally', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ task_steps: [{ type: 'drawing', label: 'Draw your farm' }] }), error: null },
      { data: baseAssignmentRow(), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockCloudinaryUpload.mockRejectedValue(new Error('Cloudinary quota exceeded'));
    mockGroqCreate
      .mockResolvedValueOnce(groqJson({ answered: true, score: 80, studentAnswer: 'A farm with animals.', correct: true, comment: 'Nice work!', teacherNote: '' }))
      .mockResolvedValueOnce(groqJson({ text: 'Nice!', wellDone: '', improve: '' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      stepAnswers: [{ type: 'drawing', drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.perQuestion[0].score).toBe(80);
    expect(res.body.perQuestion[0].evidenceUrl).toBeNull();
  });

  test('THE ORIGINAL GAP: an AI grading failure must not silently become score:50', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ task_steps: [{ type: 'drawing', label: 'Draw your farm' }] }), error: null },
      { data: baseAssignmentRow(), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/evidence/farm999.jpg' });
    // Malformed JSON — simulates a real parse failure on the AI's response.
    mockGroqCreate
      .mockResolvedValueOnce(Promise.resolve({ choices: [{ message: { content: 'not valid json {{{' } }] }))
      .mockResolvedValueOnce(groqJson({ text: 'Great effort!' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      stepAnswers: [{ type: 'drawing', drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.perQuestion[0].score).not.toBe(50);
  });

  test('an AI grading failure sets needsReview:true, score:null, and still keeps the persisted evidenceUrl', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ task_steps: [{ type: 'drawing', label: 'Draw your farm' }] }), error: null },
      { data: baseAssignmentRow(), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/evidence/farm999.jpg' });
    mockGroqCreate
      .mockResolvedValueOnce(Promise.resolve({ choices: [{ message: { content: 'not valid json {{{' } }] }))
      .mockResolvedValueOnce(groqJson({ text: 'Great effort!' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      stepAnswers: [{ type: 'drawing', drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' }],
    });

    expect(res.status).toBe(200);
    const step = res.body.perQuestion[0];
    expect(step.needsReview).toBe(true);
    expect(step.score).toBeNull();
    expect(step.evidenceUrl).toBe('https://res.cloudinary.com/evidence/farm999.jpg');
  });

  test('a needsReview step is excluded from the overall score average, not folded in as 0', async () => {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ task_steps: [
        { type: 'drawing', label: 'Draw your farm' },
        { type: 'drawing', label: 'Draw your barn' },
      ] }), error: null },
      { data: baseAssignmentRow(), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://x/e.jpg' });
    mockGroqCreate
      .mockResolvedValueOnce(groqJson({ answered: true, score: 100, studentAnswer: 'x', correct: true, comment: 'x', teacherNote: '' }))
      .mockResolvedValueOnce(Promise.resolve({ choices: [{ message: { content: 'not valid json {{{' } }] }))
      .mockResolvedValueOnce(groqJson({ text: 'Great job!' }));

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      stepAnswers: [
        { type: 'drawing', drawingBase64: 'YQ==', drawingMime: 'image/png' },
        { type: 'drawing', drawingBase64: 'Yg==', drawingMime: 'image/png' },
      ],
    });

    expect(res.status).toBe(200);
    // If the needsReview step were folded in as 0, the average would be 50
    // (100+0)/2. Excluding it entirely, the average of the ONE real score is 100.
    expect(res.body.score).toBe(100);
  });
});

describe('drawing grading uses Gemini vision with the real grade', () => {
  function setup(stepType, grade) {
    mockSb.setTable('assignments', [
      { data: baseAssignmentRow({ grade, task_steps: [{ type: stepType, label: 'Draw a right triangle' }] }), error: null },
      { data: baseAssignmentRow(), error: null },
    ]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/evidence/tri.jpg' });
    mockGroqCreate
      .mockResolvedValueOnce(groqJson({ answered: true, score: 90, studentAnswer: 'A labelled right triangle.', correct: true, comment: 'Accurate!', teacherNote: '' }))
      .mockResolvedValueOnce(groqJson({ text: 'Great job!' }));
  }

  test('the image goes to Gemini as inlineData and the prompt names the student grade', async () => {
    setup('drawing', 'Grade 8');
    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      stepAnswers: [{ type: 'drawing', drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.perQuestion[0]).toMatchObject({ score: 90, needsReview: false });
    const parts = mockGeminiGenerate.mock.calls[0][0];
    expect(parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: 'ZmFrZS1pbWFnZS1kYXRh' } });
    const prompt = parts.find(p => p.text).text;
    expect(prompt).toContain('Grade 8');
    expect(prompt).not.toContain('Grade 3');
  });

  test('an art_creation upload is graded, not marked "Not submitted"', async () => {
    setup('art_creation', 'Grade 5');
    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID,
      stepAnswers: [{ type: 'art_creation', drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/jpeg' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.perQuestion[0]).toMatchObject({ answered: true, score: 90 });
    expect(mockGeminiGenerate).toHaveBeenCalled();
  });
});

test('Gemini and Groq vision both fail -> Mistral vision grades it', async () => {
  process.env.MISTRAL_API_KEY = 'test-mistral';
  mockSb.setTable('assignments', [
    { data: baseAssignmentRow({ grade: 'Grade 8', task_steps: [{ type: 'drawing', label: 'Draw a right triangle' }] }), error: null },
    { data: baseAssignmentRow(), error: null },
  ]);
  mockSb.setTable('assignment_submissions', { data: {}, error: null });
  mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/evidence/tri.jpg' });
  mockGroqCreate
    .mockRejectedValueOnce(new Error('[402 Payment Required] Your prepayment credits are depleted'))
    .mockRejectedValueOnce(new Error('Groq 503 overloaded'))
    .mockResolvedValueOnce(groqJson({ text: 'Great job!' }));
  mockMistralVision.mockResolvedValueOnce('Here you go: {"answered":true,"score":82,"studentAnswer":"A right triangle with sides labelled.","correct":true,"comment":"Good!","teacherNote":""}');

  const res = await request(app).post('/assignments/a1/submit').send({
    studentId: STUDENT_UUID,
    stepAnswers: [{ type: 'drawing', drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' }],
  });
  delete process.env.MISTRAL_API_KEY;

  expect(res.status).toBe(200);
  expect(res.body.perQuestion[0]).toMatchObject({ score: 82, needsReview: false });
  const [images, prompt] = mockMistralVision.mock.calls[0];
  expect(images[0].mime).toBe('image/png');
  expect(prompt).toContain('Grade 8');
});

test('Gemini out of credits (402) falls back to Groq vision instead of Review', async () => {
  process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-groq';
  mockSb.setTable('assignments', [
    { data: baseAssignmentRow({ grade: 'Grade 8', task_steps: [{ type: 'drawing', label: 'Draw a right triangle' }] }), error: null },
    { data: baseAssignmentRow(), error: null },
  ]);
  mockSb.setTable('assignment_submissions', { data: {}, error: null });
  mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/evidence/tri.jpg' });
  mockGroqCreate
    .mockRejectedValueOnce(new Error('[402 Payment Required] Your prepayment credits are depleted'))
    .mockResolvedValueOnce(Promise.resolve({ choices: [{ message: { content: '<think>checking</think>```json\n{"answered":true,"score":82,"studentAnswer":"A labelled right triangle.","correct":true,"comment":"Good!","teacherNote":""}\n```' } }] }))
    .mockResolvedValueOnce(groqJson({ text: 'Great job!' }));

  const res = await request(app).post('/assignments/a1/submit').send({
    studentId: STUDENT_UUID,
    stepAnswers: [{ type: 'drawing', drawingBase64: 'ZmFrZS1pbWFnZS1kYXRh', drawingMime: 'image/png' }],
  });

  expect(res.status).toBe(200);
  expect(res.body.perQuestion[0]).toMatchObject({ score: 82, needsReview: false });
  const visionCall = mockGroqCreate.mock.calls[1][0];
  expect(visionCall.model).toBe('qwen/qwen3.8-27b');
  expect(visionCall.messages[0].content[0].text).toContain('Grade 8');
  expect(visionCall.messages[0].content[1].image_url.url).toBe('data:image/png;base64,ZmFrZS1pbWFnZS1kYXRh');
});
