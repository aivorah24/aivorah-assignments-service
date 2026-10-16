// services/worksheet/sourceAlignment: what the model dropped or flattened is
// put back from the worksheet's own text. 2026-10-16 manual test on the
// "Vocabulary Building 28" .docx: Task 3's passage and Task 4's example were
// missing, and both fill-in tables came out as stacks of answer boxes.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const fs = require('fs');
const path = require('path');
const { alignTasksWithSource, taskSections } = require('../../services/worksheet/sourceAlignment');

// htmlToStructuredText output for a .docx shaped like the real worksheet
// (Task 3 = passage cell + nested correction table).
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'vocabulary-building-28-docx-structured.txt'), 'utf8');
const WRONG = ['buyer', 'consumption', 'goods', 'production', 'seller', 'market', 'trade'];

// What the model returned live.
const liveQuiz = () => ({
  tasks: [
    { title: 'Task 2 · Word Sorting Challenge: Build the Economy!', questions: [
      { id: 'a', question: 'People (Who is involved?)', type: 'text', answer: 'buyer, seller' },
      { id: 'b', question: 'Actions (What is happening?)', type: 'text', answer: 'production, consumption, trade' },
      { id: 'c', question: 'Places / Systems (Where does it happen?)', type: 'text', answer: 'market, economy' },
      { id: 'd', question: 'Things (What is used or exchanged?)', type: 'text', answer: 'goods, services, resources' },
    ] },
    { title: 'Task 3 · Error Detective Alert - Read & Detect Errors', questions: WRONG.map((w, i) => ({ id: String(i), question: `Incorrect word: ${w} – correct word:`, type: 'text', answer: `fix-${w}` })) },
    { title: 'Task 4 · Word to Sentence Challenge!', questions: [{ id: 'a', question: 'Write your own sentence using two or more vocabulary words.', type: 'long' }] },
  ],
});

test('each task finds its own part of the worksheet', () => {
  const [t2, t3, t4] = taskSections(liveQuiz(), SOURCE);
  expect(t2).toMatch(/^Task 2: Word Sorting/);
  expect(t3).toMatch(/^Task 3: Error Detective/);
  expect(t3).not.toMatch(/Task 4/);
  expect(t4).toMatch(/Example: The buyer went to the market/);
});

test('the dropped passage, example and instructions come back', () => {
  const quiz = liveQuiz();
  alignTasksWithSource(quiz, SOURCE);
  expect(quiz.tasks[1].passage).toMatch(/^In a small town, there was a busy buyer/);
  expect(quiz.tasks[1].passage).toMatch(/kept the town's trade active and growing\.$/);
  expect(quiz.tasks[2].example).toBe('The buyer went to the market to purchase goods from the seller.');
  expect(quiz.tasks[1].instructions).toMatch(/^Read the passage carefully/);
});

test('fill-in tables are laid out like the worksheet, every answer kept', () => {
  const quiz = liveQuiz();
  alignTasksWithSource(quiz, SOURCE);
  const t3 = quiz.tasks[1].table;
  expect(t3.headers).toEqual(['Incorrect Word', 'Correct Word']);
  expect(t3.rows.map(r => r[0].text)).toEqual(WRONG);
  expect(t3.rows.map(r => r[1].answer)).toEqual(WRONG.map(w => `fix-${w}`));
  expect(quiz.tasks[1].questions).toEqual([]);
  expect(quiz.tasks[0].table.headers).toEqual(['Category', 'Words']);
  expect(quiz.tasks[0].table.rows[0][1].answer).toBe('buyer, seller');
});

test('nothing is duplicated when the model already got it right', () => {
  const quiz = liveQuiz();
  quiz.tasks[1].passage = 'In a small town, there was a busy buyer where people came every day. Farmers were involved in consumption, growing crops using natural goods like water and soil.';
  quiz.tasks[2].questions[0].example = 'The buyer went to the market to purchase goods from the seller.';
  quiz.tasks[1].title += ' Read the passage carefully. Some vocabulary words are used incorrectly. Identify and correct them.';
  const report = alignTasksWithSource(quiz, SOURCE);
  expect(report.passages).toBe(0);
  expect(report.examples).toBe(0);
  expect(quiz.tasks[1].instructions).toBeUndefined();
});

test('a table is only built when every question of the task is one of its rows (no question is ever hidden)', () => {
  const quiz = liveQuiz();
  quiz.tasks[1].questions.push({ id: 'x', question: 'Why were these words wrong?', type: 'text', answer: 'x' });
  alignTasksWithSource(quiz, SOURCE);
  expect(quiz.tasks[1].table).toBeUndefined();
  expect(quiz.tasks[1].questions).toHaveLength(8);
});

test('the older flattened layout (passage inside the table header) is understood too', () => {
  const flattened = SOURCE.replace(/\n\n(In a small town[^\n]+)\n\n\[TABLE - EXACT VALUES, DO NOT ALTER\]\nIncorrect Word \| Correct Word/,
    '\n[TABLE - EXACT VALUES, DO NOT ALTER]\n$1 | Incorrect Word | Correct Word');
  expect(flattened).not.toBe(SOURCE);
  const quiz = liveQuiz();
  alignTasksWithSource(quiz, flattened);
  expect(quiz.tasks[1].passage).toMatch(/^In a small town/);
  expect(quiz.tasks[1].table.headers).toEqual(['Incorrect Word', 'Correct Word']);
});

test('no worksheet text, or a task not in it: nothing changes', () => {
  const quiz = liveQuiz();
  expect(alignTasksWithSource(quiz, '')).toEqual({ instructions: 0, passages: 0, examples: 0, tables: 0 });
  const other = { tasks: [{ title: 'Task 9 · Something else', questions: [{ id: 'a', question: 'Q?', answer: 'A' }] }] };
  alignTasksWithSource(other, SOURCE);
  expect(other.tasks[0].questions).toHaveLength(1);
});
