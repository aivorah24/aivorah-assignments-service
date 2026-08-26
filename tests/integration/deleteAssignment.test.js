const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

beforeEach(() => {
  mockSb.reset();
});

describe('DELETE /assignments/:id', () => {
  test('deletes the real assignment and its linked schedule event, returns ok', async () => {
    mockSb.setTable('schedule_events', { data: null, error: null });
    mockSb.setTable('assignments', { data: null, error: null });

    const res = await request(app).delete('/assignments/a1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('a real Supabase error deleting the assignment returns 500 with the real error message', async () => {
    mockSb.setTable('schedule_events', { data: null, error: null });
    mockSb.setTable('assignments', { data: null, error: { message: 'delete failed' } });

    const res = await request(app).delete('/assignments/a1');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('delete failed');
  });

  test('a schedule_events delete failure does not block the assignment delete (best-effort, caught)', async () => {
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'schedule_events') {
        return { delete: () => ({ eq: () => Promise.reject(new Error('schedule delete blew up')) }) };
      }
      return {
        delete: jest.fn(function () { return this; }),
        eq: jest.fn(function () { return this; }),
        then: (resolve) => Promise.resolve({ data: null, error: null }).then(resolve),
      };
    });

    const res = await request(app).delete('/assignments/a1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
