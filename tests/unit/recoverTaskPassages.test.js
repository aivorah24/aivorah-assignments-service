// Live 2026-10-26: Gemini was down, the Groq text fallback built "Vocabulary
// Building 28" without Task 3's story, so students saw only "Incorrect word:
// seller – correct word:" with nothing to read.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { recoverTaskPassages } = require('../../services/quizVision');

const VB28 = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'vocabulary-building-28-source.txt'), 'utf8');
const VB28_PASSAGE = 'In a small town, there was a busy buyer where people came every day.';

const VB29 = `Task 1: Fix it like a pro! Spot the incorrect words in the given story and replace them with the correct ones.

[TABLE - EXACT VALUES, DO NOT ALTER]
Riya went to the market with her mother to do some barter . She had ₹200 as her expense for the day. As they walked around, Riya checked the income of fruits and vegetables before deciding what to buy.
Incorrect Word | Correct Word
barter |
[/TABLE]

[TABLE - EXACT VALUES, DO NOT ALTER]
Think and reflect: How do the words like value, budget, expense, and profit help us make smart decisions in real life? Give one example from your daily life.
[/TABLE]
Task 2: Travel through time!
Example: | Example: |
`;

const task = (title, extra = {}) => ({ title, questions: [{ id: 'a', question: 'Incorrect word: seller – correct word:' }], ...extra });

test('a passage the AI dropped is restored verbatim from that task\'s section', () => {
  const quiz = { tasks: [task('Task 1: Riddles'), task('Task 3: Error Detective Alert'), task('Task 4: Word to Sentence Challenge!')] };
  recoverTaskPassages(quiz, VB28);
  expect(quiz.tasks[1].passage.startsWith(VB28_PASSAGE)).toBe(true);
  expect(quiz.tasks[1].passage).toContain("kept the town's trade active and growing.");
  expect(quiz.tasks[0].passage).toBeUndefined();
  expect(quiz.tasks[2].passage).toBeUndefined();
});

test('a dropped worked example is restored on the first question', () => {
  const quiz = { tasks: [task('Task 4: Word to Sentence Challenge!')] };
  recoverTaskPassages(quiz, VB28);
  expect(quiz.tasks[0].questions[0].example).toBe('The buyer went to the market to purchase goods from the seller.');
});

test('story inside a table is restored; reflection questions and empty "Example:" cells are not', () => {
  const quiz = { tasks: [task('Task 1: Fix it like a pro!'), task('Task 2: Travel through time!')] };
  recoverTaskPassages(quiz, VB29);
  expect(quiz.tasks[0].passage).toMatch(/^Riya went to the market with her mother to do some barter\. She had ₹200/);
  expect(quiz.tasks[0].passage).not.toMatch(/Think and reflect/);
  expect(quiz.tasks[1].passage).toBeUndefined();
  expect(quiz.tasks[1].questions[0].example).toBeUndefined();
});

test('never overwrites what the AI returned, and skips text already in a question', () => {
  const quiz = { tasks: [
    task('Task 3: Error Detective Alert', { passage: 'AI passage' }),
  ] };
  recoverTaskPassages(quiz, VB28);
  expect(quiz.tasks[0].passage).toBe('AI passage');

  const inQuestion = { tasks: [{ title: 'Task 3: Error Detective', questions: [{ question: `Read: ${VB28_PASSAGE} Farmers were involved in consumption, growing crops using natural goods like water and soil.` }] }] };
  recoverTaskPassages(inQuestion, VB28);
  expect(inQuestion.tasks[0].passage).toBeUndefined();
});

test('no "Task N" headings in the source: nothing changes', () => {
  const quiz = { tasks: [task('Spot the errors')] };
  recoverTaskPassages(quiz, 'A long story. '.repeat(30));
  expect(quiz.tasks[0].passage).toBeUndefined();
});
