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

  test('notifies the student + parents in the bell with the feedback text', async () => {
    mockSb.setTable('assignment_submissions', [
      { data: { ai_feedback: null }, error: null },
      { data: null, error: null },
    ]);
    mockSb.setTable('assignments', { data: { id: 'a1', title: 'Fractions', subject: 'Mathematics', type: 'assignment' }, error: null });
    mockSb.setTable('rpc:notify_event', { data: { inserted: [{ id: 'n1' }], recipients: 2 }, error: null });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const res = await request(app).put('/assignments/a1/teacher-feedback')
      .send({ studentId: STUDENT_UUID, feedback: 'Great job!', teacherEmail: 'T@x.com' });
    logSpy.mockRestore();

    expect(res.status).toBe(200);
    const [fn, args] = mockSb.supabase.rpc.mock.calls.at(-1);
    expect(fn).toBe('notify_event');
    expect(args.p_event).toMatchObject({
      type: 'assignment_feedback', entity_type: 'assignment', entity_id: 'a1',
      student_ids: [STUDENT_UUID], actor_email: 't@x.com', actor_role: 'teacher',
      title: 'Teacher feedback on your assignment: Fractions', body: 'Great job!',
      parent_title: 'Teacher feedback for {child}: Fractions',
      version: res.body.feedback.teacherFeedbackAt,
    });
  });

  test('editing sent feedback keeps the first send time, stamps the edit and notifies as updated', async () => {
    mockSb.setTable('assignment_submissions', [
      { data: { ai_feedback: JSON.stringify({ teacherFeedback: 'Good', teacherFeedbackAt: '2026-10-01T00:00:00.000Z' }) }, error: null },
      { data: null, error: null },
    ]);
    mockSb.setTable('assignments', { data: { id: 'a1', title: 'Fractions', type: 'assignment' }, error: null });
    mockSb.setTable('rpc:notify_event', { data: { inserted: [] }, error: null });
    mockSb.supabase.rpc.mockClear();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const res = await request(app).put('/assignments/a1/teacher-feedback').send({ studentId: STUDENT_UUID, feedback: 'Good, show your working' });
    logSpy.mockRestore();

    expect(res.body.feedback).toMatchObject({ teacherFeedback: 'Good, show your working', teacherFeedbackAt: '2026-10-01T00:00:00.000Z' });
    expect(res.body.feedback.teacherFeedbackEditedAt).toBeTruthy();
    const evt = mockSb.supabase.rpc.mock.calls.at(-1)[1].p_event;
    expect(evt.title).toBe('Teacher updated feedback on your assignment: Fractions');
    expect(evt.version).toBe(res.body.feedback.teacherFeedbackEditedAt);
  });

  test('re-saving identical feedback sends no new notification', async () => {
    mockSb.setTable('assignment_submissions', [
      { data: { ai_feedback: JSON.stringify({ teacherFeedback: 'Good' }) }, error: null },
      { data: null, error: null },
    ]);
    mockSb.supabase.rpc.mockClear();

    const res = await request(app).put('/assignments/a1/teacher-feedback').send({ studentId: STUDENT_UUID, feedback: 'Good' });

    expect(res.status).toBe(200);
    expect(mockSb.supabase.rpc).not.toHaveBeenCalled();
  });

  test('a failed notification never fails the saved feedback', async () => {
    mockSb.setTable('assignment_submissions', [
      { data: { ai_feedback: null }, error: null },
      { data: null, error: null },
    ]);
    mockSb.setTable('rpc:notify_event', { data: null, error: { message: 'boom' } });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const res = await request(app).put('/assignments/a1/teacher-feedback').send({ studentId: STUDENT_UUID, feedback: 'Great job!' });
    logSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
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
