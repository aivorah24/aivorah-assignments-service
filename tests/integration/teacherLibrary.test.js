// The teacher's private assignment library: saved on every teacher-created
// assignment, listed / opened / removed only by the signed-in teacher.
const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

// Token "<email>" signs in as that email; "bad" is rejected.
jest.mock('../../services/firebaseAdmin', () => ({
  auth: () => ({
    verifyIdToken: jest.fn(async (token) => {
      if (token === 'bad') throw new Error('invalid');
      return { email: token };
    }),
  }),
}));

const request = require('supertest');
const app = require('../../index');
const { contentFromBody, hashContent } = require('../../services/teacherLibrary');

const TEACHER = { id: '22222222-2222-2222-2222-222222222222', role: 'teacher', email: 't@school.test', name: 'Ms. Rao' };
const ITEM_ID = '33333333-3333-3333-3333-333333333333';
const as = (email) => ({ Authorization: `Bearer ${email}` });
const chains = (table) => mockSb.supabase.from.mock.calls
  .map((c, i) => [c[0], mockSb.supabase.from.mock.results[i].value])
  .filter(([t]) => t === table).map(([, ch]) => ch);

beforeEach(() => {
  mockSb.reset();
  mockSb.supabase.from.mockClear();
});

describe('content and hashing', () => {
  test('who / when it was assigned is not part of the reusable content', () => {
    const content = contentFromBody({
      title: 'Fractions', type: 'quiz', subject: 'Mathematics', quizQuestions: [{ q: 1 }],
      dueDate: '2026-12-01', startDate: '2026-11-20', studentId: 's1', createdById: 't@x', createdByRole: 'teacher',
      interactiveQuizHtml: '<html>', libraryItemId: 'x',
    });
    expect(content).toEqual({ title: 'Fractions', type: 'quiz', subject: 'Mathematics', quizQuestions: [{ q: 1 }] });
  });

  test('the same content hashes the same whatever the key order; different content differs', () => {
    expect(hashContent({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(hashContent({ b: { d: 'x', c: [1, 2] }, a: 1 }));
    expect(hashContent({ a: 1 })).not.toBe(hashContent({ a: 2 }));
  });
});

describe('POST /assignments keeps a copy in the teacher\'s library', () => {
  const BODY = { title: 'Fractions quiz', type: 'assignment', subject: 'Mathematics', dueDate: '2026-12-01', studentId: '11111111-1111-1111-1111-111111111111', createdById: TEACHER.id };
  const ROW = { id: 'a1', title: 'Fractions quiz', type: 'assignment', subject: 'Mathematics', grade: 'Grade 4', curriculum: 'CBSE', created_by_id: TEACHER.id };

  test('a new piece of work is added', async () => {
    mockSb.setTable('users', { data: { id: TEACHER.id, name: 'Ms. Rao' }, error: null });
    mockSb.setTable('assignments', { data: ROW, error: null });
    mockSb.setTable('teacher_assignment_library', [{ data: null, error: null }, { data: { id: 'lib1' }, error: null }]);
    const res = await request(app).post('/assignments').send(BODY);
    expect(res.status).toBe(200);
    const insert = chains('teacher_assignment_library').flatMap((c) => c.insert.mock.calls)[0][0];
    expect(insert).toMatchObject({
      teacher_id: TEACHER.id, title: 'Fractions quiz', type: 'assignment', subject: 'Mathematics',
      grade: 'Grade 4', curriculum: 'CBSE', source_assignment_id: 'a1',
      content: { title: 'Fractions quiz', type: 'assignment', subject: 'Mathematics' },
    });
    expect(insert.content).not.toHaveProperty('dueDate');
    expect(insert.content).not.toHaveProperty('studentId');
  });

  test('the same work again (another student, or from the library) is counted, not duplicated', async () => {
    mockSb.setTable('users', { data: { id: TEACHER.id, name: 'Ms. Rao' }, error: null });
    mockSb.setTable('assignments', { data: ROW, error: null });
    mockSb.setTable('teacher_assignment_library', [{ data: { id: 'lib1', times_assigned: 2 }, error: null }, { data: null, error: null }]);
    await request(app).post('/assignments').send({ ...BODY, studentId: '44444444-4444-4444-4444-444444444444', libraryItemId: 'lib1' });
    const lib = chains('teacher_assignment_library');
    expect(lib.flatMap((c) => c.insert.mock.calls)).toHaveLength(0);
    expect(lib.flatMap((c) => c.update.mock.calls)[0][0]).toMatchObject({ times_assigned: 3 });
  });

  test('a library failure never fails the assignment', async () => {
    mockSb.setTable('users', { data: { id: TEACHER.id, name: 'Ms. Rao' }, error: null });
    mockSb.setTable('assignments', { data: ROW, error: null });
    mockSb.setTable('teacher_assignment_library', [{ data: null, error: null }, { data: null, error: { message: 'relation does not exist' } }]);
    const res = await request(app).post('/assignments').send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('a1');
  });

  test('parent-created assignments are not put in any library', async () => {
    mockSb.setTable('users', { data: { id: TEACHER.id, name: 'Mum' }, error: null });
    mockSb.setTable('assignments', { data: { ...ROW, created_by_role: 'parent' }, error: null });
    await request(app).post('/assignments').send({ ...BODY, createdByRole: 'parent' });
    expect(chains('teacher_assignment_library')).toHaveLength(0);
  });
});

describe('/assignments/library', () => {
  test('sign-in required; a bad token or a non-teacher is refused', async () => {
    expect((await request(app).get('/assignments/library')).status).toBe(401);
    expect((await request(app).get('/assignments/library').set(as('bad'))).status).toBe(401);
    mockSb.setTable('users', { data: { ...TEACHER, role: 'student' }, error: null });
    expect((await request(app).get('/assignments/library').set(as('kid@school.test'))).status).toBe(403);
  });

  test('lists only the signed-in teacher\'s items, chosen by their token - not a query param', async () => {
    mockSb.setTable('users', { data: TEACHER, error: null });
    mockSb.setTable('teacher_assignment_library', { data: [{ id: ITEM_ID, title: 'Fractions quiz', times_assigned: 2 }], error: null });
    const res = await request(app).get('/assignments/library?teacherId=someone-else').set(as(TEACHER.email));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: ITEM_ID, title: 'Fractions quiz', times_assigned: 2 }]);
    const eqs = chains('teacher_assignment_library').flatMap((c) => c.eq.mock.calls);
    expect(eqs).toContainEqual(['teacher_id', TEACHER.id]);
    expect(chains('users')[0].eq).toHaveBeenCalledWith('email', 't@school.test');
  });

  test('opening an item returns its content; another teacher\'s item is not found', async () => {
    mockSb.setTable('users', { data: TEACHER, error: null });
    mockSb.setTable('teacher_assignment_library', [
      { data: { id: ITEM_ID, title: 'Fractions quiz', content: { title: 'Fractions quiz', quizQuestions: [] } }, error: null },
      { data: null, error: null },
    ]);
    const ok = await request(app).get(`/assignments/library/${ITEM_ID}`).set(as(TEACHER.email));
    expect(ok.status).toBe(200);
    expect(ok.body.item.content.title).toBe('Fractions quiz');
    const other = await request(app).get(`/assignments/library/${ITEM_ID}`).set(as(TEACHER.email));
    expect(other.status).toBe(404);
    expect(chains('teacher_assignment_library')[0].eq).toHaveBeenCalledWith('teacher_id', TEACHER.id);
  });

  test('removing an item is limited to the teacher\'s own', async () => {
    mockSb.setTable('users', { data: TEACHER, error: null });
    mockSb.setTable('teacher_assignment_library', [{ data: [{ id: ITEM_ID }], error: null }, { data: [], error: null }]);
    expect((await request(app).delete(`/assignments/library/${ITEM_ID}`).set(as(TEACHER.email))).body).toEqual({ ok: true });
    expect((await request(app).delete(`/assignments/library/${ITEM_ID}`).set(as(TEACHER.email))).status).toBe(404);
    expect((await request(app).delete('/assignments/library/not-a-uuid').set(as(TEACHER.email))).status).toBe(404);
  });
});
