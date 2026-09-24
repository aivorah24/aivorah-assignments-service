const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);
const { assignmentAssignedEvent, createNotificationEvent } = require('../../services/notify');

const row = (o = {}) => ({
  id: 'a1', title: 'Fractions', subject: 'Mathematics', type: 'assignment',
  due_date: '2026-09-30', created_at: '2026-09-24T10:00:00.123456+00:00', ...o,
});

let logSpy;
beforeEach(() => {
  mockSb.reset();
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe('assignmentAssignedEvent', () => {
  test('versions the event by the assignment’s created_at and carries the entity refs', () => {
    const e = assignmentAssignedEvent(row(), { studentIds: ['s1'], actorEmail: 't@x.com', actorRole: 'teacher' });
    expect(e).toEqual({
      type: 'assignment_assigned', entity_type: 'assignment', entity_id: 'a1',
      version: '2026-09-24T10:00:00.123456+00:00', student_ids: ['s1'],
      actor_email: 't@x.com', actor_role: 'teacher',
      title: 'New assignment: Fractions', body: 'Mathematics · Due 30 Sept',
      parent_title: 'New assignment for {child}: Fractions', parent_body: 'Mathematics · Due 30 Sept',
      data: { assignmentId: 'a1', assignmentType: 'assignment', subject: 'Mathematics', dueDate: '2026-09-30' },
    });
  });

  test('labels quizzes as quizzes', () => {
    const e = assignmentAssignedEvent(row({ type: 'quiz' }), { studentIds: ['s1'] });
    expect(e.title).toBe('New quiz: Fractions');
    expect(e.parent_title).toBe('New quiz for {child}: Fractions');
  });

  test('omits missing subject/due date from the body instead of printing blanks', () => {
    expect(assignmentAssignedEvent(row({ subject: '', due_date: null }), { studentIds: ['s1'] }).body).toBeNull();
  });
});

describe('createNotificationEvent', () => {
  const evt = () => assignmentAssignedEvent(row(), { studentIds: ['s1'], actorEmail: 't@x.com' });

  test('sends the event to notify_event and logs ids/counts without PII', async () => {
    mockSb.setTable('rpc:notify_event', { data: { eventKey: 'k', recipients: 2, duplicates: 0, inserted: [{ id: 'n1' }, { id: 'n2' }] }, error: null });
    const r = await createNotificationEvent(evt());
    expect(mockSb.supabase.rpc).toHaveBeenCalledWith('notify_event', { p_event: evt() });
    expect(r).toMatchObject({ ok: true, recipients: 2, duplicates: 0 });
    expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({ svc: 'assignments', ok: true, inserted: 2, notificationIds: ['n1', 'n2'] });
    expect(logSpy.mock.calls[0][0]).not.toMatch(/t@x\.com|Fractions/);
  });

  test('no eligible students → no database call', async () => {
    const r = await createNotificationEvent({ ...evt(), student_ids: [] });
    expect(r).toMatchObject({ ok: true, recipients: 0 });
    expect(mockSb.supabase.rpc).not.toHaveBeenCalled();
  });

  test('database error → ok:false, never throws', async () => {
    mockSb.setTable('rpc:notify_event', { data: null, error: { message: 'timeout' } });
    await expect(createNotificationEvent(evt())).resolves.toEqual({ ok: false, error: 'timeout' });
  });
});
