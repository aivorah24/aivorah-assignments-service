const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const STUDENT_UUID = '11111111-1111-1111-1111-111111111111';
const TEACHER_UUID = '22222222-2222-2222-2222-222222222222';

function usersRow(overrides = {}) {
  return { curriculum: null, grade: null, school: null, created_at: '2020-01-01T00:00:00Z', ...overrides };
}

function assignmentRow(overrides = {}) {
  return {
    id: 'a1', title: 'Fractions', subject: 'Mathematics', chapter: 'Numbers', due_date: '2099-01-01',
    type: 'worksheet', note: '', student_id: STUDENT_UUID, created_by_id: null, created_by_role: 'teacher',
    status: 'pending', score: null, created_at: '2026-08-01T00:00:00Z', completed_at: null,
    grade: null, curriculum: null, questions: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockSb.reset();
});

describe('GET /assignments — validation', () => {
  test('requires a real studentId or teacherId', async () => {
    const res = await request(app).get('/assignments');
    expect(res.status).toBe(400);
  });
});

describe('GET /assignments — student personal assignments', () => {
  test('returns a real personal assignment normalised, with a real empty teacher_student/submission lookup', async () => {
    mockSb.setTable('users', { data: usersRow(), error: null });
    mockSb.setTable('assignments', { data: [assignmentRow()], error: null });
    mockSb.setTable('teacher_student', { data: [], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('a1');
    expect(res.body[0].dueDate).toBe('2099-01-01');
  });

  test('a real 500 from the assignments table surfaces as a real 500 response', async () => {
    mockSb.setTable('users', { data: usersRow(), error: null });
    mockSb.setTable('assignments', { data: null, error: { message: 'db down' } });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}`);

    expect(res.status).toBe(500);
  });
});

describe('GET /assignments — class-wide curriculum/grade scoping', () => {
  test('shows a real class-wide assignment whose curriculum/grade matches the student', async () => {
    mockSb.setTable('users', [
      { data: usersRow({ curriculum: 'IB PYP', grade: 'Grade 4' }), error: null }, // student profile lookup
      { data: [{ id: TEACHER_UUID, school: null }], error: null }, // classCreatorIds school lookup
    ]);
    mockSb.setTable('assignments', {
      data: [assignmentRow({ id: 'a2', student_id: null, created_by_id: TEACHER_UUID, curriculum: 'IB PYP', grade: 'Grade 4' })],
      error: null,
    });
    mockSb.setTable('teacher_student', { data: [{ teacher_id: TEACHER_UUID }], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body.map(a => a.id)).toContain('a2');
  });

  test('hides a real class-wide assignment whose curriculum does not match the student', async () => {
    mockSb.setTable('users', [
      { data: usersRow({ curriculum: 'NCERT', grade: 'Grade 4' }), error: null },
      { data: [{ id: TEACHER_UUID, school: null }], error: null },
    ]);
    mockSb.setTable('assignments', {
      data: [assignmentRow({ id: 'a2', student_id: null, created_by_id: TEACHER_UUID, curriculum: 'IB PYP', grade: 'Grade 4' })],
      error: null,
    });
    mockSb.setTable('teacher_student', { data: [{ teacher_id: TEACHER_UUID }], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}`);

    expect(res.body.map(a => a.id)).not.toContain('a2');
  });

  test('hides a real teacher "all students" assignment from a student not linked to that teacher', async () => {
    mockSb.setTable('users', [
      { data: usersRow({ curriculum: 'IB PYP', grade: 'Grade 4' }), error: null },
      { data: [{ id: TEACHER_UUID, school: null }], error: null },
    ]);
    mockSb.setTable('assignments', {
      data: [assignmentRow({ id: 'a2', student_id: null, created_by_id: TEACHER_UUID, curriculum: 'IB PYP', grade: 'Grade 4' })],
      error: null,
    });
    // Student is NOT linked to this teacher.
    mockSb.setTable('teacher_student', { data: [], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}`);

    expect(res.body.map(a => a.id)).not.toContain('a2');
  });
});

describe('GET /assignments — joinedAfterDue', () => {
  test('flags a real class-wide assignment as joinedAfterDue when the student joined after its due date', async () => {
    mockSb.setTable('users', [
      { data: usersRow({ curriculum: 'IB PYP', grade: 'Grade 4', created_at: '2026-06-01T00:00:00Z' }), error: null },
      { data: [{ id: TEACHER_UUID, school: null }], error: null },
    ]);
    mockSb.setTable('assignments', {
      data: [assignmentRow({ id: 'a2', student_id: null, created_by_id: TEACHER_UUID, curriculum: 'IB PYP', grade: 'Grade 4', due_date: '2026-01-01' })],
      error: null,
    });
    mockSb.setTable('teacher_student', { data: [{ teacher_id: TEACHER_UUID }], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}`);

    const a2 = res.body.find(a => a.id === 'a2');
    expect(a2.joinedAfterDue).toBe(true);
  });
});

describe('GET /assignments — parent shareProgress enforcement', () => {
  test('hides a real score from a parent viewer when the creating teacher turned off shareProgress', async () => {
    mockSb.setTable('users', [
      { data: usersRow({ curriculum: 'IB PYP', grade: 'Grade 4' }), error: null }, // student profile lookup
      // a2 is personal (student_id set), so the classCreatorIds school lookup never
      // fires for it — next real 'users' call is teacherSetting's email resolution.
      { data: { email: 'teacher@school.com' }, error: null },
    ]);
    mockSb.setTable('user_preferences', { data: { data: { shareProgress: false } }, error: null });
    mockSb.setTable('assignments', {
      data: [assignmentRow({ id: 'a2', student_id: STUDENT_UUID, created_by_id: TEACHER_UUID, score: 90, status: 'completed' })],
      error: null,
    });
    mockSb.setTable('teacher_student', { data: [{ teacher_id: TEACHER_UUID }], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}&viewerRole=parent`);

    const a2 = res.body.find(a => a.id === 'a2');
    expect(a2.score).toBeNull();
    expect(a2.scoreHidden).toBe(true);
  });

  test('a real student viewing their own completed work still sees their real score', async () => {
    mockSb.setTable('users', usersRow({ curriculum: 'IB PYP', grade: 'Grade 4' }));
    mockSb.setTable('assignments', {
      data: [assignmentRow({ id: 'a1', student_id: STUDENT_UUID, score: 90, status: 'completed' })],
      error: null,
    });
    mockSb.setTable('teacher_student', { data: [], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}`);

    expect(res.body[0].score).toBe(90);
  });
});

describe('GET /assignments — teacherId path', () => {
  test('returns a real teacher\'s own created assignments, ordered by due date', async () => {
    mockSb.setTable('assignments', { data: [assignmentRow({ id: 'a1', created_by_id: TEACHER_UUID })], error: null });

    const res = await request(app).get(`/assignments?teacherId=${TEACHER_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('GET /assignments — interactive quiz HTML live regeneration', () => {
  test('a real assignment with interactive_quiz.tasks gets a real regenerated, non-null interactiveQuizHtml', async () => {
    mockSb.setTable('users', usersRow());
    mockSb.setTable('assignments', {
      data: [assignmentRow({
        id: 'a1',
        interactive_quiz: { tasks: [{ title: 'Addition', questions: [{ type: 'mcq', question: 'What is 2+2?', options: ['3', '4', '5', '6'], answer: '4' }] }] },
      })],
      error: null,
    });
    mockSb.setTable('teacher_student', { data: [], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].interactiveQuizHtml).toEqual(expect.any(String));
    expect(res.body[0].interactiveQuizHtml).toContain('What is 2+2?');
  });

  test('an assignment with no interactive_quiz falls back to a real null (or stored) interactiveQuizHtml, no crash', async () => {
    mockSb.setTable('users', usersRow());
    mockSb.setTable('assignments', { data: [assignmentRow({ id: 'a1' })], error: null });
    mockSb.setTable('teacher_student', { data: [], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].interactiveQuizHtml).toBeNull();
  });
});

describe('GET /assignments — deny by default (no owner / no audience means not shown)', () => {
  test('an unknown student gets no assignments at all, not the class-wide ones', async () => {
    mockSb.setTable('users', { data: null, error: null });
    mockSb.setTable('assignments', {
      data: [assignmentRow({ id: 'orphan', student_id: null, created_by_id: TEACHER_UUID, created_by_role: 'school_admin', curriculum: null, grade: null })],
      error: null,
    });

    const res = await request(app).get('/assignments?studentId=nobody@example.com');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('hides a class-wide assignment that has no owner', async () => {
    mockSb.setTable('users', [
      { data: usersRow({ curriculum: 'CBSE', grade: 'Grade 9' }), error: null },
      { data: [], error: null },
    ]);
    mockSb.setTable('assignments', {
      data: [assignmentRow({ id: 'no-owner', student_id: null, created_by_id: null, created_by_role: 'parent', curriculum: 'CBSE', grade: 'Grade 9' })],
      error: null,
    });
    mockSb.setTable('teacher_student', { data: [], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body.map(a => a.id)).not.toContain('no-owner');
  });

  test('hides a graded class-wide assignment from a student whose grade is not set', async () => {
    mockSb.setTable('users', [
      { data: usersRow({ curriculum: 'CBSE', grade: null }), error: null },
      { data: [{ id: TEACHER_UUID, school: null }], error: null },
    ]);
    mockSb.setTable('assignments', {
      data: [assignmentRow({ id: 'g9', student_id: null, created_by_id: TEACHER_UUID, curriculum: 'CBSE', grade: 'Grade 9' })],
      error: null,
    });
    mockSb.setTable('teacher_student', { data: [{ teacher_id: TEACHER_UUID }], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });

    const res = await request(app).get(`/assignments?studentId=${STUDENT_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body.map(a => a.id)).not.toContain('g9');
  });
});
