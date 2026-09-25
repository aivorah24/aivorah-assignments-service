const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const STUDENT = '11111111-1111-1111-1111-111111111111';

const notificationUpdates = () => mockSb.supabase.from.mock.calls
  .map((c, i) => (c[0] === 'notifications' ? mockSb.supabase.from.mock.results[i].value : null))
  .filter(chain => chain && chain.update.mock.calls.length);

// The clear runs after the response is sent (res 'finish'), so wait for it.
const settle = () => new Promise(r => setTimeout(r, 30));

let logSpy;
beforeEach(() => {
  mockSb.reset();
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  mockSb.setTable('notifications', { data: [{ id: 'n1' }], error: null });
});
afterEach(() => logSpy.mockRestore());

describe('completing an assignment clears the student’s open notifications for it', () => {
  test('PUT /:id/complete → that student’s + their parents’ rows for this assignment are marked read', async () => {
    mockSb.setTable('assignments', [{ data: { due_date: null }, error: null }, { data: { id: 'a1', title: 'T' }, error: null }]);
    mockSb.setTable('assignment_submissions', { data: null, error: null });

    const res = await request(app).put('/assignments/a1/complete').send({ studentId: STUDENT, score: 90 });
    expect(res.status).toBe(200);
    await settle();

    const [q] = notificationUpdates();
    expect(q.update).toHaveBeenCalledWith({ read_at: expect.any(String) });
    expect(q.eq).toHaveBeenCalledWith('entity_type', 'assignment');
    expect(q.eq).toHaveBeenCalledWith('entity_id', 'a1');
    expect(q.is).toHaveBeenCalledWith('read_at', null);
    expect(q.or).toHaveBeenCalledWith(`recipient_id.eq.${STUDENT},child_id.eq.${STUDENT}`);
  });

  test('a rejected completion (past due) clears nothing', async () => {
    mockSb.setTable('assignments', { data: { due_date: '2000-01-01' }, error: null });
    const res = await request(app).put('/assignments/a1/complete').send({ studentId: STUDENT });
    expect(res.status).toBe(403);
    await settle();
    expect(notificationUpdates()).toHaveLength(0);
  });

  test('a failed completion (DB error) clears nothing', async () => {
    mockSb.setTable('assignments', { data: { due_date: null }, error: null });
    mockSb.setTable('assignment_submissions', { data: null, error: { message: 'write failed' } });
    const res = await request(app).put('/assignments/a1/complete').send({ studentId: STUDENT });
    expect(res.status).toBe(500);
    await settle();
    expect(notificationUpdates()).toHaveLength(0);
  });

  test('a clear failure never affects the completion response', async () => {
    mockSb.setTable('assignments', [{ data: { due_date: null }, error: null }, { data: { id: 'a1', title: 'T' }, error: null }]);
    mockSb.setTable('assignment_submissions', { data: null, error: null });
    mockSb.setTable('notifications', { data: null, error: { message: 'db down' } });
    const res = await request(app).put('/assignments/a1/complete').send({ studentId: STUDENT });
    expect(res.status).toBe(200);
    await settle();
    const line = logSpy.mock.calls.map(c => c[0]).find(l => /notification\.clear/.test(l));
    expect(JSON.parse(line)).toMatchObject({ ok: false, reason: 'db down' });
  });
});

test('deleting an assignment clears every recipient’s open notification for it', async () => {
  mockSb.setTable('assignments', { data: null, error: null });
  const res = await request(app).delete('/assignments/a1');
  expect(res.status).toBe(200);
  const [q] = notificationUpdates();
  expect(q.eq).toHaveBeenCalledWith('entity_id', 'a1');
  expect(q.or).not.toHaveBeenCalled();
});
