jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const request = require('supertest');
const app = require('../../index');

describe('POST /assignments/validate-fill-blank', () => {
  test('requires both a real studentAnswer and correctAnswer', async () => {
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: 'x' });
    expect(res.status).toBe(400);
  });

  test('an exact match (after normalization) is correct', async () => {
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: '  New Delhi  ', correctAnswer: 'new delhi' });
    expect(res.body.correct).toBe(true);
  });

  test('a real bare number matches a correct answer that has extra words ("4 novels")', async () => {
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: '4', correctAnswer: '4 novels' });
    expect(res.body.correct).toBe(true);
  });

  test('a real decimal and its equivalent fraction are treated as correct', async () => {
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: '0.5', correctAnswer: '1/2' });
    expect(res.body.correct).toBe(true);
  });

  test('a real different number is wrong, with no fuzzy leniency for numeric answers', async () => {
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: '5', correctAnswer: '4' });
    expect(res.body.correct).toBe(false);
  });

  test('a real text answer containing the correct answer is accepted ("new delhi" for "New Delhi, India")', async () => {
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: 'new delhi', correctAnswer: 'New Delhi, India' });
    expect(res.body.correct).toBe(true);
  });

  test('a real close-but-not-exact text answer within Levenshtein tolerance is accepted', async () => {
    // "phostosynthesis" vs "photosynthesis" — 1 char off, well within a 5-char-long answer's tolerance
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: 'phostosynthesis', correctAnswer: 'photosynthesis' });
    expect(res.body.correct).toBe(true);
  });

  test('a real completely wrong text answer is rejected', async () => {
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: 'banana', correctAnswer: 'photosynthesis' });
    expect(res.body.correct).toBe(false);
  });

  test('a real short (<5 char) answer gets no Levenshtein leniency, only exact/contains', async () => {
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: 'cta', correctAnswer: 'cat' });
    expect(res.body.correct).toBe(false);
  });

  // Only a correct answer is accepted; anything else is pointed out as wrong.
  test('a fragment of the correct answer is wrong ("a" for "Paris")', async () => {
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: 'a', correctAnswer: 'Paris' });
    expect(res.body.correct).toBe(false);
  });

  test('the correct comparison sign is accepted and a wrong one is rejected', async () => {
    const ok = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: '>', correctAnswer: '>' });
    const wrong = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: '<', correctAnswer: '>' });
    const sentence = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: '3/4 < 2/3', correctAnswer: '3/4 > 2/3' });
    expect(ok.body.correct).toBe(true);
    expect(wrong.body.correct).toBe(false);
    expect(sentence.body.correct).toBe(false);
  });

  test('a wrong answer in another script is rejected, the right one accepted', async () => {
    const wrong = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: 'हवा', correctAnswer: 'जल' });
    const ok = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: 'जल।', correctAnswer: 'जल' });
    expect(wrong.body.correct).toBe(false);
    expect(ok.body.correct).toBe(true);
  });
});
