// GET /quiz/transliterate — proxy for the student quiz IME (Google Input Tools).
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const request = require('supertest');
const app = require('../../index');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('GET /quiz/transliterate', () => {
  test('returns script suggestions for a supported language', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ['SUCCESS', [['amma', ['అమ్మ', 'అమ్మా'], [], {}]]] });
    const res = await request(app).get('/quiz/transliterate').query({ text: 'amma', lang: 'te' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suggestions: ['అమ్మ', 'అమ్మా'] });
    expect(global.fetch.mock.calls[0][0]).toContain('itc=te-t-i0-und');
    expect(global.fetch.mock.calls[0][0]).toContain('text=amma');
  });

  test('works for any Indic IME language (e.g. Tamil)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ['SUCCESS', [['amma', ['அம்மா'], [], {}]]] });
    const res = await request(app).get('/quiz/transliterate').query({ text: 'amma', lang: 'ta' });
    expect(res.body.suggestions).toEqual(['அம்மா']);
  });

  test('unsupported language or empty text → empty list, no upstream call', async () => {
    global.fetch = jest.fn();
    expect((await request(app).get('/quiz/transliterate').query({ text: 'hi', lang: 'xx' })).body).toEqual({ suggestions: [] });
    expect((await request(app).get('/quiz/transliterate').query({ text: '', lang: 'hi' })).body).toEqual({ suggestions: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an upstream failure degrades to an empty list, never a 500', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network'));
    const res = await request(app).get('/quiz/transliterate').query({ text: 'namaste', lang: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suggestions: [] });
  });
});
