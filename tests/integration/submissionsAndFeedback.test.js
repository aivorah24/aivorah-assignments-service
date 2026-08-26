const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const STUDENT_UUID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  mockSb.reset();
});

describe('GET /assignments/:id/submissions', () => {
  test('404s when the real assignment does not exist', async () => {
    mockSb.setTable('assignments', { data: null, error: null });

    const res = await request(app).get('/assignments/a1/submissions');

    expect(res.status).toBe(404);
  });

  test('returns empty submissions with totalLinked 0 when nobody has submitted yet', async () => {
    mockSb.setTable('assignments', { data: { id: 'a1', student_id: STUDENT_UUID, questions: [] }, error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get('/assignments/a1/submissions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ submissions: [], totalLinked: 0 });
  });

  test('a real student submission is enriched with the real student name/grade', async () => {
    mockSb.setTable('assignments', { data: { id: 'a1', student_id: STUDENT_UUID, questions: [] }, error: null });
    mockSb.setTable('assignment_submissions', {
      data: [{ student_id: STUDENT_UUID, status: 'completed', score: 80, ai_feedback: null, completed_at: '2026-08-20T00:00:00Z', submission_text: null }],
      error: null,
    });
    mockSb.setTable('users', { data: [{ id: STUDENT_UUID, name: 'Asha', grade: 'Grade 5' }], error: null });

    const res = await request(app).get('/assignments/a1/submissions');

    expect(res.status).toBe(200);
    expect(res.body.submissions).toHaveLength(1);
    expect(res.body.submissions[0].studentName).toBe('Asha');
    expect(res.body.submissions[0].grade).toBe('Grade 5');
    expect(res.body.totalLinked).toBe(1);
  });

  test('a class-wide assignment (student_id null) counts totalLinked from the real linked-student count', async () => {
    mockSb.setTable('assignments', { data: { id: 'a1', student_id: null, questions: [] }, error: null });
    mockSb.setTable('assignment_submissions', {
      data: [{ student_id: STUDENT_UUID, status: 'completed', score: 90, ai_feedback: null, completed_at: '2026-08-20T00:00:00Z', submission_text: null }],
      error: null,
    });
    mockSb.setTable('users', { data: [{ id: STUDENT_UUID, name: 'Asha', grade: 'Grade 5' }], error: null });
    const origFrom = mockSb.supabase.from;
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'teacher_student') return { select: () => Promise.resolve({ count: 12 }) };
      return origFrom(table);
    });

    const res = await request(app).get('/assignments/a1/submissions');
    mockSb.supabase.from = origFrom;

    expect(res.status).toBe(200);
    expect(res.body.totalLinked).toBe(12);
  });
});

describe('PUT /assignments/:id/teacher-feedback', () => {
  test('requires a real studentId and feedback', async () => {
    const res = await request(app).put('/assignments/a1/teacher-feedback').send({});
    expect(res.status).toBe(400);
  });

  test('a real unresolvable student returns 400', async () => {
    const res = await request(app).put('/assignments/a1/teacher-feedback').send({ studentId: 'not-an-id-or-email', feedback: 'Great job!' });
    expect(res.status).toBe(400);
  });

  test('merges real teacher feedback into the existing ai_feedback JSON and saves it', async () => {
    mockSb.setTable('assignment_submissions', [
      { data: { ai_feedback: JSON.stringify({ text: 'Nice work' }) }, error: null }, // current submission read
      { data: null, error: null }, // update() call
    ]);

    const res = await request(app).put('/assignments/a1/teacher-feedback').send({ studentId: STUDENT_UUID, feedback: 'Great job!' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.feedback.text).toBe('Nice work');
    expect(res.body.feedback.teacherFeedback).toBe('Great job!');
    expect(res.body.feedback.teacherFeedbackAt).toBeTruthy();
  });

  test('a real Supabase error saving feedback returns 500', async () => {
    mockSb.setTable('assignment_submissions', [
      { data: { ai_feedback: null }, error: null },
      { data: null, error: { message: 'save failed' } },
    ]);

    const res = await request(app).put('/assignments/a1/teacher-feedback').send({ studentId: STUDENT_UUID, feedback: 'Great job!' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('save failed');
  });
});
