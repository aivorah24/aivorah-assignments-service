jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
// The AI meaning check (word answers only). Default: it says "incorrect".
const mockGroq = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: (...a) => mockGroq(...a) } } })));
const mockGemini = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({ getGenerativeModel: () => ({ generateContent: (...a) => mockGemini(...a) }) })),
}));
const aiSays = verdict => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdict, reason: '' }) } }] });
beforeEach(() => { mockGroq.mockReset().mockResolvedValue(aiSays('incorrect')); mockGemini.mockReset(); });

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

  test('a negative number is not its positive, and thousands commas are read', async () => {
    const neg = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: '3', correctAnswer: '-3' });
    const thou = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: '4,000', correctAnswer: '4000' });
    expect(neg.body.correct).toBe(false);
    expect(thou.body.correct).toBe(true);
  });

  test('a right word in other words is accepted by the AI meaning check ("Gandhiji")', async () => {
    mockGroq.mockResolvedValue(aiSays('correct'));
    const res = await request(app).post('/assignments/validate-fill-blank')
      .send({ studentAnswer: 'Gandhiji', correctAnswer: 'Mahatma Gandhi', question: 'The Father of the Nation is ___.' });
    expect(res.body.correct).toBe(true);
    expect(mockGroq.mock.calls[0][0].messages[0].content).toContain('Question: The Father of the Nation is ___.');
  });

  test('"partly right" is still wrong for a blank', async () => {
    mockGroq.mockResolvedValue(aiSays('partial'));
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: 'Gandhi', correctAnswer: 'Mahatma Gandhi' });
    expect(res.body.correct).toBe(false);
  });

  test('numbers, signs and exact matches never go to the AI', async () => {
    await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: '5', correctAnswer: '4' });
    await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: '<', correctAnswer: '>' });
    await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: 'paris', correctAnswer: 'Paris' });
    expect(mockGroq).not.toHaveBeenCalled();
  });

  test('AI down (Groq and Gemini): the exact check stands, the request does not fail', async () => {
    mockGroq.mockRejectedValue(new Error('429'));
    mockGemini.mockRejectedValue(new Error('503'));
    const res = await request(app).post('/assignments/validate-fill-blank').send({ studentAnswer: 'Gandhiji', correctAnswer: 'Mahatma Gandhi' });
    expect(res.status).toBe(200);
    expect(res.body.correct).toBe(false);
  });
});
