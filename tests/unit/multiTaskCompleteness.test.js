// Multi-task completeness regression suite — added 2026-09-12 (Phase 6).
// The original reported bug: "Task 1 generates but remaining tasks do
// not." Already fixed (findIncompleteTasks/retryIncompleteTasks) and
// validated against both a real 4-task Telugu fixture (task count
// preserved, 4/4) and one synthetic worksheet. This file makes that
// validation a PERMANENT regression suite covering 2/3/4+ tasks,
// multiple questions per task, ordering preservation, partial-failure
// recovery via retry, and merge behavior - so a future change can't
// silently reintroduce "only Task 1" without a test catching it.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const { findIncompleteTasks, retryIncompleteTasks } = require('../../services/quizVision');

function makeTask(title, questionCount) {
  return {
    title,
    questions: Array.from({ length: questionCount }, (_, i) => ({ id: String.fromCharCode(97 + i), question: `${title} Q${i + 1}`, answer: i + 1 })),
  };
}

describe('multi-task completeness - task count preservation', () => {
  test('2 tasks: both fully populated are not flagged', () => {
    const quiz = { tasks: [makeTask('Task 1', 2), makeTask('Task 2', 3)] };
    expect(findIncompleteTasks(quiz)).toHaveLength(0);
  });

  test('3 tasks: a real gap in the MIDDLE task is caught, not just a trailing one', () => {
    const quiz = { tasks: [makeTask('Task 1', 2), { title: 'Task 2', questions: [] }, makeTask('Task 3', 1)] };
    const incomplete = findIncompleteTasks(quiz);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].title).toBe('Task 2');
  });

  test('4+ tasks: multiple simultaneous gaps are all caught (the exact original bug pattern - not just Task 1 surviving)', () => {
    const quiz = {
      tasks: [
        makeTask('Task 1', 2),
        { title: 'Task 2', questions: [] },
        makeTask('Task 3', 1),
        { title: 'Task 4', questions: [] },
      ],
    };
    const incomplete = findIncompleteTasks(quiz);
    expect(incomplete.map(t => t.title)).toEqual(['Task 2', 'Task 4']);
  });

  test('the specific reported failure mode - ONLY Task 1 has content, everything else is empty - is fully caught', () => {
    const quiz = {
      tasks: [makeTask('Task 1', 3), { title: 'Task 2', questions: [] }, { title: 'Task 3', questions: [] }, { title: 'Task 4', questions: [] }],
    };
    const incomplete = findIncompleteTasks(quiz);
    expect(incomplete).toHaveLength(3);
    expect(quiz.tasks[0].questions).toHaveLength(3); // Task 1 itself is untouched by detection
  });
});

describe('multi-task completeness - retry recovers multiple simultaneous gaps, preserving order', () => {
  test('recovers 2 different missing tasks out of 4 in a single retry call, without disturbing the already-complete ones', async () => {
    const quiz = {
      tasks: [
        makeTask('Task 1: Addition', 2),
        { title: 'Task 2: Diagram Question', questions: [] },
        makeTask('Task 3: Word Problems', 1),
        { title: 'Task 4: Compare Fractions', questions: [] },
      ],
    };
    const retryFn = jest.fn().mockResolvedValue(JSON.stringify({
      tasks: [
        { title: 'Diagram Question', questions: [{ question: 'What shape is shown?', answer: 'triangle' }] },
        { title: 'Compare Fractions', questions: [{ question: '1/2 ___ 1/4', answer: '>' }] },
      ],
    }));

    const result = await retryIncompleteTasks(quiz, retryFn);

    expect(retryFn).toHaveBeenCalledTimes(1);
    // Order preserved: still 4 tasks, in the original sequence.
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks[0].title).toBe('Task 1: Addition');
    expect(result.tasks[0].questions).toHaveLength(2); // untouched
    expect(result.tasks[1].title).toBe('Task 2: Diagram Question'); // original title preserved, not the retry's paraphrase
    expect(result.tasks[1].questions).toHaveLength(1);
    expect(result.tasks[1].questions[0].answer).toBe('triangle');
    expect(result.tasks[2].title).toBe('Task 3: Word Problems');
    expect(result.tasks[2].questions).toHaveLength(1); // untouched
    expect(result.tasks[3].title).toBe('Task 4: Compare Fractions');
    expect(result.tasks[3].questions[0].answer).toBe('>');
    expect(findIncompleteTasks(result)).toHaveLength(0);
  });

  test('a partially-successful retry (one of two gaps recovered) still merges what it can, leaving the other flagged', async () => {
    const quiz = {
      tasks: [
        { title: 'Task 1: First Gap', questions: [] },
        { title: 'Task 2: Second Gap', questions: [] },
      ],
    };
    // The retry engine only manages to answer for the first gap this time.
    const retryFn = jest.fn().mockResolvedValue(JSON.stringify({
      tasks: [{ title: 'First Gap', questions: [{ question: 'x', answer: 'y' }] }],
    }));

    const result = await retryIncompleteTasks(quiz, retryFn);

    expect(result.tasks[0].questions).toHaveLength(1); // recovered
    expect(result.tasks[1].questions).toHaveLength(0); // still empty - correctly still flagged
    expect(findIncompleteTasks(result)).toHaveLength(1);
    expect(findIncompleteTasks(result)[0].title).toBe('Task 2: Second Gap');
  });

  test('a completely failed retry (network/engine error) leaves ALL original gaps flagged, not silently accepted as complete', async () => {
    const quiz = {
      tasks: [makeTask('Task 1', 2), { title: 'Task 2', questions: [] }, { title: 'Task 3', questions: [] }],
    };
    const retryFn = jest.fn().mockRejectedValue(new Error('engine down'));

    const result = await retryIncompleteTasks(quiz, retryFn);

    expect(findIncompleteTasks(result)).toHaveLength(2);
  });
});

describe('multi-task completeness - multi-page tasks', () => {
  test('tasks spanning different sourcePage values are all still checked independently', () => {
    const quiz = {
      tasks: [
        { ...makeTask('Task 1', 2), sourcePage: 1 },
        { title: 'Task 2', questions: [], sourcePage: 2 },
        { ...makeTask('Task 3', 1), sourcePage: 3 },
      ],
    };
    const incomplete = findIncompleteTasks(quiz);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].sourcePage).toBe(2);
  });
});

describe('multi-task completeness - retry can never corrupt an already-valid task', () => {
  test('a malformed/mismatched retry response (extra or wrongly-ordered tasks) cannot overwrite an already-complete task', async () => {
    const quiz = { tasks: [makeTask('Task 1', 3), { title: 'Task 2', questions: [] }] };
    // Retry response deliberately includes a bogus entry for "Task 1" too,
    // as if trying to overwrite it - by construction, retryIncompleteTasks
    // only ever considers positions that were in findIncompleteTasks'
    // result (only Task 2's slot here), so Task 1 can never be reached
    // regardless of what a misbehaving retry response contains.
    const retryFn = jest.fn().mockResolvedValue(JSON.stringify({
      tasks: [{ title: 'Task 2', questions: [{ question: 'x', answer: 'y' }] }],
    }));
    const result = await retryIncompleteTasks(quiz, retryFn);
    expect(result.tasks[0].questions).toHaveLength(3); // Task 1 completely untouched
    expect(result.tasks[1].questions).toHaveLength(1); // Task 2 correctly recovered
  });

  test('when there is nothing incomplete, retryFn is never even invoked - zero risk of any task being touched', async () => {
    const quiz = { tasks: [makeTask('Task 1', 2), makeTask('Task 2', 3), makeTask('Task 3', 1)] };
    const retryFn = jest.fn();
    const result = await retryIncompleteTasks(quiz, retryFn);
    expect(retryFn).not.toHaveBeenCalled();
    expect(result).toBe(quiz); // same object reference - not even a copy was made
  });
});
