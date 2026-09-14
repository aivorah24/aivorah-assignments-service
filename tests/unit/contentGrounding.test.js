// flagUngroundedTaskContent — added 2026-09-14 (Task 3: strengthen
// source grounding, with explicit attention to Telugu/Indic text per the
// acceptance criteria).
//
// Root cause: a live determinism run on the real Telugu worksheet
// revealed a fabrication mode enforceVisualGrounding does NOT cover -
// the source text for a "rewrite these given sentences" task contains
// ONLY the instruction line (the actual example sentences exist as blank
// handwriting lines, unreadable by text extraction), and the model
// invented entirely new Telugu sentences wholesale instead of declining.
// This wasn't caught by enforceVisualGrounding because the question
// isn't flagged hasImage/sharedImage, and its VISUAL_DEPENDENCY_PATTERN
// is English-only phrasing - silently missing non-English worksheets.
// This check is deliberately language-agnostic (Unicode-property
// tokenization, not keyword matching) and NON-destructive (a flag for
// review, not a null-out) - some legitimate generation (new practice
// problems following a given pattern) can share no literal tokens with
// source text without being wrong.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const { flagUngroundedTaskContent, extractContentTokens, CONTENT_GROUNDING_NOTE } = require('../../services/quizVision');

describe('extractContentTokens - language-agnostic tokenization', () => {
  test('tokenizes English text', () => {
    expect(extractContentTokens('Reduce 28/50 to lowest terms')).toEqual(expect.arrayContaining(['Reduce', '28', '50', 'to', 'lowest', 'terms']));
  });
  test('tokenizes Telugu text (Unicode script, not just ASCII)', () => {
    const tokens = extractContentTokens('మారము పాఠశాలకి వెళ్లాడు');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).toContain('మారము');
  });
});

describe('flagUngroundedTaskContent', () => {
  test('the exact real live-observed fabrication case: invented Telugu example sentences not in the source text', () => {
    const quiz = { tasks: [{
      title: 'అ)  కింది వాక్యా లలో గ, ట ఒత్తు పదాలకు సున్నా చుట్టి, రాయిండి.',
      questions: [
        { question: '1. మా○రము పాఠశాలకి వెళ్లాడు.', answer: 'మారము' },
        { question: '2. అతను బొ○లెను తిన్నాడు.', answer: 'బొటలెను' },
      ],
    }] };
    const sourceText = 'అ)  కింది వాక్యాల్లో గ, ట ఒత్తు పదాలకు సున్నా చుట్టి, రాయండి.';
    flagUngroundedTaskContent(quiz, { visualUnderstandingAvailable: false, sourceText });
    expect(quiz.tasks[0].contentGroundingUncertain).toBe(true);
    expect(quiz.tasks[0].contentGroundingNote).toBe(CONTENT_GROUNDING_NOTE);
  });

  test('genuinely grounded content (real fraction table, English) is NOT flagged', () => {
    const quiz = { tasks: [{
      title: 'Task 2: Reduce the fractions to their lowest terms.',
      questions: [
        { question: 'Reduce 28/50 to its lowest terms.', answer: '14/25' },
        { question: 'Reduce 8/24 to its lowest terms.', answer: '1/3' },
      ],
    }] };
    const sourceText = 'Task 2: Reduce the fractions to their lowest terms.\n1) 28/50 | 5) 32/48\n2) 8/24';
    flagUngroundedTaskContent(quiz, { visualUnderstandingAvailable: false, sourceText });
    expect(quiz.tasks[0].contentGroundingUncertain).toBeUndefined();
  });

  test('a real vision provider (visualUnderstandingAvailable: true) is always trusted, never flagged', () => {
    const quiz = { tasks: [{ title: 'Task', questions: [{ question: 'totally novel content not in any text', answer: 'x' }] }] };
    flagUngroundedTaskContent(quiz, { visualUnderstandingAvailable: true, sourceText: 'irrelevant' });
    expect(quiz.tasks[0].contentGroundingUncertain).toBeUndefined();
  });

  test('a question already handled by enforceVisualGrounding (visualUnderstandingRequired) is skipped here, not double-flagged', () => {
    const quiz = { tasks: [{ title: 'Task', questions: [{ question: 'unrelated to source', answer: null, visualUnderstandingRequired: true }] }] };
    flagUngroundedTaskContent(quiz, { visualUnderstandingAvailable: false, sourceText: 'Task' });
    expect(quiz.tasks[0].contentGroundingUncertain).toBeUndefined();
  });

  test('empty source text never triggers a flag (nothing to compare against, not a false alarm)', () => {
    const quiz = { tasks: [{ title: 'Task', questions: [{ question: 'anything', answer: 'x' }] }] };
    flagUngroundedTaskContent(quiz, { visualUnderstandingAvailable: false, sourceText: '' });
    expect(quiz.tasks[0].contentGroundingUncertain).toBeUndefined();
  });

  test('a task with only title-vocabulary overlap (no real question content to check) is not flagged', () => {
    const quiz = { tasks: [{ title: 'Task', questions: [] }] };
    flagUngroundedTaskContent(quiz, { visualUnderstandingAvailable: false, sourceText: 'Task some other content' });
    expect(quiz.tasks[0].contentGroundingUncertain).toBeUndefined();
  });
});
