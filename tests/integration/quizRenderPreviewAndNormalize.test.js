// POST /quiz/render-preview and POST /quiz/normalize — ported from the
// monolith (2026-09-11, B05). Both are pure JSON transforms (no Gemini/Groq/
// Cloudinary calls) — verified by reading every normalizer before porting.
// recoverBarCharts (Gemini vision chart recovery) is deliberately NOT ported
// here; a worksheet needing it still renders with the raw scanned image
// instead of an interactive chart.
jest.mock('../../services/supabase', () => ({ from: jest.fn(() => ({ select: () => ({ in: () => Promise.resolve({ data: [] }) }) })) }));

const request = require('supertest');
const app = require('../../index');

describe('POST /quiz/render-preview — validation', () => {
  test('rejects a body with no tasks', async () => {
    const res = await request(app).post('/quiz/render-preview').send({ quiz: { title: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No quiz data provided/);
  });
});

describe('POST /quiz/render-preview — real rendering', () => {
  test('renders real HTML containing the quiz title and a real question', async () => {
    const res = await request(app).post('/quiz/render-preview').send({
      quiz: {
        title: 'Fractions Practice',
        tasks: [{
          title: 'Task 1',
          questions: [{ id: 'q1', question: 'What is 1/2 + 1/4?', type: 'text', answer: '3/4' }],
        }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // Fractions are shown stacked, as printed on worksheets.
    expect(res.text).toContain('What is <span class="frac"><span>1</span><span>2</span></span> + <span class="frac"><span>1</span><span>4</span></span>?');
  });

  test('autoDetectMCQ converts an inline-options text question into a real MCQ before rendering', async () => {
    const res = await request(app).post('/quiz/render-preview').send({
      quiz: {
        title: 'Units Quiz',
        tasks: [{
          title: 'Tick the correct option',
          questions: [{ id: 'q1', question: 'A pencil is about: (2 cm / 15 cm / 2 m)', type: 'text', answer: '15 cm' }],
        }],
      },
    });
    expect(res.status).toBe(200);
    // The parenthesized options must have been stripped from the question text
    // and rendered as real selectable MCQ options instead.
    expect(res.text).not.toContain('(2 cm / 15 cm / 2 m)');
    expect(res.text).toContain('15 cm');
    expect(res.text).toContain('2 m');
  });
});

describe('POST /quiz/normalize — validation', () => {
  test('rejects a body with no tasks', async () => {
    const res = await request(app).post('/quiz/normalize').send({ quiz: {} });
    expect(res.status).toBe(400);
  });
});

describe('POST /quiz/normalize — real structural normalization', () => {
  test('collapses a real riddle set into a table', async () => {
    const res = await request(app).post('/quiz/normalize').send({
      quiz: {
        tasks: [{
          title: 'Riddle Time',
          questions: [
            { id: 'q1', question: 'I am a fruit and I am red.', answer: 'apple' },
            { id: 'q2', question: 'I am yellow and curved.', answer: 'banana' },
            { id: 'q3', question: 'I am small and purple.', answer: 'grape' },
          ],
        }],
      },
    });
    expect(res.status).toBe(200);
    const task = res.body.quiz.tasks[0];
    expect(task.table.headers).toEqual(['No.', 'Riddle', 'Answer']);
    expect(task.table.rows).toHaveLength(3);
    expect(task.questions).toEqual([]);
  });

  test('parses a real bar-graph description into structured chart bars', async () => {
    const res = await request(app).post('/quiz/normalize').send({
      quiz: {
        tasks: [{
          title: 'Favourite Sports Bar Graph',
          sharedImageDescription: 'A bar graph titled "Favourite Sports": football has 16, tennis has 8, chess has 4',
          questions: [{ id: 'q1', question: 'How many votes did football get?', type: 'text', answer: '16' }],
        }],
      },
    });
    expect(res.status).toBe(200);
    const chart = res.body.quiz.tasks[0].chart;
    expect(chart.type).toBe('bar');
    expect(chart.bars.length).toBeGreaterThanOrEqual(2);
    expect(chart.bars.map(b => b.label.toLowerCase())).toEqual(expect.arrayContaining(['football', 'tennis']));
  });

  test('converts a real matching task into per-item MCQs with a shared word bank', async () => {
    const res = await request(app).post('/quiz/normalize').send({
      quiz: {
        tasks: [{
          title: 'Match the animal to its sound',
          questions: [
            { id: 'q1', question: 'Match: Dog', answer: 'Bark' },
            { id: 'q2', question: 'Match: Cat', answer: 'Meow' },
            { id: 'q3', question: 'Match: Cow', answer: 'Moo' },
          ],
        }],
      },
    });
    expect(res.status).toBe(200);
    const task = res.body.quiz.tasks[0];
    expect(task._matchTask).toBe(true);
    expect(task._wordBank).toEqual(expect.arrayContaining(['Bark', 'Meow', 'Moo']));
    expect(task.questions.every(q => q.type === 'mcq' && q.options.some(o => o.correct))).toBe(true);
  });
});
