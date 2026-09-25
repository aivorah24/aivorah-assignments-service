const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
const mockResolve = jest.fn();
jest.mock('../../services/supabase', () => mockSb.supabase);
jest.mock('../../services/push', () => ({ sendPush: jest.fn().mockResolvedValue({ sent: 0 }) }));
jest.mock('../../services/assignmentRecipients', () => ({
  resolveClassRecipients: (...a) => mockResolve(...a),
}));

const request = require('supertest');
const app = require('../../index');

const STUDENT = '11111111-1111-1111-1111-111111111111';
const TEACHER = '22222222-2222-2222-2222-222222222222';
const created = (o = {}) => ({
  id: 'a1', title: 'Fractions', subject: 'Mathematics', chapter: '', due_date: '2026-09-30', type: 'assignment',
  note: '', student_id: STUDENT, created_by_id: TEACHER, created_by_role: 'teacher', created_by_name: 'Ms Rao',
  grade: 'Grade 4', curriculum: 'CBSE', questions: [], created_at: '2026-09-24T10:00:00.123456+00:00', ...o,
});

let logSpy;
beforeEach(() => {
  mockSb.reset();
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  mockSb.setTable('users', { data: { id: TEACHER, name: 'Ms Rao', school: 'A', email: 'Teacher@X.com' }, error: null });
  mockSb.setTable('rpc:notify_event', { data: { eventKey: 'k', recipients: 2, duplicates: 0, inserted: [{ id: 'n1' }, { id: 'n2' }] }, error: null });
});
afterEach(() => logSpy.mockRestore());

const rpcEvents = () => mockSb.supabase.rpc.mock.calls.filter(c => c[0] === 'notify_event').map(c => c[1].p_event);

test('individual assignment → one V2 event for that student, versioned by created_at, actor = creator', async () => {
  mockResolve.mockImplementation(async (a) => [a.student_id]);
  mockSb.setTable('assignments', { data: created(), error: null });

  const res = await request(app).post('/assignments').send({
    title: 'Fractions', dueDate: '2026-09-30', subject: 'Mathematics', studentId: STUDENT, createdById: TEACHER,
  });

  expect(res.status).toBe(200);
  const events = rpcEvents();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: 'assignment_assigned', entity_type: 'assignment', entity_id: 'a1',
    version: '2026-09-24T10:00:00.123456+00:00', student_ids: [STUDENT],
    actor_email: 'teacher@x.com', actor_role: 'teacher',
  });
});

test('class-wide assignment → students come from the shared recipient resolver', async () => {
  mockResolve.mockResolvedValue(['s1', 's2', 's3']);
  mockSb.setTable('assignments', { data: created({ student_id: null }), error: null });

  const res = await request(app).post('/assignments').send({
    title: 'Fractions', dueDate: '2026-09-30', subject: 'Mathematics', createdById: TEACHER, curriculum: 'CBSE', grade: 'Grade 4',
  });

  expect(res.status).toBe(200);
  expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', student_id: null }), 'A');
  expect(rpcEvents()[0].student_ids).toEqual(['s1', 's2', 's3']);
});

test('parent-created assignment passes the parent as actor (so they are not notified of their own action)', async () => {
  mockResolve.mockImplementation(async (a) => [a.student_id]);
  mockSb.setTable('users', { data: { id: TEACHER, name: 'Mom', school: null, email: 'mom@x.com' }, error: null });
  mockSb.setTable('assignments', { data: created({ created_by_role: 'parent' }), error: null });

  await request(app).post('/assignments').send({
    title: 'Fractions', dueDate: '2026-09-30', studentId: STUDENT, createdById: 'Mom@X.com', createdByRole: 'parent',
  });

  expect(rpcEvents()[0]).toMatchObject({ actor_email: 'mom@x.com', actor_role: 'parent' });
});

test('rejected request → no notification', async () => {
  const res = await request(app).post('/assignments').send({ title: 'No due date' });
  expect(res.status).toBe(400);
  expect(mockSb.supabase.rpc).not.toHaveBeenCalled();
});

test('failed insert → no notification', async () => {
  mockSb.setTable('assignments', { data: null, error: { message: 'insert failed' } });
  const res = await request(app).post('/assignments').send({
    title: 'Fractions', dueDate: '2026-09-30', studentId: STUDENT, createdById: TEACHER,
  });
  expect(res.status).toBe(500);
  expect(mockSb.supabase.rpc).not.toHaveBeenCalled();
});

test('notification failure does not fail the assignment', async () => {
  mockResolve.mockRejectedValue(new Error('users query failed'));
  mockSb.setTable('assignments', { data: created(), error: null });
  const res = await request(app).post('/assignments').send({
    title: 'Fractions', dueDate: '2026-09-30', studentId: STUDENT, createdById: TEACHER,
  });
  expect(res.status).toBe(200);
  expect(logSpy.mock.calls.map(c => c[0]).some(l => /"ok":false/.test(l) && /users query failed/.test(l))).toBe(true);
});

test('legacy push + parent system message still run alongside V2', async () => {
  mockResolve.mockImplementation(async (a) => [a.student_id]);
  mockSb.setTable('assignments', { data: created(), error: null });
  mockSb.setTable('parent_children', { data: [{ parent_email: 'mom@x.com' }], error: null });
  await request(app).post('/assignments').send({
    title: 'Fractions', dueDate: '2026-09-30', studentId: STUDENT, createdById: TEACHER,
  });
  await new Promise(r => setImmediate(r));
  const { sendPush } = require('../../services/push');
  await new Promise(r => setTimeout(r, 20));
  expect(sendPush).toHaveBeenCalled();
  expect(mockSb.supabase.from.mock.calls.some(c => c[0] === 'messages')).toBe(true);
});
