// findIncompleteTasks / retryIncompleteTasks — added 2026-09-12 after a
// live manual-test report: a real English math worksheet's "Compare
// fractions with <, >, or =" task came back with a title but zero
// questions. Root cause was NOT a Telugu/OCR issue and NOT a known
// post-processing bug in quizHtmlRenderer.js's table normalizers - the
// generation step itself just didn't produce items for that one task.
// Since any uploaded document can contain any task type/phrasing, this is
// a general safety net: detect any title-only task and do one retry
// against whichever engine produced the quiz, asking specifically for the
// missing tasks, then merge them back in.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const { findIncompleteTasks, retryIncompleteTasks } = require('../../services/quizVision');

describe('findIncompleteTasks', () => {
  test('flags a task with a title but no questions and no alternate content', () => {
    const quiz = { tasks: [
      { title: 'Task 1', questions: [{ id: 'a', question: 'x', answer: 1 }] },
      { title: 'Task 2', questions: [] },
    ] };
    const incomplete = findIncompleteTasks(quiz);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].title).toBe('Task 2');
  });

  test('does NOT flag a task with an empty questions array if it has a table instead', () => {
    const quiz = { tasks: [
      { title: 'Task 1', questions: [], table: { headers: ['a'], rows: [[{ text: '1' }]] } },
    ] };
    expect(findIncompleteTasks(quiz)).toHaveLength(0);
  });

  test('does NOT flag a task with a chart, pyramids, or diagramFillBlanks instead of questions', () => {
    const quiz = { tasks: [
      { title: 'Chart task', questions: [], chart: { bars: [{ label: 'x', value: 1 }] } },
      { title: 'Pyramid task', questions: [], pyramids: [{ blocks: [1, 2, 3] }] },
      { title: 'Diagram-fill task', questions: [], diagramFillBlanks: [{ x: 0, y: 0, w: 1, h: 1, answer: '1' }], diagramFillImageUrl: 'http://x' },
    ] };
    expect(findIncompleteTasks(quiz)).toHaveLength(0);
  });

  test('an empty tasks array has no incomplete tasks (nothing to flag)', () => {
    expect(findIncompleteTasks({ tasks: [] })).toHaveLength(0);
    expect(findIncompleteTasks({})).toHaveLength(0);
  });
});

describe('retryIncompleteTasks', () => {
  test('merges a successful retry back into the original task by position, keeping the original title', async () => {
    const quiz = {
      tasks: [
        { title: 'Task 1: Addition', questions: [{ id: 'a', question: '2+2', answer: 4 }] },
        { title: 'Task 2: Compare fractions with <, >, or =', questions: [] },
      ],
    };
    // Simulates a real, observed model behavior: the retry response drops
    // the "Task 2: " prefix even when told to match the title exactly.
    const retryFn = jest.fn().mockResolvedValue(JSON.stringify({
      tasks: [{ title: 'Compare fractions with <, >, or =', questions: [
        { question: '1/2 ___ 1/4', answer: '>', hint: 'h', solution: 's' },
      ] }],
    }));

    const result = await retryIncompleteTasks(quiz, retryFn);

    expect(retryFn).toHaveBeenCalledTimes(1);
    expect(retryFn.mock.calls[0][0]).toMatch(/Task 2: Compare fractions/);
    expect(result.tasks[1].title).toBe('Task 2: Compare fractions with <, >, or =');
    expect(result.tasks[1].questions).toHaveLength(1);
    expect(result.tasks[1].questions[0].answer).toBe('>');
    expect(result.tasks[0].questions).toHaveLength(1); // untouched
  });

  test('a quiz with no incomplete tasks skips the retry call entirely', async () => {
    const quiz = { tasks: [{ title: 'Task 1', questions: [{ id: 'a', question: 'x', answer: 1 }] }] };
    const retryFn = jest.fn();
    const result = await retryIncompleteTasks(quiz, retryFn);
    expect(retryFn).not.toHaveBeenCalled();
    expect(result).toBe(quiz);
  });

  test('a retry call that fails (network error) returns the original quiz unchanged, not a throw', async () => {
    const quiz = { tasks: [{ title: 'Task 1', questions: [] }] };
    const retryFn = jest.fn().mockRejectedValue(new Error('network down'));
    const result = await retryIncompleteTasks(quiz, retryFn);
    expect(result.tasks[0].questions).toEqual([]);
  });

  test('a retry call that returns malformed JSON returns the original quiz unchanged, not a throw', async () => {
    const quiz = { tasks: [{ title: 'Task 1', questions: [] }] };
    const retryFn = jest.fn().mockResolvedValue('not valid json');
    const result = await retryIncompleteTasks(quiz, retryFn);
    expect(result.tasks[0].questions).toEqual([]);
  });

  test('a retry response that is itself still empty for a task leaves that task incomplete, without crashing', async () => {
    const quiz = { tasks: [{ title: 'Task 1', questions: [] }] };
    const retryFn = jest.fn().mockResolvedValue(JSON.stringify({ tasks: [{ title: 'Task 1', questions: [] }] }));
    const result = await retryIncompleteTasks(quiz, retryFn);
    expect(result.tasks[0].questions).toEqual([]);
  });
});
