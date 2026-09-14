// Deterministic visual-grounding enforcement — added 2026-09-13 after a
// live production test caught real hallucination: a text-only fallback
// (no vision provider available) confidently answered "What colors do you
// see?" with "red, blue, yellow" - a WRONG guess (the real image also had
// green) for a question it fundamentally could not see. This is enforced
// at the data-validation layer (enforceVisualGrounding), not via prompt
// wording alone - prompt wording is exactly what failed here.
//
// A real regression was caught and fixed while building this: checking
// only the answer against source text wrongly rejected the ALREADY-
// correct L-shaped-polygon perimeter case (answer=28, a computed sum of
// printed measurements 6/8/3 - the sum "28" itself is never printed
// anywhere, only its inputs are). Fixed by also checking the solution's
// cited numbers, which restate the real given measurements.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const { enforceVisualGrounding, isVisuallyDependentQuestion, isAnswerGroundedInSource, VISUAL_UNAVAILABLE_MESSAGE } = require('../../services/quizVision');

function quizWith(question, taskOverrides = {}) {
  return { tasks: [{ title: 'Task 1', sharedImage: false, ...taskOverrides, questions: [question] }] };
}

describe('isVisuallyDependentQuestion', () => {
  test('flags a question with hasImage: true', () => {
    expect(isVisuallyDependentQuestion({ hasImage: true, question: 'anything' }, {})).toBe(true);
  });
  test('flags a question whose task has sharedImage: true', () => {
    expect(isVisuallyDependentQuestion({ hasImage: false, question: 'anything' }, { sharedImage: true })).toBe(true);
  });
  test('flags a question by phrasing alone, even with no image flags set', () => {
    expect(isVisuallyDependentQuestion({ hasImage: false, question: 'What colors do you see in the picture?' }, {})).toBe(true);
    expect(isVisuallyDependentQuestion({ hasImage: false, question: 'Name this shape.' }, {})).toBe(true);
    expect(isVisuallyDependentQuestion({ hasImage: false, question: 'Look at the diagram and answer.' }, {})).toBe(true);
  });
  test('does NOT flag an ordinary text-only question', () => {
    expect(isVisuallyDependentQuestion({ hasImage: false, question: 'What is 2 + 2?' }, {})).toBe(false);
  });
});

describe('isAnswerGroundedInSource', () => {
  test('a computed numeric answer is grounded via its SOLUTION citing real printed measurements', () => {
    expect(isAnswerGroundedInSource(28, 'Adding 8+6+5+3+3+3 = 28', '5m 6m 8m 3m')).toBe(true);
  });
  test('an answer with no textual basis anywhere (answer or solution) is not grounded', () => {
    expect(isAnswerGroundedInSource('red, blue, yellow', 'The diagram has three colors.', 'Look at the diagram a) What colors do you see?')).toBe(false);
  });
  test('a word answer that merely happens to appear elsewhere in the document (unrelated section) is NOT grounded - the real bug caught by a blind unseen-document test', () => {
    // A real Computer Science worksheet's diagram showed "PC A -- Router
    // -- PC B", but the system answered "switch" (wrong) because "switch"
    // is a real word from an earlier, unrelated term-matching table in
    // the same document - word/phrase-overlap grounding was removed
    // entirely for this exact reason (see isAnswerGroundedInSource's own
    // comment). Only numeric evidence is trusted now.
    const sourceText = 'Activity C: Match the Term to its Definition\nRouter | Directs data packets between networks\nSwitch | Connects devices within the same network\nChallenge: Diagram\n6. What device connects PC A and PC B in the diagram above?';
    expect(isAnswerGroundedInSource('switch', 'The diagram shows a switch linking PC A and PC B, so the answer is switch.', sourceText)).toBe(false);
  });

  test('null/empty answers are never considered grounded', () => {
    expect(isAnswerGroundedInSource(null, 'x', 'anything')).toBe(false);
    expect(isAnswerGroundedInSource('', 'x', 'anything')).toBe(false);
  });
});

describe('enforceVisualGrounding - TASK 1 required scenarios', () => {
  test('scenario: image-dependent question + no vision provider -> answer nulled, honest message, flagged', () => {
    const quiz = quizWith({ hasImage: true, question: 'What shape is this?', answer: 'octagon', solution: 'It looks like an octagon.' });
    enforceVisualGrounding(quiz, { visualUnderstandingAvailable: false, sourceText: 'Task 1' });
    const q = quiz.tasks[0].questions[0];
    expect(q.answer).toBeNull();
    expect(q.solution).toBe(VISUAL_UNAVAILABLE_MESSAGE);
    expect(q.visualUnderstandingRequired).toBe(true);
  });

  test('scenario: image-dependent question + vision provider available -> answer is trusted, untouched', () => {
    const quiz = quizWith({ hasImage: true, question: 'What shape is this?', answer: 'octagon', solution: 'A regular octagon has 8 sides.' });
    enforceVisualGrounding(quiz, { visualUnderstandingAvailable: true, sourceText: '' });
    const q = quiz.tasks[0].questions[0];
    expect(q.answer).toBe('octagon'); // untouched - a real vision provider actually looked at it
    expect(q.visualUnderstandingRequired).toBeUndefined();
  });

  test('scenario: text-only question -> never touched, regardless of vision availability', () => {
    const quiz = quizWith({ hasImage: false, question: 'What is 12 + 7?', answer: 19, solution: '12 + 7 = 19' });
    enforceVisualGrounding(quiz, { visualUnderstandingAvailable: false, sourceText: 'irrelevant' });
    expect(quiz.tasks[0].questions[0].answer).toBe(19);
  });

  test('scenario: mixed worksheet with both text-only and visual-dependent questions - only the visual one is affected', () => {
    const quiz = {
      tasks: [{
        title: 'Task 1', sharedImage: false,
        questions: [
          { hasImage: false, question: 'What is 5 + 5?', answer: 10, solution: '5 + 5 = 10' },
          { hasImage: true, question: 'What animal is shown?', answer: 'a rabbit', solution: 'The picture shows a rabbit.' },
        ],
      }],
    };
    enforceVisualGrounding(quiz, { visualUnderstandingAvailable: false, sourceText: 'Task 1: 5 + 5' });
    expect(quiz.tasks[0].questions[0].answer).toBe(10); // text-only, untouched
    expect(quiz.tasks[0].questions[1].answer).toBeNull(); // visual-dependent, ungrounded, overridden
  });

  test('scenario: diagram-dependent MATH question with printed measurements -> grounded, answer preserved (the real L-shape regression case)', () => {
    const quiz = quizWith({
      hasImage: true,
      question: 'Find the perimeter of the L‑shaped polygon whose outer sides measure 6 m, 8 m and 3 m as shown.',
      answer: 28, unit: 'm',
      solution: 'The outer edges are: 8 m (top), 6 m (left), 5 m (bottom), 3 m, 3 m, 3 m. Adding: 8+6+5+3+3+3=28 m.',
    });
    enforceVisualGrounding(quiz, { visualUnderstandingAvailable: false, sourceText: 'Task 2: Find the perimeter of the L shaped polygon. 5m 6m 8m 3m' });
    expect(quiz.tasks[0].questions[0].answer).toBe(28); // must NOT be nulled - it's genuinely grounded
  });

  test('scenario: photograph/object-identification question with zero textual basis -> declined, not guessed', () => {
    const quiz = quizWith({
      hasImage: true,
      question: 'Identify the object shown in the photograph.',
      answer: 'a microscope',
      solution: 'The photograph shows a microscope on a table.',
    });
    enforceVisualGrounding(quiz, { visualUnderstandingAvailable: false, sourceText: 'Task 3: Look at the photo and answer the question.' });
    const q = quiz.tasks[0].questions[0];
    expect(q.answer).toBeNull();
    expect(q.visualUnderstandingRequired).toBe(true);
  });
});

describe('enforceVisualGrounding - image asset preservation is independent of understanding', () => {
  test('an overridden (nulled) question KEEPS its real imageUrl - asset preservation and understanding are separate concerns', () => {
    const quiz = quizWith({
      hasImage: true,
      question: 'What colors do you see?',
      answer: 'red, blue, yellow',
      solution: 'Three colors are visible.',
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/real-image.png',
    });
    enforceVisualGrounding(quiz, { visualUnderstandingAvailable: false, sourceText: 'Task: look at the picture' });
    const q = quiz.tasks[0].questions[0];
    expect(q.answer).toBeNull();
    expect(q.imageUrl).toBe('https://res.cloudinary.com/demo/image/upload/v1/real-image.png'); // preserved regardless
  });
});
