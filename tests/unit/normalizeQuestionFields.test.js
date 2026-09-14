// normalizeQuestionFields — added 2026-09-14 after a live determinism
// test on the real Telugu worksheet caught a real, separate correctness
// gap: the model occasionally writes a question's text under a non-
// canonical field name ("prompt" instead of "question", alongside extra
// unspecified fields like "task_id"/"instruction"). findIncompleteTasks
// did NOT catch this - the questions array was non-empty, just using the
// wrong key - so this would have reached quizHtmlRenderer.js as a
// question with BLANK text shown to the student despite the pipeline
// reporting "extractionStatus: ok".
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const { normalizeQuestionFields, findIncompleteTasks } = require('../../services/quizVision');

describe('normalizeQuestionFields', () => {
  test('recovers question text from the real live-observed alias "prompt"', () => {
    const quiz = { tasks: [{ title: 'T1', questions: [{ prompt: '1. గము పండు తింటాడు.', answer: null }] }] };
    normalizeQuestionFields(quiz);
    expect(quiz.tasks[0].questions[0].question).toBe('1. గము పండు తింటాడు.');
  });

  test('recovers from other common aliases too (text, q, questionText)', () => {
    const quiz = { tasks: [{ title: 'T1', questions: [
      { text: 'via text alias' },
      { q: 'via q alias' },
      { questionText: 'via questionText alias' },
    ] }] };
    normalizeQuestionFields(quiz);
    expect(quiz.tasks[0].questions.map(q => q.question)).toEqual(['via text alias', 'via q alias', 'via questionText alias']);
  });

  test('a question that already has real question text is left untouched, even if aliases are also present', () => {
    const quiz = { tasks: [{ title: 'T1', questions: [{ question: 'the real one', prompt: 'should be ignored' }] }] };
    normalizeQuestionFields(quiz);
    expect(quiz.tasks[0].questions[0].question).toBe('the real one');
  });

  test('a question with NO recoverable text under any known field is dropped entirely - blank UI is worse than no question', () => {
    const quiz = { tasks: [{ title: 'T1', questions: [
      { question: 'keep me', answer: 'x' },
      { task_id: 'A', instruction: 'unrelated metadata', answer: null },
    ] }] };
    normalizeQuestionFields(quiz);
    expect(quiz.tasks[0].questions).toHaveLength(1);
    expect(quiz.tasks[0].questions[0].question).toBe('keep me');
  });

  test('dropping all of a task\'s questions (all unrecoverable) correctly makes findIncompleteTasks flag it for retry', () => {
    const quiz = { tasks: [{ title: 'T1', questions: [{ task_id: 'A' }, { task_id: 'B' }] }] };
    normalizeQuestionFields(quiz);
    expect(quiz.tasks[0].questions).toHaveLength(0);
    expect(findIncompleteTasks(quiz)).toHaveLength(1); // now correctly eligible for the existing retry mechanism
  });

  test('a task with no questions array at all is handled gracefully, not a crash', () => {
    const quiz = { tasks: [{ title: 'T1' }] };
    expect(() => normalizeQuestionFields(quiz)).not.toThrow();
  });
});
