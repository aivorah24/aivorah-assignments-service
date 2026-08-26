const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const STUDENT_UUID = '11111111-1111-1111-1111-111111111111';
const TEACHER_UUID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  mockSb.reset();
});

describe('POST /assignments', () => {
  test('creates a plain assignment for a specific student and returns the normalised row', async () => {
    mockSb.setTable('users', { data: { id: TEACHER_UUID, name: 'Ms. Rao' }, error: null });
    mockSb.setTable('assignments', {
      data: {
        id: 'a1', title: 'E2E Assignment', subject: 'Mathematics', chapter: '',
        due_date: '2026-09-01', type: 'assignment', note: '',
        student_id: STUDENT_UUID, created_by_id: TEACHER_UUID, created_by_role: 'teacher',
        created_by_name: 'Ms. Rao', grade: null, curriculum: null, questions: [],
        status: null, score: null, created_at: '2026-08-26T00:00:00.000Z', completed_at: null,
      },
      error: null,
    });

    const res = await request(app).post('/assignments').send({
      title: 'E2E Assignment',
      dueDate: '2026-09-01',
      subject: 'Mathematics',
      studentId: STUDENT_UUID,
      createdById: TEACHER_UUID,
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('a1');
    expect(res.body.title).toBe('E2E Assignment');
    expect(res.body.studentId).toBe(STUDENT_UUID);
  });

  test('rejects a request missing title or dueDate', async () => {
    const res = await request(app).post('/assignments').send({ title: 'No due date' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title and dueDate required/);
  });

  test('rejects a class-wide assignment (no studentId) with no resolvable curriculum', async () => {
    mockSb.setTable('users', { data: null, error: null });

    const res = await request(app).post('/assignments').send({
      title: 'Class-wide',
      dueDate: '2026-09-01',
      createdById: TEACHER_UUID,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/curriculum/);
  });

  test('a real Supabase error on insert returns 500 with the real error message', async () => {
    mockSb.setTable('users', { data: { id: TEACHER_UUID, name: 'Ms. Rao' }, error: null });
    mockSb.setTable('assignments', { data: null, error: { message: 'insert failed' } });

    const res = await request(app).post('/assignments').send({
      title: 'E2E Assignment',
      dueDate: '2026-09-01',
      studentId: STUDENT_UUID,
      createdById: TEACHER_UUID,
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('insert failed');
  });
});
